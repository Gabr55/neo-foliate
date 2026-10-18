import {
    api, t, el, icon, translateDOM, renderIcons, pickBooks, loadFile, fileName, isMobile, showDialog,
    pushOverlay, popOverlay,
    formatLanguageMap, formatAuthors, bookFraction, percentFormat, locale, debounce,
    prefs, initPrefs, onPrefsChanged, savePrefs, applyColorScheme, showPopover, closePopover, isPopoverOpen,
} from './common.js'
import { makeBook } from './foliate-js/view.js'
import { ensureIdentifier, registerBook } from './bookdata.js'
import { showBookInfo } from './info.js'
import { isAndroid, android, onAndroid } from './android.js'

const $ = document.querySelector.bind(document)
await initPrefs()
// The library has its own light/dark setting, separate from the books'
// themes; until chosen it follows the system
const systemDark = matchMedia('(prefers-color-scheme: dark)')
const libraryScheme = () => prefs.libraryScheme === 'light' || prefs.libraryScheme === 'dark'
    ? prefs.libraryScheme : systemDark.matches ? 'dark' : 'light'
applyColorScheme(libraryScheme())
translateDOM()
renderIcons()
if (isMobile) $('#empty p').textContent = t('Tap + to add books')

const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' })
let items = []
let menuItem = null

const toast = (() => {
    let timeout
    return (message, ms = 2500) => {
        const elem = $('#toast')
        elem.textContent = message
        elem.hidden = false
        clearTimeout(timeout)
        if (ms) timeout = setTimeout(() => elem.hidden = true, ms)
    }
})()

// --- Covers ----------------------------------------------------------------

const coverURLs = new Map()
const loadedCovers = new Map() // key -> object URL, once loaded
const getCoverURL = async key => {
    if (coverURLs.has(key)) return coverURLs.get(key)
    const promise = api.getCover(key)
        .then(blob => blob ? URL.createObjectURL(blob) : null)
        .then(url => {
            // a book opened for the first time may get its cover a bit later
            if (url) loadedCovers.set(key, url)
            else coverURLs.delete(key)
            return url
        })
        .catch(() => null)
    coverURLs.set(key, promise)
    return promise
}

const hashHue = str => {
    let h = 0
    for (const c of str) h = (h * 31 + c.codePointAt(0)) | 0
    return Math.abs(h) % 360
}

const makeCover = item => {
    const title = formatLanguageMap(item.data.metadata?.title) || fileName(item.path ?? '')
    const author = formatAuthors(item.data.metadata?.author)
    const cover = el('div', { class: 'cover' },
        el('div', { class: 'cover-fallback' },
            el('span', { class: 'cover-fallback-title' }, title),
            el('span', { class: 'cover-fallback-author' }, author)))
    cover.style.setProperty('--hue', hashHue(title))
    cover.dataset.key = item.key
    // Covers already loaded show at once, so re-rendering does not flicker
    const url = loadedCovers.get(item.key)
    if (url) {
        cover.classList.add('has-image')
        cover.append(el('img', { alt: '', draggable: 'false', src: url }))
    } else coverObserver.observe(cover)
    return cover
}

const coverObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const cover = entry.target
        coverObserver.unobserve(cover)
        getCoverURL(cover.dataset.key).then(url => {
            if (!url) return
            const img = el('img', { alt: '', draggable: 'false' })
            img.onload = () => cover.classList.add('has-image')
            img.src = url
            cover.append(img)
        })
    }
}, { rootMargin: '200px' })

// --- Rendering -------------------------------------------------------------

const getTitle = item => formatLanguageMap(item.data.metadata?.title) || fileName(item.path ?? '') || t('Untitled')
const getAuthor = item => formatAuthors(item.data.metadata?.author)
const getRecent = item => Date.parse(item.data.lastOpened ?? '') || item.modified

