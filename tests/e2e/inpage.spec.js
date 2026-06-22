// In-page behavior on a REAL public .win thread (no login, but needs network).
// Opt-in: set WIN_E2E_NET=1 to run. Skipped by default so the offline suite stays
// green and fast. These guard the subtle DOM logic (the removal outline scoping,
// restored text, and the re-approval-aware Watch tooltip) that has no good unit-test
// home because it depends on the site's actual comment markup.
import { test, expect, credentials } from './fixtures.js'

const url = (id, p) => `chrome-extension://${id}/src/${p}`
// Pick a currently-busy public thread at runtime (no hardcoded thread → nothing
// account-specific in the repo, and it can't go stale). Community is configurable.
const COMMUNITY = process.env.WIN_E2E_COMMUNITY || 'TheDonald'
async function discoverThread() {
    const res = await fetch(`https://api.scored.co/api/v2/post/hotv2.json?community=${COMMUNITY}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const data = await res.json()
    const posts = (data.posts || data.data || []).filter(p => p && p.uuid && (p.comments || 0) >= 30)
    return posts.length ? `${credentials.origin}/p/${posts[0].uuid}/x` : null
}

test.describe('in-page (live .win thread, no login)', () => {
    test.skip(!process.env.WIN_E2E_NET, 'set WIN_E2E_NET=1 to run (needs network access to the .win sites)')

    test('outlines only the removed comment body (not its replies) + shows restored text', async ({ context, extensionId }) => {
        const thread = await discoverThread()
        test.skip(!thread, `no busy thread found in c/${COMMUNITY}`)
        const page = await context.newPage()
        await page.goto(thread, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForTimeout(4500)
        // pick any rendered comment and read its permalink uuid
        const uuid = await page.evaluate(() => {
            for (const a of document.querySelectorAll('a[href*="/c/"]')) {
                if ((a.textContent || '').trim().toLowerCase() !== 'permalink') continue
                const h = a.getAttribute('href') || ''
                const i = h.lastIndexOf('/c/')
                const m = i >= 0 && h.slice(i + 3).match(/^([0-9A-Za-z]+)/)
                if (m) return m[1]
            }
            return null
        })
        test.skip(!uuid, 'no comment with a permalink found on the thread')

        // seed that uuid as a known removal (with restored text), then reload
        const ext = await context.newPage()
        await ext.goto(url(extensionId, 'options.html'))
        await ext.evaluate(
            u =>
                new Promise(r =>
                    chrome.storage.local.set(
                        {
                            removed: {
                                999: {
                                    id: 999, uuid: u, type: 'comment', post_uuid: 'p', community: 'TheDonald', title: '',
                                    text: 'the original words, saved and shown back in place', text_loading: false,
                                    status: 'publicly_removed', removal_source: 'communityFilter', created: Date.now() - 3600000,
                                    observed_utc: Date.now() - 1800000, unseen: true, source: 'own',
                                },
                            },
                        },
                        () => r(1),
                    ),
                ),
            uuid,
        )
        await ext.close()
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page.waitForTimeout(4500)

        const r = await page.evaluate(() => {
            const el = document.querySelector('.ghostedwatch-removed')
            if (!el) return null
            return {
                cls: el.className,
                hasNestedComment: !!el.querySelector('[class*="comment"]'),
                hasBanner: !!el.querySelector('.ghostedwatch-banner'),
                hasRestored: !!el.querySelector('.ghostedwatch-recovered'),
            }
        })
        expect(r).toBeTruthy()
        expect(r.cls).toContain('body') // outlines the body column, not the whole comment block
        expect(r.hasNestedComment).toBe(false) // → nested replies are excluded
        expect(r.hasBanner).toBe(true)
        expect(r.hasRestored).toBe(true)
    })

    test('Watch tooltip says "re-approved" on a comment the site already shows as removed', async ({ context, extensionId }) => {
        const thread = await discoverThread()
        test.skip(!thread, `no busy thread found in c/${COMMUNITY}`)
        const page = await context.newPage()
        await page.goto(thread, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await page.waitForTimeout(5000)
        // find a Watch button inside a comment whose body is a removal placeholder
        const uuid = await page.evaluate(() => {
            const re = /^\s*(comment|post) removed\b/i
            for (const btn of document.querySelectorAll('.ghostedwatch-watch[data-uuid]')) {
                const body = btn.parentElement && btn.parentElement.parentElement
                if (!body) continue
                for (const child of body.children) {
                    if (child === btn.parentElement) continue
                    if (re.test((child.textContent || '').trim())) return btn.getAttribute('data-uuid')
                }
            }
            return null
        })
        test.skip(!uuid, 'no site-removed comment with a Watch button on the thread')

        const btn = page.locator(`.ghostedwatch-watch[data-uuid="${uuid}"]`).first()
        await btn.scrollIntoViewIfNeeded()
        await btn.hover()
        await page.waitForTimeout(150)
        await expect(page.locator('.ghostedwatch-tooltip')).toContainText('re-approved')
    })
})
