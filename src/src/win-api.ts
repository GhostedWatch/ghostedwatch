// Helpers for the .win sites (patriots.win / scored.co /
// communities.win — all the same backend): id<->uuid encoding, the normalized
// shape of the user's own comments, and apiGet, which the background's checks use.
import { noteRequest } from './diaglog'

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

// The platform's id <-> "uuid" scheme (e.g. 1000 <-> "tqd3A", 12345 <-> "3idarWH"):
// the numeric id is taken
// as its ASCII decimal string, those bytes are read big-endian as a bigint, and
// that bigint is base62-encoded. Decoding reverses the steps. Ported from the
// site's own minified winID functions.

function base62Encode(n: bigint): string {
    if (n === 0n) return '0'
    let out = ''
    while (n > 0n) {
        out = BASE62[Number(n % 62n)] + out
        n /= 62n
    }
    return out
}

function base62Decode(str: string): bigint {
    let n = 0n
    for (const ch of str) {
        const v = BASE62.indexOf(ch)
        if (v === -1) throw new Error(`uuidToId: bad character ${JSON.stringify(ch)}`)
        n = n * 62n + BigInt(v)
    }
    return n
}

export function idToUuid(id: number): string {
    const digits = String(id)
    let n = 0n
    for (let i = 0; i < digits.length; i++) {
        n = n * 256n + BigInt(digits.charCodeAt(i))
    }
    return base62Encode(n)
}

export function uuidToId(uuid: string): number {
    let n = base62Decode(uuid)
    const length = Math.ceil((uuid.length * Math.log2(62)) / 8)
    const bytes = new Uint8Array(length)
    for (let o = length - 1; o >= 0; o--) {
        bytes[o] = Number(n % 256n)
        n /= 256n
    }
    let s = ''
    for (const b of bytes) {
        if (b !== 0) s += String.fromCharCode(b)
    }
    return parseInt(s, 10)
}

// Removal status we record for a comment.
export type CommentStatus = 'live' | 'publicly_removed' | 'shadow_removed' | 'deleted'

// Normalized view of one of the user's own comments, from the authenticated
// content/profile.json feed. The content script does the (authenticated) fetch
// and normalizes raw items into this shape before handing them to detection.
export type ItemType = 'post' | 'comment'

export interface ProfileComment {
    id: number
    uuid: string
    type: ItemType
    post_id: number // for permalinks/threads: the POST's numeric id
    post_uuid: string // the POST's base62 id (== uuid for a post item)
    community: string
    created: number
    is_removed: boolean
    removal_source: string
    title: string // post title (posts only)
    text: string // body: raw_content when the API exposes it; '' once removed/blanked
}

// Authenticated GET against a .win origin's API. The X-Api-Key/X-Api-Secret header
// tokens (which the site stores in localStorage) authenticate independently of
// cookies — verified — so this works from the background service worker, which has
// host permissions to bypass CORS. Omit the tokens for the anonymous (logged-out)
// view used by the public-view audit.
export async function apiGet<T = any>(origin: string, path: string, apiKey?: string, apiSecret?: string): Promise<T> {
    const headers: Record<string, string> = {}
    if (apiKey && apiSecret) {
        headers['X-Api-Key'] = apiKey
        headers['X-Api-Secret'] = apiSecret
    }
    // every request goes in the check's diagnostic log, with how it failed if it did
    let failure = ''
    try {
        const res = await fetch(`${origin}/api/v2/${path}`, { credentials: 'omit', headers })
        if (!res.ok) {
            failure = `HTTP ${res.status}`
            throw new Error(`win-api ${res.status} for ${path.split('?')[0]}`)
        }
        try {
            return (await res.json()) as T
        } catch (e) {
            failure = 'not JSON'
            throw e
        }
    } catch (e) {
        failure ||= 'no answer'
        throw e
    } finally {
        noteRequest(path, failure || undefined)
    }
}

// content/profile.json mixes the user's posts and comments. A comment carries a
// parent-post reference; a post is its own top-level item.
export function isCommentRaw(raw: Record<string, any>): boolean {
    return 'comment_parent_id' in raw || 'post_title' in raw
}

export function normalizeProfileComment(raw: Record<string, any>): ProfileComment {
    const isComment = isCommentRaw(raw)
    return {
        id: raw.id,
        uuid: raw.uuid,
        type: isComment ? 'comment' : 'post',
        // a comment's parent_id/parent_uuid point at its post; a post is its own
        post_id: isComment ? Number(raw.parent_id ?? raw.post_id ?? 0) : Number(raw.id),
        post_uuid: isComment ? raw.parent_uuid || raw.post_uuid || '' : raw.uuid,
        community: raw.community || '',
        created: raw.created || 0,
        is_removed: raw.is_removed === true,
        removal_source: raw.removal_source || '',
        title: isComment ? '' : raw.title || '',
        text: raw.raw_content || '',
    }
}

// --- public-view audit ---
// The logged-out view of an item, as returned by post/post.json (posts) or
// comment/thread (comments) fetched WITHOUT tokens.
export interface PublicViewResponse {
    posts?: Array<{ id: number; title?: string; raw_content?: string; content?: string }>
    comments?: Array<{ id: number; raw_content?: string; content?: string }>
}

// How a removal we recorded actually appears to a logged-out visitor:
//   'live'    — the public still sees real content, so it isn't removed after all
//               (a false positive → drop the record)
//   'visible' — present but blanked: a "removed by …" placeholder others can see
//   'absent'  — not in the public view at all: hidden from others entirely
export type AuditResult = 'live' | 'visible' | 'absent'

// Pure classifier for the public-view audit, so the visible/hidden/false-positive
// logic is unit-tested independently of the fetch in the poller.
export function classifyPublicView(type: ItemType, id: number, data: PublicViewResponse): AuditResult {
    if (type === 'post') {
        // exact id match, else fall back to the first post the thread returned
        const p = (data?.posts || []).find(x => x.id === id) || data?.posts?.[0]
        if (!p) return 'absent'
        return p.title || p.raw_content || p.content ? 'live' : 'visible'
    }
    const c = (data?.comments || []).find(x => x.id === id)
    if (!c) return 'absent'
    return c.raw_content || c.content ? 'live' : 'visible'
}

