import { prefs } from './common.js'

// Read aloud with the system speech synthesizer (Web Speech API).
// foliate-js produces SSML with <mark> elements; we turn it into plain text,
// remember where each mark falls, and highlight words on boundary events.

const parseSSML = ssml => {
    const doc = new DOMParser().parseFromString(ssml, 'application/xml')
    const root = doc.documentElement
    const lang = root.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang')
        || root.getAttribute('xml:lang') || ''
    const marks = []
    let text = ''
    const walk = node => {
        for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) text += child.nodeValue
            else if (child.nodeType === Node.ELEMENT_NODE) {
                if (child.localName === 'mark') marks.push({ offset: text.length, name: child.getAttribute('name') })
                else if (child.localName === 'break') text += ' '
                else walk(child)
            }
        }
    }
    walk(root)
    return { text, marks, lang }
}

export class Speech {
    state = 'stopped'
    #generation = 0
    #voice = null
    #rate = 1
    #voices = []
    #currentSSML = null

    constructor(reader, { onState, onError }) {
        this.reader = reader
        this.onState = onState
        this.onError = onError
        this.synth = globalThis.speechSynthesis
        if (!this.synth) return
        this.#rate = prefs.ttsRate ?? 1
        this.#loadVoices()
        this.synth.addEventListener?.('voiceschanged', () => this.#loadVoices())
    }

    #loadVoices() {
        this.#voices = this.synth.getVoices()
        const select = document.getElementById('tts-voice')
        if (!select) return
        const saved = prefs.ttsVoice ?? ''
        const bookLang = (this.reader.view?.language?.canonical ?? '').split('-')[0]
        const sorted = [...this.#voices].sort((a, b) => {
            const am = a.lang.startsWith(bookLang) ? 0 : 1
            const bm = b.lang.startsWith(bookLang) ? 0 : 1
            return am - bm || a.name.localeCompare(b.name)
        })
        const def = document.createElement('option')
        def.value = ''
        def.textContent = '—'
        select.replaceChildren(def, ...sorted.map(v => {
            const option = document.createElement('option')
            option.value = v.voiceURI
            option.textContent = `${v.name} (${v.lang})`
            return option
        }))
        select.value = saved
        this.setVoice(saved)
    }

    setVoice(uri) {
        this.#voice = this.#voices.find(v => v.voiceURI === uri) ?? null
        if (this.state === 'playing') this.#restart()
    }

    setRate(rate) {
        this.#rate = rate
        if (this.state === 'playing') this.#restart()
    }

    #setState(state) {
        this.state = state
        this.onState?.(state)
    }

    async #init() {
        await this.reader.view.initTTS()
        return this.reader.view.tts
    }

    #speak(ssml) {
        const generation = ++this.#generation
        this.synth.cancel()
        if (!ssml) return this.#nextSection(generation)
        this.#currentSSML = ssml
        const { text, marks, lang } = parseSSML(ssml)
        if (!text.trim()) return this.#onEnd(generation)
        const utterance = new SpeechSynthesisUtterance(text)
        utterance.rate = this.#rate
        if (this.#voice) utterance.voice = this.#voice
        utterance.lang = this.#voice?.lang || lang || this.reader.view?.language?.canonical || ''
        utterance.onboundary = e => {
            if (generation !== this.#generation) return
            let mark
            for (const m of marks) {
                if (m.offset <= e.charIndex) mark = m
                else break
            }
            if (mark) this.reader.view.tts?.setMark(mark.name)
        }
        utterance.onend = () => this.#onEnd(generation)
        utterance.onerror = e => {
            if (generation !== this.#generation) return
            if (e.error === 'interrupted' || e.error === 'canceled') return
            console.error(e)
            this.onError?.(e)
            this.stop()
        }
        // Mark the first word right away; some engines skip early boundaries
        if (marks[0]) this.reader.view.tts?.setMark(marks[0].name)
        this.synth.speak(utterance)
        this.#setState('playing')
    }

    #onEnd(generation) {
        if (generation !== this.#generation || this.state !== 'playing') return
        const ssml = this.reader.view.tts?.next()
        if (ssml) this.#speak(ssml)
        else this.#nextSection(generation)
    }

    async #nextSection(generation) {
        if (generation !== this.#generation) return
        const renderer = this.reader.view.renderer
        const before = renderer.getContents()[0]?.index
        await renderer.nextSection?.()
        const after = renderer.getContents()[0]?.index
        if (generation !== this.#generation) return
        if (after === before) return this.stop()
        const tts = await this.#init()
        this.#speak(tts.start())
    }

    #restart() {
        const tts = this.reader.view.tts
        if (tts) this.#speak(tts.resume())
    }

    async start() {
        if (!this.synth) return this.onError?.()
        const tts = await this.#init()
        this.#speak(tts.start())
    }

    async fromRange(range) {
        if (!this.synth) return this.onError?.()
        const tts = await this.#init()
        this.#speak(tts.from(range))
    }

    async toggle() {
        if (this.state === 'playing') return this.pause()
        if (this.state === 'paused') return this.resume()
        return this.start()
    }

    pause() {
        this.#generation++
        this.synth?.cancel()
        this.#setState('paused')
    }

    async resume() {
        const tts = await this.#init()
        this.#speak(tts.resume())
    }

    async prev() {
        const tts = await this.#init()
        this.#speak(tts.prev())
    }

    async next() {
        const tts = await this.#init()
        this.#speak(tts.next())
    }

    stop() {
        this.#generation++
        this.synth?.cancel()
        this.#currentSSML = null
        if (this.state !== 'stopped') this.#setState('stopped')
    }
}