const sorters = {
    recent: (a, b) => getRecent(b) - getRecent(a),
    title: (a, b) => collator.compare(getTitle(a), getTitle(b)),
    author: (a, b) => collator.compare(getAuthor(a), getAuthor(b)) || sorters.title(a, b),
    progress: (a, b) => (bookFraction(b.data) ?? -1) - (bookFraction(a.data) ?? -1),
}

const matches = (item, query) => {
    if (!query) return true
    const q = query.toLocaleLowerCase()
    return getTitle(item).toLocaleLowerCase().includes(q)
        || getAuthor(item).toLocaleLowerCase().includes(q)
}

const renderItem = item => {
    const frac = bookFraction(item.data)
    const progressLabel = frac == null ? t('New') : frac >= 1 ? t('Finished') : percentFormat.format(frac)
    const elem = el('div', {
        class: 'book' + (item.exists ? '' : ' missing'),
        role: 'listitem',
        tabIndex: 0,
        title: isMobile ? '' : item.path ?? '',
        onclick: () => {
            if (elem.dataset.longPressed) return delete elem.dataset.longPressed
            openItem(item)
        },
        onkeydown: e => {
            if (e.key === 'Enter') openItem(item)
            if (e.key === 'Delete' || e.key === 'Backspace') removeItem(item)
        },
        oncontextmenu: e => {
            e.preventDefault()
            showBookMenu(item, { left: e.clientX, right: e.clientX, top: e.clientY, bottom: e.clientY })
        },
    },
    makeCover(item),
    el('div', { class: 'book-text' },
        el('div', { class: 'book-title' }, getTitle(item)),
        el('div', { class: 'book-author' }, getAuthor(item) || t('Unknown Author')),
        el('div', { class: 'book-progress' },
            el('div', { class: 'progress-bar' },
                el('div', { class: 'progress-fill', style: `width: ${(frac ?? 0) * 100}%` })),
            el('span', { class: 'progress-label' }, progressLabel))),
    el('button', {
        class: 'icon-only book-more',
        'data-popover-toggle': true,
        title: t('More'),
        onclick: e => {
            e.stopPropagation()
            showBookMenu(item, e.currentTarget.getBoundingClientRect())
        },
    }, icon('more')))
    if (isMobile) addLongPress(elem, () => showBookMenu(item, elem.getBoundingClientRect()))
    return elem
}

// Touch and hold opens the book menu (there is no right click on phones)
const addLongPress = (elem, f) => {
    let timer, start
    const cancel = () => {
        clearTimeout(timer)
        elem.classList.remove('pressed')
    }
    elem.addEventListener('pointerdown', e => {
        start = { x: e.clientX, y: e.clientY }
        elem.classList.add('pressed')
        timer = setTimeout(() => {
            elem.classList.remove('pressed')
            elem.dataset.longPressed = '1'
            navigator.vibrate?.(15)
            f()
        }, 450)
    })
    elem.addEventListener('pointermove', e => {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel()
    })
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) elem.addEventListener(type, cancel)
    elem.addEventListener('contextmenu', e => e.preventDefault())
}

// Phones: the book in progress gets a card at the top, as in Books or Play Books
const renderContinue = (query, count) => {
    const box = $('#continue')
    const heading = $('#books-heading')
    const item = !isMobile || query ? null : items
        .filter(i => i.exists && i.data.lastOpened && (bookFraction(i.data) ?? 1) < 1)
        .sort(sorters.recent)[0]
    box.hidden = heading.hidden = !item
    if (!item) return
    const frac = bookFraction(item.data) ?? 0
    heading.textContent = `${t('All books')} · ${count}`
    box.replaceChildren(
        el('div', { class: 'continue-label' }, t('Continue reading')),
        el('div', { class: 'continue-card', onclick: () => openItem(item) },
            makeCover(item),
            el('div', { class: 'continue-text' },
                el('div', { class: 'book-title' }, getTitle(item)),
                el('div', { class: 'book-author' }, getAuthor(item) || t('Unknown Author')),
                el('div', { class: 'book-progress' },
                    el('div', { class: 'progress-bar' },
                        el('div', { class: 'progress-fill', style: `width: ${frac * 100}%` })),
                    el('span', { class: 'progress-label' }, percentFormat.format(frac))),
                el('button', { class: 'suggested' }, t('Continue')))))
}

