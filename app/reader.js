import {
    api, t, el, icon, translateDOM, renderIcons, loadFile, fileName, isMac, isMobile, pickBooks,
    showDialog, pushOverlay, popOverlay, setMarquee,
    formatLanguageMap, formatAuthors, percentFormat, debounce, themes, invertColor,
    prefs, initPrefs, onPrefsChanged, savePrefs, applyColorScheme, showPopover, closePopover, isPopoverOpen,
} from './common.js'
import { makeBook, NotFoundError, UnsupportedTypeError } from './foliate-js/view.js'
import { Overlayer } from './foliate-js/overlayer.js'
import { FootnoteHandler } from './foliate-js/footnotes.js'
import { createTOC } from './toc.js'
import * as CFI from './foliate-js/epubcfi.js'
import { ensureIdentifier, plainMetadata, saveCover } from './bookdata.js'
import { showBookInfo } from './info.js'
import { Speech } from './speech.js'
import { isAndroid, android, onAndroid } from './android.js'

const $ = document.querySelector.bind(document)
const $$ = s => Array.from(document.querySelectorAll(s))
const appWindow = api.window()
// Start reading and parsing the book right away, while the rest of the page
// (preferences, interface) sets up
const openBook = async path => {
    // Work on the app's own copy of the book; Android imports are copies already
    const stored = isAndroid ? path : await api.storeBook(path).catch(e => {
        console.warn(e)
        return path
    })
    const file = await loadFile(stored)
    return { path: stored, book: await makeBook(file) }
}
const earlyBook = openBook(new URLSearchParams(location.search).get('path'))
earlyBook.catch(() => {}) // reported when the reader opens

await initPrefs()
const darkQuery = matchMedia('(prefers-color-scheme: dark)')

translateDOM()
renderIcons()
// Phones get text labels under the icons, which are easier to discover by touch
if (isMobile) for (const b of $$('.selection-actions button, .sidebar-tabs button'))
    b.append(el('span', { class: 'label' }, b.title))

const toast = (() => {
    let timeout
    return (message, ms = 2500) => {
        const elem = $('#toast')
        elem.textContent = message
        elem.hidden = false
        clearTimeout(timeout)
        timeout = setTimeout(() => elem.hidden = true, ms)
    }
})()

// --- Book styles (adapted from Foliate) -------------------------------------

const fontStacks = {
    'serif': 'Georgia, "Iowan Old Style", "Times New Roman", serif',
    'sans-serif': '-apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif',
}

const getCSS = ({
    lineHeight, justify, hyphenate, invert, theme, fontSize, fontFamily, mediaActiveClass, dark,
}) => {
    // Resolve the scheme here instead of relying on `prefers-color-scheme`,
    // so the app's own light/dark choice applies to the book too
    const inverted = dark && invert
    const colors = inverted ? theme.light : dark ? theme.dark : theme.light
    const isWhite = !dark && colors.bg === '#ffffff'
    const active = CSS.escape(mediaActiveClass)
    return [`
    @namespace epub "http://www.idpf.org/2007/ops";
    @media screen {
        html {
            color-scheme: ${dark && !inverted ? 'only dark' : 'only light'};
            color: ${colors.fg};
            font-size: ${fontSize}px;
            ${inverted ? '-webkit-font-smoothing: antialiased;' : ''}
        }
        a:any-link {
            color: ${colors.link};
            text-decoration-color: color-mix(in srgb, currentColor 30%, transparent);
            text-underline-offset: .1em;
        }
        a:any-link:hover {
            text-decoration-color: unset;
        }
        aside[epub|type~="footnote"] {
            display: none;
        }
    }
    @media print {
        html {
            column-width: auto !important;
            height: auto !important;
            width: auto !important;
        }
    }
    html {
        line-height: ${lineHeight};
        hanging-punctuation: allow-end last;
        orphans: 2;
        widows: 2;
    }
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }
    :is(hgroup, header) p {
        text-align: unset;
        hyphens: unset;
    }
    h1, h2, h3, h4, h5, h6, hgroup, th {
        text-wrap: balance;
    }
    pre {
        white-space: pre-wrap !important;
        tab-size: 2;
    }
`, `
    @media screen {
        ${isWhite ? '' : `
        html, body {
            color: ${colors.fg} !important;
            background: none !important;
        }
        body * {
            color: inherit !important;
            border-color: currentColor !important;
            background-color: ${colors.bg} !important;
        }
        a:any-link {
            color: ${colors.link} !important;
        }
        ${dark && !inverted ? '' : `
        svg, img {
            background-color: transparent !important;
            mix-blend-mode: multiply;
        }`}
        .${active}, .${active} * {
            color: ${colors.fg} !important;
            background: color-mix(in hsl, ${colors.fg}, ${colors.bg} ${dark ? 75 : 85}%) !important;
        }`}
    }
    p, li, blockquote, dd {
        line-height: ${lineHeight};
        text-align: ${justify ? 'justify' : 'start'};
        hyphens: ${hyphenate ? 'auto' : 'manual'};
        -webkit-hyphens: ${hyphenate ? 'auto' : 'manual'};
    }
    ${fontStacks[fontFamily] ? `
    body, body *:not(pre, code, kbd, samp, tt, pre *, code *) {
        font-family: ${fontStacks[fontFamily]} !important;
    }` : ''}
`]
}

// --- Positioning helpers (from Foliate) ------------------------------------

const frameRect = (frame, rect, sx = 1, sy = 1) => {
    const left = sx * rect.left + frame.left
    const right = sx * rect.right + frame.left
    const top = sy * rect.top + frame.top
    const bottom = sy * rect.bottom + frame.top
    return { left, right, top, bottom }
}

const pointIsInView = ({ x, y }) =>
    x > 0 && y > 0 && x < window.innerWidth && y < window.innerHeight

const getPosition = target => {
    const frameElement = (target.getRootNode?.() ?? target?.endContainer?.getRootNode?.())
        ?.defaultView?.frameElement

    const transform = frameElement ? getComputedStyle(frameElement).transform : ''
    const match = transform.match(/matrix\((.+)\)/)
    const [sx, , , sy] = match?.[1]?.split(/\s*,\s*/)?.map(x => parseFloat(x)) ?? []

    const frame = frameElement?.getBoundingClientRect() ?? { top: 0, left: 0 }
    const rects = Array.from(target.getClientRects())
    if (!rects.length) return { point: { x: window.innerWidth / 2, y: window.innerHeight / 2 }, dir: 'down' }
    const first = frameRect(frame, rects[0], sx, sy)
    const last = frameRect(frame, rects.at(-1), sx, sy)
    const start = { point: { x: (first.left + first.right) / 2, y: first.top }, dir: 'up' }
    const end = { point: { x: (last.left + last.right) / 2, y: last.bottom }, dir: 'down' }
    const startInView = pointIsInView(start.point)
    const endInView = pointIsInView(end.point)
    if (!startInView && !endInView) return { point: { x: window.innerWidth / 2, y: 80 }, dir: 'down' }
    if (!startInView) return end
    if (!endInView) return start
    return start.point.y > window.innerHeight - end.point.y ? start : end
}

const positionToRect = ({ point: { x, y } }) => ({ left: x, right: x, top: y, bottom: y })

const minuteFormat = new Intl.NumberFormat(navigator.language || 'en', { style: 'unit', unit: 'minute', unitDisplay: 'short' })
const hourFormat = new Intl.NumberFormat(navigator.language || 'en', { style: 'unit', unit: 'hour', unitDisplay: 'short', maximumFractionDigits: 1 })
const formatMinutes = minutes => minutes < 1 ? '< ' + minuteFormat.format(1)
    : minutes < 60 ? minuteFormat.format(Math.round(minutes))
        : hourFormat.format(Math.round(minutes / 6) / 10)

const mixColors = (a, b, amount) => {
    const parse = hex => {
        const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16)
        return [n >> 16 & 255, n >> 8 & 255, n & 255]
    }
    const [x, y] = [parse(a), parse(b)]
    return '#' + x.map((v, i) => Math.round(v * amount + y[i] * (1 - amount))
        .toString(16).padStart(2, '0')).join('')
}

