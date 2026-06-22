import type { CommentStatus, ItemType } from './win-api'
import { DEFAULT_ORIGIN } from './common'

// Storage layout. Only tiny `options` lives in chrome.storage.sync — sync has an
// 8KB-per-item limit, and the removed/changes maps (which hold recovered text)
// blow past it. Everything else uses chrome.storage.local (10MB, no per-item cap).
//   local.removed, local.changes, local.own_items, local.notified_ids,
//   local.notif_targets, local.last_*, local.backfilled_users
//   sync.options

// One of the user's own comments we've seen (via post-time capture or the
// authenticated profile poll), plus the state needed to detect a removal.
export interface OwnItem {
    id: number
    uuid: string
    type: ItemType
    title: string // post title (posts only)
    post_id: number // numeric post id; used to build permalinks / fetch the thread
    post_uuid: string // base62 post id; used to build permalinks
    community: string
    created: number
    // best-known text: captured at post time, or recovered later. '' if unknown.
    text: string
    // last observed removal state from the profile poll
    is_removed: boolean
    removal_source: string
    // consecutive removed observations, for confirmation before alerting
    removal_count: number
    // consecutive visible observations while recorded-removed, for confirming a
    // re-approval (symmetric with removal_count — see applyProfileObservation)
    visible_count: number
    // whether this removal has already been recorded + notified
    recorded: boolean
}

export interface RemovedRecord {
    id: number
    uuid: string
    type: ItemType
    post_uuid: string
    community: string
    title: string
    text: string
    text_loading: boolean // true while we still need to recover the content
    status: CommentStatus
    removal_source: string
    created: number // when the item was posted (ms); for the created→removed interval
    observed_utc: number // when the removal was observed (ms)
    unseen: boolean
    // 'own' (default) = your own content; 'other' = someone else's comment you chose
    // to watch — those carry the author so the UI can attribute them.
    source?: 'own' | 'other'
    author?: string
    // set when a recorded removal later becomes visible again (re-approved); ms
    reapproved_utc?: number
    // set by the anonymous public-view audit:
    audited?: boolean // we've checked what a logged-out visitor sees
    hidden?: boolean // others can't see the comment at all (vs. a removal placeholder)
}

// A post or comment authored by SOMEONE ELSE that the user chose to watch for removal.
// Unlike OwnItem (your own content, detected via the authenticated profile feed), these
// are detected from the public post thread — for a watched post, post.json returns the
// post's own is_removed; for a watched comment, it's in the thread's comment list. We
// keep the text we saw while it was still visible (so a later removal can show "here's
// what it said" — no /raw).
export interface OtherItem {
    id: number
    uuid: string
    type: ItemType
    post_id: number
    post_uuid: string
    author: string
    community: string
    created: number
    title: string // post title (posts only); '' for comments
    text: string // body text, captured while visible at watch time
    watched_at: number
    // detection state (same anti-flap hysteresis as OwnItem)
    is_removed: boolean
    removal_source: string
    removal_count: number
    visible_count: number
    recorded: boolean
    // whole-post watch: on a type:'post' item, also watch every comment in its thread
    watch_comments?: boolean
    // this comment was auto-added by a whole-post watch (vs. clicked individually);
    // removed when its parent whole-post watch is dropped
    auto?: boolean
}

export interface Options {
    interval: number // minutes
    watchButtons: boolean // show the in-page "Watch" buttons on posts/comments
    // 'each' = a notification per group of events; 'summary' = one digest per check
    notifyMode: 'each' | 'summary'
}

export const INTERVAL_DEFAULT = 1
export const MAX_OWN = 500
export const MAX_REMOVED = 200
export const MAX_CHANGES = 100
// Watching other users' comments: cap how many can be watched, and how many distinct
// posts we'll fetch per cycle (each post = one request covering all watched comments
// in it). Beyond the per-cycle budget we round-robin so the site isn't hammered.
export const MAX_OTHER = 200
export const OTHER_POSTS_PER_CYCLE = 20
// Require this many consecutive "removed" observations before notifying, to ride
// out transient API failures / thread paging quirks.
export const REMOVAL_CONFIRM_THRESHOLD = 2
// Symmetrically, require this many consecutive "visible again" observations before
// declaring a recorded removal re-approved. This is the key anti-flap guard: a lone
// transient "looks visible" blip never fires a re-approval (and never resets the
// recorded state), so it can't cause remove/re-approve notification storms.
export const REAPPROVAL_CONFIRM_THRESHOLD = 2

