// One-time login for live e2e tests. Opens Chromium with the built extension and a
// PERSISTENT profile, lets you log in by hand (captcha and all), and saves the
// session. Then run live tests with:  WIN_E2E_LIVE=1 yarn test:e2e
//
//   yarn e2e:login
import { chromium } from '@playwright/test'
import path from 'path'
import readline from 'readline'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const extensionPath = path.join(__dirname, '..', '..', 'dist-chrome')
const profileDir = path.join(__dirname, '..', '..', '.e2e-user-data')
const origin = process.env.WIN_ORIGIN || 'https://patriots.win'

const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`, '--no-first-run'],
})
const page = await context.newPage()
await page.goto(origin)

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
await new Promise(resolve =>
    rl.question('\nLog in in the opened browser window, then press Enter here to save the session…\n', resolve),
)
rl.close()
await context.close()
console.log(`Session saved to ${profileDir}. Run live tests with: WIN_E2E_LIVE=1 yarn test:e2e`)
