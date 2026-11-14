import { describe, it, expect } from 'vitest'

const local: Record<string, unknown> = {}
;(globalThis as any).chrome = {
    storage: {
        local: {
            get: (keys: string[]) => Promise.resolve(Object.fromEntries(keys.filter(k => k in local).map(k => [k, structuredClone(local[k])]))),
            set: (obj: Record<string, unknown>) => (Object.assign(local, structuredClone(obj)), Promise.resolve()),
        },
        sync: { get: () => Promise.resolve({}), set: () => Promise.resolve() },
    },
}
import { fillRemovedSources, getRemoved } from '../storage'

describe('fillRemovedSources', () => {
    it('fills a missing source and follows a pending one once it is settled', async () => {
        local.removed = {
            1: { id: 1, removal_source: '' },
            2: { id: 2, removal_source: 'communityFilterPending' },
            3: { id: 3, removal_source: 'moderator' },
        }
        await fillRemovedSources({ 1: 'spamFilter', 2: 'communityFilter', 3: 'moderator', 4: 'nuke' })
        const r = (await getRemoved()) as Record<string, { removal_source: string }>
        expect(r[1].removal_source).toBe('spamFilter')
        expect(r[2].removal_source).toBe('communityFilter')
        expect(r[3].removal_source).toBe('moderator')
        expect(r[4]).toBeUndefined() // no record is made up for an id it doesn't have
    })
})
