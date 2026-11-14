// Runs in the PAGE context (not the content-script sandbox) so it can observe the
// site's own fetch/XHR traffic. It watches for create_comment / create_post
// responses — the only reliable way to learn the ids of things the user posts —
// then forwards what it finds to the content script via window.postMessage. It
// performs no writes and reads no credentials.

import { MSG_SOURCE } from './constants'

export {} // mark as a module so top-level names don't leak to global scope

interface Captured {
    type: 'created-comment' | 'created-post' | 'logged-in-user'
    [key: string]: unknown
}

function send(msg: Captured) {
    window.postMessage({ source: MSG_SOURCE, ...msg }, window.location.origin)
}

// Find the first id+uuid object in a response (optionally requiring/forbidding the
// comment marker), scanning rather than assuming a fixed path.
function findItem(responseJson: any, wantComment: boolean): any {
    const candidates: any[] = []
    const visit = (o: any, depth: number) => {
        if (!o || typeof o !== 'object' || depth > 4) return
        const isComment = 'comment_parent_id' in o || 'post_title' in o
        if (typeof o.id === 'number' && typeof o.uuid === 'string' && isComment === wantComment) candidates.push(o)
        for (const v of Object.values(o)) visit(v, depth + 1)
    }
    visit(responseJson, 0)
    return candidates[0]
}

function extractCreatedComment(requestBody: any, responseJson: any): void {
    const comment = findItem(responseJson, true)
    if (!comment) return
    // `parent_id`/`parent_uuid` refer to the POST; the captured text is the source
    // of truth for the comment's content if it later gets removed.
    const postId = Number(comment.parent_id ?? requestBody?.parentId ?? comment.post_id)
    send({
        type: 'created-comment',
        id: comment.id,
        uuid: comment.uuid,
        post_id: Number.isFinite(postId) ? postId : comment.parent_id,
        post_uuid: comment.parent_uuid || comment.post_uuid || '',
        community: comment.community || requestBody?.community || '',
        created: comment.created || Date.now(),
        title: '',
        text: comment.raw_content || comment.content || requestBody?.content || '',
    })
    if (comment.author) send({ type: 'logged-in-user', user: comment.author })
}

function extractCreatedPost(requestBody: any, responseJson: any): void {
    const post = findItem(responseJson, false)
    if (!post) return
    // A post is its own top-level item: its id/uuid serve as the post reference.
    send({
        type: 'created-post',
        id: post.id,
        uuid: post.uuid,
        post_id: post.id,
        post_uuid: post.uuid,
        community: post.community || requestBody?.community || '',
        created: post.created || Date.now(),
        title: post.title || requestBody?.title || '',
        text: post.raw_content || post.content || requestBody?.content || '',
    })
    if (post.author) send({ type: 'logged-in-user', user: post.author })
}

// Which create endpoint (if any) a URL hits.
function createKind(url: string): 'comment' | 'post' | null {
    if (/\/api\/v2\/action\/create_comment/.test(url)) return 'comment'
    if (/\/api\/v2\/action\/create_post/.test(url)) return 'post'
    return null
}

function handle(kind: 'comment' | 'post', requestBody: any, responseJson: any) {
    if (kind === 'comment') extractCreatedComment(requestBody, responseJson)
    else extractCreatedPost(requestBody, responseJson)
}

const parseBody = (body: any): any => {
    try {
        return body ? JSON.parse(String(body)) : {}
    } catch {
        return {}
    }
}

// Guard: only wrap fetch/XHR once per page, even if injected again (e.g. after an
// extension reload while a tab is open). The existing wrappers keep working — they
// only window.postMessage — and the freshly-run content script picks the messages up.
declare global {
    interface Window {
        __ghostedwatch_inject?: boolean
    }
}
if (!window.__ghostedwatch_inject) {
    window.__ghostedwatch_inject = true
    installHooks()
}

function installHooks() {
// --- wrap fetch ---
const origFetch = window.fetch
window.fetch = async function (this: unknown, ...args: Parameters<typeof fetch>) {
    const [input, init] = args
    const url = typeof input === 'string' ? input : (input as Request).url
    const res = await origFetch.apply(this, args as any)
    const kind = url ? createKind(url) : null
    if (kind) {
        try {
            handle(kind, parseBody(init?.body), await res.clone().json())
        } catch {
            /* never disturb the page on failure */
        }
    }
    return res
}

// --- wrap XHR (the site uses axios, which may use either transport) ---
const origOpen = XMLHttpRequest.prototype.open
const origSend = XMLHttpRequest.prototype.send
XMLHttpRequest.prototype.open = function (this: any, ...args: any[]) {
    this.__ghostedwatch_url = args[1]
    return (origOpen as any).apply(this, args)
}
XMLHttpRequest.prototype.send = function (this: any, body?: any) {
    const kind = this.__ghostedwatch_url ? createKind(this.__ghostedwatch_url) : null
    if (kind) {
        this.addEventListener('load', () => {
            try {
                handle(kind, parseBody(body), JSON.parse(this.responseText))
            } catch {
                /* ignore */
            }
        })
    }
    return origSend.call(this, body)
}
} // end installHooks()
