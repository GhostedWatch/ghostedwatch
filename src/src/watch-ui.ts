// Injects a "👻 Watch" button into each post's and comment's action bar so the user
// can watch OTHER people's content for removal. The button sits alongside the site's
// native actions (permalink · award · save · …) but is clearly marked as ours (ghost
// glyph + GhostedWatch-orange + an instant tooltip). Toggling sends watch-other /
// unwatch-other to the background, which does the polling.
//
// For your OWN posts/comments the button is shown disabled (your content is already
// watched automatically) — detected by the presence of an "edit" control, which only
// the author ever has. The whole feature can be turned off in the options.
//
// Works on threads, user profiles, AND feeds (HOT/NEW/community) — each item's uuids
// are read from links in its own action bar, so there's no dependence on the page URL.
//
// DOM coupling: comment bars are found via the "permalink" link (a[href*="/c/"] whose
// text is "permalink"); post bars via their "share" action (posts have it, comments
// don't), with the post uuid taken from a /p/ link in the bar/block. If the site
// renders those as icons without text, those selectors are what to adjust.
import { NS, APP_NAME, GHOST_PATH } from './constants'
import { uuidToId } from './win-api'
import { uuidFromHref, postUuidFromHref, attachTip, setTip, isRemovedUuid, closestBlock } from './highlight'
import api, { extensionAlive } from './api'
import { getOptions, watchedIds, autoCommentRoom, type OtherItem } from './storage'
import { isRemovalPlaceholder } from './removal-sources'
import { MENU_FULL_NOTE } from './ui-common'

const ACCENT = '#d93a00'
const BTN = `${NS}-watch`
const LABEL = `${NS}-watch-label`

interface WatchCtx {
    id: number
    uuid: string
    type: 'post' | 'comment'
    post_id: number
    post_uuid: string
}

let watched = new Set<number>()
let enabled = true // mirrors the `watchButtons` option
// how many more comments whole-post watches may follow (autoCommentRoom); unknown = room
let autoRoom = Infinity

function send<T = unknown>(msg: unknown): Promise<T> {
    return api.runtime.sendMessage(msg)
}

const text = (el: Element) => (el.textContent || '').trim().toLowerCase()

const GHOST_SVG =
    `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="${GHOST_PATH}"/>` +
    '<circle cx="9.3" cy="10.6" r="1.45" fill="#fff"/><circle cx="14.7" cy="10.6" r="1.45" fill="#fff"/></svg>'

// The tooltip wording. A removed item can only change by being re-approved, so an
// already-removed item is watched FOR re-approval; a visible one, for removal.
export function watchTooltip(on: boolean, type: string, removed: boolean): string {
    const fate = removed ? 're-approved' : 'removed'
    return on
        ? `You're watching this ${type} — ${APP_NAME} will alert you if it's ${fate}. Click to stop.`
        : `Watch this ${type} — ${APP_NAME} will alert you if it's ${fate}.`
}

// Does the comment hosting this action bar currently show a removal placeholder?
// Scans the body column's own children (nested replies are separate sibling columns,
// so they're excluded) — purely from the rendered DOM, no extra request.
function pageShowsRemoved(bar: HTMLElement | null): boolean {
    const body = bar?.parentElement
    if (!body) return false
    for (const child of Array.from(body.children)) {
        if (child === bar) continue // skip the action bar itself
        if (isRemovalPlaceholder((child.textContent || '').trim())) return true
    }
    return false
}

function renderState(btn: HTMLElement, on: boolean): void {
    btn.classList.toggle(`${BTN}-on`, on)
    const label = btn.querySelector(`.${LABEL}`)
    if (label) label.textContent = on ? 'Watching ✓' : 'Watch'
    const type = btn.getAttribute('data-ctype') || 'comment'
    const uuid = btn.getAttribute('data-uuid') || ''
    // a getter so it reflects the item's removal state at hover time — either one we
    // recorded ourselves, or one the page is already showing as removed
    setTip(btn, () => watchTooltip(on, type, isRemovedUuid(uuid) || pageShowsRemoved(btn.parentElement)))
}

