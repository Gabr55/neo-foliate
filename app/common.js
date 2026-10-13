// Shared helpers for the library and reader windows

const tauri = globalThis.__TAURI__
const { invoke } = tauri.core

export const isMac = /Mac/.test(navigator.platform)
document.documentElement.classList.toggle('mac', isMac)

// --- Backend ---------------------------------------------------------------

export const api = {
    readBook: async path => new Uint8Array(await invoke('read_book', { path })),
    bookIdentifier: path => invoke('book_identifier', { path }),
    getData: key => invoke('data_get', { key }),
    setData: (key, value) => invoke('data_set', { key, value }),
    deleteData: key => invoke('data_delete', { key }),
    setURI: (key, path) => invoke('uri_set', { key, path }),
    listLibrary: () => invoke('library_list'),
    setCover: async (key, blob) => invoke('cover_set',
        new Uint8Array(await blob.arrayBuffer()),
        { headers: { 'x-key': encodeURIComponent(key) } }),
    getCover: async key => {
        const buf = new Uint8Array(await invoke('cover_get', { key }))
        return buf.length ? new Blob([buf]) : null
    },
    writeTextFile: (path, contents) => invoke('write_text_file', { path, contents }),
    openReader: path => invoke('open_reader', { path }),
    showLibrary: () => invoke('show_library'),
    openURL: url => tauri.opener.openUrl(url),
    revealInFolder: path => tauri.opener.revealItemInDir(path),
    openDialog: opts => tauri.dialog.open(opts),
    saveDialog: opts => tauri.dialog.save(opts),
    confirm: (message, opts) => tauri.dialog.confirm(message, opts),
    message: (message, opts) => tauri.dialog.message(message, opts),
    listen: (event, f) => tauri.event.listen(event, f),
    window: () => tauri.window.getCurrentWindow(),
}

export const bookExtensions = ['epub', 'mobi', 'azw', 'azw3', 'kf8', 'fb2', 'fbz', 'cbz', 'pdf', 'zip']

export const pickBooks = async () => {
    const result = await api.openDialog({
        multiple: true,
        directory: false,
        filters: [{ name: t('E-books'), extensions: bookExtensions }],
    })
    if (!result) return []
    return Array.isArray(result) ? result : [result]
}

export const fileName = path => path.split(/[\\/]/).pop()

export const loadFile = async path => {
    const bytes = await api.readBook(path)
    return new File([bytes], fileName(path))
}

// --- i18n ------------------------------------------------------------------

