import { describe, it, expect } from 'vitest'
import { idToUuid, uuidToId, normalizeProfileComment, classifyPublicView } from '../win-api'

describe('win id <-> uuid encoding', () => {
    // id/uuid pairs produced by the scheme (synthetic, computed from the algorithm).
    const pairs: Array<[number, string]> = [
        [1000, 'tqd3A'],
        [12345, '3idarWH'],
        [9000000, '1BiviZSCC8'],
    ]
    it('decodes uuids to ids', () => {
        for (const [id, uuid] of pairs) expect(uuidToId(uuid)).toBe(id)
    })
    it('encodes ids to uuids', () => {
        for (const [id, uuid] of pairs) expect(idToUuid(id)).toBe(uuid)
    })
    it('round-trips arbitrary ids', () => {
        for (const id of [1, 100, 999001, 123456789, 9007199254740991]) {
            expect(uuidToId(idToUuid(id))).toBe(id)
        }
    })
})

describe('normalizeProfileComment', () => {
    it('maps a comment item (parent_id/parent_uuid = the post)', () => {
        const c = normalizeProfileComment({
            id: 12345,
            uuid: '3idarWH',
            post_title: 'a thread title', // marks it a comment
            comment_parent_id: 0,
            parent_id: 1000,
            parent_uuid: 'tqd3A',
            community: 'TheDonald',
            created: 123,
            is_removed: true,
            removal_source: 'communityFilter',
            raw_content: '',
        })
        expect(c).toEqual({
            id: 12345,
            uuid: '3idarWH',
            type: 'comment',
            post_id: 1000,
            post_uuid: 'tqd3A',
            community: 'TheDonald',
            created: 123,
            is_removed: true,
            removal_source: 'communityFilter',
            title: '',
            text: '',
        })
    })
    it('maps a post item (its own id/uuid is the post; title carried)', () => {
        const p = normalizeProfileComment({
            id: 9000000,
            uuid: '1BiviZSCC8',
            title: 'An example removed post',
            link: 'https://example.com',
            community: 'TheDonald',
            created: 9,
            is_removed: true,
            removal_source: 'communityFilterPending',
            raw_content: '',
        })
        expect(p.type).toBe('post')
        expect(p.post_id).toBe(9000000)
        expect(p.post_uuid).toBe('1BiviZSCC8')
        expect(p.title).toBe('An example removed post')
        expect(p.is_removed).toBe(true)
    })
    it('keeps live comment text when present', () => {
        const c = normalizeProfileComment({ id: 1, uuid: 'x', post_title: 't', parent_id: 2, parent_uuid: 'p', raw_content: 'hi' })
        expect(c.type).toBe('comment')
        expect(c.text).toBe('hi')
        expect(c.is_removed).toBe(false)
    })
})

describe('classifyPublicView (audit)', () => {
    describe('comments', () => {
        it('"live" when the public still sees the content (false positive)', () => {
            expect(classifyPublicView('comment', 5, { comments: [{ id: 5, raw_content: 'still here' }] })).toBe('live')
            expect(classifyPublicView('comment', 5, { comments: [{ id: 5, content: 'rendered' }] })).toBe('live')
        })
        it('"visible" when present but blanked (a placeholder others can see)', () => {
            expect(classifyPublicView('comment', 5, { comments: [{ id: 5, raw_content: '', content: '' }] })).toBe('visible')
        })
        it('"absent" when not in the public thread at all (hidden from others)', () => {
            expect(classifyPublicView('comment', 5, { comments: [{ id: 99, content: 'someone else' }] })).toBe('absent')
            expect(classifyPublicView('comment', 5, {})).toBe('absent')
        })
    })

    describe('posts', () => {
        it('"live" when the public post still has a title/body', () => {
            expect(classifyPublicView('post', 8, { posts: [{ id: 8, title: 'Hello' }] })).toBe('live')
        })
        it('"visible" when the post is present but blanked', () => {
            expect(classifyPublicView('post', 8, { posts: [{ id: 8, title: '', raw_content: '', content: '' }] })).toBe('visible')
        })
        it('"absent" when no post is returned', () => {
            expect(classifyPublicView('post', 8, { posts: [] })).toBe('absent')
        })
        it('falls back to the first post when the id does not match exactly', () => {
            // the thread endpoint returns the post under a different id shape; treat
            // the sole returned post as the subject
            expect(classifyPublicView('post', 8, { posts: [{ id: 0, title: 'Hello' }] })).toBe('live')
        })
    })
})
