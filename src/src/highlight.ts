// In-thread highlighting: when the user is on a site page that shows one of their
// own posts/comments we know is removed, mark it visibly. A MutationObserver re-runs
// the pass as the SPA navigates or the user clicks "load more comments".
import { APP_NAME, NS } from './constants'

// All injected class/attribute names derive from the NS prefix (DRY + distinctive).
const C = {
    removed: `${NS}-removed`,
    banner: `${NS}-banner`,
    tag: `${NS}-tag`,
    word: `${NS}-word`,
    pill: `${NS}-pill`,
    pillHidden: `${NS}-pill-hidden`,
    recovered: `${NS}-recovered`,
    recoveredLabel: `${NS}-recovered-label`,
    tooltip: `${NS}-tooltip`,
    styleId: `${NS}-style`,
}
const DATA_ATTR = `data-${NS}` // records the uuid on a block we've annotated

export interface RemovedLite {
    id: number
    uuid: string
    type: 'post' | 'comment'
    community: string
    removal_source: string
    // true if others can't see it at all (vs. seeing a removal placeholder).
    // Populated for comments by the public-view audit.
    hidden?: boolean
    // the recovered original text/title, shown back on the page below the site's
    // "removed" placeholder when we have it.
    text?: string
    title?: string
}

let removedByUuid = new Map<string, RemovedLite>()
let observer: MutationObserver | null = null

export function setRemovedSet(list: RemovedLite[]): void {
    removedByUuid = new Map(list.map(r => [r.uuid, r]))
    markComments()
}

// Is this uuid currently in our known-removed set? Used to word the Watch tooltip:
// an item that's already removed will next change by being RE-APPROVED, not removed.
export function isRemovedUuid(uuid: string): boolean {
    return removedByUuid.has(uuid)
}

export function uuidFromHref(href: string): string | null {
    // The comment uuid is the LAST `/c/<id>` segment. scored.co paths look like
    // /c/<community>/p/<post>/<slug>/c/<commentUuid>, so matching the first `/c/`
    // would wrongly grab the community name; patriots.win has only one `/c/`.
    const i = href.lastIndexOf('/c/')
    if (i === -1) return null
    const m = href.slice(i + 3).match(/^([0-9A-Za-z]+)/)
    return m ? m[1] : null
}

export function postUuidFromHref(href: string): string | null {
    // A post permalink is /p/<postUuid>/... — take the segment after the first /p/.
    const m = href.match(/\/p\/([0-9A-Za-z]+)/)
    return m ? m[1] : null
}

// Nearest ancestor whose class contains the given whole word ("comment" / "post").
export function closestBlock(el: Element, word: string): HTMLElement | null {
    const re = new RegExp(`(^|\\s)${word}(\\s|$)`)
    let n: Element | null = el
    for (let i = 0; i < 10 && n; i++) {
        n = n.parentElement
        if (n && re.test(n.className || '')) return n as HTMLElement
    }
    return null
}

// The direct child of `parent` that is, or contains, `descendant` — or null if
// `descendant` isn't inside `parent`. On the .win sites a comment block is a flex
// row [vote | body | .child …]; the body (which holds the permalink) is the child
// containing the anchor, and the nested replies are SEPARATE .child columns. So
// outlining the body — not the whole block — hugs just this comment, not its
// replies. Pure (only walks parentElement) so it's unit-tested directly.
export function childContaining(parent: Element, descendant: Element): HTMLElement | null {
    let n: Element | null = descendant
    while (n && n.parentElement && n.parentElement !== parent) n = n.parentElement
    return n && n.parentElement === parent ? (n as HTMLElement) : null
}

// Friendly label for a known removal source, or null if we don't recognize it.
function sourceLabel(source: string): string | null {
    const s = (source || '').toLowerCase()
    if (s.includes('filter')) return 'community filter'
    if (s === 'moderator') return 'moderator'
    if (s === 'nuke') return 'nuke'
    if (s === 'admin') return 'admin'
    return null
}

