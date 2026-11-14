import { describe, it, expect } from 'vitest'
import { computeStats, toCSV, toJSON } from '../stats'
import type { RemovedRecord } from '../storage'

const rec = (over: Partial<RemovedRecord>): RemovedRecord => ({
    id: 1,
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
    observed_utc: 1000,
    unseen: true,
    ...over,
})

describe('computeStats', () => {
    it('counts totals, own/other, hidden, reapproved', () => {
        const s = computeStats([
            rec({ id: 1 }),
            rec({ id: 2, source: 'other' }),
            rec({ id: 3, hidden: true }),
            rec({ id: 4, reapproved_utc: 5 }),
        ])
        expect(s.total).toBe(4)
        expect(s.own).toBe(3) // no source = own
        expect(s.other).toBe(1)
        expect(s.hidden).toBe(1)
        expect(s.reapproved).toBe(1)
    })

    it('tallies communities and sources, sorted desc', () => {
        const s = computeStats([
            rec({ id: 1, community: 'A', removal_source: 'moderator' }),
            rec({ id: 2, community: 'A', removal_source: 'communityFilter' }),
            rec({ id: 3, community: 'B', removal_source: 'communityFilter' }),
        ])
        expect(s.byCommunity[0]).toEqual({ name: 'A', count: 2 })
        expect(s.bySource[0]).toEqual({ name: 'community filter', count: 2 })
    })

    it('labels sources with the shared removal-source labels (each filter separately)', () => {
        const s = computeStats([
            rec({ id: 1, removal_source: 'spamFilter' }),
            rec({ id: 2, removal_source: 'riskFilterPending' }),
            rec({ id: 3, removal_source: 'communityFilter' }),
            rec({ id: 4, removal_source: '' }),
        ])
        expect(s.bySource.map(t => t.name).sort()).toEqual([
            'community filter',
            'risk filter (pending)',
            'spam filter',
            'unknown',
        ])
    })

    it('median time-to-removal from created→observed (ignores unknown created)', () => {
        const s = computeStats([
            rec({ id: 1, created: 1000, observed_utc: 4000 }), // 3000
            rec({ id: 2, created: 1000, observed_utc: 6000 }), // 5000
            rec({ id: 3, created: 0, observed_utc: 9999 }), // ignored (no created)
        ])
        expect(s.medianTimeToRemovalMs).toBe(4000)
    })

    it('leaves history-scan finds out of the timing figures (their time is the scan), not the totals', () => {
        const now = Date.UTC(2026, 5, 20, 12)
        const s = computeStats(
            [
                rec({ id: 1, created: now - 4000, observed_utc: now - 1000 }), // 3000
                rec({ id: 2, created: now - 90 * 86400000, observed_utc: now, backfill: true }),
                rec({ id: 3, created: now - 30 * 86400000, observed_utc: now, backfill: true }),
            ],
            now,
        )
        expect(s.total).toBe(3)
        expect(s.medianTimeToRemovalMs).toBe(3000)
        expect(s.perDay[13].count).toBe(1)
    })

    it('buckets removals into the last 14 days, zero-filled', () => {
        const now = Date.UTC(2026, 5, 20, 12)
        const s = computeStats(
            [
                rec({ id: 1, observed_utc: now }),
                rec({ id: 2, observed_utc: now - 86400000 }),
                rec({ id: 3, observed_utc: now - 86400000 }),
            ],
            now,
        )
        expect(s.perDay).toHaveLength(14)
        expect(s.perDay[13].count).toBe(1) // today
        expect(s.perDay[12].count).toBe(2) // yesterday
        expect(s.perDay[0].count).toBe(0) // 13 days ago
    })
})

describe('export', () => {
    it('toCSV: header row + plain fields unquoted, special chars escaped', () => {
        const csv = toCSV([
            rec({ id: 1, text: 'plain' }),
            rec({ id: 2, text: 'has, comma "and" quote\nnewline' }),
        ])
        expect(csv.split('\n')[0]).toBe('id,type,source,community,author,removed_by,status,created,observed,reapproved,title,text')
        expect(csv).toContain(',plain')
        expect(csv).toContain('"has, comma ""and"" quote\nnewline"') // quoted + doubled quotes
    })
    it('toCSV: text that a spreadsheet would run as a formula stays text', () => {
        const rows = toCSV([
            rec({ id: 1, text: '=HYPERLINK("http://x","click")' }),
            rec({ id: 2, text: '+1 agreed' }),
            rec({ id: 3, text: '@everyone' }),
            rec({ id: 4, text: '-5 for this' }),
            rec({ id: 5, text: 'a = b' }),
        ]).split('\n')
        expect(rows[1].endsWith(`,"'=HYPERLINK(""http://x"",""click"")"`)).toBe(true)
        expect(rows[2].endsWith(",'+1 agreed")).toBe(true)
        expect(rows[3].endsWith(",'@everyone")).toBe(true)
        expect(rows[4].endsWith(",'-5 for this")).toBe(true)
        expect(rows[5].endsWith(',a = b')).toBe(true) // only a leading sign matters
    })
    it('toCSV: removed_by carries the shared removal-source label', () => {
        const [, row] = toCSV([rec({ id: 1, removal_source: 'politicsFilterPending' })]).split('\n')
        expect(row.split(',')[5]).toBe('politics filter (pending)')
    })
    it('toJSON: round-trips the records', () => {
        const recs = [rec({ id: 1 }), rec({ id: 2, source: 'other' })]
        expect(JSON.parse(toJSON(recs))).toEqual(recs)
    })
})
