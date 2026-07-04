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

// HS256 JWT for the AMO API (what jsonwebtoken did for reveddit).
export function amoJwt(issuer, secret) {
    const b64url = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')
    const iat = Math.floor(Date.now() / 1000)
    const head = b64url({ alg: 'HS256', typ: 'JWT' })
    const body = b64url({ iss: issuer, jti: crypto.randomUUID(), iat, exp: iat + 60 })
    const sig = crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url')
    return `${head}.${body}.${sig}`
}
