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
    forgetAuth,
    getSessionCheckDue,
    setSessionCheckDue,
    isBackfilled,
    markBackfilled,
    getDeepCheckedAt,
    setDeepCheckedAt,
    getRemovedMissingTextIds,
    setRemovedText,
    noteTextAttempt,
    getRemovedNeedingAudit,
    setRemovedAudit,
    noteAuditAttempt,
    unrecordRemoval,
    type OwnItem,
} from './storage'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
export const SESSION_CHECK_MS = 60 * 60 * 1000
// After no answer, ask again in 10 minutes, not at every check: at the default 1-minute
// interval a failing request would otherwise add 60 an hour.
export const SESSION_RETRY_MS = 10 * 60 * 1000
// The session check and the 6-hourly read fall due this much early. Their time is taken
// after the check's own fetches, so at a check interval equal to the wait, fetches that
// are a little faster next time would otherwise find them not yet due and skip a turn.
export const DUE_SLACK_MS = 2 * 60 * 1000
const dueIn = (ms: number) => Date.now() + ms - DUE_SLACK_MS

async function sessionAccepted(auth: { origin: string; apiKey: string; apiSecret: string }): Promise<boolean> {
    // A due time more than the longest wait ahead is from a clock that was since set
    // back: treat it as due, or the check would stop until the clock caught up.
    const wait = (await getSessionCheckDue(auth.apiKey)) - Date.now()
    if (wait > 0 && wait <= SESSION_CHECK_MS) return true
    let data: { users?: unknown[]; status?: boolean; error?: string }
    try {
        data = await apiGet(auth.origin, 'user/about.json?user=me', auth.apiKey, auth.apiSecret)
    } catch {
        // no answer: can't tell, so carry on, and ask again in a while
        await setSessionCheckDue(auth.apiKey, dueIn(SESSION_RETRY_MS))
        return true
    }
    // This request goes by the tokens alone: cookies, even good ones, don't change the
    // answer (checked on the site 2026-11-14), so it agrees with the page's own check.
    if (data?.status === false && data?.error === 'invalid user' && !data?.users?.length) {
        await forgetAuth(auth)
        return false
    }
    await setSessionCheckDue(auth.apiKey, dueIn(SESSION_CHECK_MS))
    return true
}
const MAX_BACKFILL_PAGES = 20
const BACKFILL_PAGE_DELAY_MS = 800
// A profile page holds 25 items, which for an active poster is a day or so. Every 6 hours
// a check also reads the next three pages (your next 75 items), so a removal or a
// re-approval of something that has slid off page 1 is still noticed.
export const DEEP_PAGES = 4
export const DEEP_EVERY_MS = 6 * 60 * 60 * 1000

