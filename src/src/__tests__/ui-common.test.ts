import { describe, it, expect } from 'vitest'
;(globalThis as any).chrome = { runtime: {}, storage: { local: {}, sync: {} } }
import { displayStatus, statusLabel, threadLimitNote, MENU_FULL_NOTE } from '../ui-common'
import { autoCommentRoom, MAX_AUTO_PER_POST, MAX_AUTO_TOTAL, type OtherItem, type RemovedRecord } from '../storage'

const rec = (over: Partial<RemovedRecord>): RemovedRecord => ({
    id: 1, uuid: 'u', type: 'comment', post_uuid: 'p', community: 'c', title: '', text: '', text_loading: false,
    status: 'publicly_removed', removal_source: 'moderator', created: 0, observed_utc: 0, unseen: false, ...over,
})

describe('status shown for a removed item', () => {
    it('an item the audit found hidden from others reads "hidden"', () => {
        // detection records publicly_removed; the public-view audit adds hidden
        const r = rec({ hidden: true })
        expect(statusLabel(r)).toBe('hidden')
        expect(displayStatus(r)).toBe('shadow_removed') // the style for hidden items
    })
    it('re-approval and deletion win over hidden', () => {
        expect(statusLabel(rec({ hidden: true, reapproved_utc: 5 }))).toBe('re-approved')
        expect(displayStatus(rec({ hidden: true, reapproved_utc: 5 }))).toBe('reapproved')
        expect(statusLabel(rec({ hidden: true, status: 'deleted' }))).toBe('deleted')
    })
    it('a placeholder others can see reads "removed"', () => {
        expect(statusLabel(rec({ hidden: false }))).toBe('removed')
        expect(displayStatus(rec({}))).toBe('publicly_removed')
    })
})

describe('the comment limits a whole-post watch can hit', () => {
    it('counts the room left across all threads, auto-added comments only', () => {
        const map: Record<string, OtherItem> = {}
        for (let i = 0; i < MAX_AUTO_TOTAL; i++) map[i] = { id: i, auto: true } as OtherItem
        map.post = { id: 99999, type: 'post', watch_comments: true } as OtherItem
        map.single = { id: 99998, type: 'comment' } as OtherItem // clicked on its own
        expect(autoCommentRoom(map)).toBe(0)
        delete map[0]
        expect(autoCommentRoom(map)).toBe(1)
        expect(autoCommentRoom({})).toBe(MAX_AUTO_TOTAL)
    })
    it('says why a thread follows no comments, or no new ones', () => {
        expect(threadLimitNote(0, 0)).toBe(
            "Its comments aren't followed: the 3,000-comment limit is reached. Turn off All comments on another post to make room.",
        )
        expect(threadLimitNote(12, 0)).toMatch(/^New comments aren't followed: the 3,000-comment limit is reached/)
        // a post at its own cap: room elsewhere wouldn't help it, so it doesn't say to make some
        expect(threadLimitNote(MAX_AUTO_PER_POST, 50)).toBe("New comments aren't followed: 300 is the most for one post.")
        expect(threadLimitNote(MAX_AUTO_PER_POST, 0)).toBe("New comments aren't followed: 300 is the most for one post.")
        expect(threadLimitNote(12, 50)).toBe('')
        expect(MENU_FULL_NOTE).toContain('3,000-comment limit')
    })
})