export const DEFAULT_OPTIONS: Options = { interval: INTERVAL_DEFAULT, watchButtons: true, notifyMode: 'each' }

function localGet<T>(key: string, fallback: T): Promise<T> {
    return new Promise(resolve => {
        chrome.storage.local.get([key], res => resolve((res[key] as T) ?? fallback))
    })
}
function localSet(obj: Record<string, unknown>): Promise<void> {
    return new Promise(resolve => chrome.storage.local.set(obj, () => resolve()))
}
function syncGet<T>(key: string, fallback: T): Promise<T> {
    return new Promise(resolve => {
        chrome.storage.sync.get([key], res => resolve((res[key] as T) ?? fallback))
    })
}
function syncSet(obj: Record<string, unknown>): Promise<void> {
    return new Promise(resolve => chrome.storage.sync.set(obj, () => resolve()))
}

// --- auth (so the background can poll the API without an open tab) ---
// Captured by the content script from the site's localStorage when you have a .win
// tab open; the header tokens authenticate independently of cookies.
export interface Auth {
    user: string
    origin: string
    apiKey: string
    apiSecret: string
}
export async function getAuth(): Promise<Auth | null> {
    const a = await localGet<Auth | null>('auth', null)
    return a && a.user && a.origin && a.apiKey ? a : null
}
export function setAuth(auth: Auth): Promise<void> {
    // Track where the user is active so permalinks/notification targets use the
    // origin they actually logged into (patriots.win vs scored.co), not a default.
    return localSet({ auth, last_origin: auth.origin })
}

// --- options ---
export async function getOptions(): Promise<Options> {
    const stored = await syncGet<Partial<Options>>('options', {})
    return { ...DEFAULT_OPTIONS, ...stored }
}
export function setOptions(options: Options): Promise<void> {
    return syncSet({ options })
}

// --- own items (your authored posts/comments) ---
export function getOwnItems(): Promise<Record<string, OwnItem>> {
    return localGet<Record<string, OwnItem>>('own_items', {})
}
export function setOwnItems(map: Record<string, OwnItem>): Promise<void> {
    return localSet({ own_items: map })
}

// Record a post or comment captured at post time (gives us its text/title up front).
export async function addOwnItem(
    c: Pick<OwnItem, 'id' | 'uuid' | 'type' | 'title' | 'post_id' | 'post_uuid' | 'community' | 'created' | 'text'>,
): Promise<void> {
    const map = await getOwnItems()
    const key = String(c.id)
    if (map[key]) {
        if (c.text && !map[key].text) map[key].text = c.text
        if (c.title && !map[key].title) map[key].title = c.title
    } else {
        map[key] = { ...c, is_removed: false, removal_source: '', removal_count: 0, visible_count: 0, recorded: false }
    }
    await setOwnItems(trimOwnItems(map))
}

export function trimOwnItems(map: Record<string, OwnItem>): Record<string, OwnItem> {
    const entries = Object.values(map).sort((a, b) => b.created - a.created)
    const trimmed: Record<string, OwnItem> = {}
    for (const e of entries.slice(0, MAX_OWN)) trimmed[String(e.id)] = e
    return trimmed
}

