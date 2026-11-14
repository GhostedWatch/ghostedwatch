import type { RemovedRecord } from './storage'
import { removalSourceLabel } from './removal-sources'

// Pure aggregation over the removal log, so the insights view stays unit-testable and
// free of storage/DOM. `now` is injectable for deterministic day-bucket tests.

export interface Tally {
    name: string
    count: number
}
export interface Stats {
    total: number
    own: number
    other: number
    hidden: number // removed AND hidden from others entirely
    reapproved: number
    byCommunity: Tally[] // sorted desc
    bySource: Tally[] // sorted desc, friendly labels
    medianTimeToRemovalMs: number | null // among records whose post time is known
    perDay: Array<{ day: string; count: number }> // last 14 days incl. zeros, ascending
}

// --- export ---
const CSV_COLS: Array<[string, (r: RemovedRecord) => string]> = [
    ['id', r => String(r.id)],
    ['type', r => r.type],
    ['source', r => r.source || 'own'],
    ['community', r => r.community],
    ['author', r => r.author || ''],
    ['removed_by', r => removalSourceLabel(r.removal_source)],
    ['status', r => (r.reapproved_utc ? 're-approved' : r.hidden ? 'hidden' : r.status)],
    ['created', r => (r.created ? new Date(r.created).toISOString() : '')],
    ['observed', r => new Date(r.observed_utc).toISOString()],
    ['reapproved', r => (r.reapproved_utc ? new Date(r.reapproved_utc).toISOString() : '')],
    ['title', r => r.title || ''],
    ['text', r => r.text || ''],
]
function csvField(s: string): string {
    // Text from comments (other people's too, for watched items) must not become a
    // formula when the file is opened in a spreadsheet: a leading ' keeps it text.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function toCSV(removed: RemovedRecord[]): string {
    const header = CSV_COLS.map(c => c[0]).join(',')
    const rows = removed.map(r => CSV_COLS.map(([, f]) => csvField(f(r))).join(','))
    return [header, ...rows].join('\n')
}
export function toJSON(removed: RemovedRecord[]): string {
    return JSON.stringify(removed, null, 2)
}

function tally(values: string[]): Tally[] {
    const counts = new Map<string, number>()
    for (const v of values) counts.set(v, (counts.get(v) || 0) + 1)
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count)
}

function median(nums: number[]): number | null {
    if (nums.length === 0) return null
    const s = [...nums].sort((a, b) => a - b)
    const mid = Math.floor(s.length / 2)
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function computeStats(removed: RemovedRecord[], now: number = Date.now()): Stats {
    // Records the first-run history scan found carry the scan's time, not the removal's,
    // so they count in the totals but not in when-it-happened figures.
    const timed = removed.filter(r => !r.backfill)
    const durations = timed
        .filter(r => r.created > 0 && r.observed_utc > r.created)
        .map(r => r.observed_utc - r.created)

    // last 14 days, with zero-filled gaps, oldest → newest
    const counts = new Map<string, number>()
    for (const r of timed) counts.set(dayKey(r.observed_utc), (counts.get(dayKey(r.observed_utc)) || 0) + 1)
    const perDay: Array<{ day: string; count: number }> = []
    for (let i = 13; i >= 0; i--) {
        const day = dayKey(now - i * 86400000)
        perDay.push({ day, count: counts.get(day) || 0 })
    }

    return {
        total: removed.length,
        own: removed.filter(r => r.source !== 'other').length,
        other: removed.filter(r => r.source === 'other').length,
        hidden: removed.filter(r => r.hidden).length,
        reapproved: removed.filter(r => r.reapproved_utc).length,
        byCommunity: tally(removed.map(r => r.community || 'unknown')),
        bySource: tally(removed.map(r => removalSourceLabel(r.removal_source))),
        medianTimeToRemovalMs: median(durations),
        perDay,
    }
}
