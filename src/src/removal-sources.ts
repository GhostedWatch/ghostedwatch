// Every removal_source the .win sites report, in one place: the short label the
// extension shows for it (in-page pill, History, Insights, CSV export, share card),
// and the placeholder the site itself shows others in the item's place. The site's
// wording is ported from its main JS bundle (patriots.win, 2026-09-24): the page
// renders "Comment " / "Post " followed by it.
import type { ItemType } from './win-api'

interface SourceEntry {
    label: string
    // the site's text after "Comment "/"Post ", minus the final period. Absent for
    // keys the site doesn't know, which it shows as plain "removed".
    site?: string
    // leads the tooltip when the site's wording hides the real source
    note?: string
}

// A site source and its `<key>Pending` variant, which the site shows as the same
// text + ", pending further review."
function withPending(key: string, e: SourceEntry & { site: string }): Array<[string, SourceEntry]> {
    return [
        [key, e],
        [`${key}Pending`, { ...e, label: `${e.label} (pending)`, site: `${e.site}, pending further review` }],
    ]
}

// A Map rather than an object literal, so a removal_source such as "constructor"
// can't resolve to an Object.prototype member.
const SOURCES = new Map<string, SourceEntry>([
    ['deleted', { label: 'deleted', site: 'deleted by the user' }],
    ...withPending('politicsFilter', {
        label: 'politics filter',
        site: 'removed by politics filter in non-political community',
    }),
    ...withPending('spamFilter', { label: 'spam filter', site: 'removed by spam filter' }),
    ...withPending('communityFilter', { label: 'community filter', site: 'removed by community filter' }),
    ...withPending('contentPolicy', { label: 'content policy', site: 'removed for violating our Content Policy' }),
    ...withPending('nuke', { label: 'nuke', site: 'removed upon the user being banned' }),
    ...withPending('moderator', { label: 'moderator', site: 'removed by community moderators' }),
    // the site shows its automatic risk filter to others as a moderator removal
    ...withPending('riskFilter', {
        label: 'risk filter',
        site: 'removed by community moderators',
        note: "Removed by the site's automatic risk filter.",
    }),
    // kept from the extension's earlier label map; the site's own mapping doesn't
    // include them, so it shows them as plain "removed"
    ['admin', { label: 'admin' }],
    ['legacy', { label: 'legacy' }],
])

export const REMOVAL_SOURCES: readonly string[] = [...SOURCES.keys()]

const lookup = (source: string | undefined) => SOURCES.get(source || '')

export function isKnownRemovalSource(source: string | undefined): boolean {
    return lookup(source) !== undefined
}

// Short label for a removal source. An unrecognized source keeps its raw key, so one
// the site adds later still shows up on its own (Insights, CSV) instead of being
// lumped in with "unknown".
export function removalSourceLabel(source: string | undefined): string {
    return lookup(source)?.label || source || 'unknown'
}

// The placeholder the site shows others in the item's place, worded exactly as the
// site's own mapping renders it; a missing or unrecognized source is plain "removed".
export function siteRemovalText(source: string | undefined, type: ItemType): string {
    return `${type === 'post' ? 'Post' : 'Comment'} ${lookup(source)?.site || 'removed'}.`
}

// Tooltip for a source label: what others see, after a note when that wording hides
// the real source (riskFilter reads as a moderator removal).
export function removalSourceTooltip(source: string | undefined, type: ItemType): string {
    const note = lookup(source)?.note
    return `${note ? `${note} ` : ''}The site shows it to others as “${siteRemovalText(source, type)}”`
}
