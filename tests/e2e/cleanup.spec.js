// In-page marks follow the stored records: when a check drops a removal (re-approved, or
// found to be live after all), its banner and outline leave the open page without a reload.
// Open tabs are refreshed at the end of every check, so the test stores the change and
// then runs a check, as a re-approval found by a check would.
// Offline: the .win thread is a fake served via route.
import { test, expect } from './fixtures.js'

const THREAD = 'https://patriots.win/p/Pp1/a-thread'
const comment = (uuid, content) => `
  <div class="comment" style="display:flex">
    <div class="body">
      <div class="meta">someuser · 1 points · 3 months ago</div>
      <div class="content">${content}</div>
      <div class="actions"><a href="/p/Pp1/a-thread/c/${uuid}">permalink</a> <span>save</span></div>
    </div>
  </div>`
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  ${comment('Ca1', 'Comment removed by community filter.')}
  ${comment('Cb1', 'Comment removed by community moderators.')}
</body></html>`

const rec = o => ({
    id: 1, uuid: 'x', type: 'comment', post_uuid: 'Pp1', community: 'TheDonald', title: '', text: '',
    text_loading: false, status: 'publicly_removed', removal_source: 'communityFilter', created: 0,
    observed_utc: Date.now(), unseen: false, source: 'own', ...o,
})

test('a dropped removal loses its banner on the open page', async ({ context, extensionId }) => {
    await context.route(/^https:\/\/([a-z0-9-]+\.)*patriots\.win\//, route =>
        route.request().resourceType() === 'document'
            ? route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
            : route.fulfill({ status: 404, body: '' }),
    )
    const ext = await context.newPage()
    await ext.goto(`chrome-extension://${extensionId}/src/options.html`)
    const setRemoved = removed => ext.evaluate(d => new Promise(r => chrome.storage.local.set({ removed: d }, () => r(1))), removed)
    const runCheck = () => ext.evaluate(() => chrome.runtime.sendMessage({ action: 'check-now' }))
    await setRemoved({
        1: rec({ id: 1, uuid: 'Ca1', text: 'first words' }),
        2: rec({ id: 2, uuid: 'Cb1', text: 'second words', removal_source: 'moderator' }),
    })

    const page = await context.newPage()
    await page.goto(THREAD)
    const marked = uuid => page.locator(`[data-ghostedwatch="${uuid}"]`)
    await expect(page.locator('.ghostedwatch-banner')).toHaveCount(2)
    await expect(marked('Ca1').locator('.ghostedwatch-recovered')).toContainText('first words')

    // Ca1 is re-approved: its record goes, the other stays
    await setRemoved({ 2: rec({ id: 2, uuid: 'Cb1', text: 'second words', removal_source: 'moderator' }) })
    await runCheck()
    await expect(marked('Ca1')).toHaveCount(0)
    await expect(page.locator('.ghostedwatch-recovered', { hasText: 'first words' })).toHaveCount(0)
    await expect(page.locator('.ghostedwatch-banner')).toHaveCount(1)
    await expect(marked('Cb1').locator('.ghostedwatch-banner')).toHaveCount(1)

    // nothing removed any more: the page is back to how the site drew it
    await setRemoved({})
    await runCheck()
    await expect(page.locator('[data-ghostedwatch]')).toHaveCount(0)
    await expect(page.locator('.ghostedwatch-banner, .ghostedwatch-recovered')).toHaveCount(0)
})
