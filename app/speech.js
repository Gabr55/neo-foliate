import { prefs, t } from './common.js'
import { isAndroid, AndroidSynth } from './android.js'

// The word being read is drawn on the annotation layer instead of being
// selected: a real selection brings up handles and menus on phones.
// The prefix makes foliate-js treat it like a search mark, so taps on it
// are not reported as annotation clicks.
const MARK_KEY = 'foliate-search:neo-tts'

// Soft rounded marker around the word, a little larger than the text
const roundedMark = (rects, { color }) => {
    const ns = 'http://www.w3.org/2000/svg'
    const g = document.createElementNS(ns, 'g')
    g.setAttribute('fill', color)
    g.style.opacity = 'var(--overlayer-highlight-opacity, .3)'
    g.style.mixBlendMode = 'var(--overlayer-highlight-blend-mode, normal)'
    for (const { left, top, height, width } of rects) {
        if (!width || !height) continue
        const padX = Math.max(2, height * 0.18), padY = Math.max(1, height * 0.08)
        const r = document.createElementNS(ns, 'rect')
        r.setAttribute('x', left - padX)
        r.setAttribute('y', top - padY)
        r.setAttribute('width', width + 2 * padX)
        r.setAttribute('height', height + 2 * padY)
        r.setAttribute('rx', (height + 2 * padY) / 2.4)
        g.append(r)
    }
    return g
}

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
        // Android's WebView has no speechSynthesis; use the system TTS engine
        this.synth = isAndroid ? new AndroidSynth() : globalThis.speechSynthesis
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
        def.textContent = t('Default voice')
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
        if (this.state === 'playing') this.#scheduleRestart()
    }

    setRate(rate) {
        this.#rate = rate
        if (this.state === 'playing') this.#scheduleRestart()
    }

    // Changing rate or voice restarts the current sentence once things settle,
    // instead of on every step of the slider
    #restartTimer = null
    #scheduleRestart() {
        clearTimeout(this.#restartTimer)
        this.#restartTimer = setTimeout(() => {
            if (this.state === 'playing') this.#restart()
        }, 250)
    }

    #setState(state) {
        this.state = state
        this.onState?.(state)
    }

    #highlight = range => {
        const renderer = this.reader.view.renderer
        // follow the voice to the next page without selecting anything
        renderer.scrollToAnchor?.(range)
        const contents = renderer.getContents()
            .find(c => c.doc === range.startContainer?.ownerDocument)
        const color = getComputedStyle(document.documentElement).getPropertyValue('--book-link').trim()
        try {
            contents?.overlayer?.add(MARK_KEY, range, roundedMark, { color: color || 'currentColor' })
        } catch (e) {
            console.warn(e)
        }
    }

    #clearHighlight() {
        for (const { overlayer } of this.reader.view?.renderer?.getContents?.() ?? [])
            overlayer?.remove(MARK_KEY)
    }

    async #init() {
        await this.reader.view.initTTS('word', this.#highlight)
        return this.reader.view.tts
    }

    #speak(ssml, retried = false) {
        const generation = ++this.#generation
        // WebKit may end an utterance spoken right after cancel() at once,
        // which looked like the end of the block and skipped ahead
        const wasSpeaking = this.synth.speaking || this.synth.pending
        this.synth.cancel()
        if (!ssml) return this.#nextSection(generation)
        this.#currentSSML = ssml
        const { text, marks, lang } = parseSSML(ssml)
        if (!text.trim()) return this.#onEnd(generation)
        const utterance = globalThis.SpeechSynthesisUtterance && !isAndroid
            ? new SpeechSynthesisUtterance(text) : { text }
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
        let started = 0, spoke = false, requested = 0
        utterance.onstart = () => started = performance.now()
        const onboundary = utterance.onboundary
        utterance.onboundary = e => {
            spoke = true
            onboundary(e)
        }
        utterance.onend = () => {
            if (generation !== this.#generation) return
            // An immediate end without a single word spoken is a glitch,
            // not the end of the text: say it again instead of moving on
            // (no real sentence of 20+ characters is over within 150 ms)
            const early = !spoke && performance.now() - (started || requested) < 150
            if (early && !retried && text.trim().length > 20) return this.#speak(ssml, true)
            this.#onEnd(generation)
        }
        utterance.onerror = e => {
            if (generation !== this.#generation) return
            if (e.error === 'interrupted' || e.error === 'canceled') return
            console.error(e)
            this.onError?.(e)
            this.stop()
        }
        // Mark the first word right away; some engines skip early boundaries
        if (marks[0]) this.reader.view.tts?.setMark(marks[0].name)
        this.#setState('playing')
        const speakNow = () => {
            if (generation !== this.#generation) return
            requested = performance.now()
            this.synth.speak(utterance)
        }
        if (wasSpeaking || retried) setTimeout(speakNow, 80)
        else speakNow()
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

    // Start of the page on screen, collapsed, in the document TTS reads from
    #visibleStart() {
        const range = this.reader.location?.range
        const doc = this.reader.view.renderer.getContents()[0]?.doc
        if (!range || range.startContainer?.ownerDocument !== doc) return null
        const start = range.cloneRange()
        start.collapse(true)
        return start
    }

    // Read from the page on screen, not from the start of the chapter
    async start() {
        if (!this.synth) return this.onError?.()
        const tts = await this.#init()
        const start = this.#visibleStart()
        this.#speak(start ? tts.from(start) ?? tts.start() : tts.start())
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

    #pausedAt = null
    pause() {
        this.#generation++
        this.synth?.cancel()
        this.#pausedAt = this.reader.location?.cfi ?? null
        this.#setState('paused')
    }

    // Resume where reading stopped, unless the reader turned to another page
    async resume() {
        if (this.reader.location?.cfi !== this.#pausedAt) return this.start()
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
        this.#clearHighlight()
        this.#currentSSML = null
        if (this.state !== 'stopped') this.#setState('stopped')
    }
}