const strings = {
    ru: {
        'Library': 'Библиотека',
        'Open…': 'Открыть…',
        'Add Books…': 'Добавить книги…',
        'Search library': 'Поиск по библиотеке',
        'Your library is empty': 'Библиотека пуста',
        'Open a book or drop files here': 'Откройте книгу или перетащите файлы сюда',
        'No results': 'Ничего не найдено',
        'Unknown Author': 'Автор неизвестен',
        'Untitled': 'Без названия',
        'Open': 'Открыть',
        'Show in Folder': 'Показать в папке',
        'Remove from Library': 'Убрать из библиотеки',
        'Remove “%s” from the library?': 'Убрать «%s» из библиотеки?',
        'Reading progress, annotations, and bookmarks will be permanently lost.':
            'Прогресс чтения, заметки и закладки будут удалены без возможности восстановления.',
        'Remove': 'Убрать',
        'Cancel': 'Отмена',
        'File not found': 'Файл не найден',
        'The file may have been moved or deleted. Locate it?':
            'Возможно, файл перемещён или удалён. Указать его расположение?',
        'Locate…': 'Указать…',
        'E-books': 'Электронные книги',
        'Grid': 'Сетка',
        'List': 'Список',
        'Sort by': 'Сортировка',
        'Recently opened': 'Недавно открытые',
        'Title': 'Название',
        'Author': 'Автор',
        'Progress': 'Прогресс',
        'Importing…': 'Импорт…',
        'Could not open “%s”': 'Не удалось открыть «%s»',
        'File type not supported': 'Формат файла не поддерживается',
        'An error occurred': 'Произошла ошибка',
        'About': 'О программе',
        'New': 'Новая',
        'Finished': 'Прочитано',
        // Reader
        'Contents': 'Оглавление',
        'Annotations': 'Заметки',
        'Bookmarks': 'Закладки',
        'Find in book': 'Поиск по книге',
        'Search': 'Поиск',
        'Back': 'Назад',
        'Forward': 'Вперёд',
        'Previous': 'Назад',
        'Next': 'Вперёд',
        'Sidebar': 'Боковая панель',
        'Add Bookmark': 'Добавить закладку',
        'Remove Bookmark': 'Удалить закладку',
        'View': 'Вид',
        'Fullscreen': 'Полноэкранный режим',
        'Theme': 'Тема',
        'Font': 'Шрифт',
        'Font size': 'Размер шрифта',
        'Line spacing': 'Межстрочный интервал',
        'Margins': 'Поля',
        'Max width': 'Макс. ширина',
        'Columns': 'Колонки',
        'Layout': 'Макет',
        'Paginated': 'Страницы',
        'Scrolled': 'Прокрутка',
        'Justify': 'По ширине',
        'Hyphenate': 'Переносы',
        'Publisher font': 'Шрифт издателя',
        'Serif': 'С засечками',
        'Sans-serif': 'Без засечек',
        'Invert in dark mode': 'Инверсия в тёмном режиме',
        'Animations': 'Анимация',
        'Appearance': 'Оформление',
        'System': 'Системная',
        'Light': 'Светлая',
        'Dark': 'Тёмная',
        'Zoom': 'Масштаб',
        'Copy': 'Копировать',
        'Highlight': 'Выделить',
        'Note': 'Заметка',
        'Add Note…': 'Добавить заметку…',
        'Delete': 'Удалить',
        'Speak from here': 'Читать вслух отсюда',
        'Look up': 'Найти в Википедии',
        'Translate': 'Перевести',
        'Read aloud': 'Читать вслух',
        'Stop': 'Стоп',
        'Pause': 'Пауза',
        'Play': 'Воспроизвести',
        'Voice': 'Голос',
        'Speed': 'Скорость',
        'Default voice': 'Голос по умолчанию',
        'No annotations': 'Нет заметок',
        'Select text to highlight it or add a note': 'Выделите текст, чтобы отметить его или добавить заметку',
        'No bookmarks': 'Нет закладок',
        'Export Annotations…': 'Экспорт заметок…',
        'Import Annotations…': 'Импорт заметок…',
        'Annotations for “%s”': 'Заметки к книге «%s»',
        'Book Info': 'О книге',
        'Publisher': 'Издатель',
        'Published': 'Дата публикации',
        'Language': 'Язык',
        'Identifier': 'Идентификатор',
        'Subjects': 'Темы',
        'Close': 'Закрыть',
        'Footnote': 'Сноска',
        'Go to Footnote': 'Перейти к сноске',
        'Endnote': 'Примечание',
        'Go to Endnote': 'Перейти к примечанию',
        'Reference': 'Примечание',
        'Go to Reference': 'Перейти к примечанию',
        'More': 'Ещё',
        'Show Library': 'Показать библиотеку',
        'Loc %s of %s': 'Поз. %s из %s',
        'Page %s of %s': 'Стр. %s из %s',
        'Page %s': 'Стр. %s',
        '%s results': 'Результатов: %s',
        'Searching…': 'Поиск…',
        'Match case': 'Учитывать регистр',
        'Whole words': 'Слова целиком',
        'Loading…': 'Загрузка…',
        'Print': 'Печать',
        'Edit Note': 'Изменить заметку',
        'Save': 'Сохранить',
        'Yellow': 'Жёлтый',
        'Orange': 'Оранжевый',
        'Red': 'Красный',
        'Magenta': 'Пурпурный',
        'Aqua': 'Голубой',
        'Lime': 'Салатовый',
        'Underline': 'Подчёркивание',
        'Squiggly': 'Волнистая линия',
        'Strikethrough': 'Зачёркивание',
        'Default': 'По умолчанию',
        'Gray': 'Серая',
        'Sepia': 'Сепия',
        'Grass': 'Трава',
        'Cherry': 'Вишня',
        'Sky': 'Небо',
        'Keyboard Shortcuts': 'Сочетания клавиш',
        'Imported %s annotations': 'Импортировано заметок: %s',
        'No annotations to export': 'Нет заметок для экспорта',
        'Image': 'Изображение',
        'Speech is not available': 'Синтез речи недоступен',
    },
}

