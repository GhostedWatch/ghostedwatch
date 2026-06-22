// Detection for comments authored by OTHER users that the viewer chose to watch.
// Unlike your own content (detected via the authenticated profile feed), these are
// detected from the PUBLIC post thread — the same anonymous `post/post.json` call the
// site makes to render a thread. One request per watched post returns the whole
// comment tree (removed comments included, with is_removed/removal_source), so we
// batch by post rather than per comment. No /raw, no recovery of others' content: we
// only read removal *status* and reuse the text we captured while it was visible.
import { apiGet, idToUuid, normalizeProfileComment, type ItemType } from './win-api'
import { foldRemoval } from './monitoring'
import {
    getOtherItems,
    setOtherItems,
    addOtherItem,
    getRemoved,
    addRemovedRecord,
    markReapproved,
    getNotifiedIds,
    addNotifiedIds,
    removeNotifiedIds,
    pushChange,
    getUnseenCount,
    getOtherCursor,
    setOtherCursor,
    OTHER_POSTS_PER_CYCLE,
    getSources,
    setSources,
    getSourceCursor,
    setSourceCursor,
    SOURCES_PER_CYCLE,
    MAX_SOURCE_ITEMS,
    type OtherItem,
    type WatchSource,
} from './storage'
import { setUnseenBadge } from './common'

// Capture a post/comment the user just clicked Watch on. Given only the ids from the
// page, fetch the public thread once to fill in author/title/text/created accurately
// (no fragile DOM scraping), then store it. Best-effort: still watches if the fetch fails.
export async function watchOtherFromPage(
    origin: string,
    item: {
        id: number
        uuid: string
        type: ItemType
        post_id: number
        post_uuid: string
        watch_comments?: boolean // post only: also watch every comment in the thread
    },
): Promise<void> {
    let author = ''
    let community = ''
    let created = 0
    let title = ''
    let text = ''
    try {
        const data = await apiGet<{ posts?: any[]; comments?: any[] }>(
            origin,
            `post/post.json?id=${item.post_id}&comments=true`,
        )
        community = (data?.posts && data.posts[0]?.community) || ''
        const subject =
            item.type === 'post'
                ? (data?.posts || []).find((p: any) => p.id === item.id) || data?.posts?.[0]
                : (data?.comments || []).find((c: any) => c.id === item.id)
        if (subject) {
            author = subject.author || ''
            created = subject.created || 0
            title = item.type === 'post' ? subject.title || '' : ''
            text = subject.raw_content || subject.content || ''
        }
    } catch {
        /* best-effort — watch with what we have */
    }
    await addOtherItem({ ...item, author, community, created, title, text, watch_comments: item.watch_comments })
}

export type OtherObservation = 'live' | 'removed' | 'absent' | 'unknown'

// Pure transition for one watched-comment observation (unit-tested). 'unknown'
// (incomplete tree / fetch failed) is inconclusive and changes nothing.
export function applyOtherObservation(
    prev: OtherItem,
    observed: OtherObservation,
    removalSource = '',
): { next: OtherItem; newlyRemoved: boolean; newlyReapproved: boolean } {
    if (observed === 'unknown') return { next: prev, newlyRemoved: false, newlyReapproved: false }
    const observedRemoved = observed === 'removed' || observed === 'absent'
    const f = foldRemoval(prev, observedRemoved)
    const next: OtherItem = {
        ...prev,
        is_removed: f.next.is_removed,
        removal_count: f.next.removal_count,
        visible_count: f.next.visible_count,
        recorded: f.next.recorded,
        removal_source: removalSource || prev.removal_source,
    }
    return { next, newlyRemoved: f.newlyRemoved, newlyReapproved: f.newlyReapproved }
}

interface RemovableItem {
    id: number
    uuid?: string
    is_removed?: boolean
    removal_source?: string
    author?: string
    created?: number
    raw_content?: string
    content?: string
}