function buildBanner(rec: RemovedLite): HTMLElement {
    const banner = document.createElement('div')
    banner.className = C.banner

    const tag = document.createElement('span')
    tag.className = C.tag
    tag.textContent = APP_NAME
    attachTip(tag, `Shown by the ${APP_NAME} extension — click for options`)
    tag.addEventListener('click', () => chrome.runtime.sendMessage({ action: 'open-options' }))
    banner.appendChild(tag)

    // always state "removed" explicitly
    const word = document.createElement('span')
    word.className = C.word
    word.textContent = 'removed'
    banner.appendChild(word)

    // who/how, when the site told us a recognizable source
    const label = sourceLabel(rec.removal_source)
    if (label) {
        const pill = document.createElement('span')
        pill.className = C.pill
        pill.textContent = label
        attachTip(pill, `The site reported this as removed by the ${label}.`)
        banner.appendChild(pill)
    }

    if (rec.hidden) {
        const hidden = document.createElement('span')
        hidden.className = `${C.pill} ${C.pillHidden}`
        hidden.textContent = 'hidden from others'
        attachTip(hidden, 'Other users cannot see this at all.')
        banner.appendChild(hidden)
    }
    return banner
}

// The saved original text, shown back on the page below the site's placeholder.
// "Restored" (not "recovered"): we stored it when we first saw it and put it back
// in place. The brand is already on the banner above, so the label stays unbranded.
function buildRecovered(text: string): HTMLElement {
    const box = document.createElement('div')
    box.className = C.recovered
    const label = document.createElement('div')
    label.className = C.recoveredLabel
    label.textContent = 'Restored text'
    const body = document.createElement('div')
    body.textContent = text
    box.appendChild(label)
    box.appendChild(body)
    return box
}

// A custom tooltip — white-on-black, larger text, appears instantly (the native
// HTML title tooltip is slow, small and low-contrast). The text is stored per
// element so it can change after wiring (e.g. Watch → Watching) via setTip.
let tipEl: HTMLElement | null = null
// The text may be a getter, evaluated on hover, so it can reflect state that changes
// after the tooltip is wired (e.g. the item becoming removed).
type TipText = string | (() => string)
const tipText = new WeakMap<HTMLElement, TipText>()
export function setTip(el: HTMLElement, text: TipText): void {
    tipText.set(el, text)
}
export function attachTip(el: HTMLElement, text: TipText): void {
    tipText.set(el, text)
    const bound = el as HTMLElement & { _gwTip?: boolean }
    if (bound._gwTip) return // wire the listeners once; later calls just update the text
    bound._gwTip = true
    const place = () => {
        if (!tipEl) {
            tipEl = document.createElement('div')
            tipEl.className = C.tooltip
            document.body.appendChild(tipEl)
        }
        const t = tipText.get(el)
        tipEl.textContent = (typeof t === 'function' ? t() : t) || ''
        tipEl.style.display = 'block'
        const r = el.getBoundingClientRect()
        tipEl.style.left = `${window.scrollX + r.left}px`
        tipEl.style.top = `${window.scrollY + r.top - tipEl.offsetHeight - 6}px`
    }
    el.addEventListener('mouseenter', () => {
        place()
        requestAnimationFrame(place) // re-place once we know the rendered height
    })
    el.addEventListener('mouseleave', () => {
        if (tipEl) tipEl.style.display = 'none'
    })
}

// Remove banners whose item is no longer known-removed or whose block is gone. The
// SPA reuses/replaces DOM on navigation, so this prevents stale/orphaned tags.
function cleanupBanners(): void {
    document.querySelectorAll<HTMLElement>(`.${C.banner}`).forEach(banner => {
        const block = banner.closest<HTMLElement>(`[${DATA_ATTR}]`)
        const uuid = block?.getAttribute(DATA_ATTR) || ''
        if (!block || !removedByUuid.has(uuid)) {
            banner.remove()
            if (block) {
                block.removeAttribute(DATA_ATTR)
                block.classList.remove(C.removed)
                block.querySelector(`.${C.recovered}`)?.remove()
            }
        }
    })
}

