// "Report a problem": the feedback form on ghostedwatch.com, opened with the version,
// a status summary and the diagnostic log (diaglog.ts) filled in. They travel in the
// link's #fragment, which the browser never sends to the server, so nothing leaves the
// machine until the person presses Send there. The form can also post the report as a
// public GitHub issue. It can hide the item ids, and always does in a public one.
//
// What goes in never names the account: no username, tokens, post text, or the names of
// the people and communities watched.
import api from './api'
import { getLogLines } from './diaglog'
import {
    getAuth,
    getDeepCheckedAt,
    getLastAlarm,
    getLastCheck,
    getOptions,
    getOtherItems,
    getOwnItems,
    getRemoved,
    getSources,
} from './storage'
import { prettyAgo } from './time'

export const FEEDBACK_URL = 'https://ghostedwatch.com/feedback.html'
// The link carries the log, so it's kept to the newest lines that fit: a link of a few
// tens of KB opens fine in every browser this supports.
export const REPORT_LOG_MAX_CHARS = 16000

export interface ReportDetails {
    v: string // version
    b: string // browser and system
    s: string // status summary
    l: string // diagnostic log, oldest first
    t: number // when this was put together
}

export function browserName(ua: string): string {
    const name = [
        ['Firefox', 'Firefox'],
        ['Edg', 'Edge'],
        ['OPR', 'Opera'],
        ['HeadlessChrome', 'Headless Chrome'],
        ['Chrome', 'Chrome'],
    ]
        .map(([token, label]) => {
            const m = ua.match(new RegExp(`\\b${token}/(\\d+)`))
            return m ? `${label} ${m[1]}` : ''
        })
        .find(Boolean)
    const os = /Windows/.test(ua)
        ? 'Windows'
        : /CrOS/.test(ua)
          ? 'ChromeOS'
          : /Android/.test(ua)
            ? 'Android'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'macOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : ''
    return [name, os].filter(Boolean).join(', ') || 'unknown browser'
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const ago = (t: number) => (t ? prettyAgo(t) : 'never')

// The status summary: settings, the session, and how much is watched and found.
export async function statusSummary(): Promise<string> {
    const [options, auth, lastCheck, lastAlarm, own, removed, other, sources] = await Promise.all([
        getOptions(),
        getAuth(),
        getLastCheck(),
        getLastAlarm(),
        getOwnItems(),
        getRemoved(),
        getOtherItems(),
        getSources(),
    ])
    const records = Object.values(removed)
    const mine = records.filter(r => r.source !== 'other')
    const theirs = records.length - mine.length
    const items = Object.values(other)
    const posts = items.filter(w => w.type === 'post')
    const autos = items.filter(w => w.auto).length
    const kinds = Object.values(sources)
    let bytes = 0
    try {
        bytes = (await api.storage.local.getBytesInUse?.(null)) || 0
    } catch {
        /* not in every browser */
    }
    const deep = auth ? await getDeepCheckedAt(auth.user) : 0
    return [
        `Checks every ${options.interval} min · alerts: ${options.notifyMode} · Watch buttons ${options.watchButtons === false ? 'off' : 'on'}`,
        auth
            ? `Connected (${new URL(auth.origin).host}) · last check ${ago(lastCheck)} · check timer last fired ${ago(lastAlarm)} · read further back ${ago(deep)}`
            : `Not connected · last check ${ago(lastCheck)} · check timer last fired ${ago(lastAlarm)}`,
        `Your items: ${Object.keys(own).length} tracked · ${mine.filter(r => !r.reapproved_utc).length} removed ` +
            `(${mine.filter(r => r.hidden && !r.reapproved_utc).length} hidden from others) · ` +
            `${mine.filter(r => r.reapproved_utc).length} re-approved`,
        `Watching: ${plural(posts.length, 'post')} (${posts.filter(w => w.watch_comments).length} with all comments, ` +
            `following ${plural(autos, 'comment')}) · ${plural(items.filter(w => w.type === 'comment' && !w.auto).length, 'comment')} · ` +
            `${plural(kinds.filter(k => k.kind === 'user').length, 'user')} · ${plural(kinds.filter(k => k.kind === 'feed').length, 'feed')} · ` +
            `${theirs} watched removals recorded`,
        ...(bytes ? [`Storage: ${(bytes / 1048576).toFixed(1)} MB used`] : []),
    ].join('\n')
}

// The newest lines that fit in `max` characters, with a note when older ones were cut.
export function newestLines(lines: string[], max: number): string {
    const kept: string[] = []
    let size = 0
    for (let i = lines.length - 1; i >= 0; i--) {
        if (size + lines[i].length + 1 > max) {
            kept.unshift(`(${i + 1} older line${i ? 's' : ''} left out)`)
            break
        }
        kept.unshift(lines[i])
        size += lines[i].length + 1
    }
    return kept.join('\n')
}

export async function buildReportDetails(): Promise<ReportDetails> {
    return {
        v: api.runtime.getManifest().version,
        b: browserName(navigator.userAgent),
        s: await statusSummary(),
        l: newestLines(await getLogLines(), REPORT_LOG_MAX_CHARS),
        t: Date.now(),
    }
}

// base64url of the details' JSON, as the form's `#r=` reads it
export function reportUrl(d: ReportDetails): string {
    const bytes = new TextEncoder().encode(JSON.stringify(d))
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return `${FEEDBACK_URL}#r=${btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

export async function openReport(): Promise<void> {
    await api.tabs.create({ url: reportUrl(await buildReportDetails()) })
}
