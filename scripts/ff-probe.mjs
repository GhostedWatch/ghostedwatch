// Firefox smoke test: drives a headless Firefox over the Marionette protocol
// (no extra dependencies) to install dist-firefox as a temporary add-on and
// verify the full pipeline: background start, alarm, content-script injection
// on the live site, content<->background messaging, popup round-trips, and the
// set-auth -> get-auth-status storage path.
//
// If WIN_USER + WIN_PASS are set (via .env — gitignored), it performs a REAL
// login and asserts the extension captures the live session — the path that had
// the Firefox-only relative-fetch bug. Without them it falls back to a fake
// session, which can't exercise the whoami fetch. Never logs credentials/tokens.
//
// Requires a real network connection (loads patriots.win) and /Applications/Firefox.app.
// Usage: yarn test:firefox   (or: node scripts/ff-probe.mjs [path/to/dist-firefox])
import net from 'net'
import { spawn } from 'child_process'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Minimal .env loader (no dependency): populate process.env from ../.env if present.
try {
    const envFile = path.join(__dirname, '..', '.env')
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
    }
} catch { /* no .env — fine, falls back to fake session */ }

const EXT_DIR = process.argv[2] || path.join(__dirname, '..', 'dist-firefox')
const EXT_ID = 'ghostedwatch@reveddit.com'
const WIN_ORIGIN = process.env.WIN_ORIGIN || 'https://patriots.win'
const WIN_USER = process.env.WIN_USER || ''
const WIN_PASS = process.env.WIN_PASS || ''
const FIREFOX = '/Applications/Firefox.app/Contents/MacOS/firefox'
const PORT = 2828

if (!EXT_DIR || !fs.existsSync(EXT_DIR)) {
    console.error('extension dir missing:', EXT_DIR)
    process.exit(1)
}

// --- tiny Marionette client (protocol v3: "<len>:<json>" frames) ---
class Marionette {
    constructor(socket) {
        this.socket = socket
        this.buf = ''
        this.msgId = 0
        this.pending = new Map()
        this.onHello = null
        socket.on('data', d => this.onData(d.toString('utf8')))
    }
    onData(chunk) {
        this.buf += chunk
        for (;;) {
            const colon = this.buf.indexOf(':')
            if (colon === -1) return
            const len = parseInt(this.buf.slice(0, colon), 10)
            if (this.buf.length < colon + 1 + len) return
            const body = this.buf.slice(colon + 1, colon + 1 + len)
            this.buf = this.buf.slice(colon + 1 + len)
            const msg = JSON.parse(body)
            if (!Array.isArray(msg)) {
                // server hello
                if (this.onHello) this.onHello(msg)
                continue
            }
            const [type, id, err, result] = msg
            if (type === 1) {
                const p = this.pending.get(id)
                if (p) {
                    this.pending.delete(id)
                    err ? p.reject(new Error(JSON.stringify(err))) : p.resolve(result)
                }
            }
        }
    }
    send(name, params = {}) {
        const id = ++this.msgId
        const frame = JSON.stringify([0, id, name, params])
        this.socket.write(Buffer.byteLength(frame) + ':' + frame)
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject })
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id)
                    reject(new Error(`timeout waiting for ${name}`))
                }
            }, 30000)
        })
    }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function connectMarionette(retries = 60) {
    for (let i = 0; i < retries; i++) {
        try {
            const socket = await new Promise((resolve, reject) => {
                const s = net.connect(PORT, '127.0.0.1', () => resolve(s))
                s.on('error', reject)
            })
            const m = new Marionette(socket)
            await new Promise(resolve => { m.onHello = resolve })
            return m
        } catch {
            await sleep(500)
        }
    }
    throw new Error('could not connect to marionette')
}

// --- launch firefox with a fresh profile ---
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ff-'))
fs.writeFileSync(path.join(profile, 'user.js'), [
    `user_pref("marionette.port", ${PORT});`,
    'user_pref("browser.shell.checkDefaultBrowser", false);',
    'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
    'user_pref("app.update.disabledForTesting", true);',
    'user_pref("browser.tabs.warnOnClose", false);',
    'user_pref("devtools.console.stdout.content", true);', // page/content-script console -> stdout
    'user_pref("browser.dom.window.dump.enabled", true);',
    'user_pref("extensions.webextensions.keepStorageOnUninstall", false);',
].join('\n'))