// Mark one matched anchor's removed item. We outline and host the banner on the
// item's own content column (not the whole comment block), so the box surrounds
// only the removed content — never its nested replies. The banner lives inside the
// target so it's removed with it on SPA navigation (no orphans).
function mark(block: HTMLElement, anchor: Element, rec: RemovedLite, uuid: string): void {
    const bs = getComputedStyle(block)
    const blockIsRow = bs.display.includes('flex') && bs.flexDirection.startsWith('row')
    // comment block is a flex row [vote | body | .child replies] → outline the body
    // column only. A post block is vertical and has no nested-reply siblings → it is
    // its own content, so outline the block.
    const target = (blockIsRow && childContaining(block, anchor)) || block
    if (target.querySelector(`.${C.banner}`) || target.classList.contains(C.removed)) return // dedupe
    target.setAttribute(DATA_ATTR, uuid)
    target.classList.add(C.removed)
    target.insertBefore(buildBanner(rec), target.firstChild)

    // Show the recovered original text back on the page, just below the site's
    // "removed" placeholder (i.e. above the action row), when we have it.
    const recovered = rec.type === 'post' ? rec.title : rec.text
    if (recovered && !target.querySelector(`.${C.recovered}`)) {
        const box = buildRecovered(recovered)
        const actions = childContaining(target, anchor) // the action row holding the permalink
        if (actions) target.insertBefore(box, actions)
        else target.appendChild(box)
    }
}

export function markComments(): void {
    cleanupBanners()
    if (removedByUuid.size === 0) return

    // comments: match the comment uuid in /c/<uuid> links, mark the comment block.
    // Treat a missing type as 'comment' so records saved before the type field
    // (and post-time captures) still highlight.
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]').forEach(a => {
        const uuid = uuidFromHref(a.getAttribute('href') || '')
        const rec = uuid ? removedByUuid.get(uuid) : undefined
        if (!rec || rec.type === 'post') return
        const block = closestBlock(a, 'comment')
        if (block) mark(block, a, rec, uuid!)
    })

    // posts: match the post uuid in /p/<uuid> links, mark the post block
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/p/"]').forEach(a => {
        const uuid = postUuidFromHref(a.getAttribute('href') || '')
        const rec = uuid ? removedByUuid.get(uuid) : undefined
        if (!rec || rec.type !== 'post') return
        const block = closestBlock(a, 'post')
        if (block) mark(block, a, rec, uuid!)
    })
}

function injectStyles(): void {
    if (document.getElementById(C.styleId)) return
    const style = document.createElement('style')
    style.id = C.styleId
    style.textContent = `
        .${C.removed} { outline: 2px solid #d93a00 !important; outline-offset: 1px; border-radius: 4px;
            padding-left: 12px !important; padding-right: 8px !important; }
        .${C.banner} { all: unset; display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box;
            align-self: flex-start; width: fit-content; max-width: 100%; background: #d93a00; color: #fff;
            font: 600 12px/1.35 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 3px 6px; border-radius: 4px; margin: 4px 0 6px; }
        .${C.tag} { display: inline-block; background: rgba(0,0,0,0.28); border-radius: 3px;
            padding: 0 5px; font-size: 10px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 0.04em; cursor: pointer; }
        .${C.tag}:hover { background: rgba(0,0,0,0.45); }
        .${C.word} { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em; }
        .${C.pill} { display: inline-block; background: #fff; color: #b3122e; border-radius: 3px;
            padding: 0 6px; font-size: 11px; font-weight: 700; cursor: help; }
        .${C.pillHidden} { background: #2a0a0a; color: #fff; cursor: help; }
        .${C.recovered} { all: unset; display: block; box-sizing: border-box; margin: 2px 0 8px;
            padding: 8px 11px; background: rgba(217,58,0,0.07);
            border-radius: 5px; font: 400 14px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #1a1a1b; white-space: pre-wrap; word-break: break-word; }
        .${C.recoveredLabel} { display: block; font-size: 10px; font-weight: 700; text-transform: uppercase;
            letter-spacing: 0.04em; color: #d93a00; margin-bottom: 3px; }
        .${C.tooltip} { position: absolute; z-index: 2147483647; display: none; pointer-events: none;
            background: #111; color: #fff; font: 500 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            padding: 6px 9px; border-radius: 6px; max-width: 320px; box-shadow: 0 2px 8px rgba(0,0,0,0.35); }
    `
    ;(document.head || document.documentElement).appendChild(style)
}

export function startHighlighting(): void {
    injectStyles()
    if (observer) return
    let t: ReturnType<typeof setTimeout>
    observer = new MutationObserver(() => {
        clearTimeout(t)
        t = setTimeout(markComments, 300)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
}