const isLightColor = hex => {
    const n = parseInt(String(hex).replace('#', '').slice(0, 6), 16)
    if (isNaN(n)) return true
    const r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255
    return 0.299 * r + 0.587 * g + 0.114 * b > 150
}

const getSelectionRange = sel => {
    if (!sel?.rangeCount) return
    const range = sel.getRangeAt(0)
    if (range.collapsed) return
    return range
}

const getLang = el => {
    const lang = el?.lang || el?.getAttributeNS?.('http://www.w3.org/XML/1998/namespace', 'lang')
    if (lang) return lang
    if (el?.parentElement) return getLang(el.parentElement)
}

const blobToDataURL = blob => new Promise(resolve => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(reader.result)
    reader.readAsDataURL(blob)
})

// --- Annotation export (formats from Foliate) ------------------------------

const htmlEscape = str => String(str ?? '').replace(/[<>&"]/g, x =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[x])
const mdEscape = str => String(str ?? '').replace(/[<>&]/g, x => '\\' + x)

const exportFormats = {
    json: ({ metadata, annotations, bookmarks }) =>
        JSON.stringify({ metadata, annotations, bookmarks }, null, 2),
    html: ({ annotations }, title) => `<!DOCTYPE html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>
    body { max-width: 36em; padding: 1em; margin: auto; font-family: system-ui, sans-serif; }
    header { text-align: center; }
    section { border-top: 1px solid; }
    .cfi { font-size: small; opacity: 0.5; font-family: monospace; }
    blockquote { margin-inline-start: 0; padding-inline-start: 1em; border-inline-start: .5em solid; }
    .underline { text-decoration: underline red; }
    .squiggly { text-decoration: underline wavy red; }
    .strikethrough { text-decoration: line-through red; }
    .note { white-space: pre-wrap; }
</style>
<header><h1>${htmlEscape(title)}</h1><p>${annotations.length}</p></header>${
    annotations.map(({ value, text, color, note }) => `<section>
    <p class="cfi">${htmlEscape(value)}</p>
    <blockquote style="border-color: ${htmlEscape(color)}">
        <span class="${htmlEscape(color)}">${htmlEscape(text)}</span>
    </blockquote>
    ${note ? `<p class="note">${htmlEscape(note)}</p>` : ''}
</section>`).join('')}`,
    md: ({ annotations }, title) => `# ${title}\n\n${annotations.map(({ value, text, color, note }) => `
---

**${color}** - \`${value}\`

> ${mdEscape(text).replace(/\n/g, '\n> ')}${note ? '\n\n' + mdEscape(note) : ''}
`).join('')}`,
}

// --- Highlight colors -------------------------------------------------------

const highlightColors = [
    ['yellow', 'Yellow'], ['orange', 'Orange'], ['red', 'Red'], ['magenta', 'Magenta'],
    ['aqua', 'Aqua'], ['lime', 'Lime'],
    ['underline', 'Underline'], ['squiggly', 'Squiggly'], ['strikethrough', 'Strikethrough'],
]

const referenceLabels = {
    'footnote': ['Footnote', 'Go to Footnote'],
    'endnote': ['Endnote', 'Go to Endnote'],
    'note': ['Reference', 'Go to Reference'],
}

// --- Reader -----------------------------------------------------------------

class Reader {
    path = new URLSearchParams(location.search).get('path')
    key = null
    data = {}
    book = null
    view = null
    location = null
    annotations = new Map() // value -> annotation
    annotationInfo = new Map() // value -> { index, label }
    #footnoteHandler = new FootnoteHandler()
    #tocView = null
    #lastColor = 'yellow'
    #currentAnnotation = null
    #currentSelection = null
    #speech = null
    #searchToken = 0
    #annotationTapAt = 0
    #chromeVisible = !isMobile
    #closeSidebar = () => this.toggleSidebar(false)

    // Phones can leave the page at any moment (back button, app switch),
    // so write sooner there
    save = debounce(() => {
        if (this.key) api.setData(this.key, this.data).catch(e => console.error(e))
    }, isMobile ? 150 : 600)

    async open() {
        const name = fileName(this.path ?? '')
        document.title = name
        try {
            const { path, book } = await earlyBook
            if (path && path !== this.path) {
                this.path = path
                history.replaceState(history.state, '', `reader.html?path=${encodeURIComponent(path)}`)
            }
            this.book = book
        } catch (e) {
            console.error(e)
            const message = e instanceof UnsupportedTypeError ? t('File type not supported')
                : e instanceof NotFoundError ? t('File not found')
                    : (e?.message ?? String(e))
            return this.showError(t('Could not open “%s”', name), message)
        }
        const { book } = this
        book.transformTarget?.addEventListener('data', ({ detail }) => {
            detail.data = Promise.resolve(detail.data).catch(e => {
                console.error(new Error(`Failed to load ${detail.name}`, { cause: e }))
                return ''
            })
        })

        this.key = await ensureIdentifier(book, this.path)
        this.data = (await api.getData(this.key)) ?? {}
        this.data.metadata = plainMetadata(book.metadata)
        this.data.lastOpened = new Date().toISOString()
        this.data.annotations ??= []
        this.data.bookmarks ??= []
        // Saving does not need to hold up opening the book
        const { key, path } = this
        api.setData(key, this.data).catch(e => console.error(e))
        api.setURI(key, path).catch(e => console.error(e))
        api.coverExists(key).then(exists => exists || saveCover(key, book)).catch(() => {})

        const title = formatLanguageMap(book.metadata?.title) || name
        document.title = title
        appWindow.setTitle(title).catch(() => {})
        $('#title').textContent = title
        $('#book-title').textContent = title
        $('#book-author').textContent = formatAuthors(book.metadata?.author)
        Promise.resolve(book.getCover?.()).then(blob => {
            if (!blob) return
            const img = $('#book-cover')
            img.src = URL.createObjectURL(blob)
            img.hidden = false
        }).catch(() => {})

        this.pageTotal = book.pageList?.findLast(x => !isNaN(parseInt(x.label)))?.label

        this.view = document.createElement('foliate-view')
        this.#handleEvents()
        await this.view.open(book)
        $('#viewer').append(this.view)
        $('#loading').hidden = true
        document.body.classList.toggle('fixed-layout', !!this.view.isFixedLayout)

        this.applyAppearance()
        this.#setupFootnotes()
        this.#buildTOC()
        this.#buildTicks()

        await this.view.init({
            lastLocation: this.data.lastLocation,
            showTextStart: !this.data.lastLocation,
        })

        this.view.focus()
        performance.mark('book-ready')
        // Annotations and bookmarks come in once the page is showing
        Promise.all(this.data.annotations.map(a => this.#addAnnotation(a, false)))
            .then(() => this.renderAnnotations())
        this.renderBookmarks()
    }

    showError(title, message) {
        $('#loading').hidden = true
        $('#error').hidden = false
        $('#error-title').textContent = title
        $('#error-message').textContent = message
        $('#navbar').hidden = true
        $('#mini-progress').hidden = true
        for (const b of $$('#headerbar button'))
            if (b.id !== 'sidebar-button' && b.id !== 'library-button') b.disabled = true
        this.setChrome(true)
    }

    // --- Appearance ---

    get theme() {
        return themes.find(x => x.name === prefs.theme) ?? themes[0]
    }

    get isDark() {
        return prefs.colorScheme === 'dark' || (prefs.colorScheme === 'system' && darkQuery.matches)
    }

    applyAppearance() {
        // font and layout changes change how much text fits on a page
        this.#pageDensity.clear()
        applyColorScheme(prefs.colorScheme)
        appWindow.setTheme(prefs.colorScheme === 'system' ? null : prefs.colorScheme).catch(() => {})
        const theme = this.theme
        const colors = this.isDark ? theme.dark : theme.light
        const root = document.documentElement.style
        const inverted = this.isDark && prefs.invert
        root.setProperty('--book-bg', inverted ? invertColor(theme.light.bg) : colors.bg)
        root.setProperty('--book-fg', inverted ? invertColor(theme.light.fg) : colors.fg)
        root.setProperty('--book-link', colors.link)
        document.body.classList.toggle('invert', prefs.invert && this.isDark)
        document.body.classList.toggle('dark', this.isDark)
        // Read-aloud marker: the theme's accent leaning toward its text color,
        // so it matches every theme; stronger on dark pages, where it lightens
        const palette = this.isDark && !prefs.invert ? theme.dark : theme.light
        root.setProperty('--tts-marker', mixColors(palette.link, palette.fg, 0.7))
        root.setProperty('--tts-marker-opacity', this.isDark && !prefs.invert ? '0.4' : '0.3')
        if (isAndroid) {
            android.setSystemBars(isLightColor(getComputedStyle(document.documentElement)
                .getPropertyValue('--book-bg').trim()))
            this.syncVolumeKeys()
            android.setBrightness(prefs.brightness)
        }

        const renderer = this.view?.renderer
        if (renderer) {
            if (this.view.isFixedLayout) {
                renderer.setAttribute('zoom', prefs.zoom === 1 ? 'fit-page' : prefs.zoom)
            } else {
                renderer.setAttribute('flow', prefs.flow)
                renderer.setAttribute('gap', prefs.gap * 100 + '%')
                renderer.setAttribute('margin', isMobile ? '36px' : '48px')
                renderer.setAttribute('max-inline-size', prefs.maxInlineSize + 'px')
                renderer.setAttribute('max-block-size', '1440px')
                renderer.setAttribute('max-column-count', prefs.maxColumnCount)
                if (prefs.animated) renderer.setAttribute('animated', '')
                else renderer.removeAttribute('animated')
                renderer.setStyles?.(getCSS(this.style))
            }
        }
        this.#syncSettingsUI()
    }

    // Re-render the position labels (e.g. after the numbering mode changed)
    clearPageDensity() {
        this.#pageDensity.clear()
    }

    refreshLocation() {
        if (this.location) this.#onRelocate(this.location)
    }

    get style() {
        return {
            lineHeight: prefs.lineHeight,
            justify: prefs.justify,
            hyphenate: prefs.hyphenate,
            invert: prefs.invert,
            theme: this.theme,
            fontSize: prefs.fontSize,
            fontFamily: prefs.fontFamily,
            mediaActiveClass: this.book?.media?.activeClass ?? 'foliate-media-active',
            dark: this.isDark,
        }
    }

    setPref(key, value) {
        prefs[key] = value
        savePrefs(prefs)
        this.applyAppearance()
    }

    #syncSettingsUI() {
        for (const b of $$('#scheme-buttons button'))
            b.setAttribute('aria-pressed', b.dataset.scheme === prefs.colorScheme)
        for (const b of $$('#flow-buttons button'))
            b.setAttribute('aria-pressed', b.dataset.flow === prefs.flow)
        for (const b of $$('#page-number-buttons button'))
            b.setAttribute('aria-pressed', b.dataset.pages === prefs.pageNumbers)
        for (const b of $$('#column-buttons button'))
            b.setAttribute('aria-pressed', +b.dataset.columns === prefs.maxColumnCount)
        for (const b of $$('#theme-list button'))
            b.setAttribute('aria-pressed', b.dataset.theme === prefs.theme)
        $('#font-size-value').textContent = prefs.fontSize
        $('#zoom-value').textContent = percentFormat.format(prefs.zoom)
        $('#font-family').value = prefs.fontFamily
        $('#line-height').value = prefs.lineHeight
        $('#gap').value = prefs.gap
        $('#max-inline-size').value = prefs.maxInlineSize
        $('#justify').checked = prefs.justify
        $('#hyphenate').checked = prefs.hyphenate
        $('#animated').checked = prefs.animated
        $('#invert').checked = prefs.invert
        $('#volume-keys').checked = prefs.volumeKeys !== false
        const systemBrightness = !(prefs.brightness >= 0)
        $('#brightness-system').checked = systemBrightness
        $('#brightness').disabled = systemBrightness
        if (!systemBrightness) $('#brightness').value = prefs.brightness
    }

    // --- Events from the view ---

    #handleEvents() {
        const view = this.view
        view.addEventListener('relocate', e => this.#onRelocate(e.detail))
        view.addEventListener('load', e => this.#onLoad(e.detail))
        view.addEventListener('create-overlay', e => {
            const { index } = e.detail
            for (const [value, info] of this.annotationInfo)
                if (info.index === index) view.addAnnotation(this.annotations.get(value))
        })
        view.addEventListener('draw-annotation', e => {
            const { draw, annotation, doc, range } = e.detail
            const { color } = annotation
            if (['underline', 'squiggly', 'strikethrough'].includes(color)) {
                const node = range.startContainer
                const elem = node.nodeType === 1 ? node : node.parentElement
                const { writingMode } = doc.defaultView.getComputedStyle(elem)
                draw(Overlayer[color], { writingMode })
            }
            else draw(Overlayer.highlight, { color })
        })
        view.addEventListener('show-annotation', e => {
            this.#annotationTapAt = Date.now()
            const { value, range } = e.detail
            const annotation = this.annotations.get(value)
            if (annotation) this.showAnnotationMenu(annotation, getPosition(range))
        })
        view.addEventListener('external-link', e => {
            e.preventDefault()
            const { href } = e.detail
            if (/^(https?|mailto):/i.test(href)) api.openURL(href)
        })
        view.addEventListener('link', e =>
            this.#footnoteHandler.handle(this.book, e)?.catch(err => {
                console.warn(err)
                view.goTo(e.detail.href)
            }))
        view.history.addEventListener('index-change', e => {
            $('#back-button').disabled = !e.target.canGoBack
            $('#forward-button').disabled = !e.target.canGoForward
        })
    }

    #onRelocate(detail) {
        this.location = detail
        const { fraction, tocItem, cfi, time } = detail
        // While the view has no size yet (starting up, hidden, rotating) the
        // position comes without numbers; keep the last labels then
        const location = Number.isFinite(detail.location?.current) ? detail.location : null
        // Screen pages replace the book's numbering when chosen
        const screen = prefs.pageNumbers === 'screen' ? this.#screenPages(detail) : null
        const pageItem = screen ? null : detail.pageItem
        const { heads, feet } = this.view.renderer
        const locText = (a, b) => t('Loc %s of %s', a, b)
        const pageText = label => this.pageTotal
            ? t('Page %s of %s', label, this.pageTotal) : t('Page %s', label)
        // Margins: chapter on top (book title too on spreads), position as
        // plain numbers at the bottom ("5 / 51")
        const chapter = tocItem?.label ?? ''
        const title = formatLanguageMap(this.book.metadata?.title)
        const numbers = (a, b) => b ? `${a} / ${b}` : `${a}`
        if (heads?.length) {
            heads.at(-1).innerText = chapter
            if (heads.length > 1) heads[0].innerText = title
        }
        if (feet?.length && screen) {
            // a spread shows several columns: number them like book pages
            const columns = feet.length
            const first = (screen.current - 1) * columns + 1
            feet.forEach((foot, i) => foot.innerText = numbers(first + i, screen.total * columns))
        } else if (feet?.length && location) {
            const { current, next, total } = location
            if (pageItem) {
                feet.at(-1).innerText = numbers(pageItem.label, this.pageTotal)
                if (feet.length > 1) feet[0].innerText = numbers(current + 1, total)
            } else {
                feet[0].innerText = numbers(current + 1, total)
                if (feet.length > 1) {
                    const r = 1 - 1 / feet.length
                    const end = Math.floor((1 - r) * current + r * next)
                    feet.at(-1).innerText = numbers(end + 1, total)
                }
            }
        }

        // Some intermediate relocations (mid-layout) carry no valid progress
        if (Number.isFinite(fraction)) {
            $('#progress-fill').style.width = `${fraction * 100}%`
            $('#mini-fill').style.width = `${fraction * 100}%`
            $('#percent-label').textContent = percentFormat.format(fraction)
        }
        const locationLabel = $('#location-label')
        const columns = Math.max(1, this.view.renderer.feet?.length ?? 1)
        const locationText = screen ? numbers((screen.current - 1) * columns + 1, screen.total * columns)
            : pageItem ? numbers(pageItem.label, this.pageTotal)
                : location ? numbers(location.current + 1, location.total) : ''
        if (locationText) {
            locationLabel.textContent = locationText
            locationLabel.title = pageItem ? pageText(pageItem.label)
                : location ? locText(location.current + 1, location.total) : ''
        }
        if (tocItem?.href) this.#tocView?.setCurrentHref?.(tocItem.href)
        const sectionTime = Number.isFinite(time?.section) ? time.section : null
        const totalTime = Number.isFinite(time?.total) ? time.total : null
        const chapterLeft = sectionTime != null ? t('%s left in chapter', formatMinutes(sectionTime)) : ''
        const bookLeft = totalTime != null ? t('%s left in book', formatMinutes(totalTime)) : ''
        setMarquee($('#subtitle'), [tocItem?.label,
            sectionTime != null ? t('%s left', formatMinutes(sectionTime)) : ''].filter(Boolean).join(' · '))
        setMarquee($('#time-label'), chapterLeft)
        $('#time-label').title = bookLeft
        $('#progress-button').title = [Number.isFinite(fraction) ? percentFormat.format(fraction) : '', bookLeft]
            .filter(Boolean).join(' · ')

        this.data.lastLocation = cfi
        if (Number.isFinite(location?.current) && location.total) this.data.progress = [location.current, location.total]
        // the library shows exactly the percentage seen here
        if (Number.isFinite(fraction)) this.data.fraction = fraction
        this.save()
        this.#updateBookmarkButton()
    }

    // Pages as laid out on this screen: the current section is counted
    // exactly, the rest of the book is estimated from the text per page
    // measured so far (it changes with font size and window size)
    #pageDensity = new Map() // section index -> characters per screen page
    #screenPages(detail) {
        const renderer = this.view?.renderer
        if (!renderer || this.view.isFixedLayout || prefs.flow !== 'paginated') return null
        const index = detail.section?.current
        const pages = (renderer.pages ?? 0) - 2 // without the blank pages at both ends
        const sizes = this.book.sections.map(s => s.linear === 'no' ? 0 : (s.size ?? 0))
        if (index == null || !(pages > 0) || !sizes[index]) return null
        this.#pageDensity.set(index, sizes[index] / pages)
        const densities = [...this.#pageDensity.values()]
        const density = densities.reduce((a, b) => a + b, 0) / densities.length
        const before = sizes.slice(0, index).reduce((a, b) => a + b, 0)
        const after = sizes.slice(index + 1).reduce((a, b) => a + b, 0)
        const page = Math.min(Math.max(renderer.page ?? 1, 1), pages)
        const current = Math.round(before / density) + page
        const total = Math.round(before / density) + pages + Math.round(after / density)
        return { current, total: Math.max(current, total) }
    }

    #onLoad({ doc, index }) {
        doc.addEventListener('keydown', e => this.handleKeydown(e))
        doc.addEventListener('wheel', e => this.handleWheel(e), { passive: false })
        doc.addEventListener('pointerdown', () => closePopover())
        // While reading aloud, swipes do not turn pages
        for (const type of ['touchstart', 'touchmove', 'touchend']) doc.addEventListener(type, e => {
            if (!this.isSpeaking) return
            e.stopImmediatePropagation()
            if (type === 'touchmove') {
                e.preventDefault()
                this.notifySpeaking()
            }
        }, { capture: true, passive: false })

        for (const img of doc.querySelectorAll('img')) img.addEventListener('dblclick', () =>
            fetch(img.src).then(res => res.blob()).then(blobToDataURL).then(url => {
                $('#image-view').src = url
                showDialog($('#image-dialog'))
            }).catch(e => console.error(e)))

        const checkSelection = () => {
            const sel = doc.getSelection()
            const range = getSelectionRange(sel)
            if (!range) return
            const text = sel.toString()
            if (!text.trim()) return
            const value = this.view.getCFI(index, range)
            const lang = getLang(range.commonAncestorContainer)
            this.showSelectionMenu({ index, range, value, text, lang })
        }
        // wait for the selection to settle
        doc.addEventListener('pointerup', () => setTimeout(checkSelection, 10))

        if (isMobile) {
            // Touch selection is adjusted with handles that send no pointer
            // events to the page, so follow the selection itself
            doc.addEventListener('selectionchange', debounce(checkSelection, 350))
            doc.addEventListener('click', e => {
                if (e.defaultPrevented || e.target.closest?.('a[href], button, input, select, textarea')) return
                if (doc.getSelection()?.toString()) return
                // map the tap from the (possibly scaled) iframe to the window
                const frame = doc.defaultView.frameElement
                const rect = frame.getBoundingClientRect()
                const scale = rect.width / (frame.offsetWidth || rect.width)
                const x = rect.left + e.clientX * scale
                setTimeout(() => this.handleTap(x), 0)
            })
        }
    }

    // Phones: tap the left or right edge to turn pages, the middle for menus
    handleTap(x) {
        if (Date.now() - this.#annotationTapAt < 400) return
        if (document.querySelector('.popover:not([hidden])')) return closePopover()
        if (this.#chromeVisible) return this.setChrome(false)
        const w = window.innerWidth
        const edge = x < w * 0.28 ? 'left' : x > w * 0.72 ? 'right' : null
        if (!edge) return this.setChrome(true)
        if (this.isSpeaking) return this.notifySpeaking()
        if (edge === 'left') this.view.goLeft()
        else this.view.goRight()
    }

    // --- Reading aloud drives the pages ---

    get isSpeaking() {
        return this.#speech?.state === 'playing'
    }

    #speakingNoticeAt = 0
    notifySpeaking() {
        const now = Date.now()
        if (now - this.#speakingNoticeAt < 4000) return
        this.#speakingNoticeAt = now
        toast(t('Pages turn by themselves while reading aloud'))
    }

    // Explicit jumps (contents, search, Go to Location…) keep reading aloud
    // from the new place
    async navigate(go) {
        const speaking = this.isSpeaking
        if (speaking) this.#speech.pause()
        try {
            await go()
        } catch (e) {
            console.error(e)
        }
        if (speaking) this.#speech.start()
    }

    syncVolumeKeys() {
        // Volume keys control the volume while reading aloud
        if (isAndroid) android.setVolumeKeys(prefs.volumeKeys !== false && !this.isSpeaking)
    }

    setChrome(visible) {
        if (!isMobile) return
        this.#chromeVisible = visible
        document.body.classList.toggle('chrome-hidden', !visible)
        if (isAndroid) android.setImmersive(!visible)
        if (!visible) closePopover()
    }

    // --- Navigation helpers ---

    #wheel = { delta: 0, last: 0, turned: false, swiping: false, vx: 0, timer: null, ignoreUntil: 0 }
    handleWheel(e) {
        const view = this.view
        if (!view || e.ctrlKey) return
        if (this.isSpeaking) {
            e.preventDefault()
            return this.notifySpeaking()
        }
        const fixed = view.isFixedLayout
        if (!fixed && prefs.flow !== 'paginated') return
        if (fixed && prefs.zoom !== 1) return
        e.preventDefault()
        const w = this.#wheel
        const now = e.timeStamp || performance.now()
        const gap = now - w.last
        w.last = now
        const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY)
        const renderer = view.renderer

        // Trackpad swipe: the page follows the fingers, then snaps by velocity
        if (horizontal && !fixed && renderer.scrollBy && renderer.snap) {
            if (now < w.ignoreUntil) return // momentum tail after a snap
            if (!w.swiping && renderer.isAnimating) return
            w.swiping = true
            const dt = Math.max(1, Math.min(gap, 50))
            w.vx = 0.6 * w.vx + 0.4 * (e.deltaX / dt)
            renderer.scrollBy(e.deltaX, 0)
            clearTimeout(w.timer)
            w.timer = setTimeout(() => {
                w.swiping = false
                renderer.snap(w.vx, 0)
                w.vx = 0
                w.ignoreUntil = performance.now() + 250
            }, 90)
            return
        }

        // Mouse wheel or vertical scroll: one gesture turns one page
        if (gap > 180) {
            w.delta = 0
            w.turned = false
        }
        if (w.turned) return
        const delta = horizontal ? e.deltaX : e.deltaY
        w.delta += e.deltaMode === 1 ? delta * 16 : delta
        if (Math.abs(w.delta) < 30) return
        w.turned = true
        if (w.delta > 0) view.next()
        else view.prev()
    }

    handleKeydown(e) {
        const target = e.target
        if (target?.closest?.('input, textarea, select, [contenteditable]')
            && !(target.type === 'range' || target.type === 'checkbox')) return
        const mod = isMac ? e.metaKey : e.ctrlKey
        const k = e.key
        const view = this.view
        if (k === 'Escape') {
            if (isPopoverOpen($('#selection-menu')) || isPopoverOpen($('#annotation-menu'))
                || document.querySelector('.popover:not([hidden])')) return closePopover()
            appWindow.isFullscreen().then(f => f ? this.toggleFullscreen(false) : null)
            return
        }
        if (mod && k === 'f') { e.preventDefault(); return this.openSearch() }
        if (mod && k === 'd') { e.preventDefault(); return this.toggleBookmark() }
        if (mod && (k === '=' || k === '+')) { e.preventDefault(); return this.zoomText(1) }
        if (mod && k === '-') { e.preventDefault(); return this.zoomText(-1) }
        if (mod && k === '0') { e.preventDefault(); return this.zoomText(0) }
        if (mod && k === 'l') { e.preventDefault(); return api.showLibrary() }
        if (mod && k === 'i') { e.preventDefault(); return this.showInfo() }
        if (mod && k === 'g') { e.preventDefault(); return this.openJump($('#progress-button').getBoundingClientRect()) }
        if (mod && k === 'o' && !isMobile) {
            e.preventDefault()
            return pickBooks().then(paths => paths.forEach(path => api.openReader(path)))
        }
        if (mod && k === 'w' && !isMobile) { e.preventDefault(); return appWindow.close() }
        if (k === 'F11' || (isMac && e.metaKey && e.ctrlKey && k === 'f')) {
            e.preventDefault()
            return this.toggleFullscreen()
        }
        if (k === 'F9' || (mod && e.shiftKey && k.toLowerCase() === 's')) {
            e.preventDefault()
            return this.toggleSidebar()
        }
        if ((e.altKey && k === 'ArrowLeft') || (mod && k === '[')) { e.preventDefault(); return view?.history.back() }
        if ((e.altKey && k === 'ArrowRight') || (mod && k === ']')) { e.preventDefault(); return view?.history.forward() }
        if (!view || mod || e.altKey) return
        if (target?.type === 'range') return
        if (this.isSpeaking && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'h', 'j', 'k', 'l',
            'PageUp', 'PageDown', ' ', 'Home', 'End'].includes(k)) {
            e.preventDefault()
            return this.notifySpeaking()
        }
        switch (k) {
            case 'ArrowLeft': case 'h': e.preventDefault(); view.goLeft(); break
            case 'ArrowRight': case 'l': e.preventDefault(); view.goRight(); break
            case 'ArrowUp': case 'k':
                if (prefs.flow === 'paginated' || view.isFixedLayout) { e.preventDefault(); view.prev() }
                break
            case 'ArrowDown': case 'j':
                if (prefs.flow === 'paginated' || view.isFixedLayout) { e.preventDefault(); view.next() }
                break
            case 'PageUp': e.preventDefault(); view.prev(); break
            case 'PageDown': e.preventDefault(); view.next(); break
            case ' ': e.preventDefault(); e.shiftKey ? view.prev() : view.next(); break
            case 'Home': e.preventDefault(); view.renderer.firstSection?.(); break
            case 'End': e.preventDefault(); view.renderer.lastSection?.(); break
        }
    }

    zoomText(dir) {
        if (this.view?.isFixedLayout) {
            const steps = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
            const i = steps.indexOf(prefs.zoom)
            const next = dir === 0 ? 1 : steps[Math.max(0, Math.min(steps.length - 1, (i < 0 ? 2 : i) + dir))]
            return this.setPref('zoom', next)
        }
        const size = dir === 0 ? 16 : Math.max(10, Math.min(40, prefs.fontSize + dir))
        this.setPref('fontSize', size)
    }

    async toggleFullscreen(force) {
        const isFull = await appWindow.isFullscreen()
        const next = force ?? !isFull
        await appWindow.setFullscreen(next)
        document.body.classList.toggle('fullscreen', next)
    }

    toggleSidebar(force) {
        const app = $('#app')
        const wasCollapsed = app.classList.contains('sidebar-collapsed')
        const collapsed = force != null ? !force : !wasCollapsed
        app.classList.toggle('sidebar-collapsed', collapsed)
        $('#sidebar-button').setAttribute('aria-pressed', !collapsed)
        if (isMobile) {
            if (wasCollapsed && !collapsed) {
                closePopover()
                pushOverlay(this.#closeSidebar)
            } else if (!wasCollapsed && collapsed) popOverlay(this.#closeSidebar)
            return
        }
        if (window.innerWidth > 760) {
            prefs.sidebarOpen = !collapsed
            savePrefs(prefs)
        }
    }

    closeDrawerOnPhone() {
        if (isMobile || window.innerWidth <= 760) this.toggleSidebar(false)
    }

    showPanel(name, reveal = true) {
        for (const b of $$('.sidebar-tabs button'))
            b.setAttribute('aria-selected', b.dataset.panel === name)
        for (const p of $$('.panel')) p.hidden = p.dataset.panel !== name
        if (reveal) this.toggleSidebar(true)
    }

    openSearch(query) {
        this.showPanel('search')
        const input = $('#search-input')
        if (query != null) {
            input.value = query
            this.search(query)
        }
        input.focus()
        input.select()
    }

    // --- Table of contents and ticks ---

    #buildTOC() {
        const toc = this.book.toc
        if (!toc?.length) return
        this.#tocView = createTOC(toc, {
            onNavigate: href => {
                this.navigate(() => this.view.goTo(href))
                this.closeDrawerOnPhone()
            },
        })
        $('#toc-view').replaceChildren(this.#tocView.element)
    }

    #buildTicks() {
        const list = $('#tick-marks')
        list.replaceChildren()
        $('#progress-ticks').replaceChildren()
        $('#mini-ticks').replaceChildren()
        const dir = this.book.dir === 'rtl' ? 'rtl' : 'ltr'
        $('#jump-slider').dir = dir
        $('#progress-button').dir = dir
        if (this.view.isFixedLayout) return
        const fractions = this.view.getSectionFractions()
        for (const fraction of fractions) list.append(el('option', { value: fraction }))
        // chapter marks on the progress bar, unless there are too many to read
        const ticks = () => fractions.slice(1, -1)
            .map(f => el('span', { class: 'tick', style: `inset-inline-start: ${f * 100}%` }))
        if (fractions.length <= 60) {
            $('#progress-ticks').append(...ticks())
            $('#mini-ticks').append(...ticks())
        }
        $('#mini-progress').dir = dir
    }

    // --- Go to location ---

    // Chapter labels by section index, for previews while choosing a place
    #sectionLabels = null
    #sectionLabel(index) {
        if (!this.#sectionLabels) {
            this.#sectionLabels = []
            const walk = items => {
                for (const item of items ?? []) {
                    try {
                        const i = this.view.resolveNavigation(item.href)?.index
                        if (i != null && this.#sectionLabels[i] == null) this.#sectionLabels[i] = item.label
                    } catch {
                        // ignore entries that do not resolve
                    }
                    walk(item.subitems)
                }
            }
            walk(this.book.toc)
        }
        for (let i = index; i >= 0; i--)
            if (this.#sectionLabels[i] != null) return this.#sectionLabels[i]
        return ''
    }

    previewJump(fraction) {
        const fractions = this.view.getSectionFractions()
        let index = 0
        while (index < fractions.length - 2 && fractions[index + 1] <= fraction) index++
        $('#jump-chapter').textContent = this.#sectionLabel(index)
        const total = this.location?.location?.total
        $('#jump-position').textContent = [
            total ? t('Loc %s of %s', Math.min(total, Math.floor(fraction * total) + 1), total) : '',
            percentFormat.format(fraction),
        ].filter(Boolean).join(' · ')
    }

    openJump(anchor) {
        if (!this.view) return
        const slider = $('#jump-slider')
        slider.value = this.location?.fraction ?? 0
        this.previewJump(parseFloat(slider.value))
        showPopover($('#jump-menu'), anchor, { prefer: 'above' })
        if (!isMobile) slider.focus()
    }

    jump() {
        const fraction = parseFloat($('#jump-slider').value)
        closePopover()
        this.navigate(() => this.view?.goToFraction(fraction))
    }

    // --- Footnotes ---

    #setupFootnotes() {
        const dialog = $('#footnote-dialog')
        dialog.addEventListener('close', () => {
            const view = dialog.querySelector('foliate-view')
            view?.close()
            view?.remove()
            if (dialog.returnValue === 'go')
                this.view.goTo(dialog.querySelector('[name="href"]').value)
            dialog.returnValue = ''
        })
        dialog.addEventListener('click', e => e.target === dialog ? dialog.close() : null)

        this.#footnoteHandler.addEventListener('before-render', e => {
            const { view } = e.detail
            view.addEventListener('link', e => {
                e.preventDefault()
                this.view.goTo(e.detail.href)
                dialog.close()
            })
            view.addEventListener('external-link', e => {
                e.preventDefault()
                if (/^(https?|mailto):/i.test(e.detail.href)) api.openURL(e.detail.href)
            })
            dialog.querySelector('main').replaceChildren(view)
            const { renderer } = view
            renderer.setAttribute('flow', 'scrolled')
            renderer.setAttribute('margin', '12px')
            renderer.setAttribute('gap', '5%')
            renderer.setStyles(getCSS(this.style))
        })
        this.#footnoteHandler.addEventListener('render', e => {
            const { href, hidden, type } = e.detail
            const [label, goLabel] = referenceLabels[type] ?? referenceLabels.footnote
            dialog.querySelector('[name="href"]').value = href
            const go = dialog.querySelector('[value="go"]')
            go.hidden = hidden
            go.textContent = t(goLabel)
            dialog.querySelector('header').textContent = t(label)
            showDialog(dialog)
        })
    }

    // --- Selection ---

    showSelectionMenu(selection) {
        this.#currentSelection = selection
        const pos = getPosition(selection.range)
        const menu = $('#selection-menu')
        menu.querySelector('[data-action="speak"]').hidden = !!this.view.isFixedLayout
        showPopover(menu, positionToRect(pos), { prefer: pos.dir === 'up' ? 'above' : 'below' })
    }

    async onSelectionAction(action) {
        const sel = this.#currentSelection
        if (!sel) return
        closePopover()
        const { range, value, text, lang } = sel
        switch (action) {
            case 'copy':
                await navigator.clipboard.writeText(text).catch(e => console.error(e))
                break
            case 'highlight':
            case 'note': {
                const annotation = {
                    value, color: this.#lastColor, text, note: '',
                    created: new Date().toISOString(),
                }
                await this.#addAnnotation(annotation)
                range.startContainer.ownerDocument.getSelection()?.removeAllRanges()
                this.showAnnotationMenu(annotation, getPosition(range), action === 'note')
                break
            }
            case 'search':
                this.openSearch(text.trim().slice(0, 200))
                break
            case 'speak':
                this.speech.fromRange(range)
                break
            case 'lookup': {
                const l = (lang || this.view.language?.canonical || 'en').split('-')[0]
                api.openURL(`https://${encodeURIComponent(l)}.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(text.trim())}`)
                break
            }
            case 'translate': {
                const target = (navigator.language || 'en').split('-')[0]
                api.openURL(`https://translate.google.com/?sl=auto&tl=${encodeURIComponent(target)}&text=${encodeURIComponent(text.trim())}&op=translate`)
                break
            }
        }
    }

    // --- Annotations ---

    async #addAnnotation(annotation, save = true) {
        try {
            const info = await this.view.addAnnotation(annotation)
            this.annotations.set(annotation.value, annotation)
            if (info) this.annotationInfo.set(annotation.value, info)
            if (save) this.#saveAnnotations()
        } catch (e) {
            console.error(e)
        }
    }

    async #deleteAnnotation(annotation) {
        try {
            await this.view.deleteAnnotation(annotation)
        } catch (e) {
            console.error(e)
        }
        this.annotations.delete(annotation.value)
        this.annotationInfo.delete(annotation.value)
        this.#saveAnnotations()
    }

    #saveAnnotations() {
        this.data.annotations = Array.from(this.annotations.values())
        this.save()
        this.renderAnnotations()
    }

    showAnnotationMenu(annotation, pos, focusNote = false) {
        this.#currentAnnotation = annotation
        const menu = $('#annotation-menu')
        for (const b of menu.querySelectorAll('[data-color]'))
            b.setAttribute('aria-pressed', b.dataset.color === annotation.color)
        const note = $('#annotation-note')
        note.value = annotation.note ?? ''
        showPopover(menu, positionToRect(pos), { prefer: pos.dir === 'up' ? 'above' : 'below' })
        if (focusNote) note.focus()
    }

    copyCurrentAnnotation() {
        const text = this.#currentAnnotation?.text
        if (text) navigator.clipboard.writeText(text).catch(e => console.error(e))
    }

    deleteCurrentAnnotation() {
        const annotation = this.#currentAnnotation
        this.#currentAnnotation = null
        if (annotation) this.#deleteAnnotation(annotation)
    }

    updateCurrentAnnotation(changes) {
        const annotation = this.#currentAnnotation
        if (!annotation) return
        Object.assign(annotation, changes, { modified: new Date().toISOString() })
        if ('color' in changes) {
            this.#lastColor = changes.color
            this.view.addAnnotation(annotation)
        }
        this.#saveAnnotations()
    }

    sortedAnnotations() {
        return Array.from(this.annotations.values()).sort((a, b) => {
            try {
                return CFI.compare(a.value, b.value)
            } catch {
                return 0
            }
        })
    }

    renderAnnotations() {
        const list = this.sortedAnnotations()
        $('#annotations-empty').hidden = list.length > 0
        const container = $('#annotation-list')
        let lastLabel = null
        const children = []
        for (const annotation of list) {
            const label = this.annotationInfo.get(annotation.value)?.label ?? ''
            if (label !== lastLabel) {
                children.push(el('div', { class: 'item-heading' }, label))
                lastLabel = label
            }
            const isLine = ['underline', 'squiggly', 'strikethrough'].includes(annotation.color)
            children.push(el('button', {
                class: 'item annotation-item',
                onclick: () => {
                    this.navigate(() => this.view.goTo(annotation.value))
                    if (window.innerWidth <= 760) this.toggleSidebar(false)
                },
            },
            el('span', {
                class: 'swatch' + (isLine ? ' line ' + annotation.color : ''),
                style: isLine ? '' : `background: ${annotation.color}`,
            }),
            el('span', { class: 'item-text' },
                el('span', { class: 'quote' }, annotation.text),
                annotation.note ? el('span', { class: 'note' }, annotation.note) : null)))
        }
        container.replaceChildren(...children)
    }

    async exportAnnotations() {
        const annotations = this.sortedAnnotations()
        if (!annotations.length) return toast(t('No annotations to export'))
        const title = t('Annotations for “%s”', formatLanguageMap(this.book.metadata?.title))
        const path = await api.saveDialog({
            defaultPath: title.replace(/[\\/:*?"<>|]/g, '') + '.md',
            filters: [
                { name: 'Markdown', extensions: ['md'] },
                { name: 'HTML', extensions: ['html'] },
                { name: 'JSON', extensions: ['json'] },
            ],
        })
        if (!path) return
        const ext = path.split('.').pop().toLowerCase()
        const f = exportFormats[ext === 'htm' ? 'html' : ext] ?? exportFormats.md
        const contents = f({
            metadata: this.data.metadata, annotations, bookmarks: this.data.bookmarks,
        }, title)
        await api.writeTextFile(path, contents)
    }

    async importAnnotations() {
        const picked = await api.openDialog({
            filters: isMobile ? undefined : [{ name: 'JSON', extensions: ['json'] }],
        })
        if (!picked) return
        try {
            const path = await api.readablePath(picked)
            const text = new TextDecoder().decode(await api.readBook(path))
            const json = JSON.parse(text)
            const list = json.annotations ?? []
            if (!list.length) return toast(t('No annotations'))
            for (const a of list) if (a?.value && !this.annotations.has(a.value))
                await this.#addAnnotation(a, false)
            for (const b of json.bookmarks ?? []) if (!this.data.bookmarks.includes(b))
                this.data.bookmarks.push(b)
            this.#saveAnnotations()
            this.renderBookmarks()
            toast(t('Imported %s annotations', list.length))
        } catch (e) {
            console.error(e)
            toast(t('An error occurred'))
        }
    }

    // --- Bookmarks ---

    #visibleBookmark() {
        const cfi = this.location?.cfi
        if (!cfi) return null
        try {
            const start = CFI.collapse(cfi)
            const end = CFI.collapse(cfi, true)
            return (this.data.bookmarks ?? []).find(bookmark => {
                const point = CFI.collapse(bookmark)
                return CFI.compare(start, point) <= 0 && CFI.compare(point, end) <= 0
            }) ?? null
        } catch (e) {
            console.warn(e)
            return null
        }
    }

    #updateBookmarkButton() {
        const bookmarked = !!this.#visibleBookmark()
        const button = $('#bookmark-button')
        button.replaceChildren(icon(bookmarked ? 'bookmark-filled' : 'bookmark'))
        button.title = button.ariaLabel = t(bookmarked ? 'Remove Bookmark' : 'Add Bookmark')
        button.classList.toggle('accent', bookmarked)
    }

    toggleBookmark() {
        if (!this.location) return
        const existing = this.#visibleBookmark()
        if (existing) this.data.bookmarks = this.data.bookmarks.filter(x => x !== existing)
        else this.data.bookmarks.push(this.location.cfi)
        this.save()
        this.#updateBookmarkButton()
        this.renderBookmarks()
    }

    async renderBookmarks() {
        const bookmarks = [...(this.data.bookmarks ?? [])].sort((a, b) => {
            try {
                return CFI.compare(a, b)
            } catch {
                return 0
            }
        })
        $('#bookmarks-empty').hidden = bookmarks.length > 0
        const items = await Promise.all(bookmarks.map(async cfi => {
            const item = await this.view.getTOCItemOf(cfi).catch(() => null)
            return el('div', { class: 'item bookmark-item' },
                el('button', {
                    class: 'item-main',
                    onclick: () => {
                        this.navigate(() => this.view.goTo(cfi))
                        this.closeDrawerOnPhone()
                    },
                }, icon('bookmark'), el('span', { class: 'item-text' }, item?.label || cfi)),
                el('button', {
                    class: 'icon-only item-remove',
                    title: t('Remove Bookmark'),
                    onclick: () => {
                        this.data.bookmarks = this.data.bookmarks.filter(x => x !== cfi)
                        this.save()
                        this.renderBookmarks()
                        this.#updateBookmarkButton()
                    },
                }, icon('close')))
        }))
        $('#bookmark-list').replaceChildren(...items)
    }

    // --- Search ---

    async search(query) {
        const token = ++this.#searchToken
        this.view.clearSearch()
        const results = $('#search-results')
        results.replaceChildren()
        const status = $('#search-status')
        if (!query.trim()) {
            status.textContent = ''
            return
        }
        status.textContent = t('Searching…')
        let count = 0
        const opts = {
            query,
            matchCase: $('#search-case').checked,
            matchWholeWords: $('#search-words').checked,
        }
        const addItem = (cfi, excerpt) => results.append(el('button', {
            class: 'item search-item',
            onclick: () => {
                this.navigate(() => this.view.goTo(cfi))
                this.closeDrawerOnPhone()
            },
        }, el('span', { class: 'item-text' },
            excerpt.pre, el('mark', {}, excerpt.match), excerpt.post)))
        try {
            for await (const result of this.view.search(opts)) {
                if (token !== this.#searchToken) return
                if (result === 'done') break
                if (result.progress != null) {
                    status.textContent = `${t('Searching…')} ${percentFormat.format(result.progress)}`
                    continue
                }
                if (result.subitems) {
                    results.append(el('div', { class: 'item-heading' }, result.label))
                    for (const { cfi, excerpt } of result.subitems) addItem(cfi, excerpt)
                    count += result.subitems.length
                } else if (result.cfi) {
                    addItem(result.cfi, result.excerpt)
                    count++
                }
            }
        } catch (e) {
            console.error(e)
        }
        if (token === this.#searchToken) status.textContent = t('%s results', count)
    }

    // --- Speech ---

    get speech() {
        this.#speech ??= new Speech(this, {
            onState: state => {
                this.syncVolumeKeys()
                $('#tts-bar').hidden = state === 'stopped'
                // phones: the book area makes room for the bar instead of hiding under it
                document.body.classList.toggle('tts-active', state !== 'stopped')
                const play = $('#tts-play')
                play.replaceChildren(icon(state === 'playing' ? 'pause' : 'play'))
                play.title = play.ariaLabel = t(state === 'playing' ? 'Pause' : 'Play')
            },
            onError: async e => {
                if (e?.error !== 'language-unavailable') return toast(t('Speech is not available'))
                const ok = await api.confirm(t('Install a voice for this language in the system speech settings.'), {
                    title: t('No voice for the book’s language'), okLabel: t('Open Settings'), cancelLabel: t('Cancel'),
                })
                if (ok) android.tts.openSettings()
            },
        })
        return this.#speech
    }

    async showInfo() {
        const blob = await Promise.resolve(this.book?.getCover?.()).catch(() => null)
        showBookInfo($('#info-dialog'), this.book?.metadata, blob ? URL.createObjectURL(blob) : null)
    }

    stopSpeech() {
        this.#speech?.stop()
    }

    async flush() {
        if (this.key) await api.setData(this.key, this.data).catch(e => console.error(e))
    }
}

