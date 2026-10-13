// Book data in the same shape Foliate stores it:
// { metadata, lastLocation, progress: [current, total], annotations, bookmarks }
import { api } from './common.js'

const COVER_WIDTH = 320

export const ensureIdentifier = async (book, path) => {
    book.metadata ??= {}
    book.metadata.identifier ||= await api.bookIdentifier(path)
    return book.metadata.identifier
}

// Metadata may contain non-serializable bits (functions, maps); keep plain JSON
export const plainMetadata = metadata => JSON.parse(JSON.stringify(metadata ?? {}))

const scaleCover = async blob => {
    try {
        const bitmap = await createImageBitmap(blob)
        const ratio = Math.min(1, COVER_WIDTH / bitmap.width)
        const width = Math.round(bitmap.width * ratio)
        const height = Math.round(bitmap.height * ratio)
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')
        // JPEG has no alpha; put transparent covers on white
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, width, height)
        ctx.drawImage(bitmap, 0, 0, width, height)
        bitmap.close?.()
        return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88))
    } catch (e) {
        console.warn('Failed to scale cover', e)
        return blob
    }
}

export const saveCover = async (key, book) => {
    try {
        const blob = await book.getCover?.()
        if (blob) await api.setCover(key, await scaleCover(blob))
    } catch (e) {
        console.warn('Failed to save cover', e)
    }
}

// Add or refresh a book in the library without touching reading data
export const registerBook = async (key, path, book, extra = {}) => {
    const data = (await api.getData(key)) ?? {}
    data.metadata = plainMetadata(book.metadata)
    Object.assign(data, extra)
    await api.setData(key, data)
    await api.setURI(key, path)
    if (!await api.getCover(key)) await saveCover(key, book)
    return data
}
