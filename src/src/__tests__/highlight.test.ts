import { describe, it, expect } from 'vitest'
import { uuidFromHref, postUuidFromHref, childContaining } from '../highlight'

// Build a fake node tree (only parentElement is walked) mirroring the real .win
// comment block: a flex row [vote | body | .child reply], where body holds the
// permalink and the nested reply is a SEPARATE column.
function node(parent?: Fake): Fake {
    const n: Fake = { parentElement: parent || null }
    return n
}
type Fake = { parentElement: Fake | null }
const asEl = (n: Fake) => n as unknown as Element

describe('childContaining (which column to outline)', () => {
    const block = node()
    const vote = node(block)
    const body = node(block)
    const meta = node(body)
    const content = node(body)
    const actions = node(body)
    const permalink = node(actions)
    const childCol = node(block)
    const nestedComment = node(childCol)

    it('returns the body column for the comment block (not the whole block)', () => {
        expect(childContaining(asEl(block), asEl(permalink))).toBe(body)
    })
    it('returns the action row within the body (anchor host) for text insertion', () => {
        expect(childContaining(asEl(body), asEl(permalink))).toBe(actions)
    })
    it('keeps a nested reply in its OWN column — the body outline excludes it', () => {
        expect(childContaining(asEl(block), asEl(nestedComment))).toBe(childCol)
        expect(childContaining(asEl(body), asEl(nestedComment))).toBeNull()
        // sanity: these unused fixtures are wired up
        expect([vote, meta, content].every(n => n.parentElement)).toBe(true)
    })
    it('returns null when the descendant is not inside the parent', () => {
        expect(childContaining(asEl(body), asEl(vote))).toBeNull()
    })
})

// These pure URL parsers decide which DOM block gets a "removed" banner. They
// previously regressed on scored.co (whose paths carry TWO `/c/` segments), so
// pin both site URL shapes.
describe('uuidFromHref (comment uuid)', () => {
    it('reads the single /c/ on a patriots.win permalink', () => {
        expect(uuidFromHref('/p/examplePost1/example-post/c/exampleCmnt1')).toBe('exampleCmnt1')
    })
    it('reads the LAST /c/ on a scored.co path (first /c/ is the community)', () => {
        // /c/<community>/p/<post>/<slug>/c/<commentUuid>
        expect(uuidFromHref('/c/SomeCommunity/p/examplePost2/some-slug/c/exampleCmnt2')).toBe('exampleCmnt2')
    })
    it('handles a trailing slash / query after the uuid', () => {
        expect(uuidFromHref('/p/examplePost1/x/c/exampleCmnt1/')).toBe('exampleCmnt1')
        expect(uuidFromHref('/p/examplePost1/x/c/exampleCmnt1?context=3')).toBe('exampleCmnt1')
    })
    it('returns null when there is no comment segment', () => {
        expect(uuidFromHref('/p/examplePost2/just-a-post')).toBeNull()
        expect(uuidFromHref('/u/someuser')).toBeNull()
    })
})

describe('postUuidFromHref (post uuid)', () => {
    it('reads /p/<uuid> on patriots.win', () => {
        expect(postUuidFromHref('/p/examplePost2/just-a-post')).toBe('examplePost2')
    })
    it('reads the post uuid from a scored.co comment path', () => {
        expect(postUuidFromHref('/c/SomeCommunity/p/examplePost2/some-slug/c/exampleCmnt2')).toBe('examplePost2')
    })
    it('returns null when there is no post segment', () => {
        expect(postUuidFromHref('/c/SomeCommunity')).toBeNull()
    })
})
