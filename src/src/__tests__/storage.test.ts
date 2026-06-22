import { describe, it, expect } from 'vitest'
import { trimOwnItems, MAX_OWN, type OwnItem } from '../storage'
import { permalink } from '../common'

const tracked = (id: number, created: number): OwnItem => ({
    id,
    uuid: `u${id}`,
    type: 'comment',
    title: '',
    post_id: 1,
    post_uuid: 'p',
    community: 'TheDonald',
    created,
    text: '',
    is_removed: false,
    removal_source: '',
    removal_count: 0,
    visible_count: 0,
    recorded: false,
})

describe('trimOwnItems', () => {
    it('keeps everything when under the cap', () => {
        const map = { '1': tracked(1, 10), '2': tracked(2, 20) }
        expect(Object.keys(trimOwnItems(map))).toHaveLength(2)
    })

    it('caps at MAX_OWN, keeping the most recently created', () => {
        const map: Record<string, OwnItem> = {}
        for (let i = 0; i < MAX_OWN + 50; i++) map[String(i)] = tracked(i, i) // created === i
        const out = trimOwnItems(map)
        expect(Object.keys(out)).toHaveLength(MAX_OWN)
        // the oldest (small `created`) are dropped; the newest survive
        expect(out[String(MAX_OWN + 49)]).toBeDefined()
        expect(out['0']).toBeUndefined()
    })
})

describe('permalink', () => {
    it('links a comment within its post (default origin)', () => {
        expect(permalink('examplePost1', 'exampleCmnt1', 'comment')).toBe(
            'https://patriots.win/p/examplePost1/x/c/exampleCmnt1',
        )
    })
    it('links a post to itself (uuid ignored)', () => {
        expect(permalink('examplePost2', 'examplePost2', 'post')).toBe('https://patriots.win/p/examplePost2/')
    })
    it('honors the active origin (e.g. scored.co)', () => {
        expect(permalink('examplePost1', 'exampleCmnt1', 'comment', 'https://scored.co')).toBe(
            'https://scored.co/p/examplePost1/x/c/exampleCmnt1',
        )
        expect(permalink('examplePost2', 'examplePost2', 'post', 'https://scored.co')).toBe(
            'https://scored.co/p/examplePost2/',
        )
    })
})