// Build an OtherItem for a comment discovered inside a whole-watched post's thread.
function autoComment(c: RemovableItem, post: OtherItem): OtherItem {
    return {
        id: c.id,
        uuid: c.uuid || idToUuid(c.id),
        type: 'comment',
        post_id: post.id,
        post_uuid: post.post_uuid,
        author: c.author || '',
        community: post.community,
        created: c.created || 0,
        title: '',
        text: c.raw_content || c.content || '',
        watched_at: Date.now(),
        is_removed: false,
        removal_source: '',
        removal_count: 0,
        visible_count: 0,
        recorded: false,
        auto: true,
    }
}
interface PostThreadResponse {
    posts?: RemovableItem[] // the post itself carries its own removal state
    comments?: RemovableItem[]
    has_more_entries?: boolean
}

// Run one watch-detection pass against `origin` (the user's active .win origin;
// post.json is anonymous so no tokens are used). Returns the newly removed / newly
// re-approved watched comments for the background to notify.
export async function runOtherCycle(origin: string): Promise<{
    removed: OtherItem[]
    reapproved: OtherItem[]
}> {
    const map = await getOtherItems()
    const all = Object.values(map)
    if (all.length === 0) return { removed: [], reapproved: [] }

    // group watched comments by their post (one fetch per post covers them all)
    const byPost = new Map<number, OtherItem[]>()
    for (const w of all) {
        const arr = byPost.get(w.post_id) || []
        arr.push(w)
        byPost.set(w.post_id, arr)
    }
    const postIds = [...byPost.keys()]

    // round-robin a slice of posts this cycle so we never exceed the request budget
    let cursor = await getOtherCursor()
    if (cursor >= postIds.length) cursor = 0
    const slice = postIds.slice(cursor, cursor + OTHER_POSTS_PER_CYCLE)
    if (slice.length < OTHER_POSTS_PER_CYCLE && postIds.length > slice.length) {
        slice.push(...postIds.slice(0, OTHER_POSTS_PER_CYCLE - slice.length))
    }
    await setOtherCursor((cursor + slice.length) % Math.max(1, postIds.length))

    const alreadyRemoved = await getRemoved()
    const newlyRemoved: Array<{ w: OtherItem; hidden: boolean }> = []
    const newlyReapproved: OtherItem[] = []

    for (const postId of new Set(slice)) {
        let data: PostThreadResponse
        try {
            data = await apiGet<PostThreadResponse>(origin, `post/post.json?id=${postId}&comments=true`)
        } catch {
            continue // inconclusive this cycle; leave these comments' state untouched
        }
        const complete = !data?.has_more_entries
        const byId = new Map<number, RemovableItem>((data?.comments || []).map(c => [c.id, c]))
        // the post itself (for watched posts); its removal state lives on the post object
        const post = (data?.posts || []).find(p => p.id === postId) || data?.posts?.[0]
        const folded = new Set<number>()

        // fold one observation, collect a confirmed removal/re-approval for notifying
        const fold = (w: OtherItem, observed: OtherObservation, src = '') => {
            const r = applyOtherObservation(w, observed, src)
            map[String(w.id)] = r.next
            folded.add(w.id)
            const prevRec = alreadyRemoved[String(w.id)]
            if (r.newlyRemoved && (!prevRec || prevRec.reapproved_utc)) {
                newlyRemoved.push({ w: r.next, hidden: observed === 'absent' })
            } else if (r.newlyReapproved && prevRec && !prevRec.reapproved_utc) {
                newlyReapproved.push(r.next)
            }
        }

        // explicitly-watched items in this post (the post and/or individual comments)
        for (const w of byPost.get(postId)!) {
            // a watched POST reads its status from the post object; a watched COMMENT
            // from the thread's comment list (absent-from-a-complete-tree = removed)
            const subject = w.type === 'post' ? post : byId.get(w.id)
            let observed: OtherObservation
            let src = ''
            if (subject) {
                observed = subject.is_removed === true ? 'removed' : 'live'
                src = subject.removal_source || ''
            } else if (w.type === 'post') {
                observed = 'absent' // the post wasn't returned at all (gone/deleted)
            } else {
                observed = complete ? 'absent' : 'unknown' // comment: absent only counts if tree complete
            }
            fold(w, observed, src)
        }

        // whole-post: also watch every comment in the thread (auto-add new ones; a
        // comment that vanishes from a complete tree is a removal)
        const postItem = map[String(postId)]
        if (postItem?.type === 'post' && postItem.watch_comments) {
            for (const c of data?.comments || []) {
                let w = map[String(c.id)]
                if (!w) {
                    w = autoComment(c, postItem)
                    map[String(c.id)] = w
                    if (c.is_removed === true) {
                        // already removed when we started watching → baseline silently
                        w.is_removed = true
                        w.recorded = true
                        folded.add(c.id)
                        continue
                    }
                }
                if (!folded.has(c.id)) fold(w, c.is_removed === true ? 'removed' : 'live', c.removal_source || '')
            }
            if (complete) {
                for (const w of Object.values(map)) {
                    if (w.type === 'comment' && w.post_id === postId && !byId.has(w.id) && !folded.has(w.id)) {
                        fold(w, 'absent')
                    }
                }
            }
        }
    }
    await setOtherItems(map)
    return commitOutcomes(newlyRemoved, newlyReapproved)
}