const lang = (navigator.languages?.[0] ?? navigator.language ?? 'en').split('-')[0]
const dict = strings[lang] ?? {}
export const locale = navigator.language || 'en'

export const t = (str, ...args) => {
    let s = dict[str] ?? str
    for (const arg of args) s = s.replace('%s', arg)
    return s
}

// Translate static markup: elements with data-i18n / data-i18n-title / data-i18n-placeholder
export const translateDOM = (root = document) => {
    for (const el of root.querySelectorAll('[data-i18n]'))
        el.textContent = t(el.dataset.i18n)
    for (const el of root.querySelectorAll('[data-i18n-title]'))
        el.title = el.ariaLabel = t(el.dataset.i18nTitle)
    for (const el of root.querySelectorAll('[data-i18n-placeholder]'))
        el.placeholder = t(el.dataset.i18nPlaceholder)
    document.documentElement.lang = lang
}

// --- Formatting ------------------------------------------------------------

export const formatLanguageMap = x => {
    if (!x) return ''
    if (typeof x === 'string') return x
    const keys = Object.keys(x)
    return x[keys[0]]
}

const listFormat = new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' })

const formatOneContributor = contributor => typeof contributor === 'string'
    ? contributor : formatLanguageMap(contributor?.name)

export const formatAuthors = contributor => Array.isArray(contributor)
    ? listFormat.format(contributor.map(formatOneContributor).filter(Boolean))
    : formatOneContributor(contributor) ?? ''

export const percentFormat = new Intl.NumberFormat(locale, { style: 'percent' })

export const formatDate = str => {
    if (!str) return ''
    const date = new Date(str)
    if (isNaN(date)) return str
    return date.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
}

export const formatLanguage = code => {
    if (!code) return ''
    try {
        return new Intl.DisplayNames(locale, { type: 'language' }).of(code) ?? code
    } catch {
        return code
    }
}

export const progressFraction = progress => {
    if (!Array.isArray(progress)) return null
    const [current, total] = progress
    if (!total) return null
    return total > 1 ? current / (total - 1) : 1
}

// Book descriptions are HTML; reduce them to safe paragraphs of text
export const htmlToText = html => {
    if (!html) return ''
    const doc = new DOMParser().parseFromString(html, 'text/html')
    for (const el of doc.querySelectorAll('p, div, li, br, h1, h2, h3, h4, h5, h6'))
        el.before('\n')
    return doc.body.textContent.replace(/\n{3,}/g, '\n\n').trim()
}

export const debounce = (f, wait) => {
    let timeout
    const debounced = (...args) => {
        clearTimeout(timeout)
        timeout = setTimeout(() => f(...args), wait)
    }
    debounced.flush = (...args) => {
        clearTimeout(timeout)
        f(...args)
    }
    return debounced
}

export const el = (tag, props = {}, ...children) => {
    const elem = document.createElement(tag)
    for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue
        if (k === 'class') elem.className = v
        else if (k === 'dataset') Object.assign(elem.dataset, v)
        else if (k.startsWith('on')) elem.addEventListener(k.slice(2), v)
        else if (k in elem && typeof v !== 'string') elem[k] = v
        else elem.setAttribute(k, v === true ? '' : v)
    }
    elem.append(...children.flat().filter(x => x != null && x !== false))
    return elem
}

// --- Themes (from Foliate) -------------------------------------------------

