import type { CommentStatus, ItemType } from './win-api'
import { DEFAULT_ORIGIN } from './common'
import api from './api'

// Storage layout. Only tiny `options` lives in chrome.storage.sync — sync has an
// 8KB-per-item limit, and the removed/changes maps (which hold recovered text)
// blow past it. Everything else uses chrome.storage.local (10MB, no per-item cap).
//   local.removed, local.changes, local.own_items, local.notified_ids,
//   local.notif_targets, local.last_*, local.backfilled_users, local.deep_checked, local.auth,
//   local.session_checks
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
    // text recoveries and public-view audits that came back empty or failed (poller.ts)
    text_attempts?: number
    audit_attempts?: number
    // found by a read of older pages (the first-run history scan, or the 6-hourly read
    // past page 1): observed_utc is when that read ran, not when the item was removed,
    // so timings leave it out
    backfill?: boolean
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
    // a comment the user stopped watching inside a whole-post watch: kept, so the thread
    // watch doesn't add it back, but never checked or alerted on
    muted?: boolean
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
// a whole-post watch follows at most this many of a thread's comments
export const MAX_AUTO_PER_POST = 300
// and all whole-post watches together at most this many. An auto-added comment with its
// text is about 0.6 KB, and without this, 200 thread watches could hold 60,000 of them,
// far past Chrome's 10 MB storage.local quota, where every write to storage.local fails.
// 3,000 is about 2 MB, leaving room for full watch sources (50 × 200 items) and the rest.
export const MAX_AUTO_TOTAL = 3000
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
    return api.storage.local.get([key]).then(res => (res[key] as T) ?? fallback)
}
function localSet(obj: Record<string, unknown>): Promise<void> {
    return api.storage.local.set(obj).then(() => undefined)
}
function syncGet<T>(key: string, fallback: T): Promise<T> {
    return api.storage.sync.get([key]).then(res => (res[key] as T) ?? fallback)
}
function syncSet(obj: Record<string, unknown>): Promise<void> {
    return api.storage.sync.set(obj).then(() => undefined)
}