// --- other items (someone else's posts/comments the user chose to watch) ---
export function getOtherItems(): Promise<Record<string, OtherItem>> {
    return localGet<Record<string, OtherItem>>('other_items', {})
}
export function setOtherItems(map: Record<string, OtherItem>): Promise<void> {
    return localSet({ other_items: map })
}
// Start watching a post or comment (captured from the visible page). For a post,
// `watch_comments` also watches every comment in its thread. Updates the flag if
// already watched (e.g. upgrading post-only → post + comments).
export async function addOtherItem(
    c: Pick<
        OtherItem,
        'id' | 'uuid' | 'type' | 'post_id' | 'post_uuid' | 'author' | 'community' | 'created' | 'title' | 'text'
    > & { watch_comments?: boolean },
): Promise<void> {
    const map = await getOtherItems()
    const key = String(c.id)
    if (map[key]) {
        if (c.watch_comments) map[key].watch_comments = true // upgrade to whole-post
    } else {
        map[key] = {
            ...c,
            watched_at: Date.now(),
            is_removed: false,
            removal_source: '',
            removal_count: 0,
            visible_count: 0,
            recorded: false,
        }
    }
    // cap: drop the oldest-watched if over the limit
    const entries = Object.values(map).sort((a, b) => b.watched_at - a.watched_at)
    const trimmed: Record<string, OtherItem> = {}
    for (const e of entries.slice(0, MAX_OTHER)) trimmed[String(e.id)] = e
    await setOtherItems(trimmed)
}
export async function removeOtherItem(id: number): Promise<void> {
    const map = await getOtherItems()
    const w = map[String(id)]
    if (!w) return
    delete map[String(id)]
    // dropping a whole-post watch also drops the comments it auto-added
    if (w.type === 'post' && w.watch_comments) {
        for (const [k, v] of Object.entries(map)) if (v.auto && v.post_id === w.id) delete map[k]
    }
    await setOtherItems(map)
}
// Toggle a watched post's "also watch every comment" flag in place. Turning it off
// drops the comments that whole-post watch had auto-added; turning it on lets the
// next cycle pick them up.
export async function setWatchComments(id: number, watch_comments: boolean): Promise<void> {
    const map = await getOtherItems()
    const w = map[String(id)]
    if (!w || w.type !== 'post') return
    w.watch_comments = watch_comments
    if (!watch_comments) {
        for (const [k, v] of Object.entries(map)) if (v.auto && v.post_id === w.id) delete map[k]
    }
    await setOtherItems(map)
}
// Just the ids, for the content script to render each comment's button state.
export async function getOtherIds(): Promise<number[]> {
    return Object.values(await getOtherItems()).map(w => w.id)
}
// Round-robin cursor so we poll a different slice of watched posts each cycle.
export function getOtherCursor(): Promise<number> {
    return localGet<number>('watch_cursor', 0)
}
export function setOtherCursor(n: number): Promise<void> {
    return localSet({ watch_cursor: n })
}

// --- watch sources (a whole user's history, or a community feed) ---
// Each source is one polling unit (1 request/cycle): a user's public profile feed, or
// a community's NEW feed. We keep per-item state so removals are detected by diffing
// against what was visible last time (see runSourceCycle). `items` reuses OtherItem.
export interface WatchSource {
    key: string // 'user:<name>' or 'feed:<community>'
    kind: 'user' | 'feed'
    name: string // username or community
    added: number
    items: Record<string, OtherItem>
}
export const MAX_SOURCES = 50
export const MAX_SOURCE_ITEMS = 200
export const SOURCES_PER_CYCLE = 10

export function sourceKey(kind: 'user' | 'feed', name: string): string {
    return `${kind}:${name.toLowerCase()}`
}
export function getSources(): Promise<Record<string, WatchSource>> {
    return localGet<Record<string, WatchSource>>('watch_sources', {})
}
export function setSources(map: Record<string, WatchSource>): Promise<void> {
    return localSet({ watch_sources: map })
}
export async function addSource(kind: 'user' | 'feed', name: string): Promise<void> {
    const map = await getSources()
    const key = sourceKey(kind, name)
    if (!map[key]) {
        map[key] = { key, kind, name, added: Date.now(), items: {} }
        // cap: drop the oldest-added source if over the limit
        const entries = Object.values(map).sort((a, b) => b.added - a.added)
        const trimmed: Record<string, WatchSource> = {}
        for (const e of entries.slice(0, MAX_SOURCES)) trimmed[e.key] = e
        await setSources(trimmed)
    }
}
export async function removeSource(key: string): Promise<void> {
    const map = await getSources()
    if (map[key]) {
        delete map[key]
        await setSources(map)
    }
}
export async function getSourceKeys(): Promise<string[]> {
    return Object.keys(await getSources())
}
export function getSourceCursor(): Promise<number> {
    return localGet<number>('source_cursor', 0)
}
export function setSourceCursor(n: number): Promise<void> {
    return localSet({ source_cursor: n })
}