const ff = spawn(FIREFOX, ['-marionette', '-headless', '-remote-allow-system-access', '-profile', profile, '-no-remote', '-new-instance'], {
    stdio: ['ignore', 'pipe', 'pipe'],
})
const ffLogs = []
const grab = d => {
    const s = d.toString()
    ffLogs.push(s)
    // surface extension console lines live
    for (const line of s.split('\n')) if (line.includes('GhostedWatch')) console.log('FFLOG>', line.trim())
}
ff.stdout.on('data', grab)
ff.stderr.on('data', grab)

const cleanup = code => {
    try { ff.kill('SIGKILL') } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true }) } catch {}
    process.exit(code)
}
process.on('SIGINT', () => cleanup(2))

try {
    console.log('connecting to marionette...')
    const m = await connectMarionette()
    await m.send('WebDriver:NewSession', {})
    console.log('session up; installing temporary add-on from', EXT_DIR)
    const inst = await m.send('Addon:Install', { path: path.resolve(EXT_DIR), temporary: true })
    console.log('installed:', JSON.stringify(inst))

    await sleep(2500) // let onInstalled run (it opens patriots.win, which will fail to load offline — fine)

    // Resolve the internal moz-extension UUID from chrome context.
    await m.send('Marionette:SetContext', { value: 'chrome' })
    const baseURL = await m.send('WebDriver:ExecuteScript', {
        script: `return WebExtensionPolicy.getByID("${EXT_ID}").getURL("");`,
        args: [],
    })
    console.log('extension base URL:', baseURL.value)
    await m.send('Marionette:SetContext', { value: 'content' })

    // 1) Open the extension's own popup page as a tab: `browser.*` is available
    //    in its page context, so we can probe exactly what the real popup does.
    await m.send('WebDriver:Navigate', { url: baseURL.value + 'src/popup.html' })
    await sleep(1500)

    const probe = async (label, script) => {
        try {
            const r = await m.send('WebDriver:ExecuteAsyncScript', {
                script: `const cb = arguments[arguments.length-1];
                    Promise.resolve().then(async () => { ${script} })
                        .then(v => cb(JSON.stringify(v)))
                        .catch(e => cb('ERR: ' + (e && e.message || String(e))))`,
                args: [],
            })
            console.log(label + ':', r.value)
            return r.value
        } catch (e) {
            console.log(label + ': MARIONETTE-ERR', e.message)
            return null
        }
    }

    // Collected assertions -> pass/fail verdict at the end.
    const failures = []
    const expect = (label, actual, test) => {
        if (!test(actual)) failures.push(`${label}: got ${actual}`)
    }

    expect('browser api in ext page', await probe('typeof browser in ext page', `return typeof browser`),
        v => v === '"object"')
    expect('get-auth-status', await probe('get-auth-status round-trip',
        `return await browser.runtime.sendMessage({action:'get-auth-status'})`),
        v => v && v.includes('"connected"'))
    expect('check-now', await probe('check-now round-trip',
        `return await browser.runtime.sendMessage({action:'check-now'})`),
        v => v && v.includes('"ok":true'))
    await probe('storage.local keys', `return Object.keys(await browser.storage.local.get(null))`)
    expect('alarm', await probe('alarm registered', `return await browser.alarms.get('win-notifyme')`),
        v => v && v.includes('win-notifyme'))

    // 2) Storage path: store auth like the content script would, read it back.
    expect('set-auth', await probe('inject fake auth via set-auth', `return await browser.runtime.sendMessage({
        action:'set-auth', auth:{user:'probe_user', origin:'https://patriots.win', apiKey:'k', apiSecret:'s'}})`),
        v => v && v.includes('"ok":true'))
    expect('auth-status after set-auth', await probe('get-auth-status after set-auth',
        `return await browser.runtime.sendMessage({action:'get-auth-status'})`),
        v => v && v.includes('"connected":true') && v.includes('probe_user'))
    // Clear it so the real-session test below starts from a clean slate.
    await probe('clear fake auth', `await browser.storage.local.remove('auth'); return 'ok'`)

    // 3) Content-script injection test on the real site. The content script
    //    stamps data-gw-* attributes on <html> in dev builds.
    await m.send('WebDriver:Navigate', { url: WIN_ORIGIN + '/' }).catch(e => {
        console.log('navigate to site failed:', e.message)
    })
    await sleep(6000)
    const stamps = await m.send('WebDriver:ExecuteScript', {
        script: `const d = document.documentElement; const out = {};
            for (const a of d.getAttributeNames()) if (a.startsWith('data-gw-')) out[a] = d.getAttribute(a);
            out._url = location.href; return out;`,
        args: [],
    })
    console.log('content-script stamps:', JSON.stringify(stamps.value))
    const s = stamps.value || {}
    if (s._url && s._url.startsWith(WIN_ORIGIN)) {
        expect('content script injected', s['data-gw-cs'], v => v === 'injected')
        expect('content->background round-trip', s['data-gw-bg'], v => v === 'ok')

        if (WIN_USER && WIN_PASS) {
            // 4a) REAL login end-to-end. Reproduces the site's own flow from the
            //     page context (same-origin -> cookies/XSRF just work): POST
            //     /api/v2/user/login, then /api/v2/token for the api_key/secret,
            //     then stash them in localStorage where the content script reads.
            //     Credentials are passed as script ARGS (never interpolated into
            //     the script text, never returned to node, never logged).
            const login = await m.send('WebDriver:ExecuteAsyncScript', {
                script: `const [user, pass] = arguments;
                    const cb = arguments[arguments.length - 1];
                    (async () => {
                        const body = new URLSearchParams();
                        body.set('username', user); body.set('password', pass);
                        const lr = await fetch('/api/v2/user/login', { method:'POST', credentials:'include', body });
                        const lj = await lr.json().catch(() => ({}));
                        if (!lj.status) return { ok:false, stage:'login', error: lj.error || ('http '+lr.status) };
                        const tr = await fetch('/api/v2/token', { method:'POST', credentials:'include' });
                        const tj = await tr.json().catch(() => ({}));
                        if (!tj.api_key || !tj.api_secret) return { ok:false, stage:'token', error: tj.error || ('http '+tr.status) };
                        localStorage.setItem('api_key', tj.api_key);
                        localStorage.setItem('api_secret', tj.api_secret);
                        return { ok:true }; // never return the secrets themselves
                    })().then(r => cb(JSON.stringify(r))).catch(e => cb(JSON.stringify({ ok:false, stage:'throw', error:String(e&&e.message||e) })));`,
                args: [WIN_USER, WIN_PASS],
            })
            const lr = JSON.parse(login.value)
            console.log('real login:', lr.ok ? 'OK (tokens stored)' : `FAILED at ${lr.stage}: ${lr.error}`)
            expect('real login + token fetch', lr.ok, v => v === true)

            if (lr.ok) {
                // Reload so the content script captures the now-present session at
                // document_start — this is the exact path the relative-fetch bug broke.
                await m.send('WebDriver:Navigate', { url: WIN_ORIGIN + '/' })
                await sleep(7000)
                const s2 = (await m.send('WebDriver:ExecuteScript', {
                    script: `const d = document.documentElement; const out = {};
                        for (const a of d.getAttributeNames()) if (a.startsWith('data-gw-')) out[a] = d.getAttribute(a);
                        return out;`,
                    args: [],
                })).value || {}
                console.log('stamps after real login:', JSON.stringify(s2))
                expect('live session captured (data-gw-auth)', s2['data-gw-auth'], v => v === 'sent-ok')

                // And the background now reports connected with the REAL username.
                await m.send('WebDriver:Navigate', { url: baseURL.value + 'src/popup.html' })
                await sleep(1500)
                const status = await probe('get-auth-status after real login',
                    `return await browser.runtime.sendMessage({action:'get-auth-status'})`)
                expect('background reports connected', status, v => v && v.includes('"connected":true'))
                expect('background reports real user', status,
                    v => v && v.includes('"user":"' + WIN_USER + '"'))
            }
        } else {
            console.log('\n(WIN_USER/WIN_PASS not set — skipping live-login test.')
            console.log(' Set them in ghostedwatch/.env to exercise real token capture.)')
        }
    } else {
        console.log('(site unreachable — skipping content-script assertions)')
    }

    console.log('--- interesting firefox stdout lines ---')
    const all = ffLogs.join('')
    for (const line of all.split('\n')) {
        if (/GhostedWatch|ghostedwatch|JavaScript error.*moz-extension|content.js|background.js/i.test(line))
            console.log('  ', line.trim().slice(0, 300))
    }
    if (failures.length) {
        console.error('\nPROBE FAILED — ' + failures.length + ' assertion(s):')
        for (const f of failures) console.error('  ✗ ' + f)
        cleanup(1)
    }
    console.log('\nPROBE PASSED — background, alarm, messaging, popup, auth path, content script all OK')
    cleanup(0)
} catch (e) {
    console.error('PROBE FAILED:', e.message)
    console.error('--- last firefox output ---')
    console.error(ffLogs.join('').split('\n').slice(-40).join('\n'))
    cleanup(1)
}
