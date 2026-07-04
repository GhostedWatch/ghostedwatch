// Verifies the extension's SERVICE WORKER can fetch the .win API cross-origin
// (host permission bypassing CORS). Anonymous public endpoint — no login needed.
import { chromium } from '@playwright/test'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ext = path.join(__dirname, '..', '..', 'dist-chrome-dev')

const ctx = await chromium.launchPersistentContext('', {
    headless: false,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run'],
})
let sw = ctx.serviceWorkers()[0]
if (!sw) sw = await ctx.waitForEvent('serviceworker')

const result = await sw.evaluate(async () => {
    try {
        const r = await fetch('https://patriots.win/api/v2/post/post.json?comments=false&id=5255188', {
            credentials: 'omit',
        })
        const d = await r.json()
        return { status: r.status, hasPost: !!(d.posts && d.posts[0]) }
    } catch (e) {
        return { error: String(e) }
    }
})
console.log('SW cross-origin .win API fetch:', JSON.stringify(result))
await ctx.close()
