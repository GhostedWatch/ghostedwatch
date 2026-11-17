// The log a problem report carries (report.ts): what each check did. Only the background
// writes it, to storage.local. No username, tokens or post text go in; item ids do, as
// #<id>, which the feedback form can swap for stand-ins (always, in a public report).
//
// A routine check, where nothing failed and nothing was found, only adds to its hour's
// totals, kept in a small key of their own and written out as one line once the hour is
// over. So at the default 1-minute interval a quiet hour is one line, and MAX_LINES holds
// about a week. Anything else gets a line of its own at once.
import api from './api'
import { locked } from './storage'

export const LOG_KEY = 'diag_log'
export const HOUR_KEY = 'diag_hour'
export const MAX_LINES = 400
const MAX_LINE_CHARS = 400
const HOUR_MS = 60 * 60 * 1000

interface Hour {
    at: number // when the hour began
    checks: number
    noSession: number // checks with no session to check with
    requests: Record<string, number> // by endpoint
}
interface Check {
    notes: string[]
    noSession: boolean
    requests: Record<string, number>
}

// The check in progress; the background runs one at a time (cycle() in background.ts).
// Requests made between checks (a Watch click looks its item up) count toward the next.
let check: Check | null = null
let between: Record<string, number> = {}

// "11-14 10:05", in UTC, which the feedback form tells the reader above the log
export const stamp = (t: number): string => new Date(t).toISOString().slice(5, 16).replace('T', ' ')
// 'content/profile.json?user=…' → 'profile': no query, so no username or ids
export const endpointOf = (path: string): string => (path.split('?')[0].split('/').pop() || '').replace(/\.json$/, '')
// An error's message for the log: no query strings (they can hold a username), and short.
export const errorText = (e: unknown): string =>
    (e instanceof Error ? e.message : String(e)).replace(/\?\S*/g, '').slice(0, 160)
export const idList = (items: Array<{ id: number }>): string => items.map(i => `#${i.id}`).join(' ')

export function beginCheck(): void {
    check = { notes: [], noSession: false, requests: between }
    between = {}
}
// A request to the site (win-api.ts apiGet), and how it failed if it did.
export function noteRequest(path: string, failure?: string): void {
    const endpoint = endpointOf(path)
    const counts = check ? check.requests : between
    counts[endpoint] = (counts[endpoint] || 0) + 1
    if (failure) note(`${endpoint}: ${failure}`)
}
// Something this check did that's worth a line. Outside a check it goes nowhere.
export function note(text: string): void {
    check?.notes.push(text)
}
export function noteNoSession(): void {
    if (check) check.noSession = true
}

const clip = (s: string) => (s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS - 1)}…` : s)
const read = async <T>(key: string, fallback: T): Promise<T> =>
    ((await api.storage.local.get([key]))[key] as T) ?? fallback
function hourLine(h: Hour): string {
    const requests = Object.entries(h.requests)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')
    return clip(
        `${stamp(h.at)}–${stamp(h.at + HOUR_MS - 60_000).slice(6)} · ${h.checks} check${h.checks === 1 ? '' : 's'}` +
            (h.noSession ? ` (${h.noSession} with no session)` : '') +
            (requests ? ` · requests: ${requests}` : ''),
    )
}

// The end of a check: add it to its hour, and give it a line if anything happened.
export function endCheck(): Promise<void> {
    const c = check
    check = null
    if (!c) return Promise.resolve()
    return locked(LOG_KEY, async () => {
        const now = Date.now()
        const at = now - (now % HOUR_MS)
        let hour = await read<Hour | null>(HOUR_KEY, null)
        const add: string[] = []
        if (hour && hour.at !== at) {
            add.push(hourLine(hour))
            hour = null
        }
        hour ||= { at, checks: 0, noSession: 0, requests: {} }
        hour.checks++
        if (c.noSession) hour.noSession++
        for (const [k, n] of Object.entries(c.requests)) hour.requests[k] = (hour.requests[k] || 0) + n
        if (c.notes.length) add.push(clip(`${stamp(now)} check · ${c.notes.join(' · ')}`))
        const writes: Record<string, unknown> = { [HOUR_KEY]: hour }
        if (add.length) writes[LOG_KEY] = [...(await read<string[]>(LOG_KEY, [])), ...add].slice(-MAX_LINES)
        await api.storage.local.set(writes)
    })
}

// Something that happened outside a check: an install, an update, a new session.
export function logEvent(text: string): Promise<void> {
    return locked(LOG_KEY, async () => {
        const lines = await read<string[]>(LOG_KEY, [])
        lines.push(clip(`${stamp(Date.now())} ${text}`))
        await api.storage.local.set({ [LOG_KEY]: lines.slice(-MAX_LINES) })
    })
}

// The log, oldest first, with the hour still running as its last line.
export async function getLogLines(): Promise<string[]> {
    const [lines, hour] = await Promise.all([read<string[]>(LOG_KEY, []), read<Hour | null>(HOUR_KEY, null)])
    return hour ? [...lines, `${hourLine(hour)} so far`] : lines
}
