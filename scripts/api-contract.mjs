// Live check that the site's anonymous API still has the shape GhostedWatch reads.
// No login, a handful of GETs, one second apart. Meant for a daily schedule (e.g. on the
// Pi) and before each release.
//
//   node scripts/api-contract.mjs            # patriots.win, community TheDonald
//   WIN_ORIGIN=https://scored.co WIN_COMMUNITY=... node scripts/api-contract.mjs
//
// Exit codes: 0 = shape as expected, 1 = shape changed (the extension needs a look),
// 2 = couldn't get answers (outage, challenge page, network) — not a verdict.
// The last line of output is one JSON object for scripts that collect results.

const ORIGIN = process.env.WIN_ORIGIN || 'https://patriots.win'
const COMMUNITY = process.env.WIN_COMMUNITY || 'TheDonald'

// The site's id <-> uuid scheme, as in src/src/win-api.ts idToUuid.
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
function idToUuid(id) {
    let n = 0n
    for (const ch of String(id)) n = n * 256n + BigInt(ch.charCodeAt(0))
    if (n === 0n) return '0'
    let out = ''
    while (n > 0n) {
        out = BASE62[Number(n % 62n)] + out
        n /= 62n
    }
    return out
}
// As in src/src/win-api.ts isCommentRaw: how a profile item is told to be a comment.
const isCommentRaw = r => 'comment_parent_id' in r || 'post_title' in r

class Unreachable extends Error {}
const sleep = ms => new Promise(r => setTimeout(r, ms))
let calls = 0
async function get(path) {
    if (calls++) await sleep(1000)
    let res
    try {
        res = await fetch(`${ORIGIN}/api/v2/${path}`, { credentials: 'omit' })
    } catch (e) {
        throw new Unreachable(`${path}: ${e.cause?.code || e.message}`)
    }
    const body = await res.text()
    if (!res.ok) throw new Unreachable(`${path}: HTTP ${res.status}`)
    try {
        return JSON.parse(body)
    } catch {
        throw new Unreachable(`${path}: not JSON (${body.slice(0, 60).replace(/\s+/g, ' ')}…)`)
    }
}

const results = []
function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok, detail })
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
    return !!ok
}
const ids = items => items.every(x => Number.isInteger(x.id) && typeof x.uuid === 'string' && x.uuid === idToUuid(x.id))

async function main() {
    // 1) community feed (watched communities, and a source of a live thread)
    const feed = await get(`post/newv2.json?community=${encodeURIComponent(COMMUNITY)}`)
    const posts = Array.isArray(feed?.posts) ? feed.posts : null
    check('feed: posts[] present', posts?.length > 0, posts ? `${posts.length} posts` : 'no posts array')
    if (!posts?.length) return
    check('feed: numeric id + uuid that matches the id codec', ids(posts))

    // 2) a thread with comments (watched posts and comments, public-view audit)
    let thread = null
    let postId = 0
    for (const p of posts.slice(0, 6)) {
        const t = await get(`post/post.json?id=${p.id}&comments=true`)
        if (Array.isArray(t?.comments) && t.comments.length > 0) {
            thread = t
            postId = p.id
            break
        }
    }
    check('thread: post/post.json returns comments for a recent post', thread, thread ? `post ${postId}, ${thread.comments.length} comments` : 'none of 6 posts had comments')
    if (!thread) return
    const tp = thread.posts?.[0]
    check('thread: posts[0] is the post asked for, with its community', tp?.id === postId && typeof tp?.community === 'string' && tp.community)
    const cs = thread.comments
    check('thread: comments have numeric id + uuid that matches the id codec', ids(cs))
    check('thread: comments carry comment_parent_id (comment marker)', cs.every(c => 'comment_parent_id' in c))
    check('thread: parent_id is the post id', cs.every(c => c.parent_id === postId), `${cs.filter(c => c.parent_id !== postId).length} differ`)
    check('thread: is_removed is a boolean', cs.every(c => typeof c.is_removed === 'boolean'))
    const removed = cs.filter(c => c.is_removed)
    check(
        'thread: removed comments name a removal_source and hide their text',
        removed.every(c => typeof c.removal_source === 'string' && c.removal_source && !c.raw_content),
        `${removed.length} removed in this thread`,
    )
    const live = cs.find(c => !c.is_removed && c.author)
    if (!live) return check('thread: a live comment with an author', false)

    // 3) the logged-out comment view the public-view audit reads
    const ct = await get(`comment/thread?id=${live.id}`)
    check('comment/thread: anonymous view includes the comment', (ct?.comments || []).some(c => c.id === live.id))

    // 4) a profile feed (detection reads the signed-in one; same shape)
    const prof = await get(`content/profile.json?user=${encodeURIComponent(live.author)}`)
    const items = Array.isArray(prof?.content) ? prof.content : null
    check('profile: content[] present', items?.length > 0, items ? `${items.length} items` : 'no content array')
    if (items?.length) {
        check('profile: items have numeric id + uuid that matches the id codec', ids(items))
        check('profile: has_more_entries is a boolean', typeof prof.has_more_entries === 'boolean')
        check('profile: is_removed is a boolean on every item', items.every(r => typeof r.is_removed === 'boolean'))
        const comments = items.filter(isCommentRaw)
        check(
            'profile: comments point at their post (parent_id + parent_uuid)',
            comments.every(r => Number.isInteger(r.parent_id) && typeof r.parent_uuid === 'string' && r.parent_uuid === idToUuid(r.parent_id)),
            `${comments.length} comments, ${items.length - comments.length} posts`,
        )
    }

    // 5) the account lookup used for the signed-in user
    const about = await get(`user/about.json?user=${encodeURIComponent(live.author)}`)
    const u = about?.users?.[0]
    check('about: users[0] has username and created', u && String(u.username).toLowerCase() === String(live.author).toLowerCase() && Number.isFinite(u.created))
}

let unreachable = ''
try {
    await main()
} catch (e) {
    if (!(e instanceof Unreachable)) throw e
    unreachable = e.message
    console.log(`UNREACHABLE ${unreachable}`)
}
const failed = results.filter(r => !r.ok)
const status = unreachable ? 'unreachable' : failed.length ? 'changed' : 'ok'
console.log(JSON.stringify({ check: 'api-contract', origin: ORIGIN, status, at: new Date().toISOString(), failed: failed.map(f => f.name), unreachable }))
process.exit(status === 'ok' ? 0 : status === 'changed' ? 1 : 2)
