import {
    t, el, api, showDialog, formatLanguageMap, formatAuthors, formatDate, formatLanguage, htmlToText,
} from './common.js'

const formatList = x => (Array.isArray(x) ? x : [x])
    .map(item => typeof item === 'string' ? item : formatLanguageMap(item?.name ?? item?.label))
    .filter(Boolean).join(', ')

export const showBookInfo = (dialog, metadata = {}, coverURL) => {
    const $ = s => dialog.querySelector(s)
    $('.info-title').textContent = formatLanguageMap(metadata.title) || t('Untitled')
    $('.info-author').textContent = formatAuthors(metadata.author)
    $('.info-description').textContent = htmlToText(metadata.description)
    const cover = $('.info-cover')
    cover.hidden = !coverURL
    if (coverURL) cover.src = coverURL

    const rows = [
        [t('Publisher'), formatList(metadata.publisher ?? '')],
        [t('Published'), formatDate(metadata.published)],
        [t('Language'), formatList(metadata.language ?? '').split(', ').map(formatLanguage).join(', ')],
        [t('Subjects'), formatList(metadata.subject ?? '')],
        [t('Identifier'), metadata.identifier ?? ''],
    ].filter(([, value]) => value)
    $('.info-meta').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]))

    for (const a of dialog.querySelectorAll('a[href]')) a.onclick = e => {
        e.preventDefault()
        api.openURL(a.href)
    }
    showDialog(dialog)
}