// --- Wire up the UI ---------------------------------------------------------

const reader = new Reader()
globalThis.reader = reader

$('#sidebar-button').addEventListener('click', () => reader.toggleSidebar())
$('#library-button').addEventListener('click', async () => {
    reader.save.flush()
    await reader.flush()
    api.showLibrary()
})
$('#toc-button').addEventListener('click', () => reader.showPanel('toc'))
$('#search-button-bottom').addEventListener('click', () => reader.openSearch())
$('#sidebar-backdrop').addEventListener('click', () => reader.toggleSidebar(false))
$('#back-button').addEventListener('click', () => reader.view?.history.back())
$('#forward-button').addEventListener('click', () => reader.view?.history.forward())
$('#prev-button').addEventListener('click', () => reader.view?.goLeft())
$('#next-button').addEventListener('click', () => reader.view?.goRight())
$('#search-button').addEventListener('click', () => reader.openSearch())
$('#bookmark-button').addEventListener('click', () => reader.toggleBookmark())
$('#tts-button').addEventListener('click', () => reader.speech.toggle())
$('#tts-play').addEventListener('click', () => reader.speech.toggle())
// (in the next frame, so the layout change does not loop the observer)
new ResizeObserver(([entry]) => requestAnimationFrame(() => document.documentElement.style.setProperty('--tts-height',
    `${entry.target.getBoundingClientRect().height}px`))).observe($('#tts-bar'))