// --- removed records ---
export function getRemoved(): Promise<Record<string, RemovedRecord>> {
    return localGet<Record<string, RemovedRecord>>('removed', {})
}
export async function addRemovedRecord(rec: RemovedRecord): Promise<void> {
    const map = await getRemoved()
    map[String(rec.id)] = rec
    const entries = Object.values(map).sort((a, b) => b.observed_utc - a.observed_utc)
    const trimmed: Record<string, RemovedRecord> = {}
    for (const e of entries.slice(0, MAX_REMOVED)) trimmed[String(e.id)] = e
    await localSet({ removed: trimmed })
}
export async function markAllRemovedSeen(): Promise<void> {
    const map = await getRemoved()
    for (const k of Object.keys(map)) map[k].unseen = false
    await localSet({ removed: map })
}
export async function getUnseenCount(): Promise<number> {
    const map = await getRemoved()
    return Object.values(map).filter(r => r.unseen).length
}
// Removed items we haven't yet checked against the logged-out view, with the type
// so the content script can pick the right public endpoint (comment/thread vs post).
export async function getRemovedNeedingAudit(limit = 10): Promise<Array<{ id: number; type: ItemType }>> {
    const map = await getRemoved()
    return Object.values(map)
        .filter(r => !r.audited && !r.reapproved_utc)
        .slice(0, limit)
        .map(r => ({ id: r.id, type: r.type === 'post' ? 'post' : 'comment' }))
}
// A recorded removal became visible again. Keep it in history (so the lifecycle is
// shown) but stamp the re-approval time, flip its status to live, and mark it
// audited so it's neither re-audited nor highlighted in-page anymore.
export async function markReapproved(id: number, ts: number): Promise<void> {
    const map = await getRemoved()
    const k = String(id)
    if (map[k]) {
        map[k].reapproved_utc = ts
        map[k].status = 'live'
        map[k].audited = true
        map[k].unseen = true
        await localSet({ removed: map })
    }
}
// Backfill removal_source onto existing records that lack it (older records, or
// ones first detected via blanked content before the source was known).
export async function fillRemovedSources(sources: Record<string, string>): Promise<void> {
    const map = await getRemoved()
    let changed = false
    for (const [id, src] of Object.entries(sources)) {
        if (src && map[id] && !map[id].removal_source) {
            map[id].removal_source = src
            changed = true
        }
    }
    if (changed) await localSet({ removed: map })
}
// Apply the result of the anonymous public-view audit.
export async function setRemovedAudit(id: number, hidden: boolean): Promise<void> {
    const map = await getRemoved()
    const k = String(id)
    if (map[k]) {
        map[k].audited = true
        map[k].hidden = hidden
        await localSet({ removed: map })
    }
}
// False-positive correction: the comment is publicly visible after all. Drop the
// record and reset its tracked state so a genuine future removal still registers.
export async function unrecordRemoval(id: number): Promise<void> {
    const map = await getRemoved()
    if (map[String(id)]) {
        delete map[String(id)]
        await localSet({ removed: map })
    }
    const tracked = await getOwnItems()
    const t = tracked[String(id)]
    if (t) {
        t.is_removed = false
        t.removal_count = 0
        t.recorded = false
        await setOwnItems(tracked)
    }
}
// ids of removed COMMENTS whose text we never captured (backlog) — candidates for
// author-view recovery via the authenticated comment/thread endpoint. Posts get
// their title/body from the profile feed directly, so they're excluded.
export async function getRemovedMissingTextIds(limit = 10): Promise<number[]> {
    const map = await getRemoved()
    return Object.values(map)
        .filter(r => r.type !== 'post' && !r.text)
        .slice(0, limit)
        .map(r => r.id)
}
export async function setRemovedText(id: number, text: string): Promise<void> {
    const map = await getRemoved()
    const k = String(id)
    if (map[k] && !map[k].text) {
        map[k].text = text
        await localSet({ removed: map })
    }
}