// Record confirmed removals/re-approvals and return the ones to notify (each id alerts
// at most once ever). Shared by the post-based and source-based cycles.
async function commitOutcomes(
    newlyRemoved: Array<{ w: OtherItem; hidden: boolean }>,
    newlyReapproved: OtherItem[],
): Promise<{ removed: OtherItem[]; reapproved: OtherItem[] }> {
    const now = Date.now()
    for (const { w, hidden } of newlyRemoved) await recordOtherRemoval(w, hidden)
    for (const w of newlyReapproved) {
        await markReapproved(w.id, now)
        await pushChange({ id: w.id, status: 'live', ts: now, community: w.community })
    }
    if (newlyReapproved.length) await removeNotifiedIds(newlyReapproved.map(w => w.id))
    setUnseenBadge(await getUnseenCount())
    const notified = new Set(await getNotifiedIds())
    const toNotify = newlyRemoved.map(x => x.w).filter(w => !notified.has(w.id))
    if (toNotify.length) await addNotifiedIds(toNotify.map(w => w.id))
    return { removed: toNotify, reapproved: newlyReapproved }
}

async function recordOtherRemoval(w: OtherItem, hidden: boolean): Promise<void> {
    await addRemovedRecord({
        id: w.id,
        uuid: w.uuid,
        type: w.type,
        post_uuid: w.post_uuid,
        community: w.community,
        title: w.title || '',
        text: w.text || '',
        text_loading: false, // captured at watch time — nothing to recover
        status: 'publicly_removed',
        removal_source: w.removal_source || '',
        created: w.created || 0,
        observed_utc: Date.now(),
        unseen: true,
        source: 'other',
        author: w.author,
        // we detected this from the authoritative public thread, so the self-audit
        // step can skip it; `hidden` = it was absent from the tree (vs. a placeholder)
        audited: true,
        hidden,
    })
    await pushChange({ id: w.id, status: 'publicly_removed', ts: Date.now(), community: w.community })
}

// ============================ watch sources (user / feed) ============================
// One request per source per cycle. Removal is detected by diffing the current visible
// items against what we saw last time: an item that vanishes WHILE OLDER items are
// still visible was removed (vs. one that simply scrolled off the bottom of the feed).

function fromProfile(raw: Record<string, any>): OtherItem {
    const p = normalizeProfileComment(raw)
    return {
        id: p.id,
        uuid: p.uuid,
        type: p.type,
        post_id: p.post_id,
        post_uuid: p.post_uuid,
        author: raw.author || '',
        community: p.community,
        created: p.created,
        title: p.title,
        text: p.text,
        watched_at: 0,
        is_removed: p.is_removed,
        removal_source: p.removal_source,
        removal_count: 0,
        visible_count: 0,
        recorded: false,
    }
}

function fromFeedPost(p: Record<string, any>): OtherItem {
    return {
        id: p.id,
        uuid: p.uuid || idToUuid(p.id),
        type: 'post',
        post_id: p.id,
        post_uuid: p.uuid || idToUuid(p.id),
        author: p.author || '',
        community: p.community || '',
        created: p.created || 0,
        title: p.title || '',
        text: p.raw_content || p.content || '',
        watched_at: 0,
        is_removed: p.is_removed === true,
        removal_source: p.removal_source || '',
        removal_count: 0,
        visible_count: 0,
        recorded: false,
    }
}

