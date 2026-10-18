import { prefs, t } from './common.js'
import { isAndroid, AndroidSynth } from './android.js'

// Read aloud with the system speech synthesizer (Web Speech API, or the
// Android engine through the bridge).
//
// Engines do not reliably report which word they are saying, so the marker
// does not try to guess: each block goes to the voice sentence by sentence,
// and the sentence handed to the voice is marked when it starts playing.

// The marker is drawn on the annotation layer instead of selecting text: a
// real selection brings up handles and menus on phones. The prefix makes
// foliate-js treat it like a search mark, so taps on it are not reported as
// annotation clicks.
const MARK_KEY = 'foliate-search:neo-tts'

// Sentence spans of the text; very short pieces stay with their neighbors
const splitSentences = (text, lang) => {
    let segments
    try {
        segments = [...new Intl.Segmenter(lang || undefined, { granularity: 'sentence' }).segment(text)]
    } catch {
        segments = [{ index: 0, segment: text }]
    }
    const parts = []
    for (const { index, segment } of segments) {
        const last = parts.at(-1)
        if (last && (segment.trim().length < 12 || last.end - last.start < 12)) last.end = index + segment.length
        else parts.push({ start: index, end: index + segment.length })
    }
    return parts.length ? parts : [{ start: 0, end: text.length }]
}

// Soft rounded marker, a little larger than the text
const roundedMark = (rects, { color }) => {
    const ns = 'http://www.w3.org/2000/svg'
    const g = document.createElementNS(ns, 'g')
    g.setAttribute('fill', color)
    g.style.opacity = 'var(--tts-marker-opacity, .3)'
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

// foliate-js produces SSML with a <mark> before each word; turn it into the
// plain text spoken and remember where each mark falls
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
    // collects word ranges while a sentence's span is being looked up
    #capture = null

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

    // --- Marking ---

    // Is the range on the page currently shown?
    #isOnScreen(range) {
        const visible = this.reader.location?.range
        if (!visible || visible.startContainer?.ownerDocument !== range.startContainer?.ownerDocument) return false
        try {
            return visible.compareBoundaryPoints(Range.START_TO_START, range) <= 0
                && visible.compareBoundaryPoints(Range.START_TO_END, range) >= 0
        } catch {
            return false
        }
    }

    #draw(range) {
        const renderer = this.reader.view.renderer
        // Turn the page when the sentence starts on the next one. Only then:
        // every scroll fires a relocation (position, progress, saving)
        if (!this.#isOnScreen(range)) {
            const start = range.cloneRange()
            start.collapse(true)
            renderer.scrollToAnchor?.(start)
        }
        const contents = renderer.getContents()
            .find(c => c.doc === range.startContainer?.ownerDocument)
        const color = getComputedStyle(document.documentElement).getPropertyValue('--tts-marker').trim()
        try {
            contents?.overlayer?.add(MARK_KEY, range, roundedMark, { color: color || 'currentColor' })
        } catch (e) {
            console.warn(e)
        }
    }

    // foliate-js calls this with a word's range when a mark is set, and with
    // a whole block when stepping between blocks while paused
    #highlight = range => {
        if (this.#capture) this.#capture.push(range)
        else this.#draw(range)
    }

    // Mark the text from the first to the last word of a sentence. The marks
    // are looked up last word first, so foliate-js remembers the sentence's
    // first word: resuming starts again at the beginning of the sentence.
    #markSentence(first, last) {
        const tts = this.reader.view.tts
        if (!tts || !first) return
        const ranges = []
        this.#capture = ranges
        try {
            if (last && last !== first) tts.setMark(last)
            tts.setMark(first)
        } finally {
            this.#capture = null
        }
        const start = ranges.at(-1)
        if (!start) return
        const range = start.cloneRange()
        const end = ranges.length > 1 ? ranges[0] : null
        const lastWord = end ?? start
        try {
            // include the punctuation right after the last word ("word." or "word»")
            let offset = lastWord.endOffset
            const node = lastWord.endContainer
            if (node.nodeType === Node.TEXT_NODE)
                while (offset < node.length && !/\s/.test(node.data[offset])) offset++
            range.setEnd(node, offset)
        } catch {
            // keep the first word if the end is elsewhere
        }
        this.#draw(range)
    }

    #clearHighlight() {
        for (const { overlayer } of this.reader.view?.renderer?.getContents?.() ?? [])
            overlayer?.remove(MARK_KEY)
    }

    async #init() {
        await this.reader.view.initTTS('word', this.#highlight)
        return this.reader.view.tts
    }

    // --- Speaking ---

    #speak(ssml, retried = false) {
        const generation = ++this.#generation
        // WebKit may end an utterance spoken right after cancel() at once,
        // which looked like the end of the block and skipped ahead
        const wasSpeaking = this.synth.speaking || this.synth.pending
        this.synth.cancel()
        if (!ssml) return this.#nextSection(generation)
        const { text, marks, lang } = parseSSML(ssml)
        if (!text.trim()) return this.#onEnd(generation)
        const utteranceLang = this.#voice?.lang || lang || this.reader.view?.language?.canonical || ''

        const parts = splitSentences(text, utteranceLang)
        let spoke = false, requested = 0
        const utterances = parts.map(({ start, end }, i) => {
            const partText = text.slice(start, end)
            const partMarks = marks.filter(m => m.offset >= start && m.offset < end)
            const utterance = globalThis.SpeechSynthesisUtterance && !isAndroid
                ? new SpeechSynthesisUtterance(partText) : { text: partText }
            utterance.rate = this.#rate
            if (this.#voice) utterance.voice = this.#voice
            utterance.lang = utteranceLang
            // later sentences queue behind the first instead of replacing it
            utterance.queue = i > 0
            let started = 0
            utterance.onstart = () => {
                if (started || generation !== this.#generation) return
                started = performance.now()
                // what was handed to the voice is what gets marked
                this.#markSentence(partMarks[0]?.name, partMarks.at(-1)?.name)
            }
            utterance.onboundary = () => {
                if (generation !== this.#generation) return
                spoke = true
                utterance.onstart()
            }
            utterance.onend = () => {
                if (generation !== this.#generation) return
                if (i === 0) {
                    // An immediate end without a single word spoken is a
                    // glitch, not the end of the text: say it again instead of
                    // moving on (no real sentence of 20+ characters is over
                    // within 150 ms)
                    const elapsed = performance.now() - (started || requested)
                    if (!spoke && elapsed < 150 && !retried && partText.trim().length > 20)
                        return this.#speak(ssml, true)
                }
                if (i < parts.length - 1) {
                    // the next sentence follows right away; mark it even if the
                    // engine does not report its start
                    utterances[i + 1].onstart()
                    return
                }
                this.#onEnd(generation)
            }
            utterance.onerror = e => {
                if (generation !== this.#generation) return
                if (e.error === 'interrupted' || e.error === 'canceled') return
                console.error(e)
                this.onError?.(e)
                this.stop()
            }
            return utterance
        })

        this.#setState('playing')
        const speakNow = () => {
            if (generation !== this.#generation) return
            requested = performance.now()
            for (const utterance of utterances) this.synth.speak(utterance)
            // engines that never report the start still get a marker
            setTimeout(() => utterances[0].onstart(), 1200)
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

    // Resume at the start of the sentence that was playing, unless the reader
    // turned to another page meanwhile
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
        if (this.state !== 'stopped') this.#setState('stopped')
    }
}
