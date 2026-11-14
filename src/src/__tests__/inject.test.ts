// The page-world script that reads the site's create_comment / create_post traffic.
// It runs against stub window/fetch/XHR objects here, through its real wrappers.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MSG_SOURCE } from '../constants'

let posted: any[]
let fetchResponse: () => Response

class FakeXHR {
    responseText = ''
    listeners: Record<string, (() => void)[]> = {}
    static nextResponse = ''
    open(_method: string, _url: string) {}
    addEventListener(type: string, fn: () => void) {
        ;(this.listeners[type] ||= []).push(fn)
    }
    send(_body?: unknown) {
        this.responseText = FakeXHR.nextResponse
        for (const fn of this.listeners.load || []) fn()
    }
}

beforeEach(async () => {
    posted = []
    fetchResponse = () => new Response('{}')
    ;(globalThis as any).window = {
        location: { origin: 'https://patriots.win' },
        postMessage: (msg: unknown) => posted.push(msg),
        fetch: async () => fetchResponse(),
    }
    ;(globalThis as any).XMLHttpRequest = class extends FakeXHR {} // fresh prototype for each copy of the script
    vi.resetModules()
    await import('../inject')
})

const CREATE_COMMENT = 'https://patriots.win/api/v2/action/create_comment'
const CREATE_POST = 'https://patriots.win/api/v2/action/create_post'

const comment = (over: Record<string, unknown> = {}) => ({
    id: 501, uuid: 'c501', comment_parent_id: 0, parent_id: 1000, parent_uuid: 'p1000',
    community: 'TheDonald', created: 1700000000000, raw_content: 'what I typed', author: 'me', ...over,
})

describe('create_comment through fetch', () => {
    it('forwards the new comment and the logged-in user', async () => {
        fetchResponse = () => new Response(JSON.stringify({ comments: [comment()] }))
        const res = await window.fetch(CREATE_COMMENT, { method: 'POST', body: JSON.stringify({ content: 'what I typed', parentId: 1000 }) })
        expect(await res.json()).toEqual({ comments: [comment()] }) // the page still gets its response
        expect(posted).toEqual([
            {
                source: MSG_SOURCE, type: 'created-comment', id: 501, uuid: 'c501', post_id: 1000, post_uuid: 'p1000',
                community: 'TheDonald', created: 1700000000000, title: '', text: 'what I typed',
            },
            { source: MSG_SOURCE, type: 'logged-in-user', user: 'me' },
        ])
    })

    it('falls back to the typed text when the response blanks it', async () => {
        fetchResponse = () => new Response(JSON.stringify({ comments: [comment({ raw_content: '', content: '' })] }))
        await window.fetch(CREATE_COMMENT, { method: 'POST', body: JSON.stringify({ content: 'typed body' }) })
        expect(posted[0].text).toBe('typed body')
    })

    it('ignores other endpoints and survives a response that is not JSON', async () => {
        fetchResponse = () => new Response(JSON.stringify({ comments: [comment()] }))
        await window.fetch('https://patriots.win/api/v2/post/post.json?id=1')
        fetchResponse = () => new Response('<html>busy</html>')
        const res = await window.fetch(CREATE_COMMENT, { method: 'POST', body: '{}' })
        expect(await res.text()).toBe('<html>busy</html>')
        expect(posted).toEqual([])
    })

    it('does not wrap fetch twice when injected again', async () => {
        vi.resetModules()
        await import('../inject')
        fetchResponse = () => new Response(JSON.stringify({ comments: [comment()] }))
        await window.fetch(CREATE_COMMENT, { method: 'POST', body: '{}' })
        expect(posted.filter(m => m.type === 'created-comment')).toHaveLength(1)
    })
})

describe('create_post through XHR', () => {
    it('forwards the new post with its title and text', () => {
        FakeXHR.nextResponse = JSON.stringify({
            posts: [{ id: 77, uuid: 'p77', title: 'A title', community: 'TheDonald', created: 5, raw_content: 'post body', author: 'me' }],
        })
        const xhr = new (globalThis as any).XMLHttpRequest()
        xhr.open('POST', CREATE_POST)
        xhr.send(JSON.stringify({ title: 'A title', content: 'post body' }))
        expect(posted[0]).toEqual({
            source: MSG_SOURCE, type: 'created-post', id: 77, uuid: 'p77', post_id: 77, post_uuid: 'p77',
            community: 'TheDonald', created: 5, title: 'A title', text: 'post body',
        })
        expect(posted[1]).toEqual({ source: MSG_SOURCE, type: 'logged-in-user', user: 'me' })
    })

    it('does not mistake a comment in the response for the post', () => {
        FakeXHR.nextResponse = JSON.stringify({ comment: comment(), post: { id: 78, uuid: 'p78', title: 'T' } })
        const xhr = new (globalThis as any).XMLHttpRequest()
        xhr.open('POST', CREATE_POST)
        xhr.send('{}')
        expect(posted[0]).toMatchObject({ type: 'created-post', id: 78 })
    })
})