export const themes = [
    {
        name: 'default', label: 'Default',
        light: { fg: '#000000', bg: '#ffffff', link: '#0066cc' },
        dark: { fg: '#e0e0e0', bg: '#222222', link: '#77bbee' },
    },
    {
        name: 'gray', label: 'Gray',
        light: { fg: '#222222', bg: '#e0e0e0', link: '#4488cc' },
        dark: { fg: '#c6c6c6', bg: '#444444', link: '#88ccee' },
    },
    {
        name: 'sepia', label: 'Sepia',
        light: { fg: '#5b4636', bg: '#f1e8d0', link: '#008b8b' },
        dark: { fg: '#ffd595', bg: '#342e25', link: '#48d1cc' },
    },
    {
        name: 'grass', label: 'Grass',
        light: { fg: '#232c16', bg: '#d7dbbd', link: '#177b4d' },
        dark: { fg: '#d8deba', bg: '#333627', link: '#a6d608' },
    },
    {
        name: 'cherry', label: 'Cherry',
        light: { fg: '#4e1609', bg: '#f0d1d5', link: '#de3838' },
        dark: { fg: '#e5c4c8', bg: '#462f32', link: '#ff646e' },
    },
    {
        name: 'sky', label: 'Sky',
        light: { fg: '#262d48', bg: '#cedef5', link: '#2d53e5' },
        dark: { fg: '#babee1', bg: '#282e47', link: '#ff646e' },
    },
    {
        name: 'solarized', label: 'Solarized',
        light: { fg: '#586e75', bg: '#fdf6e3', link: '#268bd2' },
        dark: { fg: '#93a1a1', bg: '#002b36', link: '#268bd2' },
    },
    {
        name: 'gruvbox', label: 'Gruvbox',
        light: { fg: '#3c3836', bg: '#fbf1c7', link: '#076678' },
        dark: { fg: '#ebdbb2', bg: '#282828', link: '#83a598' },
    },
    {
        name: 'nord', label: 'Nord',
        light: { fg: '#2e3440', bg: '#eceff4', link: '#5e81ac' },
        dark: { fg: '#d8dee9', bg: '#2e3440', link: '#88c0d0' },
    },
]

export const invertColor = color => {
    const n = parseInt(color.slice(1), 16)
    const r = 255 - (n >> 16 & 255), g = 255 - (n >> 8 & 255), b = 255 - (n & 255)
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('')
}

// --- Preferences (per-device, shared by all windows) -----------------------

const PREFS_KEY = 'neo-foliate:prefs'
export const defaultPrefs = {
    colorScheme: 'system',
    theme: 'default',
    fontSize: 16,
    fontFamily: 'publisher',
    lineHeight: 1.5,
    justify: true,
    hyphenate: true,
    invert: false,
    flow: 'paginated',
    gap: 0.06,
    maxInlineSize: 720,
    maxColumnCount: 2,
    animated: true,
    zoom: 1,
    libraryView: 'grid',
    librarySort: 'recent',
    ttsVoice: '',
    ttsRate: 1,
}

// Preferences live in settings.json next to the library (see `settings_get`);
// older versions kept them in WebView storage, which is migrated once
export const prefs = { ...defaultPrefs }
const windowLabel = tauri.window.getCurrentWindow().label

export const initPrefs = async () => {
    let stored = null
    try {
        stored = await invoke('settings_get')
    } catch (e) {
        console.error(e)
    }
    if (!stored) {
        try {
            stored = JSON.parse(localStorage.getItem(PREFS_KEY))
        } catch {
            stored = null
        }
        if (stored) await invoke('settings_set', {
            value: { ...defaultPrefs, ...stored }, source: windowLabel,
        }).catch(e => console.error(e))
    }
    Object.assign(prefs, stored)
    return prefs
}

const writePrefs = debounce(() => invoke('settings_set', { value: prefs, source: windowLabel })
    .catch(e => console.error(e)), 150)

export const savePrefs = () => writePrefs()
savePrefs.flush = () => writePrefs.flush()

// Called when another window changes preferences
export const onPrefsChanged = f => tauri.event.listen('settings-changed', ({ payload }) => {
    if (payload?.source === windowLabel) return
    Object.assign(prefs, payload?.value)
    f(prefs)
})

export const applyColorScheme = scheme => {
    document.documentElement.dataset.theme = scheme === 'system' ? '' : scheme
    const meta = document.querySelector('meta[name="color-scheme"]')
    if (meta) meta.content = scheme === 'system' ? 'light dark' : scheme
}

// --- Icons -----------------------------------------------------------------

