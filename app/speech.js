import { prefs, savePrefs, t } from './common.js'
import { isAndroid, AndroidSynth } from './android.js'

// The word being read is drawn on the annotation layer instead of being
// selected: a real selection brings up handles and menus on phones.
// The prefix makes foliate-js treat it like a search mark, so taps on it
// are not reported as annotation clicks.
const MARK_KEY = 'foliate-search:neo-tts'

// Typical speaking pace (weighted characters per second at rate 1), used
// until the voice's real pace has been measured
const DEFAULT_PACE = 16

// Voices pause at punctuation; count those pauses as extra characters so an
// estimated position keeps up with the speech
const pauseWeight = ch => /[.!?…]/.test(ch) ? 8 : /[,;:—–]/.test(ch) ? 4 : /\n/.test(ch) ? 6 : 0

// Cumulative weighted length at each character of the text
const weightedPositions = text => {
    const positions = new Float32Array(text.length + 1)
    let total = 0
    for (let i = 0; i < text.length; i++) {
        positions[i] = total
        total += 1 + pauseWeight(text[i])
    }
    positions[text.length] = total
    return positions
}

// Sentence spans of the text
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
        // keep very short pieces with the previous sentence
        if (last && (segment.trim().length < 12 || last.end - last.start < 12)) last.end = index + segment.length
        else parts.push({ start: index, end: index + segment.length })
    }
    return parts.length ? parts : [{ start: 0, end: text.length }]
}

const charAtWeight = (positions, weight) => {
    let lo = 0, hi = positions.length - 1
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (positions[mid] <= weight) lo = mid
        else hi = mid - 1
    }
    return lo
}

// Soft rounded marker around the word, a little larger than the text
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
    // weighted characters per second at rate 1, learned per voice while
    // reading and kept in the preferences for next time
    #pace = new Map(Object.entries(prefs.ttsPace ?? {}))

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

    // Is the word on the page currently shown?
    #isOnScreen(range) {
        const visible = this.reader.location?.range
        if (!visible || visible.startContainer?.ownerDocument !== range.startContainer?.ownerDocument) return false
        try {
            return visible.compareBoundaryPoints(Range.START_TO_START, range) <= 0
                && visible.compareBoundaryPoints(Range.END_TO_END, range) >= 0
        } catch {
            return false
        }
    }

    #highlight = range => {
        const renderer = this.reader.view.renderer
        // Follow the voice to the next page without selecting anything. Only
        // when the word left the page: scrolling to it on every word fires a
        // relocation (position, progress, saving) each time, which made the
        // marker lag behind the voice on phones.
        if (!this.#isOnScreen(range)) renderer.scrollToAnchor?.(range)
        const contents = renderer.getContents()
            .find(c => c.doc === range.startContainer?.ownerDocument)
        const color = getComputedStyle(document.documentElement).getPropertyValue('--tts-marker').trim()
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
        const utteranceLang = this.#voice?.lang || lang || this.reader.view?.language?.canonical || ''

        // Follow the voice. The block is spoken sentence by sentence, so the
        // start of every sentence puts the marker back in sync. Engines that
        // report word boundaries drive the marker word by word; for others
        // (some Android engines, network voices) it moves at the voice's
        // measured pace in between.
        let current = -1
        const markAt = charIndex => {
            let index = -1
            for (let i = 0; i < marks.length && marks[i].offset <= charIndex; i++) index = i
            if (index < 0 || index === current) return
            current = index
            this.reader.view.tts?.setMark(marks[index].name)
        }

        // Pace is learned per voice and speed: pauses do not shrink in
        // proportion to the speed, so one number does not fit all speeds
        const voiceKey = this.#voice?.voiceURI || utteranceLang
        const rate = Math.round(this.#rate * 10) / 10
        const paceKey = `${voiceKey}@${rate}`
        const charsPerSecond = () => {
            if (this.#pace.has(paceKey)) return this.#pace.get(paceKey) * this.#rate
            // from the nearest measured speed; real voices slow down and
            // speed up less than the rate says
            let best = null
            for (const [key, value] of this.#pace) {
                const [voice, r] = key.split('@')
                if (voice !== voiceKey || !r) continue
                const distance = Math.abs(parseFloat(r) - rate)
                if (!best || distance < best.distance) best = { distance, value, rate: parseFloat(r) }
            }
            if (!best) return DEFAULT_PACE * Math.pow(this.#rate, 0.8)
            return best.value * best.rate * Math.pow(this.#rate / best.rate, 0.8)
        }

        const positions = weightedPositions(text)
        const parts = splitSentences(text, utteranceLang)
        let started = 0, spoke = false, requested = 0, wordBoundaries = false
        let anchorTime = 0, anchorWeight = 0, timer = null
        const tick = () => {
            if (generation !== this.#generation || wordBoundaries) return
            const weight = anchorWeight + (performance.now() - anchorTime) / 1000 * charsPerSecond()
            markAt(Math.min(charAtWeight(positions, weight), text.length - 1))
            timer = setTimeout(tick, 90)
        }
        // A part (the block or a sentence) started: re-anchor the estimate
        const onPartStart = offset => {
            if (generation !== this.#generation) return
            const now = performance.now()
            if (!started) started = now
            anchorTime = now
            anchorWeight = positions[offset]
            markAt(offset)
            clearTimeout(timer)
            // give real word boundaries a moment before estimating
            if (!wordBoundaries) timer = setTimeout(tick, offset ? 0 : 450)
        }
        const learnPace = (from, to, elapsed) => {
            if (elapsed < 1500 || to - from < 40) return
            const measured = (positions[to] - positions[from]) / (elapsed / 1000) / this.#rate
            const previous = this.#pace.get(paceKey)
            this.#pace.set(paceKey, previous ? previous * 0.5 + measured * 0.5 : measured)
            prefs.ttsPace = Object.fromEntries(this.#pace)
            savePrefs()
        }

        const utterances = parts.map(({ start, end }, i) => {
            const partText = text.slice(start, end)
            const utterance = globalThis.SpeechSynthesisUtterance && !isAndroid
                ? new SpeechSynthesisUtterance(partText) : { text: partText }
            utterance.rate = this.#rate
            if (this.#voice) utterance.voice = this.#voice
            utterance.lang = utteranceLang
            // later sentences queue behind the first instead of replacing it
            utterance.queue = i > 0
            let partStarted = 0
            utterance.onstart = () => {
                if (partStarted) return
                partStarted = performance.now()
                onPartStart(start)
            }
            utterance.onboundary = e => {
                if (generation !== this.#generation) return
                spoke = true
                utterance.onstart()
                const charIndex = start + e.charIndex
                if (e.name === 'sentence') {
                    anchorTime = performance.now()
                    anchorWeight = positions[Math.min(charIndex, text.length)]
                    markAt(charIndex)
                    return
                }
                wordBoundaries = true
                clearTimeout(timer)
                markAt(charIndex)
            }
            utterance.onend = () => {
                if (generation !== this.#generation) return
                const elapsed = performance.now() - (partStarted || requested)
                if (i === 0) {
                    // An immediate end without a single word spoken is a
                    // glitch, not the end of the text: say it again instead of
                    // moving on (no real sentence of 20+ characters is over
                    // within 150 ms)
                    const early = !spoke && elapsed < 150
                    if (early && !retried && partText.trim().length > 20) return this.#speak(ssml, true)
                }
                if (partStarted) learnPace(start, end, elapsed)
                if (i < parts.length - 1) return
                clearTimeout(timer)
                this.#onEnd(generation)
            }
            utterance.onerror = e => {
                clearTimeout(timer)
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