$('#tts-prev').addEventListener('click', () => reader.speech.prev())
$('#tts-next').addEventListener('click', () => reader.speech.next())
$('#tts-stop').addEventListener('click', () => reader.speech.stop())
const rateFormat = new Intl.NumberFormat(navigator.language || 'en', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const showRate = rate => $('#tts-rate-value').textContent = `${rateFormat.format(rate)}×`
$('#tts-rate').value = prefs.ttsRate
showRate(prefs.ttsRate)
$('#tts-rate').addEventListener('input', e => showRate(parseFloat(e.target.value)))
$('#tts-rate').addEventListener('change', e => {
    prefs.ttsRate = parseFloat(e.target.value)
    savePrefs(prefs)
    reader.speech.setRate(prefs.ttsRate)
})
$('#tts-voice').addEventListener('change', e => {
    prefs.ttsVoice = e.target.value
    savePrefs(prefs)
    reader.speech.setVoice(prefs.ttsVoice)
})

$('#progress-button').addEventListener('click', e => {
    if (isPopoverOpen($('#jump-menu'))) return closePopover()
    reader.openJump(e.currentTarget.getBoundingClientRect())
})
$('#jump-slider').addEventListener('input', e => reader.previewJump(parseFloat(e.target.value)))
$('#jump-slider').addEventListener('keydown', e => {
    if (e.key === 'Enter') reader.jump()
})
$('#jump-go').addEventListener('click', () => reader.jump())
$('#jump-cancel').addEventListener('click', () => closePopover())

for (const b of $$('.sidebar-tabs button'))
    b.addEventListener('click', () => reader.showPanel(b.dataset.panel))

$('#search-form').addEventListener('submit', e => {
    e.preventDefault()
    reader.search($('#search-input').value)
})
$('#search-input').addEventListener('input', debounce(e => reader.search(e.target.value), 400))
for (const id of ['#search-case', '#search-words'])
    $(id).addEventListener('change', () => reader.search($('#search-input').value))

$('#export-annotations').addEventListener('click', () => reader.exportAnnotations())
$('#import-annotations').addEventListener('click', () => reader.importAnnotations())

// Popovers in the header
const togglePopover = (id, button) => {
    const menu = $(id)
    if (isPopoverOpen(menu)) return closePopover()
    showPopover(menu, button.getBoundingClientRect())
}
$('#view-button').addEventListener('click', e => togglePopover('#view-menu', e.currentTarget))
$('#view-button-bottom').addEventListener('click', e => togglePopover('#view-menu', e.currentTarget))
$('#tts-button-bottom').addEventListener('click', () => {
    reader.speech.toggle()
    reader.setChrome(false)
})
$('#more-button').addEventListener('click', e => togglePopover('#more-menu', e.currentTarget))

$('#more-menu').addEventListener('click', e => {
    const action = e.target.closest('button')?.dataset.action
    if (!action) return
    closePopover()
    if (action === 'library') api.showLibrary()
    else if (action === 'info') reader.showInfo()
    else if (action === 'export') reader.exportAnnotations()
    else if (action === 'import') reader.importAnnotations()
    else if (action === 'print') window.print()
    else if (action === 'fullscreen') reader.toggleFullscreen()
    else if (action === 'tts') reader.speech.toggle()
})

// Printing is not reliable in every system web view; hide it for now
$('#more-menu [data-action="print"]').hidden = true

// Appearance settings
$('#theme-list').append(...themes.map(theme => {
    const b = el('button', { class: 'theme-button', title: t(theme.label), dataset: { theme: theme.name } },
        el('span', { class: 'theme-swatch light' }, 'Aa'),
        el('span', { class: 'theme-swatch dark' }, 'Aa'))
    b.querySelector('.light').style.cssText = `background: ${theme.light.bg}; color: ${theme.light.fg}`
    b.querySelector('.dark').style.cssText = `background: ${theme.dark.bg}; color: ${theme.dark.fg}`
    b.addEventListener('click', () => reader.setPref('theme', theme.name))
    return b
}))
$('#scheme-buttons').addEventListener('click', e => {
    const s = e.target.closest('button')?.dataset.scheme
    if (s) reader.setPref('colorScheme', s)
})
$('#flow-buttons').addEventListener('click', e => {
    const f = e.target.closest('button')?.dataset.flow
    if (f) reader.setPref('flow', f)
})
$('#page-number-buttons').addEventListener('click', e => {
    const mode = e.target.closest('button')?.dataset.pages
    if (!mode) return
    reader.setPref('pageNumbers', mode)
    reader.refreshLocation()
})
$('#column-buttons').addEventListener('click', e => {
    const c = e.target.closest('button')?.dataset.columns
    if (c) reader.setPref('maxColumnCount', +c)
})
$('#font-smaller').addEventListener('click', () => reader.zoomText(-1))
$('#font-larger').addEventListener('click', () => reader.zoomText(1))
$('#zoom-out').addEventListener('click', () => reader.zoomText(-1))
$('#zoom-in').addEventListener('click', () => reader.zoomText(1))
$('#font-family').addEventListener('change', e => reader.setPref('fontFamily', e.target.value))
const rangePref = (id, key) => $(id).addEventListener('change', e => reader.setPref(key, parseFloat(e.target.value)))
rangePref('#line-height', 'lineHeight')
rangePref('#gap', 'gap')
rangePref('#max-inline-size', 'maxInlineSize')
for (const key of ['justify', 'hyphenate', 'animated', 'invert'])
    $('#' + key).addEventListener('change', e => reader.setPref(key, e.target.checked))
$('#volume-keys').addEventListener('change', e => reader.setPref('volumeKeys', e.target.checked))
$('#brightness').addEventListener('input', e => {
    // live while dragging; saved when released
    android.setBrightness(parseFloat(e.target.value))
})
$('#brightness').addEventListener('change', e => reader.setPref('brightness', parseFloat(e.target.value)))
$('#brightness-system').addEventListener('change', e =>
    reader.setPref('brightness', e.target.checked ? -1 : parseFloat($('#brightness').value) || 0.5))

// Selection and annotation popovers
$('#selection-menu').addEventListener('click', e => {
    const action = e.target.closest('button')?.dataset.action
    if (action) reader.onSelectionAction(action)
})

$('#annotation-colors').append(...highlightColors.map(([value, label]) => {
    const isLine = ['underline', 'squiggly', 'strikethrough'].includes(value)
    const b = el('button', { class: 'icon-only color-button', title: t(label), dataset: { color: value } },
        el('span', { class: 'swatch' + (isLine ? ' line ' + value : '') }))
    if (!isLine) b.firstChild.style.background = value
    return b
}))
$('#annotation-menu').addEventListener('click', e => {
    const button = e.target.closest('button')
    if (!button) return
    if (button.dataset.color) {
        for (const b of $$('#annotation-colors button'))
            b.setAttribute('aria-pressed', b === button)
        reader.updateCurrentAnnotation({ color: button.dataset.color })
    } else if (button.dataset.action === 'delete') {
        closePopover()
        reader.deleteCurrentAnnotation()
    } else if (button.dataset.action === 'copy') {
        closePopover()
        reader.copyCurrentAnnotation()
    }
})
$('#annotation-note').addEventListener('input', debounce(e =>
    reader.updateCurrentAnnotation({ note: e.target.value }), 400))

$('#image-dialog').addEventListener('click', () => $('#image-dialog').close())

document.addEventListener('keydown', e => reader.handleKeydown(e))
document.addEventListener('wheel', e => {
    if (e.target.closest?.('foliate-view')) reader.view && reader.handleWheel(e)
}, { passive: false })

// Fullscreen: reveal the toolbars when the pointer reaches an edge
document.addEventListener('pointermove', e => {
    if (!document.body.classList.contains('fullscreen')) return
    const near = e.clientY < 60 || e.clientY > window.innerHeight - 60
    document.body.classList.toggle('reveal', near)
})

// React to preference changes from other windows and the system theme
onPrefsChanged(() => reader.applyAppearance())
darkQuery.addEventListener('change', () => reader.applyAppearance())
window.addEventListener('resize', debounce(() => reader.clearPageDensity(), 200))

if (!isMobile) {
    // Native drag and drop opens dropped books in new windows
    globalThis.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === 'drop') for (const path of payload.paths) api.openReader(path)
    })

    // Save before the window goes away
    appWindow.onCloseRequested(async () => {
        reader.stopSpeech()
        savePrefs.flush()
        await reader.flush()
    })
} else {
    // Phones: reading is full screen; tap the middle of the page for menus
    reader.setChrome(false)
    // The page is replaced (not closed) when going back to the library
    window.addEventListener('pagehide', () => {
        reader.stopSpeech()
        savePrefs.flush()
        reader.save.flush()
        if (isAndroid) {
            android.setVolumeKeys(false)
            android.setKeepScreenOn(false)
            android.setImmersive(false)
            android.setBrightness(-1)
        }
    })
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) reader.save.flush()
    })
}

if (isAndroid) {
    android.setKeepScreenOn(true)
    onAndroid('volume', dir => {
        if (dir === 'down') reader.view?.next()
        else reader.view?.prev()
    })
    // A book opened from another app while reading: switch to it
    onAndroid('pending-files', async () => {
        const paths = await android.takePendingFiles(await api.libraryFilesPath()).catch(() => [])
        if (paths?.[0]) api.openReader(paths[0])
    })
}

reader.showPanel('toc', false)
if (window.innerWidth > 760 && prefs.sidebarOpen) reader.toggleSidebar(true)
reader.applyAppearance()
reader.open().catch(e => {
    console.error(e)
    reader.showError(t('An error occurred'), e?.message ?? String(e))
})