function buildButton(ctx: WatchCtx): HTMLElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = BTN
    btn.setAttribute('data-cid', String(ctx.id))
    btn.setAttribute('data-uuid', ctx.uuid)
    btn.setAttribute('data-ctype', ctx.type)
    btn.innerHTML = `${GHOST_SVG}<span class="${LABEL}"></span>`
    attachTip(btn, '') // text is set per state by renderState
    renderState(btn, watched.has(ctx.id))
    btn.addEventListener('click', async e => {
        e.preventDefault()
        e.stopPropagation()
        if (btn.classList.contains(`${BTN}-on`)) {
            // currently watching → stop
            renderState(btn, false)
            watched.delete(ctx.id)
            await send({ action: 'unwatch-other', id: ctx.id })
        } else if (ctx.type === 'post') {
            // posts: ask whether to watch the post only or the whole thread
            showPostMenu(btn, watchComments => start(btn, ctx, watchComments))
        } else {
            start(btn, ctx)
        }
    })
    return btn
}

async function start(btn: HTMLElement, ctx: WatchCtx, watchComments?: boolean): Promise<void> {
    renderState(btn, true) // optimistic
    watched.add(ctx.id)
    // what the tooltip promised: an item the page shows as removed is watched for a re-approval
    const removed = isRemovedUuid(ctx.uuid) || pageShowsRemoved(btn.parentElement)
    await send({ action: 'watch-other', item: { ...ctx, watch_comments: watchComments, removed } })
}

// Small popover for posts: watch just the post, or the post and all its comments.
let openMenu: HTMLElement | null = null
function closeMenu(): void {
    openMenu?.remove()
    openMenu = null
}
function showPostMenu(anchor: HTMLElement, onChoose: (watchComments: boolean) => void): void {
    closeMenu()
    const menu = document.createElement('div')
    menu.className = `${NS}-watch-menu`
    const opt = (label: string, watchComments: boolean) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = `${NS}-watch-mi`
        b.textContent = label
        b.addEventListener('click', ev => {
            ev.stopPropagation()
            closeMenu()
            onChoose(watchComments)
        })
        return b
    }
    menu.append(opt('Watch this post only', false), opt('Watch post + all comments', true))
    if (autoRoom <= 0) {
        // the thread watch still starts, and follows comments once there's room
        const note = document.createElement('div')
        note.className = `${NS}-watch-note`
        note.textContent = MENU_FULL_NOTE
        menu.append(note)
    }
    document.body.appendChild(menu)
    const r = anchor.getBoundingClientRect()
    menu.style.left = `${window.scrollX + r.left}px`
    menu.style.top = `${window.scrollY + r.bottom + 4}px`
    openMenu = menu
    setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0)
}

// Disabled variant shown on the user's own content (already watched automatically).
function buildOwnButton(type: 'post' | 'comment'): HTMLElement {
    const el = document.createElement('span')
    el.className = `${BTN} ${BTN}-own`
    el.innerHTML = `${GHOST_SVG}<span class="${LABEL}">Watch</span>`
    attachTip(el, `This is your own ${type} — ${APP_NAME} already watches your content automatically.`)
    return el
}

// Your own posts/comments carry an "edit" control (others' never do), so that's a
// reliable, username-free signal that the item is yours.
function barHasEdit(bar: HTMLElement): boolean {
    return Array.from(bar.querySelectorAll<HTMLElement>('a, button, span')).some(
        e => e.childElementCount === 0 && text(e) === 'edit',
    )
}

function addButton(bar: HTMLElement, ctx: WatchCtx): void {
    bar.appendChild(barHasEdit(bar) ? buildOwnButton(ctx.type) : buildButton(ctx))
}

function removeAllButtons(): void {
    document.querySelectorAll(`.${BTN}`).forEach(b => b.remove())
}