const render = () => {
    const query = $('#search').value.trim()
    const list = items.filter(item => matches(item, query)).sort(sorters[prefs.librarySort] ?? sorters.recent)
    const books = $('#books')
    books.className = prefs.libraryView === 'list' ? 'list' : 'grid'
    books.replaceChildren(...list.map(renderItem))
    renderContinue(query, list.length)
    $('#empty').hidden = items.length > 0
    $('#no-results').hidden = !(items.length > 0 && list.length === 0)
    books.hidden = list.length === 0
    for (const b of document.querySelectorAll('#view-menu [data-view]'))
        b.setAttribute('aria-pressed', b.dataset.view === prefs.libraryView)
    for (const b of document.querySelectorAll('#view-menu [data-sort]'))
        b.setAttribute('aria-pressed', b.dataset.sort === prefs.librarySort)
    for (const b of document.querySelectorAll('#view-menu [data-scheme]'))
        b.setAttribute('aria-pressed', b.dataset.scheme === libraryScheme())
}

let lastListing = ''
const refresh = async () => {
    let listing
    try {
        listing = await api.listLibrary()
    } catch (e) {
        console.error(e)
        listing = []
    }
    // Skip the re-render when nothing changed (focus, visibility changes)
    const json = JSON.stringify(listing.map(({ modified, ...rest }) => rest))
    if (json === lastListing) return
    lastListing = json
    items = listing
    render()
}

// --- Actions ---------------------------------------------------------------

const locateItem = async item => {
    const ok = await api.confirm(t('The file may have been moved or deleted. Locate it?'), {
        title: t('File not found'), kind: 'warning', okLabel: t('Locate…'), cancelLabel: t('Cancel'),
    })
    if (!ok) return
    const [path] = await pickBooks()
    if (!path) return
    await api.setURI(item.key, path)
    await api.openReader(path)
    refresh()
}

const openItem = item => {
    if (!item.path || !item.exists) return locateItem(item)
    api.openReader(item.path)
}

const removeItem = async item => {
    const ok = await api.confirm(
        t('Reading progress, annotations, and bookmarks will be permanently lost.'), {
            title: t('Remove “%s” from the library?', getTitle(item)),
            kind: 'warning', okLabel: t('Remove'), cancelLabel: t('Cancel'),
        })
    if (!ok) return
    await api.deleteData(item.key)
    coverURLs.delete(item.key)
    loadedCovers.delete(item.key)
    refresh()
}

const showBookMenu = (item, rect) => {
    menuItem = item
    $('#book-menu [data-action="reveal"]').disabled = !item.exists
    showPopover($('#book-menu'), rect)
}

$('#book-menu').addEventListener('click', async e => {
    const action = e.target.closest('button')?.dataset.action
    const item = menuItem
    if (!action || !item) return
    closePopover()
    if (action === 'open') openItem(item)
    else if (action === 'reveal') api.revealInFolder(item.path)
    else if (action === 'remove') removeItem(item)
    else if (action === 'info') showBookInfo($('#info-dialog'), item.data.metadata, await getCoverURL(item.key))
})

const importBooks = async paths => {
    if (!paths.length) return
    // A single book opens straight away, like double-clicking it
    if (paths.length === 1) return api.openReader(paths[0])
    for (const [i, path] of paths.entries()) {
        toast(`${t('Importing…')} ${i + 1}/${paths.length}`, 0)
        try {
            const stored = await api.storeBook(path).catch(() => path)
            const book = await makeBook(await loadFile(stored))
            const key = await ensureIdentifier(book, stored)
            await registerBook(key, stored, book)
        } catch (e) {
            console.error(e)
            toast(t('Could not open “%s”', fileName(path)))
        }
    }
    $('#toast').hidden = true
    refresh()
}

