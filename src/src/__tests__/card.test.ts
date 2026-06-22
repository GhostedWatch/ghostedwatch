import { describe, it, expect } from 'vitest'
import { wrapLines, removalCardSVG } from '../card'
import type { RemovedRecord } from '../storage'

const rec = (over: Partial<RemovedRecord>): RemovedRecord => ({
    id: 7,
    uuid: 'u',
    type: 'comment',
    post_uuid: 'p',
    community: 'TheDonald',
    title: '',
    text: '',
    text_loading: false,
    status: 'publicly_removed',
    removal_source: 'communityFilter',
    created: 0,
    observed_utc: 1_000_000_000,
    unseen: true,
    ...over,
})

describe('wrapLines', () => {
    it('wraps by word within the char budget', () => {
        expect(wrapLines('a b c d e', 3)).toEqual(['a b', 'c d', 'e'])
    })
    it('hard-breaks over-long words', () => {
        expect(wrapLines('abcdefgh', 3)).toEqual(['abc', 'def', 'gh'])
    })
    it('collapses whitespace', () => {
        expect(wrapLines('  hi   there  ', 20)).toEqual(['hi there'])
    })
})

describe('removalCardSVG', () => {
    it('includes branding, the removal source, author/community and the text', () => {
        const svg = removalCardSVG(
            rec({ author: 'Bob', community: 'TheDonald', removal_source: 'communityFilter', text: 'hello world' }),
        )
        expect(svg.startsWith('<svg')).toBe(true)
        expect(svg).toContain('GhostedWatch')
        expect(svg).toContain('REMOVED')
        expect(svg).toContain('community filter')
        expect(svg).toContain('comment by Bob · c/TheDonald')
        expect(svg).toContain('hello world')
    })
    it('escapes special characters in the text', () => {
        const svg = removalCardSVG(rec({ text: '<script> & "quotes"' }))
        expect(svg).toContain('&lt;script&gt; &amp; &quot;quotes&quot;')
        expect(svg).not.toContain('<script>')
    })
    it('shows a post title for posts', () => {
        const svg = removalCardSVG(rec({ type: 'post', title: 'My Post Title', author: 'Alice' }))
        expect(svg).toContain('My Post Title')
        expect(svg).toContain('post by Alice')
    })
})