const paths = {
    'sidebar': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
    'back': '<path d="M15 18l-6-6 6-6"/>',
    'forward': '<path d="M9 18l6-6-6-6"/>',
    'search': '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    'bookmark': '<path d="M6 3h12v18l-6-5-6 5z"/>',
    'bookmark-filled': '<path d="M6 3h12v18l-6-5-6 5z" fill="currentColor"/>',
    'text': '<path d="M4 19l5-14 5 14M6 14h6"/><path d="M15 19l3-8 3 8M16 16.5h4"/>',
    'fullscreen': '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    'close': '<path d="M6 6l12 12M18 6L6 18"/>',
    'library': '<path d="M4 4h4v16H4zM10 4h4v16h-4z"/><path d="M16 5l3.5-1 3 15.5-3.5 1z"/>',
    'plus': '<path d="M12 5v14M5 12h14"/>',
    'menu': '<path d="M4 7h16M4 12h16M4 17h16"/>',
    'more': '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
    'grid': '<rect x="4" y="4" width="6" height="7" rx="1"/><rect x="14" y="4" width="6" height="7" rx="1"/><rect x="4" y="14" width="6" height="7" rx="1"/><rect x="14" y="14" width="6" height="7" rx="1"/>',
    'list': '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="5" cy="6" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="18" r="1" fill="currentColor"/>',
    'play': '<path d="M7 5l12 7-12 7z" fill="currentColor"/>',
    'pause': '<path d="M7 5h3v14H7zM14 5h3v14h-3z" fill="currentColor"/>',
    'stop': '<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor"/>',
    'skip-back': '<path d="M18 6l-8 6 8 6zM6 6v12"/>',
    'skip-forward': '<path d="M6 6l8 6-8 6zM18 6v12"/>',
    'speaker': '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 010 6M18.5 6.5a8 8 0 010 11"/>',
    'note': '<path d="M5 4h14v11l-5 5H5z"/><path d="M14 20v-5h5"/>',
    'trash': '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    'folder': '<path d="M3 6a1 1 0 011-1h5l2 2h9a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1z"/>',
    'info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
    'copy': '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>',
    'highlight': '<path d="M15 4l5 5-9 9H6v-5z"/><path d="M4 21h16"/>',
    'globe': '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
    'translate': '<path d="M4 6h9M8.5 4v2M6 6c1 4 4 7 7 8M11 6c-1 4-4 7-7 8"/><path d="M13 20l4-9 4 9M14.5 17h5"/>',
    'export': '<path d="M12 15V4M8 8l4-4 4 4"/><path d="M5 13v6h14v-6"/>',
    'import': '<path d="M12 4v11M8 11l4 4 4-4"/><path d="M5 13v6h14v-6"/>',
    'print': '<path d="M7 9V4h10v5M7 17H5v-7h14v7h-2M7 14h10v6H7z"/>',
    'zoom-in': '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M8 11h6M11 8v6"/>',
    'zoom-out': '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4M8 11h6"/>',
    'check': '<path d="M5 12l5 5 9-10"/>',
}

export const icon = name => {
    const span = document.createElement('span')
    span.className = 'icon'
    span.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? ''}</svg>`
    return span
}

export const renderIcons = (root = document) => {
    for (const elem of root.querySelectorAll('[data-icon]'))
        elem.prepend(icon(elem.dataset.icon))
}

// --- Popovers --------------------------------------------------------------

// Position a floating element next to an anchor rect, keeping it on screen
export const placePopover = (popover, anchor, { prefer = 'below', gap = 6 } = {}) => {
    popover.style.left = '0px'
    popover.style.top = '0px'
    const { width, height } = popover.getBoundingClientRect()
    const vw = window.innerWidth, vh = window.innerHeight
    let top = prefer === 'above' ? anchor.top - height - gap : anchor.bottom + gap
    if (top + height > vh - 8) top = anchor.top - height - gap
    if (top < 8) top = Math.min(anchor.bottom + gap, vh - height - 8)
    let left = (anchor.left + anchor.right) / 2 - width / 2
    left = Math.max(8, Math.min(left, vw - width - 8))
    popover.style.left = `${left}px`
    popover.style.top = `${Math.max(8, top)}px`
}

let openPopover = null
export const closePopover = () => {
    if (!openPopover) return
    const p = openPopover
    openPopover = null
    p.hidden = true
    p.dispatchEvent(new Event('popover-close'))
}

export const showPopover = (popover, anchor, opts) => {
    if (openPopover && openPopover !== popover) closePopover()
    popover.hidden = false
    openPopover = popover
    placePopover(popover, anchor, opts)
}

export const isPopoverOpen = popover => openPopover === popover

document.addEventListener('pointerdown', e => {
    if (!openPopover) return
    if (openPopover.contains(e.target)) return
    if (e.target.closest?.('[data-popover-toggle]')) return
    closePopover()
}, true)

window.addEventListener('blur', () => {
    // Clicks inside book iframes blur the window but should close menus
    if (document.activeElement?.tagName === 'FOLIATE-VIEW') closePopover()
})

window.addEventListener('resize', () => closePopover())
