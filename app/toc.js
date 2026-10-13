// Table of contents tree. Replaces foliate-js's demo tree (ui/tree.js), whose
// 13px expander inside the link was hard to see and hard to hit, so nested
// chapters often could not be opened.
import { t, el, isMobile } from './common.js'

const chevron = () => {
    const span = document.createElement('span')
    span.className = 'toc-chevron'
    span.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>'
    return span
}

export const createTOC = (toc, { onNavigate }) => {
    const byHref = new Map()
    const rows = []
    let current = null

    const setExpanded = (row, expanded) => {
        if (!row.hasAttribute('aria-expanded')) return
        row.setAttribute('aria-expanded', expanded)
        row.querySelector('.toc-toggle')?.setAttribute('aria-label', t(expanded ? 'Collapse' : 'Expand'))
    }
    const isExpanded = row => row.getAttribute('aria-expanded') === 'true'
    const isVisible = row => row.offsetParent !== null

    const build = (items, depth, parent) => items.map(item => {
        const hasChildren = item.subitems?.length > 0
        const row = el('div', {
            class: 'toc-row' + (item.href ? '' : ' no-link'),
            role: 'treeitem',
            tabIndex: -1,
            style: `--depth: ${depth}`,
        })
        row.parentRow = parent
        rows.push(row) // document order, before the children
        const toggle = hasChildren
            ? el('button', { class: 'toc-toggle', tabIndex: -1, 'aria-label': t('Expand') }, chevron())
            : el('span', { class: 'toc-toggle' })
        row.append(toggle, el('span', { class: 'toc-label' }, item.label ?? ''))

        const li = el('li', { role: 'none' }, row)
        if (hasChildren) {
            row.setAttribute('aria-expanded', 'false')
            li.append(el('ul', { role: 'group' }, build(item.subitems, depth + 1, row)))
            toggle.addEventListener('click', e => {
                e.stopPropagation()
                setExpanded(row, !isExpanded(row))
            })
        }
        row.addEventListener('click', () => {
            row.focus({ preventScroll: true })
            if (item.href) {
                // on desktop also show what is inside; phones close the drawer
                if (hasChildren && !isMobile) setExpanded(row, true)
                onNavigate(item.href)
            } else if (hasChildren) setExpanded(row, !isExpanded(row))
        })
        if (item.href && !byHref.has(item.href)) byHref.set(item.href, row)
        return li
    })

    const tree = el('ul', { class: 'toc-tree', role: 'tree' }, build(toc, 0, null))
    const nested = rows.some(row => row.hasAttribute('aria-expanded'))

    // Expand / collapse everything, for deep tables of contents
    let allExpanded = false
    const toggleAll = el('button', { class: 'toc-toggle-all' }, t('Expand All'))
    toggleAll.addEventListener('click', () => {
        allExpanded = !allExpanded
        for (const row of rows) setExpanded(row, allExpanded)
        toggleAll.textContent = t(allExpanded ? 'Collapse All' : 'Expand All')
        if (!allExpanded && current) reveal(current, false)
    })

    const element = el('div', { class: 'toc' }, nested ? el('div', { class: 'toc-tools' }, toggleAll) : null, tree)

    const reveal = (row, scroll = true) => {
        for (let p = row.parentRow; p; p = p.parentRow) setExpanded(p, true)
        if (scroll && isVisible(row)) row.scrollIntoView({ block: 'nearest' })
    }

    const setCurrentHref = href => {
        const row = byHref.get(href)
        if (!row || row === current) return
        current?.removeAttribute('aria-current')
        current = row
        row.setAttribute('aria-current', 'page')
        rows.forEach(r => r.tabIndex = -1)
        row.tabIndex = 0
        reveal(row)
    }

    // Keyboard: arrows move, Left/Right collapse and expand, Enter opens
    const visibleRows = () => rows.filter(isVisible)
    tree.addEventListener('keydown', e => {
        const row = e.target.closest?.('.toc-row')
        if (!row) return
        const list = visibleRows()
        const i = list.indexOf(row)
        let handled = true
        switch (e.key) {
            case 'ArrowDown': list[i + 1]?.focus(); break
            case 'ArrowUp': list[i - 1]?.focus(); break
            case 'Home': list[0]?.focus(); break
            case 'End': list.at(-1)?.focus(); break
            case 'ArrowRight':
                if (row.hasAttribute('aria-expanded') && !isExpanded(row)) setExpanded(row, true)
                else if (isExpanded(row)) list[i + 1]?.focus()
                break
            case 'ArrowLeft':
                if (isExpanded(row)) setExpanded(row, false)
                else row.parentRow?.focus()
                break
            case 'Enter': row.click(); break
            case ' ':
                if (row.hasAttribute('aria-expanded')) setExpanded(row, !isExpanded(row))
                else row.click()
                break
            default: handled = false
        }
        if (handled) {
            e.preventDefault()
            e.stopPropagation()
        }
    })
    tree.addEventListener('focusin', e => {
        const row = e.target.closest?.('.toc-row')
        if (!row) return
        rows.forEach(r => r.tabIndex = -1)
        row.tabIndex = 0
    })
    if (rows[0]) rows[0].tabIndex = 0

    return { element, setCurrentHref }
}
