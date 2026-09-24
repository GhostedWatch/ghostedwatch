// Runs a command (the preflight checks) unless it already passed for exactly this code,
// so re-running a publish after an unrelated failure (expired token, network) doesn't
// redo minutes of tests. The key hashes the command, every tracked or untracked-but-not-
// ignored file, and the settings that change which tests run (credentials only as
// set/unset). A pass is recorded only if nothing changed while it ran, and one older
// than a day isn't trusted: the live site and the browsers move on.
// PREFLIGHT_FORCE=1 always runs.
//
// Usage: node scripts/preflight-cache.mjs <command> [args…]
import { execFileSync, spawnSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { loadDotEnv } from './lib/env.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = path.join(ROOT, 'node_modules', '.cache', 'ghostedwatch', 'preflight.json')
const MAX_AGE_MS = 24 * 60 * 60 * 1000

loadDotEnv() // the tests read these too (existing env vars win)
const command = process.argv.slice(2)
if (command.length === 0) {
    console.error('usage: node scripts/preflight-cache.mjs <command> [args…]')
    process.exit(2)
}

function codeKey() {
    const hash = crypto.createHash('sha256')
    hash.update(
        JSON.stringify({
            command,
            node: process.version,
            WIN_E2E_LIVE: process.env.WIN_E2E_LIVE || '',
            WIN_E2E_NET: process.env.WIN_E2E_NET || '',
            WIN_E2E_THREAD: process.env.WIN_E2E_THREAD || '',
            WIN_ORIGIN: process.env.WIN_ORIGIN || '',
            realLogin: !!(process.env.WIN_USER && process.env.WIN_PASS),
        }),
    )
    const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT })
        .toString()
        .split('\0')
        .filter(Boolean)
        .sort()
    for (const f of files) {
        hash.update(`${f}\0`)
        try {
            hash.update(fs.readFileSync(path.join(ROOT, f)))
        } catch {
            hash.update('(missing)') // tracked but deleted in the working tree
        }
        hash.update('\0')
    }
    return hash.digest('hex')
}

const key = codeKey()
let last = null
try {
    last = JSON.parse(fs.readFileSync(CACHE, 'utf8'))
} catch {
    /* nothing recorded yet */
}
if (!process.env.PREFLIGHT_FORCE && last?.key === key && Date.now() - last.passedAt < MAX_AGE_MS) {
    const mins = Math.round((Date.now() - last.passedAt) / 60000)
    console.log(`preflight: already passed for this exact code ${mins} min ago, skipping (PREFLIGHT_FORCE=1 re-runs it)`)
    process.exit(0)
}

const run = spawnSync(command[0], command.slice(1), { cwd: ROOT, stdio: 'inherit' })
if (run.status !== 0) process.exit(run.status ?? 1)

if (codeKey() === key) {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true })
    fs.writeFileSync(CACHE, JSON.stringify({ key, passedAt: Date.now() }))
    console.log('preflight: passed; recorded, so a re-run on this exact code skips it')
} else {
    console.log('preflight: passed, but files changed while it ran, so the pass was not recorded')
}