async function fetchSourceItems(origin: string, src: WatchSource): Promise<OtherItem[]> {
    if (src.kind === 'user') {
        const data = await apiGet<{ content?: Record<string, any>[] }>(
            origin,
            `content/profile.json?user=${encodeURIComponent(src.name)}`,
        )
        return (data?.content || []).filter(r => r?.id && r?.uuid).map(fromProfile)
    }
    const data = await apiGet<{ posts?: Record<string, any>[] }>(
        origin,
        `post/newv2.json?community=${encodeURIComponent(src.name)}`,
    )
    return (data?.posts || []).filter(p => p?.id).map(fromFeedPost)
}

export async function runSourceCycle(origin: string): Promise<{ removed: OtherItem[]; reapproved: OtherItem[] }> {
    const sources = await getSources()
    const keys = Object.keys(sources)
    if (keys.length === 0) return { removed: [], reapproved: [] }

    let cursor = await getSourceCursor()
    if (cursor >= keys.length) cursor = 0
    const slice = keys.slice(cursor, cursor + SOURCES_PER_CYCLE)
    if (slice.length < SOURCES_PER_CYCLE && keys.length > slice.length) {
        slice.push(...keys.slice(0, SOURCES_PER_CYCLE - slice.length))
    }
    await setSourceCursor((cursor + slice.length) % Math.max(1, keys.length))

    const alreadyRemoved = await getRemoved()
    const newlyRemoved: Array<{ w: OtherItem; hidden: boolean }> = []
    const newlyReapproved: OtherItem[] = []

    for (const key of new Set(slice)) {
        const src = sources[key]
        if (!src) continue
        let items: OtherItem[]
        try {
            items = await fetchSourceItems(origin, src)
        } catch {
            continue // inconclusive this cycle
        }
        if (items.length === 0 && Object.keys(src.items).length === 0) continue
        const currentIds = new Set(items.map(i => i.id))
        // anything older than this is outside the window we can see, so absence there
        // can't be distinguished from "scrolled off" → inconclusive
        const oldestVisible = items.length ? Math.min(...items.map(i => i.created || 0)) : Infinity
        const folded = new Set<number>()

        const fold = (w: OtherItem, observed: OtherObservation, srcLabel = '') => {
            const r = applyOtherObservation(w, observed, srcLabel)
            src.items[String(w.id)] = r.next
            folded.add(w.id)
            const prevRec = alreadyRemoved[String(w.id)]
            if (r.newlyRemoved && (!prevRec || prevRec.reapproved_utc)) {
                newlyRemoved.push({ w: r.next, hidden: observed === 'absent' })
            } else if (r.newlyReapproved && prevRec && !prevRec.reapproved_utc) {
                newlyReapproved.push(r.next)
            }
        }

        // currently-visible items
        for (const it of items) {
            let w = src.items[String(it.id)]
            if (!w) {
                w = { ...it, watched_at: Date.now() }
                src.items[String(it.id)] = w
                if (it.is_removed) {
                    // already removed when we started watching → baseline silently
                    w.is_removed = true
                    w.recorded = true
                    folded.add(it.id)
                    continue
                }
            }
            if (!folded.has(it.id)) fold(w, it.is_removed ? 'removed' : 'live', it.removal_source)
        }
        // items we knew that are gone now — removed only if within the visible window
        for (const w of Object.values(src.items)) {
            if (currentIds.has(w.id) || folded.has(w.id)) continue
            fold(w, (w.created || 0) > oldestVisible ? 'absent' : 'unknown')
        }
        // cap items per source (keep the most recent)
        const kept = Object.values(src.items)
            .sort((a, b) => (b.created || 0) - (a.created || 0))
            .slice(0, MAX_SOURCE_ITEMS)
        src.items = Object.fromEntries(kept.map(w => [String(w.id), w]))
    }

    await setSources(sources)
    return commitOutcomes(newlyRemoved, newlyReapproved)
}
