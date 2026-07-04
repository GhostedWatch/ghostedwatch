// Playwright fixtures that launch Chromium with the built extension loaded.
// https://playwright.dev/docs/chrome-extensions
//
// `login` is optional and only used by tests that need an authenticated .win
// session. It reads WIN_USER / WIN_PASS from the environment (put them in a
// gitignored .env — see .env.example). Tests that need login skip themselves
// when those aren't set, so the no-login smoke tests always run.

import { test as base, chromium } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', '..', 'dist-chrome-dev')

// minimal .env loader so we don't need a dotenv dependency
function loadDotenv() {
    const envPath = path.join(__dirname, '..', '..', '.env')
    if (!fs.existsSync(envPath)) return
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
}
loadDotenv()

export const credentials = {
    user: process.env.WIN_USER || '',
    pass: process.env.WIN_PASS || '',
    origin: process.env.WIN_ORIGIN || 'https://patriots.win',
}

// For live (logged-in) runs, reuse a persistent profile you logged into once via
// `yarn e2e:login`; otherwise use a throwaway profile for the page smoke tests.
export const profileDir = process.env.WIN_E2E_LIVE ? path.join(__dirname, '..', '..', '.e2e-user-data') : ''

export const launchArgs = [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-first-run',
    '--disable-gpu',
]
export { extensionPath }

export const test = base.extend({
    // eslint-disable-next-line no-empty-pattern
    context: async ({}, use) => {
        const context = await chromium.launchPersistentContext(profileDir, {
            headless: false, // extensions require a headed (or new-headless) context
            args: launchArgs,
        })
        await use(context)
        await context.close()
    },
    extensionId: async ({ context }, use) => {
        let sw = context.serviceWorkers()[0]
        if (!sw) sw = await context.waitForEvent('serviceworker')
        await use(sw.url().split('/')[2])
    },
})

// Log into the .win site in a page (used by authenticated tests).
export async function login(page) {
    if (!credentials.user || !credentials.pass) throw new Error('WIN_USER/WIN_PASS not set')
    await page.goto(`${credentials.origin}/login`)
    await page.fill('input[name="username"], input[type="text"]', credentials.user)
    await page.fill('input[name="password"], input[type="password"]', credentials.pass)
    await page.click('button[type="submit"], button:has-text("Log in")')
    await page.waitForLoadState('networkidle')
}

export const expect = test.expect
