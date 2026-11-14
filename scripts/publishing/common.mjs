// Shared helpers for the publish scripts. Ported from the reveddit real-time
// extension's scripts/publishing/common.js, but dependency-free: dotenv ->
// lib/env.mjs, clipboardy -> pbcopy, open -> `open`, jsonwebtoken -> node:crypto.
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import crypto from 'crypto'
import { spawnSync } from 'child_process'
import { loadDotEnv } from '../lib/env.mjs'

export const ROOT = process.cwd()
export const CONFIG = {
    chromeZip: path.join(ROOT, 'chrome.zip'),
    firefoxDist: path.join(ROOT, 'dist-firefox'),
    sourceZip: path.join(ROOT, 'source.zip'),
    descriptionFile: path.join(ROOT, 'STORE_DESCRIPTION.txt'),
    manifestFile: path.join(ROOT, 'src', 'manifest.json'),
}

loadDotEnv()

// ansi
export const c = {
    red: s => `\x1b[31m${s}\x1b[0m`,
    green: s => `\x1b[32m${s}\x1b[0m`,
    yellow: s => `\x1b[33m${s}\x1b[0m`,
    magenta: s => `\x1b[35m${s}\x1b[0m`,
    cyan: s => `\x1b[36m${s}\x1b[0m`,
    bold: s => `\x1b[1m${s}\x1b[0m`,
}

// In CI / non-TTY runs the interactive steps (paste description, token refresh)
// are skipped or fail fast instead of hanging on a prompt nobody will answer.
export const isInteractive = () => process.stdin.isTTY && !process.env.CI

export function setupAbortHandler() {
    process.on('SIGINT', () => {
        console.log('\n' + c.red('✖ Aborted'))
        process.exit(130)
    })
}

export function requireEnv(keys) {
    const missing = keys.filter(k => !process.env[k])
    if (missing.length) {
        console.error(c.red(`Error: missing environment variables: ${missing.join(', ')}`))
        console.error('Set them in .env (see .env.example) or the environment.')
        process.exit(1)
    }
}

export function getManifest() {
    return JSON.parse(fs.readFileSync(CONFIG.manifestFile, 'utf8'))
}

export function readDescription() {
    try {
        return fs.readFileSync(CONFIG.descriptionFile, 'utf8').trim()
    } catch {
        console.warn(c.yellow(`Warning: no description file at ${CONFIG.descriptionFile}`))
        return null
    }
}

// Refuse to publish release notes that don't mention the version being shipped.
export function assertVersionInDescription(version) {
    const description = readDescription()
    if (description && !description.includes(version)) {
        console.error(c.red(`STORE_DESCRIPTION.txt has no entry for ${version} — add release notes first.`))
        process.exit(1)
    }
}

export function prompt(query) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    return new Promise(resolve => {
        rl.on('SIGINT', () => {
            rl.close()
            console.log('\n' + c.red('✖ Aborted'))
            process.exit(130)
        })
        rl.question(query, answer => {
            rl.close()
            resolve(answer)
        })
    })
}

export function copyToClipboard(text, label = 'Text') {
    const r = spawnSync('pbcopy', { input: text })
    if (r.status === 0) {
        console.log(c.green(`✔ ${label} copied to clipboard!`))
        return true
    }
    console.log(c.yellow(`⚠ Could not copy ${label.toLowerCase()} to clipboard.`))
    return false
}

export function openUrl(url) {
    if (!isInteractive()) return
    spawnSync('open', [url], { stdio: 'ignore' })
}

// Which stores already have the current manifest version, so a publish:all that
// failed partway finishes when it's run again: it skips those stores. Kept in
// .publish-status.json (gitignored); deleting it starts over. Publishing needs the
// build inputs committed (assertCleanBuildInputs), so the commit recorded there is
// what the stores got.
const STATUS_FILE = path.join(ROOT, '.publish-status.json')

// What the built extension is made from: every tracked file but these (the
// dependencies count). One version must not ship different code to different stores.
const NOT_BUILD_INPUTS = [
    'tests', 'scripts', 'src/*__tests__*', '*.md', '.github', '.gitignore', '.env.example', 'LICENSE',
    'playwright.config.js', 'vitest.config.ts',
]
const BUILD_INPUTS = ['.', ...NOT_BUILD_INPUTS.map(p => `:(exclude)${p}`)]

