// The detection cycle, run from the background service worker using the stored API
// tokens — so it works even with no .win tab open (like reveddit real-time). One
// place owns detection; the content script only captures tokens/posts and paints
// highlights.
import {
    apiGet,
    normalizeProfileComment,
    isCommentRaw,
    classifyPublicView,
    type ProfileComment,
    type PublicViewResponse,
} from './win-api'
import { processProfileComments } from './monitoring'
import {
    getAuth,
    isBackfilled,
    markBackfilled,
    getRemovedMissingTextIds,
    setRemovedText,
    getRemovedNeedingAudit,
    setRemovedAudit,
    unrecordRemoval,
    type OwnItem,
} from './storage'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const MAX_BACKFILL_PAGES = 20
const BACKFILL_PAGE_DELAY_MS = 800

// Run one full detection cycle. Returns the newly-removed items (for notification)
// and whether this was the first-run backfill. No-ops until the content script has
// captured the session (getAuth() null).
export async function runCycle(): Promise<{
    removed: OwnItem[]
    reapproved: OwnItem[]
    backfill: boolean
} | null> {
    const auth = await getAuth()
    if (!auth) return null
    const { user, origin, apiKey, apiSecret } = auth
    const backfill = !(await isBackfilled(user))

    // 1) poll your profile (paged through your whole history on the first run)
    const items: ProfileComment[] = []
    let postsSeen = 0
    let commentsSeen = 0
    const maxPages = backfill ? MAX_BACKFILL_PAGES : 1
    for (let page = 0; page < maxPages; page++) {
        const cursor = page === 0 ? '' : `&post=${postsSeen}&comment=${commentsSeen}`
        let data: { content?: Record<string, any>[]; has_more_entries?: boolean }
        try {
            data = await apiGet(origin, `content/profile.json?user=${encodeURIComponent(user)}${cursor}`, apiKey, apiSecret)
        } catch {
            break
        }
        const raw = data?.content || []
        if (raw.length === 0) break
        for (const r of raw) {
            if (isCommentRaw(r)) commentsSeen++
            else postsSeen++
            if (r.id && r.uuid) items.push(normalizeProfileComment(r))
        }
        if (!data?.has_more_entries) break
        if (page < maxPages - 1) await sleep(BACKFILL_PAGE_DELAY_MS)
    }
    // backfill confirms on first sight; ongoing uses the usual confirmation
    const { removed, reapproved } = await processProfileComments(items, backfill ? 1 : undefined)
    if (backfill) await markBackfilled(user)

    // 2) recover text for removed comments we never captured (author view)
    for (const id of await getRemovedMissingTextIds()) {
        try {
            const d = await apiGet<{ comments?: Array<{ id: number; raw_content?: string; content?: string }> }>(
                origin,
                `comment/thread?id=${id}`,
                apiKey,
                apiSecret,
            )
            const c = (d?.comments || []).find(x => x.id === id)
            const text = (c && (c.raw_content || c.content)) || ''
            if (text) await setRemovedText(id, text)
        } catch {
            /* best-effort */
        }
    }

    // 3) public-view audit (anonymous = no tokens): confirm removal, catch false
    // positives, and classify visible-vs-hidden.
    for (const { id, type } of await getRemovedNeedingAudit()) {
        try {
            const path = type === 'post' ? `post/post.json?id=${id}` : `comment/thread?id=${id}`
            const d = await apiGet<PublicViewResponse>(origin, path)
            const result = classifyPublicView(type, id, d)
            if (result === 'live') await unrecordRemoval(id)
            else await setRemovedAudit(id, result === 'absent')
        } catch {
            /* best-effort */
        }
    }

    return { removed, reapproved, backfill }
}
