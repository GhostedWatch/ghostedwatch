import type { RemovedRecord } from './storage'
import { removalSourceLabel } from './removal-sources'
import { GHOST_PATH } from './constants'
import { fullTimestamp } from './time'

// A shareable "removal card" image, generated entirely in the browser (no upload):
// the SVG is pure + unit-tested; downloadCard() rasterizes it to a PNG the user saves.

// Word-wrap into lines of at most `maxChars`, hard-breaking over-long words.
export function wrapLines(text: string, maxChars: number): string[] {
    const lines: string[] = []
    let cur = ''
    for (const word of text.replace(/\s+/g, ' ').trim().split(' ')) {
        if (!word) continue
        cur = cur && (cur + ' ' + word).length > maxChars ? (lines.push(cur), word) : cur ? cur + ' ' + word : word
        while (cur.length > maxChars) {
            lines.push(cur.slice(0, maxChars))
            cur = cur.slice(maxChars)
        }
    }
    if (cur) lines.push(cur)
    return lines
}

const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const FONT = "Arial, Helvetica, sans-serif"

export function removalCardSVG(rec: RemovedRecord): string {
    const W = 1000
    const pad = 56
    const isPost = rec.type === 'post'
    const content = isPost ? rec.title || '(title unavailable)' : rec.text || '(text unavailable)'
    const lines = wrapLines(content, 58).slice(0, 12)
    const lineH = 38
    const textTop = 232
    const H = textTop + lines.length * lineH + 70
    const source = removalSourceLabel(rec.removal_source)
    const who = `${isPost ? 'post' : 'comment'}${rec.author ? ` by ${rec.author}` : ''} · c/${rec.community}`
    const body = lines
        .map((l, i) => `<text x="${pad}" y="${textTop + i * lineH}" fill="#fff" font-size="28" font-family="${FONT}">${esc(l)}</text>`)
        .join('')
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
        `<rect width="${W}" height="${H}" rx="20" fill="#0f0f12"/>` +
        `<g transform="translate(${pad} 40) scale(1.5)"><path fill="#d93a00" d="${GHOST_PATH}"/>` +
        `<circle cx="12" cy="7" r="4" fill="#fff"/><circle cx="12" cy="7" r="2" fill="#15151a"/></g>` +
        `<text x="${pad + 56}" y="78" fill="#fff" font-size="32" font-weight="800" font-family="${FONT}">GhostedWatch</text>` +
        `<rect x="${pad}" y="120" width="142" height="40" rx="6" fill="#d93a00"/>` +
        `<text x="${pad + 16}" y="148" fill="#fff" font-size="22" font-weight="700" font-family="${FONT}">REMOVED</text>` +
        `<text x="${pad + 162}" y="148" fill="#ff7a4d" font-size="22" font-weight="700" font-family="${FONT}">${esc(source)}</text>` +
        `<text x="${pad}" y="196" fill="#b9b9c4" font-size="22" font-family="${FONT}">${esc(who)}</text>` +
        body +
        `<text x="${pad}" y="${H - 32}" fill="#6f6f7b" font-size="19" font-family="${FONT}">${esc(fullTimestamp(rec.observed_utc))} · ghostedwatch.com</text>` +
        `</svg>`
    )
}

// Rasterize the card to a PNG and trigger a download (browser only).
export async function downloadCard(rec: RemovedRecord): Promise<void> {
    const svg = removalCardSVG(rec)
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('card render failed'))
        img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
    })
    const scale = 2 // crisp on retina
    const canvas = document.createElement('canvas')
    canvas.width = img.width * scale
    canvas.height = img.height * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(scale, scale)
    ctx.drawImage(img, 0, 0)
    const blob: Blob | null = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
    if (!blob) return
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `ghostedwatch-removal-${rec.id}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}