function git(...args) {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
    return { ok: r.status === 0, out: (r.stdout || '').trim() }
}

export const headCommit = () => git('rev-parse', 'HEAD').out

// Whether the extension's files differ from `commit`, committed or not. A commit git
// can't find counts as changed.
export const extensionChangedSince = commit => !git('diff', '--quiet', commit, '--', ...BUILD_INPUTS).ok

// Stop unless the build inputs match HEAD, so HEAD is what a build ships (and the
// Firefox source zip, made from that commit, matches the build).
export function assertCleanBuildInputs() {
    const status = git('status', '--porcelain', '--', ...BUILD_INPUTS)
    if (status.ok && !status.out) return
    console.error(c.red("The extension's files have uncommitted or untracked changes:") + `\n${status.out}`)
    console.error('Commit or stash them first, so the version in each store is a commit.')
    process.exit(1)
}

// Stop when a store already has this version from other code: one version must be
// the same code in every store.
export function assertSameCodeForVersion() {
    const status = readPublishStatus()
    // AMO may hold a Firefox submission whose run stopped before recording it
    // (publish-firefox.mjs), so other code under this version can't go out
    const otherFirefox =
        !status.published.firefox && (status.firefoxSubmissions || []).find(s => extensionChangedSince(s.commit))
    if (otherFirefox) {
        console.error(
            c.red(
                `A Firefox submission of ${status.version} from ${otherFirefox.commit?.slice(0, 7)} (${otherFirefox.at}) didn't finish, ` +
                    "so AMO may have that code, and the extension's files differ from it.",
            ),
        )
        console.error(
            'Bump the version and add its VERSION HISTORY line. If you know AMO never got it, delete firefoxSubmissions from .publish-status.json.',
        )
        process.exit(1)
    }
    const already = Object.keys(status.published)
    if (already.length && extensionChangedSince(status.commit)) {
        console.error(
            c.red(
                `${already.join(', ')} already got ${status.version} from ${status.commit?.slice(0, 7)}, and the extension's files have changed since.`,
            ),
        )
        console.error('Bump the version and add its VERSION HISTORY line, so every store gets the same code for one version.')
        process.exit(1)
    }
}

export function readPublishStatus() {
    const { version } = getManifest()
    try {
        const status = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'))
        if (status.version === version) return { ...status, published: status.published || {} }
    } catch {
        // missing or unreadable: nothing recorded yet
    }
    return { version, published: {} }
}

export function writePublishStatus(status) {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + '\n')
}

// Build a store's production artifact right before it's uploaded, so nothing stale
// or dev ships, after the checks above (here too, so a standalone publish:<store>
// can't give a store other code under a version another store has). Returns the
// commit built, which the store script hands to markPublished: HEAD can move
// while a store's step waits on you.
export function buildFresh(script, artifact) {
    assertCleanBuildInputs()
    assertSameCodeForVersion()
    const commit = headCommit()
    console.log(c.yellow(`Building fresh production package (yarn ${script})...`))
    const build = spawnSync('yarn', [script], { stdio: 'inherit' })
    if (build.status !== 0 || !fs.existsSync(artifact)) {
        console.error(c.red(`${script} failed.`))
        process.exit(1)
    }
    return commit
}

// Record that a store accepted the current version, built from `commit`. Each
// publish script calls this once its store has it, whether or not publish-all
// started it.
export function markPublished(store, commit) {
    const status = readPublishStatus()
    status.commit = status.commit || commit
    status.published[store] = new Date().toISOString()
    writePublishStatus(status)
}

// HS256 JWT for the AMO API (what jsonwebtoken did for reveddit).
export function amoJwt(issuer, secret) {
    const b64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')
    const iat = Math.floor(Date.now() / 1000)
    const head = b64url({ alg: 'HS256', typ: 'JWT' })
    const body = b64url({ iss: issuer, jti: crypto.randomUUID(), iat, exp: iat + 60 })
    const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
    return `${head}.${body}.${sig}`
}