// Inject a Watch button into the post's and every comment's action bar (once each).
export function injectWatchButtons(): void {
    if (!enabled) return

    // comments: the "permalink" link carries both the comment uuid and its post uuid
    document.querySelectorAll<HTMLAnchorElement>('a[href*="/c/"]').forEach(a => {
        if (text(a) !== 'permalink') return
        const bar = a.parentElement
        if (!bar || bar.querySelector(`.${BTN}`)) return // not a bar, or already added
        const href = a.getAttribute('href') || ''
        const uuid = uuidFromHref(href)
        const postUuid = postUuidFromHref(href)
        if (!uuid || !postUuid) return
        addButton(bar, { id: uuidToId(uuid), uuid, type: 'comment', post_id: uuidToId(postUuid), post_uuid: postUuid })
    })

    // posts: anchor on the "share" action (posts have it, comments don't); the post
    // uuid comes from a /p/ link in the bar (its "N comments" link) or the post block
    document.querySelectorAll<HTMLElement>('a, button, span').forEach(el => {
        if (el.childElementCount !== 0 || text(el) !== 'share') return
        const bar = el.parentElement
        if (!bar || bar.querySelector(`.${BTN}`)) return
        const link =
            bar.querySelector<HTMLAnchorElement>('a[href*="/p/"]') ||
            closestBlock(el, 'post')?.querySelector<HTMLAnchorElement>('a[href*="/p/"]')
        const postUuid = link ? postUuidFromHref(link.getAttribute('href') || '') : null
        if (!postUuid) return
        addButton(bar, {
            id: uuidToId(postUuid),
            uuid: postUuid,
            type: 'post',
            post_id: uuidToId(postUuid),
            post_uuid: postUuid,
        })
    })
}

// Refresh every (enabled) button's on/off state from the authoritative watched-id set.
export function setWatchedIds(ids: number[]): void {
    watched = new Set(ids)
    document.querySelectorAll<HTMLElement>(`.${BTN}:not(.${BTN}-own)`).forEach(btn => {
        renderState(btn, watched.has(Number(btn.getAttribute('data-cid'))))
    })
}

function injectStyles(): void {
    if (document.getElementById(`${NS}-watch-style`)) return
    const style = document.createElement('style')
    style.id = `${NS}-watch-style`
    style.textContent = `
        .${BTN} { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center;
            gap: 4px; color: ${ACCENT}; font: inherit; font-size: 12px; line-height: 1; vertical-align: middle;
            margin-left: 8px; }
        .${BTN}:hover { text-decoration: underline; }
        .${BTN} svg { display: inline-block; flex: none; }
        .${BTN}-on { font-weight: 700; }
        .${BTN}-own { color: #9aa0a6; cursor: default; }
        .${BTN}-own:hover { text-decoration: none; }
        .${NS}-watch-menu { position: absolute; z-index: 2147483647; background: #fff; color: #1a1a1b;
            border: 1px solid #d0d0d0; border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.18);
            overflow: hidden; min-width: 210px;
            font: 500 13px/1.3 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .${NS}-watch-mi { all: unset; display: block; box-sizing: border-box; width: 100%; padding: 10px 13px;
            cursor: pointer; color: #1a1a1b; }
        .${NS}-watch-mi:hover { background: #f0f1f2; }
        .${NS}-watch-note { box-sizing: border-box; width: 0; min-width: 100%; padding: 0 13px 10px;
            font-size: 12px; font-weight: 400; color: #8a5a00; white-space: normal; }
    `
    ;(document.head || document.documentElement).appendChild(style)
}

let observer: MutationObserver | null = null
export async function startWatchButtons(): Promise<void> {
    injectStyles()
    enabled = (await getOptions()).watchButtons !== false
    const resp = await send<{ ids?: number[]; autoRoom?: number }>({ action: 'list-other' })
    watched = new Set(resp?.ids || [])
    autoRoom = resp?.autoRoom ?? Infinity
    // buttons already here were left by a copy orphaned by an extension update, and
    // their clicks go nowhere: replace them
    removeAllButtons()
    injectWatchButtons()
    if (observer) return
    let t: ReturnType<typeof setTimeout>
    observer = new MutationObserver(() => {
        clearTimeout(t)
        t = setTimeout(() => {
            // after an extension update the new copy owns the page; this one stops
            if (extensionAlive()) injectWatchButtons()
            else observer?.disconnect()
        }, 300)
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
    api.storage.onChanged.addListener((changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        // keep the buttons in step with what's watched: an unwatch on the Watching page,
        // the comments a whole-post watch adds, a watch made in another tab
        if (area === 'local' && changes.other_items) {
            const map = (changes.other_items.newValue as Record<string, OtherItem> | undefined) || {}
            setWatchedIds(watchedIds(map))
            autoRoom = autoCommentRoom(map)
        }
        // react live to the options toggle
        if (area !== 'sync' || !changes.options) return
        enabled = (changes.options.newValue as { watchButtons?: boolean } | undefined)?.watchButtons !== false
        if (enabled) injectWatchButtons()
        else removeAllButtons()
    })
}