// Run one full detection cycle. Returns the newly-removed items (for notification)
// and whether this was the first-run backfill. Returns null without doing anything
// until the content script has captured the session (getAuth() null), and when the
// profile doesn't answer.
export async function runCycle(): Promise<{
    removed: OwnItem[]
    reapproved: OwnItem[]
    backfill: boolean
} | null> {
    const auth = await getAuth()
    if (!auth) return null
    const { user, origin, apiKey, apiSecret } = auth
    const backfill = !(await isBackfilled(user))
    // (a last read in the future means the clock was set back since: read now)
    const sinceDeep = Date.now() - (await getDeepCheckedAt(user))
    const deep = !backfill && (sinceDeep >= DEEP_EVERY_MS - DUE_SLACK_MS || sinceDeep < 0)

    // 1) poll your profile (paged through your whole history on the first run, and
    //    through its first DEEP_PAGES pages every 6 hours)
    const items: ProfileComment[] = []
    let firstPage = 0 // how many of `items` came from page 1
    let postsSeen = 0
    let commentsSeen = 0
    let answered = false // the profile answered at least its first page
    const maxPages = backfill ? MAX_BACKFILL_PAGES : deep ? DEEP_PAGES : 1
    for (let page = 0; page < maxPages; page++) {
        const cursor = page === 0 ? '' : `&post=${postsSeen}&comment=${commentsSeen}`
        let data: { content?: Record<string, any>[]; has_more_entries?: boolean }
        try {
            data = await apiGet(origin, `content/profile.json?user=${encodeURIComponent(user)}${cursor}`, apiKey, apiSecret)
        } catch {
            break
        }
        const raw = data?.content
        if (!Array.isArray(raw)) break
        answered = true
        if (raw.length === 0) break
        for (const r of raw) {
            if (isCommentRaw(r)) commentsSeen++
            else postsSeen++
            if (r.id && r.uuid) items.push(normalizeProfileComment(r))
        }
        if (page === 0) firstPage = items.length
        if (!data?.has_more_entries) break
        if (page < maxPages - 1) await sleep(BACKFILL_PAGE_DELAY_MS)
    }
    // No answer (offline, the site down, a refused or expired session): nothing was
    // checked, so nothing is recorded: no "last checked", and the one-time history scan
    // stays due for the next cycle. A scan that fails part-way still counts as done, so
    // a page that keeps failing can't make every cycle walk the history again.
    if (!answered) return null
    // The profile answers anyone. For tokens the site no longer accepts it quietly
    // returns the public view, which leaves out everything hidden from others. (Getting
    // new tokens doesn't cancel the old ones, checked 2026-11-14.) So about once an hour
    // ask the site whose tokens these are, and on a plain "invalid user" forget the
    // session and use nothing from this answer.
    if (!(await sessionAccepted(auth))) return null
    let removed: OwnItem[]
    let reapproved: OwnItem[]
    if (backfill) {
        // the history scan confirms on first sight
        ;({ removed, reapproved } = await processProfileComments(items, 1, true))
    } else {
        // Page 1, read every check, takes the usual confirmation. The pages after it are
        // read only every 6 hours, so there one sighting confirms a removal or a
        // re-approval, and a removal found there is marked as found by a scan (when it
        // happened is known only to within those hours). An item that shifted from page 1
        // onto page 2 while the pages were read counts once.
        const first = items.slice(0, firstPage)
        const onFirst = new Set(first.map(i => i.id))
        const later = items.slice(firstPage).filter(i => !onFirst.has(i.id))
        ;({ removed, reapproved } = await processProfileComments(first))
        try {
            if (later.length) {
                const b = await processProfileComments(later, 1, true, 1)
                removed = [...removed, ...b.removed]
                reapproved = [...reapproved, ...b.reapproved]
            }
        } catch {
            /* storage trouble: page 1's alerts still go out */
        }
    }

    // From here on nothing may throw: the removals above are already recorded as
    // notified, so their alerts must still go out.
    try {
        if (backfill) await markBackfilled(user)
        // A read of older pages that fails part-way still counts, so a page that keeps
        // failing can't make every check try again.
        if (backfill || deep) await setDeepCheckedAt(user, Date.now())
    } catch {
        /* storage trouble: the scan or the 6-hourly read is due again next check */
    }

    // Steps 2 and 3 are best-effort too.
    // 2) recover text for removed comments we never captured (author view)
    try {
        for (const id of await getRemovedMissingTextIds()) {
            let text = ''
            try {
                const d = await apiGet<{ comments?: Array<{ id: number; raw_content?: string; content?: string }> }>(
                    origin,
                    `comment/thread?id=${id}`,
                    apiKey,
                    apiSecret,
                )
                const c = (d?.comments || []).find(x => x.id === id)
                text = (c && (c.raw_content || c.content)) || ''
            } catch {
                /* counts as a try */
            }
            if (text) await setRemovedText(id, text)
            else await noteTextAttempt(id)
        }
    } catch {
        /* storage trouble: try again next cycle */
    }

    // 3) public-view audit (anonymous = no tokens): confirm removal, catch false
    // positives, and classify visible-vs-hidden.
    try {
        for (const { id, type } of await getRemovedNeedingAudit()) {
            try {
                const path = type === 'post' ? `post/post.json?id=${id}` : `comment/thread?id=${id}`
                const d = await apiGet<PublicViewResponse>(origin, path)
                const result = classifyPublicView(type, id, d)
                if (result === 'live') await unrecordRemoval(id)
                else await setRemovedAudit(id, result === 'absent')
            } catch {
                await noteAuditAttempt(id)
            }
        }
    } catch {
        /* storage trouble: try again next cycle */
    }

    return { removed, reapproved, backfill }
}
