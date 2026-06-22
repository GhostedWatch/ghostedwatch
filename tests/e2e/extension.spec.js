// Loads the REAL built extension and checks its pages render. No login needed.
import { test, expect, credentials } from './fixtures.js'

test.describe('extension pages', () => {
    test('popup renders', async ({ context, extensionId }) => {
        const page = await context.newPage()
        await page.goto(`chrome-extension://${extensionId}/src/popup.html`)
        await expect(page.locator('#root')).toBeVisible()
        await expect(page.getByText('GhostedWatch')).toBeVisible()
        // not logged in → the status band reads "disconnected" with a Reconnect action
        await expect(page.getByRole('button', { name: 'Reconnect' })).toBeVisible()
        // icon nav footer
        await expect(page.getByRole('button', { name: 'History' })).toBeVisible()
        await expect(page.getByRole('button', { name: 'Options' })).toBeVisible()
    })

    test('options renders with the 1-minute default interval', async ({ context, extensionId }) => {
        const page = await context.newPage()
        await page.goto(`chrome-extension://${extensionId}/src/options.html`)
        await expect(page.getByText(/check interval/i)).toBeVisible()
        await expect(page.locator('#interval')).toHaveValue('1')
    })

    test('history page renders', async ({ context, extensionId }) => {
        const page = await context.newPage()
        await page.goto(`chrome-extension://${extensionId}/src/history.html`)
        await expect(page.getByText('GhostedWatch')).toBeVisible()
        await expect(page.getByText('Detected removals')).toBeVisible()
    })
})

// Authenticated end-to-end. Automated form login is captcha-gated (Cloudflare
// Turnstile), so the supported flow is: `yarn e2e:login` once (log in by hand in
// the window — the session is saved to a persistent profile), then run with
// WIN_E2E_LIVE=1 so the fixture reuses that logged-in profile. Opt-in, so the page
// smoke tests above stay green by default.
test.describe('logged-in monitoring', () => {
    test.skip(!process.env.WIN_E2E_LIVE, 'run `yarn e2e:login` then WIN_E2E_LIVE=1 yarn test:e2e')

    test('highlights a known-removed comment in-thread', async ({ context }) => {
        // a thread path containing one of YOUR removed comments, e.g. /p/<uuid>/<slug>/c/
        // kept out of the repo (it identifies your account) — set it in the gitignored .env
        const threadPath = process.env.WIN_E2E_THREAD
        test.skip(!threadPath, 'set WIN_E2E_THREAD to a /p/<uuid>/<slug>/c/ path with one of your removed comments')
        const page = await context.newPage()
        await page.goto(`${credentials.origin}${threadPath}`)
        await expect(page.locator('.ghostedwatch-banner').first()).toBeVisible({ timeout: 20000 })
    })
})