// One read-modify-write at a time per local key. Every write to storage.local happens
// in the background (pages and content scripts only read it, or ask the background by
// message), so queueing here keeps two writers from interleaving: a check cycle's write
// can't undo a watch or an unwatch that landed while it was busy.
const queues = new Map<string, Promise<unknown>>()
function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) || Promise.resolve()).then(fn)
    queues.set(key, run.catch(() => undefined))
    return run
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
    // Queued with forgetAuth, so a session stored while a refused one is being
    // forgotten isn't wiped along with it.
    return locked('auth', () => localSet({ auth, last_origin: auth.origin }))
}
// The site refused the stored session: forget it, unless a newer one arrived meanwhile
// (any other key or secret). With no session the popup shows "Disconnected" and asks
// you to log in again.
export function forgetAuth(refused: { apiKey: string; apiSecret: string }): Promise<void> {
    return locked('auth', async () => {
        const a = await localGet<Auth | null>('auth', null)
        if (a?.apiKey === refused.apiKey && a?.apiSecret === refused.apiSecret) await localSet({ auth: null })
    })
}
// When the poller next asks the site whose session this is, per API key. Tabs signed in
// on two sites hand the stored session back and forth, and each session keeps its own
// turn. An entry that is already due means the same as none, so writes drop those.
export async function getSessionCheckDue(apiKey: string): Promise<number> {
    const due = await localGet<Record<string, number>>('session_checks', {})
    return due[apiKey] || 0
}
export function setSessionCheckDue(apiKey: string, at: number): Promise<void> {
    return locked('session_checks', async () => {
        const due = await localGet<Record<string, number>>('session_checks', {})
        const now = Date.now()
        for (const k of Object.keys(due)) if (!(due[k] > now)) delete due[k]
        due[apiKey] = at
        await localSet({ session_checks: due })
    })
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
// Change the own-items map in one queued read-modify-write; `fn` returns the map to store.
export function updateOwnItems(fn: (map: Record<string, OwnItem>) => Record<string, OwnItem>): Promise<void> {
    return locked('own_items', async () => setOwnItems(fn(await getOwnItems())))
}

// Record a post or comment captured at post time (gives us its text/title up front).
export function addOwnItem(
    c: Pick<OwnItem, 'id' | 'uuid' | 'type' | 'title' | 'post_id' | 'post_uuid' | 'community' | 'created' | 'text'>,
): Promise<void> {
    return updateOwnItems(map => {
        const key = String(c.id)
        if (map[key]) {
            if (c.text && !map[key].text) map[key].text = c.text
            if (c.title && !map[key].title) map[key].title = c.title
        } else {
            map[key] = { ...c, is_removed: false, removal_source: '', removal_count: 0, visible_count: 0, recorded: false }
        }
        return trimOwnItems(map)
    })
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
// Change the watched-items map in one queued read-modify-write (`fn` edits it in place).
export function updateOtherItems(fn: (map: Record<string, OtherItem>) => void): Promise<void> {
    return locked('other_items', async () => {
        const map = await getOtherItems()
        fn(map)
        await setOtherItems(capOtherItems(map))
    })
}
// Cap the watches the user made at MAX_OTHER, newest first. The comments a whole-post
// watch added go with their post: they don't count toward the cap, so they can't push
// out a watch the user made (the post itself included), and they leave with it.
export function capOtherItems(map: Record<string, OtherItem>): Record<string, OtherItem> {
    const kept = new Set(
        Object.values(map)
            .filter(w => !w.auto)
            .sort((a, b) => b.watched_at - a.watched_at)
            .slice(0, MAX_OTHER)
            .map(w => w.id),
    )
    const out: Record<string, OtherItem> = {}
    for (const [k, w] of Object.entries(map)) if (kept.has(w.auto ? w.post_id : w.id)) out[k] = w
    return out
}
// Start watching a post or comment (captured from the visible page). For a post,
// `watch_comments` also watches every comment in its thread. Updates the flag if
// already watched (e.g. upgrading post-only → post + comments). An item that was
// already removed when the user clicked starts out recorded as removed: its next
// change is a re-approval, so an old removal isn't reported as a new one.
export function addOtherItem(
    c: Pick<
        OtherItem,
        'id' | 'uuid' | 'type' | 'post_id' | 'post_uuid' | 'author' | 'community' | 'created' | 'title' | 'text'
    > & { watch_comments?: boolean; is_removed?: boolean; removal_source?: string },
): Promise<void> {
    return updateOtherItems(map => {
        const key = String(c.id)
        const w = map[key]
        if (w) {
            // a Watch click on a comment a whole-post watch covers makes it the user's own watch
            w.auto = false
            w.muted = false
            if (c.watch_comments) w.watch_comments = true // upgrade to whole-post
        } else {
            const removed = c.is_removed === true
            map[key] = {
                ...c,
                watched_at: Date.now(),
                is_removed: removed,
                removal_source: c.removal_source || '',
                removal_count: 0,
                visible_count: 0,
                recorded: removed,
            }
        }
    })
}
export function removeOtherItem(id: number): Promise<void> {
    return updateOtherItems(map => {
        const w = map[String(id)]
        if (!w) return
        const parent = map[String(w.post_id)]
        if (w.type === 'comment' && parent?.type === 'post' && parent.watch_comments) {
            // its post's whole-thread watch would add it straight back: keep it, muted
            w.auto = true
            w.muted = true
            return
        }
        delete map[String(id)]
        // dropping a whole-post watch also drops the comments it auto-added
        if (w.type === 'post' && w.watch_comments) {
            for (const [k, v] of Object.entries(map)) if (v.auto && v.post_id === w.id) delete map[k]
        }
    })
}
// Toggle a watched post's "also watch every comment" flag in place. Turning it off
// drops the comments that whole-post watch had auto-added; turning it on lets the
// next cycle pick them up.
export function setWatchComments(id: number, watch_comments: boolean): Promise<void> {
    return updateOtherItems(map => {
        const w = map[String(id)]
        if (!w || w.type !== 'post') return
        w.watch_comments = watch_comments
        if (!watch_comments) {
            for (const [k, v] of Object.entries(map)) if (v.auto && v.post_id === w.id) delete map[k]
        }
    })
}
// How many more comments whole-post watches may add, across all threads (MAX_AUTO_TOTAL).
// At 0, a thread watch follows no new comments until one is dropped, which the Watching
// page and the in-page post menu say.
export function autoCommentRoom(map: Record<string, OtherItem>): number {
    return Math.max(0, MAX_AUTO_TOTAL - Object.values(map).filter(v => v.auto).length)
}
// The ids the in-page Watch buttons show as watched (muted comments aren't).
export function watchedIds(map: Record<string, OtherItem>): number[] {
    return Object.values(map)
        .filter(w => !w.muted)
        .map(w => w.id)
}
// Just the ids, for the content script to render each comment's button state.
export async function getOtherIds(): Promise<number[]> {
    return watchedIds(await getOtherItems())
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
// Change the sources map in one queued read-modify-write (`fn` edits it in place).
export function updateSources(fn: (map: Record<string, WatchSource>) => void): Promise<void> {
    return locked('watch_sources', async () => {
        const map = await getSources()
        fn(map)
        await setSources(map)
    })
}
export function addSource(kind: 'user' | 'feed', name: string): Promise<void> {
    return locked('watch_sources', async () => {
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
    })
}
export function removeSource(key: string): Promise<void> {
    return locked('watch_sources', async () => {
        const map = await getSources()
        if (map[key]) {
            delete map[key]
            await setSources(map)
        }
    })
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
// Change the removed-records map in one queued read-modify-write. `fn` edits it in
// place and returns false when nothing changed (nothing is written then).
function updateRemoved(fn: (map: Record<string, RemovedRecord>) => boolean | void): Promise<void> {
    return locked('removed', async () => {
        const map = await getRemoved()
        if (fn(map) !== false) await localSet({ removed: map })
    })
}
export function addRemovedRecord(rec: RemovedRecord): Promise<void> {
    return locked('removed', async () => {
        const map = await getRemoved()
        map[String(rec.id)] = rec
        const entries = Object.values(map).sort((a, b) => b.observed_utc - a.observed_utc)
        const trimmed: Record<string, RemovedRecord> = {}
        for (const e of entries.slice(0, MAX_REMOVED)) trimmed[String(e.id)] = e
        await localSet({ removed: trimmed })
    })
}
export function markAllRemovedSeen(): Promise<void> {
    return updateRemoved(map => {
        for (const k of Object.keys(map)) map[k].unseen = false
    })
}
export async function getUnseenCount(): Promise<number> {
    const map = await getRemoved()
    return Object.values(map).filter(r => r.unseen).length
}
// How many times a record's text recovery or public-view audit may come back empty or
// fail before we stop asking (each try is a request to the site, once per cycle).
export const MAX_TEXT_ATTEMPTS = 5
export const MAX_AUDIT_ATTEMPTS = 5

// Removed items we haven't yet checked against the logged-out view, newest first, with
// the type so the poller can pick the right public endpoint (comment/thread vs post).
export async function getRemovedNeedingAudit(limit = 10): Promise<Array<{ id: number; type: ItemType }>> {
    const map = await getRemoved()
    return Object.values(map)
        .filter(r => !r.audited && !r.reapproved_utc)
        .sort((a, b) => b.observed_utc - a.observed_utc)
        .slice(0, limit)
        .map(r => ({ id: r.id, type: r.type === 'post' ? 'post' : 'comment' }))
}
// The public-view audit of a record failed again. After MAX_AUDIT_ATTEMPTS it counts as
// done (hidden stays unknown), so a gone thread isn't fetched every cycle forever.
export function noteAuditAttempt(id: number): Promise<void> {
    return updateRemoved(map => {
        const r = map[String(id)]
        if (!r) return false
        r.audit_attempts = (r.audit_attempts || 0) + 1
        if (r.audit_attempts >= MAX_AUDIT_ATTEMPTS) r.audited = true
    })
}
// A recorded removal became visible again. Keep it in history (so the lifecycle is
// shown) but stamp the re-approval time, flip its status to live, and mark it
// audited so it's neither re-audited nor highlighted in-page anymore.
export function markReapproved(id: number, ts: number): Promise<void> {
    return updateRemoved(map => {
        const r = map[String(id)]
        if (!r) return false
        r.reapproved_utc = ts
        r.status = 'live'
        r.audited = true
        r.unseen = true
    })
}
// Keep each removed record's removal_source at what the site reports now: fills it in
// for records that lack it (older ones, or ones first detected via blanked content), and
// follows a change, such as a "…Pending" source once the review is settled.
export function fillRemovedSources(sources: Record<string, string>): Promise<void> {
    if (Object.keys(sources).length === 0) return Promise.resolve()
    return updateRemoved(map => {
        let changed = false
        for (const [id, src] of Object.entries(sources)) {
            if (src && map[id] && map[id].removal_source !== src) {
                map[id].removal_source = src
                changed = true
            }
        }
        return changed
    })
}
// Apply the result of the anonymous public-view audit.
export function setRemovedAudit(id: number, hidden: boolean): Promise<void> {
    return updateRemoved(map => {
        const r = map[String(id)]
        if (!r) return false
        r.audited = true
        r.hidden = hidden
    })
}
// False-positive correction: the comment is publicly visible after all. Drop the
// record and reset its tracked state so a genuine future removal still registers.
export async function unrecordRemoval(id: number): Promise<void> {
    await updateRemoved(map => {
        if (!map[String(id)]) return false
        delete map[String(id)]
    })
    await updateOwnItems(tracked => {
        const t = tracked[String(id)]
        if (t) {
            t.is_removed = false
            t.removal_count = 0
            t.recorded = false
        }
        return tracked
    })
}
// ids of your own removed COMMENTS whose text we never captured, newest first —
// candidates for author-view recovery via the authenticated comment/thread endpoint.
// Posts get their title/body from the profile feed directly, and other people's
// records can't be recovered that way (it blanks their removed content), so both are
// left out, as is a record that has used up its tries.
export async function getRemovedMissingTextIds(limit = 10): Promise<number[]> {
    const map = await getRemoved()
    return Object.values(map)
        .filter(r => r.type !== 'post' && !r.text && r.source !== 'other' && (r.text_attempts || 0) < MAX_TEXT_ATTEMPTS)
        .sort((a, b) => b.observed_utc - a.observed_utc)
        .slice(0, limit)
        .map(r => r.id)
}
// A text recovery came back without the text. After MAX_TEXT_ATTEMPTS, stop asking and
// stop showing the record as loading.
export function noteTextAttempt(id: number): Promise<void> {
    return updateRemoved(map => {
        const r = map[String(id)]
        if (!r || r.text) return false
        r.text_attempts = (r.text_attempts || 0) + 1
        if (r.text_attempts >= MAX_TEXT_ATTEMPTS) r.text_loading = false
    })
}
export function setRemovedText(id: number, text: string): Promise<void> {
    return updateRemoved(map => {
        const r = map[String(id)]
        if (!r || r.text) return false
        r.text = text
        r.text_loading = false
    })
}

// --- change log ---
export interface ChangeEntry {
    id: number
    status: CommentStatus
    ts: number
    community: string
}
export function pushChange(entry: ChangeEntry): Promise<void> {
    return locked('changes', async () => {
        const log = await localGet<ChangeEntry[]>('changes', [])
        log.unshift(entry)
        await localSet({ changes: log.slice(0, MAX_CHANGES) })
    })
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
export function addNotifiedIds(ids: number[]): Promise<void> {
    return locked('notified_ids', async () => {
        const set = new Set(await getNotifiedIds())
        for (const id of ids) set.add(id)
        let arr = [...set]
        if (arr.length > 5000) arr = arr.slice(arr.length - 5000) // cap
        await localSet({ notified_ids: arr })
    })
}
// Clear the notify-once flag for ids (used on re-approval) so that if the same item
// is removed again later, that fresh removal notifies again.
export function removeNotifiedIds(ids: number[]): Promise<void> {
    return locked('notified_ids', async () => {
        const set = new Set(await getNotifiedIds())
        let changed = false
        for (const id of ids) changed = set.delete(id) || changed
        if (changed) await localSet({ notified_ids: [...set] })
    })
}

// --- notification click targets ---
// What a notification should open when clicked, keyed by notification id.
export interface NotifTarget {
    uuid: string
    post_uuid: string
    type: ItemType
}
export function setNotifTargets(id: string, targets: NotifTarget[]): Promise<void> {
    return locked('notif_targets', async () => {
        const m = await localGet<Record<string, NotifTarget[]>>('notif_targets', {})
        m[id] = targets
        const keys = Object.keys(m)
        if (keys.length > 30) delete m[keys[0]] // cap
        await localSet({ notif_targets: m })
    })
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
// When a check last read past the first page of a user's profile (poller.ts: every 6
// hours it reads the next three too). The first-run scan counts.
export async function getDeepCheckedAt(user: string): Promise<number> {
    return (await localGet<Record<string, number>>('deep_checked', {}))[user] || 0
}
export function setDeepCheckedAt(user: string, at: number): Promise<void> {
    return locked('deep_checked', async () => {
        const m = await localGet<Record<string, number>>('deep_checked', {})
        m[user] = at
        await localSet({ deep_checked: m })
    })
}
// Whether we've done the one-time full-history backfill for a user. After that, checks
// read the first page of their profile, and every 6 hours the three after it.
export async function isBackfilled(user: string): Promise<boolean> {
    const m = await localGet<Record<string, boolean>>('backfilled_users', {})
    return !!m[user]
}
export function markBackfilled(user: string): Promise<void> {
    return locked('backfilled_users', async () => {
        const m = await localGet<Record<string, boolean>>('backfilled_users', {})
        m[user] = true
        await localSet({ backfilled_users: m })
    })
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
