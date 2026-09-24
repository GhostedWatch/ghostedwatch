import { describe, it, expect } from 'vitest'
import {
    REMOVAL_SOURCES,
    isKnownRemovalSource,
    isRemovalPlaceholder,
    removalSourceLabel,
    removalSourceTooltip,
    siteRemovalText,
} from '../removal-sources'

// The site's own mapping, from the patriots.win main JS bundle (2026-09-24): the page
// renders "Comment " / "Post " followed by this text.
const SITE_TEXT: Record<string, string> = {
    deleted: 'deleted by the user.',
    politicsFilter: 'removed by politics filter in non-political community.',
    spamFilter: 'removed by spam filter.',
    communityFilter: 'removed by community filter.',
    contentPolicy: 'removed for violating our Content Policy.',
    nuke: 'removed upon the user being banned.',
    moderator: 'removed by community moderators.',
    riskFilter: 'removed by community moderators.', // the site shows its risk filter as a moderator removal
    politicsFilterPending: 'removed by politics filter in non-political community, pending further review.',
    spamFilterPending: 'removed by spam filter, pending further review.',
    communityFilterPending: 'removed by community filter, pending further review.',
    contentPolicyPending: 'removed for violating our Content Policy, pending further review.',
    nukePending: 'removed upon the user being banned, pending further review.',
    moderatorPending: 'removed by community moderators, pending further review.',
    riskFilterPending: 'removed by community moderators, pending further review.',
}

const LABELS: Record<string, string> = {
    deleted: 'deleted',
    politicsFilter: 'politics filter',
    politicsFilterPending: 'politics filter (pending)',
    spamFilter: 'spam filter',
    spamFilterPending: 'spam filter (pending)',
    communityFilter: 'community filter',
    communityFilterPending: 'community filter (pending)',
    contentPolicy: 'content policy',
    contentPolicyPending: 'content policy (pending)',
    nuke: 'nuke',
    nukePending: 'nuke (pending)',
    moderator: 'moderator',
    moderatorPending: 'moderator (pending)',
    riskFilter: 'risk filter',
    riskFilterPending: 'risk filter (pending)',
    admin: 'admin',
    legacy: 'legacy',
}

// Not sources the site reports: only the listed sources have a Pending variant, and
// keys match exactly (case-sensitive, never an Object.prototype member).
const UNKNOWN = [
    'someNewFilter',
    'deletedPending',
    'adminPending',
    'SpamFilter',
    'toString',
    'constructor',
    '__proto__',
]

describe('removalSourceLabel', () => {
    it('labels every source the site reports, plus the extension-only admin/legacy keys', () => {
        for (const [source, label] of Object.entries(LABELS)) {
            expect(isKnownRemovalSource(source)).toBe(true)
            expect(removalSourceLabel(source)).toBe(label)
        }
    })
    it('knows exactly those sources', () => {
        expect([...REMOVAL_SOURCES].sort()).toEqual(Object.keys(LABELS).sort())
    })
    it('passes an unknown source through as its raw key', () => {
        for (const source of UNKNOWN) {
            expect(isKnownRemovalSource(source)).toBe(false)
            expect(removalSourceLabel(source)).toBe(source)
        }
    })
    it('labels a missing source "unknown"', () => {
        expect(isKnownRemovalSource('')).toBe(false)
        expect(removalSourceLabel('')).toBe('unknown')
        expect(removalSourceLabel(undefined)).toBe('unknown')
    })
})

describe('siteRemovalText (the placeholder the site shows others)', () => {
    it('matches the site for every source, on comments and posts', () => {
        for (const [source, text] of Object.entries(SITE_TEXT)) {
            expect(siteRemovalText(source, 'comment')).toBe(`Comment ${text}`)
            expect(siteRemovalText(source, 'post')).toBe(`Post ${text}`)
        }
    })
    it('is plain "removed." for a missing, unknown or extension-only source', () => {
        for (const source of ['', undefined, 'admin', 'legacy', ...UNKNOWN]) {
            expect(siteRemovalText(source, 'comment')).toBe('Comment removed.')
            expect(siteRemovalText(source, 'post')).toBe('Post removed.')
        }
    })
})

describe('removalSourceTooltip', () => {
    it('quotes what the site shows others', () => {
        expect(removalSourceTooltip('spamFilterPending', 'comment')).toBe(
            'The site shows it to others as “Comment removed by spam filter, pending further review.”',
        )
        expect(removalSourceTooltip('deleted', 'post')).toBe(
            'The site shows it to others as “Post deleted by the user.”',
        )
    })
    it('riskFilter: explains that others see a moderator removal', () => {
        expect(removalSourceTooltip('riskFilter', 'comment')).toBe(
            "Removed by the site's automatic risk filter. " +
                'The site shows it to others as “Comment removed by community moderators.”',
        )
        expect(removalSourceTooltip('riskFilterPending', 'post')).toBe(
            "Removed by the site's automatic risk filter. " +
                'The site shows it to others as “Post removed by community moderators, pending further review.”',
        )
        // a real moderator removal reads the same to others, without the risk-filter note
        expect(removalSourceTooltip('moderator', 'comment')).toBe(
            'The site shows it to others as “Comment removed by community moderators.”',
        )
    })
    it('an unknown source reads as plain "removed"', () => {
        expect(removalSourceTooltip('someNewFilter', 'comment')).toBe(
            'The site shows it to others as “Comment removed.”',
        )
    })
})

describe('isRemovalPlaceholder (the site shows it as removed)', () => {
    it('matches the placeholder regardless of the removal reason', () => {
        for (const s of [
            'Comment removed by community filter.',
            'Comment removed by community moderators.',
            'Comment removed upon the user being banned.',
            'Comment removed for spam.',
            'Post removed by admins.',
            '   Comment removed by the author.',
        ]) {
            expect(isRemovalPlaceholder(s)).toBe(true)
        }
    })
    it('matches every removal placeholder the site renders, for any source', () => {
        for (const source of [...REMOVAL_SOURCES, '', 'someNewFilter']) {
            if (source === 'deleted') continue // "Comment deleted by the user." is the author's own deletion
            expect(isRemovalPlaceholder(siteRemovalText(source, 'comment'))).toBe(true)
            expect(isRemovalPlaceholder(siteRemovalText(source, 'post'))).toBe(true)
        }
        expect(isRemovalPlaceholder(siteRemovalText('deleted', 'comment'))).toBe(false)
    })
    it('does not match real content that merely mentions removal', () => {
        for (const s of [
            'This is my actual comment.',
            'I think this comment removed by mods was unfair',
            'removed by community filter',
            '',
        ]) {
            expect(isRemovalPlaceholder(s)).toBe(false)
        }
    })
})