const addBooks = async () => importBooks(await pickBooks())

$('#add-button').addEventListener('click', addBooks)
$('#fab').addEventListener('click', addBooks)
$('#empty-add').addEventListener('click', addBooks)
$('#search').addEventListener('input', debounce(render, 120))

// Phones: search hides behind an icon, like most mobile apps
const header = document.querySelector('.headerbar')
const closeSearch = () => {
    header.classList.remove('searching')
    $('#search-toggle').replaceChildren(icon('search'))
    if ($('#search').value) {
        $('#search').value = ''
        render()
    }
}
$('#search-toggle').addEventListener('click', () => {
    if (header.classList.contains('searching')) {
        popOverlay(closeSearch)
        return closeSearch()
    }
    header.classList.add('searching')
    $('#search-toggle').replaceChildren(icon('close'))
    $('#search').focus()
    pushOverlay(closeSearch)
})

$('#view-button').addEventListener('click', e => {
    const menu = $('#view-menu')
    if (isPopoverOpen(menu)) return closePopover()
    showPopover(menu, e.currentTarget.getBoundingClientRect())
})

$('#view-menu').addEventListener('click', e => {
    const button = e.target.closest('button')
    if (!button) return
    const { view, sort, scheme } = button.dataset
    if (view) prefs.libraryView = view
    if (sort) prefs.librarySort = sort
    if (scheme) {
        prefs.libraryScheme = scheme
        applyColorScheme(scheme)
        if (isAndroid) syncSystemBars()
    }
    if (button.id === 'about-button') {
        closePopover()
        showAbout()
        return
    }
    savePrefs(prefs)
    render()
})

const showAbout = async () => {
    const dialog = $('#about-dialog')
    dialog.querySelector('.version').textContent = await globalThis.__TAURI__.app.getVersion().catch(() => '')
    for (const a of dialog.querySelectorAll('a[href]')) a.onclick = e => {
        e.preventDefault()
        api.openURL(a.href)
    }
    showDialog(dialog)
}

// Keep the preferred color scheme in sync with reader windows
const isDark = () => libraryScheme() === 'dark'
const syncSystemBars = () => android.setSystemBars(!isDark())

onPrefsChanged(() => {
    applyColorScheme(libraryScheme())
    syncSystemBars()
    render()
})

document.addEventListener('keydown', e => {
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'o') {
        e.preventDefault()
        addBooks()
    } else if (mod && e.key === 'f') {
        e.preventDefault()
        $('#search').focus()
    } else if (e.key === 'Escape') closePopover()
})

// Native file drag and drop
if (!isMobile) globalThis.__TAURI__.webview.getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === 'enter' || payload.type === 'over') $('#drop-overlay').hidden = false
    else if (payload.type === 'leave') $('#drop-overlay').hidden = true
    else if (payload.type === 'drop') {
        $('#drop-overlay').hidden = true
        importBooks(payload.paths)
    }
})

// Books opened with the app from other apps ("Open with…", "Share")
if (isAndroid) {
    android.setVolumeKeys(false)
    android.setKeepScreenOn(false)
    android.setImmersive(false)
    android.setBrightness(-1)
    syncSystemBars()
    systemDark.addEventListener('change', syncSystemBars)
    const openPending = async () => {
        const paths = await android.takePendingFiles(await api.libraryFilesPath()).catch(() => [])
        if (paths?.length) importBooks(paths)
    }
    onAndroid('pending-files', openPending)
    openPending()
}

api.listen('library-changed', debounce(refresh, 300))
// Coming back from a book on phones may restore this page from the
// back/forward cache, with the progress it had before
// Following the system until a scheme is chosen
systemDark.addEventListener('change', () => {
    applyColorScheme(libraryScheme())
    render()
})
window.addEventListener('pageshow', e => {
    if (e.persisted) refresh()
})
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh()
})
window.addEventListener('focus', refresh)
refresh()
