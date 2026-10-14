// Bridge to the Android host (see MainActivity.kt). `NeoAndroid` is a
// JavascriptInterface; async results and events come back through
// `window.__neoAndroid`, which the Kotlin side calls with evaluateJavascript.

const native = globalThis.NeoAndroid
export const isAndroid = !!native

const pending = new Map()
let seq = 0

const emit = (type, detail) =>
    window.dispatchEvent(new CustomEvent(`neo-android:${type}`, { detail }))

globalThis.__neoAndroid = {
    resolve(id, value) {
        pending.get(id)?.resolve(value)
        pending.delete(id)
    },
    reject(id, message) {
        pending.get(id)?.reject(new Error(message))
        pending.delete(id)
    },
    emit,
}

const call = (method, ...args) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    try {
        native[method](id, ...args)
    } catch (e) {
        pending.delete(id)
        reject(e)
    }
})

export const onAndroid = (type, f) =>
    window.addEventListener(`neo-android:${type}`, e => f(e.detail))

// Safe-area insets in CSS pixels, kept as CSS variables
const applyInsets = insets => {
    if (!insets) return
    const style = document.documentElement.style
    for (const side of ['top', 'right', 'bottom', 'left'])
        style.setProperty(`--safe-${side}`, `${insets[side] ?? 0}px`)
}

if (isAndroid) {
    document.documentElement.classList.add('android')
    try {
        applyInsets(JSON.parse(native.getInsets()))
    } catch (e) {
        console.warn(e)
    }
    onAndroid('insets', applyInsets)
}

export const android = {
    // Copies a content:// URI into `dir`; resolves to the new file path
    copyToLibrary: (uri, dir) => call('copyToLibrary', uri, dir),
    writeText: (uri, text) => call('writeText', uri, text),
    // Files shared with or opened in the app ("Open with…")
    takePendingFiles: dir => call('takePendingFiles', dir),
    setKeepScreenOn: on => native?.setKeepScreenOn(!!on),
    setImmersive: on => native?.setImmersive(!!on),
    setVolumeKeys: on => native?.setVolumeKeys(!!on),
    setBrightness: value => native?.setBrightness(value ?? -1),
    setSystemBars: lightBackground => native?.setSystemBars(!!lightBackground),
    tts: {
        voices: () => {
            try {
                return JSON.parse(native?.ttsVoices() ?? '[]')
            } catch {
                return []
            }
        },
        speak: (id, text, lang, rate, voice, flush = true) =>
            native?.ttsSpeak(id, text, lang ?? '', rate ?? 1, voice ?? '', flush),
        stop: () => native?.ttsStop(),
        openSettings: () => native?.openTtsSettings(),
    },
}

// Mimics the parts of `speechSynthesis` that speech.js uses
export class AndroidSynth extends EventTarget {
    #utterances = new Map()
    #seq = 0
    constructor() {
        super()
        onAndroid('tts', ({ id, type, start, error }) => {
            const utterance = this.#utterances.get(id)
            if (type === 'voices') return this.dispatchEvent(new Event('voiceschanged'))
            if (!utterance) return
            if (type === 'start') utterance.onstart?.()
            else if (type === 'range') utterance.onboundary?.({ name: 'word', charIndex: start })
            else if (type === 'done') {
                this.#utterances.delete(id)
                utterance.onend?.()
            } else if (type === 'error') {
                this.#utterances.delete(id)
                utterance.onerror?.({ error: error ?? 'synthesis-failed' })
            }
        })
    }
    getVoices() {
        return android.tts.voices().map(v => ({ name: v.name, lang: v.lang, voiceURI: v.name }))
    }
    speak(utterance) {
        const id = String(++this.#seq)
        this.#utterances.set(id, utterance)
        android.tts.speak(id, utterance.text, utterance.lang, utterance.rate,
            utterance.voice?.voiceURI, !utterance.queue)
    }
    cancel() {
        for (const utterance of this.#utterances.values())
            utterance.onerror?.({ error: 'interrupted' })
        this.#utterances.clear()
        android.tts.stop()
    }
}