// --- change log ---
export interface ChangeEntry {
    id: number
    status: CommentStatus
    ts: number
    community: string
}
export async function pushChange(entry: ChangeEntry): Promise<void> {
    const log = await localGet<ChangeEntry[]>("changes", [])
    log.unshift(entry)
    await localSet({ changes: log.slice(0, MAX_CHANGES) })
}
export function getChanges(): Promise<ChangeEntry[]> {
    return localGet<ChangeEntry[]>("changes", [])
}

// --- notify-once-ever guard ---
// Ids we've already fired a notification for. Persisted and never cleared, so a
// removal notifies exactly once even if its record is later dropped + re-detected
// (e.g. by the public-view audit) or the tracked map is reset.
export async function getNotifiedIds(): Promise<number[]> {
    return localGet<number[]>('notified_ids', [])
}
export async function addNotifiedIds(ids: number[]): Promise<void> {
    const set = new Set(await getNotifiedIds())
    for (const id of ids) set.add(id)
    let arr = [...set]
    if (arr.length > 5000) arr = arr.slice(arr.length - 5000) // cap
    await localSet({ notified_ids: arr })
}
// Clear the notify-once flag for ids (used on re-approval) so that if the same item
// is removed again later, that fresh removal notifies again.
export async function removeNotifiedIds(ids: number[]): Promise<void> {
    const set = new Set(await getNotifiedIds())
    let changed = false
    for (const id of ids) changed = set.delete(id) || changed
    if (changed) await localSet({ notified_ids: [...set] })
}

// --- notification click targets ---
// What a notification should open when clicked, keyed by notification id.
export interface NotifTarget {
    uuid: string
    post_uuid: string
    type: ItemType
}
export async function setNotifTargets(id: string, targets: NotifTarget[]): Promise<void> {
    const m = await localGet<Record<string, NotifTarget[]>>('notif_targets', {})
    m[id] = targets
    const keys = Object.keys(m)
    if (keys.length > 30) delete m[keys[0]] // cap
    await localSet({ notif_targets: m })
}
export async function getNotifTargets(id: string): Promise<NotifTarget[]> {
    const m = await localGet<Record<string, NotifTarget[]>>('notif_targets', {})
    return m[id] || []
}

// --- misc local state ---
export function getLoggedInUser(): Promise<string> {
    return localGet<string>('last_logged_in_user', '')
}
export function setLoggedInUser(user: string): Promise<void> {
    return localSet({ last_logged_in_user: user })
}
// the .win origin where the user is active/logged in (for permalinks + context)
export function getLastOrigin(): Promise<string> {
    return localGet<string>('last_origin', DEFAULT_ORIGIN)
}
export function setLastOrigin(origin: string): Promise<void> {
    return localSet({ last_origin: origin })
}
// Whether we've done the one-time full-history backfill for a user. After that,
// ongoing monitoring only needs the first page of their profile.
export async function isBackfilled(user: string): Promise<boolean> {
    const m = await localGet<Record<string, boolean>>('backfilled_users', {})
    return !!m[user]
}
export async function markBackfilled(user: string): Promise<void> {
    const m = await localGet<Record<string, boolean>>('backfilled_users', {})
    m[user] = true
    await localSet({ backfilled_users: m })
}
export function setLastCheck(ts: number): Promise<void> {
    return localSet({ last_check: ts })
}
export function getLastCheck(): Promise<number> {
    return localGet<number>('last_check', 0)
}
// last time the alarm actually fired — used by the alarm watchdog
export function setLastAlarm(ts: number): Promise<void> {
    return localSet({ last_alarm: ts })
}
export function getLastAlarm(): Promise<number> {
    return localGet<number>('last_alarm', 0)
}
