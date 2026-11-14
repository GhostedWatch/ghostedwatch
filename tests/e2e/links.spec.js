// A link inside a comment's text to some other removed item must not mark that
// comment, and two removed items meeting in one comment must not make the page loop
// (adding and removing the "Restored text" box on every pass). A comment block is the
// item its own "permalink" link names. Offline: the .win thread is a fake served via route.
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
const link = uuid => `<a href="https://patriots.win/p/Pp1/a-thread/c/${uuid}">my removed comment</a>`
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  ${comment('Cl1', `a live comment pointing at ${link('Cr1')}`)}
  ${comment('Ca1', `what I said, still shown to me, about ${link('Cr1')}`)}
  ${comment('Cr1', 'Comment removed by community moderators.')}
</body></html>`

const rec = o => ({
    id: 1, uuid: 'x', type: 'comment', post_uuid: 'Pp1', community: 'TheDonald', title: '', text: '',
    text_loading: false, status: 'publicly_removed', removal_source: 'communityFilter', created: 0,
    observed_utc: Date.now(), unseen: false, source: 'own', ...o,
})

test('links in a comment do not mark it, and the page settles', async ({ context, extensionId }) => {
    await context.route(/^https:\/\/([a-z0-9-]+\.)*patriots\.win\//, route =>
        route.request().resourceType() === 'document'
            ? route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
            : route.fulfill({ status: 404, body: '' }),
    )
    const ext = await context.newPage()
    await ext.goto(`chrome-extension://${extensionId}/src/options.html`)
    await ext.evaluate(d => new Promise(r => chrome.storage.local.set(d, () => r(1))), {
        removed: {
            1: rec({ id: 1, uuid: 'Ca1', text: 'what I said, still shown to me, about [my removed comment](https://patriots.win/p/Pp1/a-thread/c/Cr1)' }),
            2: rec({ id: 2, uuid: 'Cr1', text: 'the words that were removed', removal_source: 'moderator' }),
        },
    })
    await ext.close()

    const page = await context.newPage()
    await page.goto(THREAD)
    await expect(page.locator('.ghostedwatch-banner')).toHaveCount(2)
    const marked = uuid => page.locator(`[data-ghostedwatch="${uuid}"]`)

    // the live comment that only links to a removed one is left alone
    await expect(marked('Cl1')).toHaveCount(0)
    await expect(page.locator('.comment').first().locator('.ghostedwatch-banner')).toHaveCount(0)
    // each removed comment carries its own banner; the one shown to its author gets no box
    await expect(marked('Ca1').locator('.ghostedwatch-pill').first()).toHaveText('community filter')
    await expect(marked('Ca1').locator('.ghostedwatch-recovered')).toHaveCount(0)
    await expect(marked('Cr1').locator('.ghostedwatch-recovered')).toContainText('the words that were removed')

    // and nothing keeps adding and removing boxes
    const churn = await page.evaluate(
        () =>
            new Promise(resolve => {
                let n = 0
                const isBox = node => node.nodeType === 1 && node.classList.contains('ghostedwatch-recovered')
                const mo = new MutationObserver(records => {
                    for (const r of records) n += [...r.addedNodes, ...r.removedNodes].filter(isBox).length
                })
                mo.observe(document.body, { childList: true, subtree: true })
                // poke the page so the extension's observer runs its pass again
                document.body.appendChild(document.createElement('div'))
                setTimeout(() => (mo.disconnect(), resolve(n)), 1500)
            }),
    )
    expect(churn).toBe(0)
})
