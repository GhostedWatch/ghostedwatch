// Chrome Web Store publish flow (ported from reveddit's publish-chrome.js):
// upload chrome.zip -> pause so you can paste STORE_DESCRIPTION.txt into the
// dashboard (the CWS API cannot update listing text) -> publish. On an expired
// refresh token (invalid_grant) it offers the guided refresh flow and retries.
// Uses the CWS HTTP API directly (fetch) — no chrome-webstore-upload dependency.
import fs from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'
import { loadDotEnv } from '../lib/env.mjs'
import {
    CONFIG, c, getManifest, readDescription, assertVersionInDescription,
    copyToClipboard, openUrl, prompt, requireEnv, setupAbortHandler, isInteractive,
} from './common.mjs'

setupAbortHandler()

const API = 'https://www.googleapis.com'

async function accessToken() {
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: process.env.CHROME_CLIENT_ID,
            client_secret: process.env.CHROME_CLIENT_SECRET,
            refresh_token: process.env.CHROME_REFRESH_TOKEN,
            grant_type: 'refresh_token',
        }),
    })
    const data = await res.json()
    if (data.error) {
        const err = new Error(`token: ${data.error} ${data.error_description || ''}`)
        err.invalidGrant = data.error === 'invalid_grant'
        throw err
    }
    return data.access_token
}

const headers = token => ({ Authorization: `Bearer ${token}`, 'x-goog-api-version': '2' })

async function uploadAndPublish() {
    const token = await accessToken()
    const id = process.env.CHROME_EXTENSION_ID

    console.log('\n' + c.yellow('[1/3] Uploading chrome.zip...'))
    const zip = fs.readFileSync(CONFIG.chromeZip)
    const up = await (await fetch(`${API}/upload/chromewebstore/v1.1/items/${id}`, {
        method: 'PUT', headers: headers(token), body: zip,
    })).json()
    if (up.uploadState === 'FAILURE') {
        console.error(c.red('Upload failed:'), JSON.stringify(up.itemError))
        process.exit(1)
    }
    console.log(c.green(`✔ Upload ${up.uploadState || 'accepted'}`))

    console.log('\n' + c.yellow('[2/3] Store listing description...'))
    const description = readDescription()
    console.log('The CWS API cannot update listing text — paste it in the dashboard.')
    if (isInteractive()) {
        if (description) copyToClipboard(description, 'Description')
        const dash = process.env.CHROME_DASHBOARD_ID ? `${process.env.CHROME_DASHBOARD_ID}/` : ''
        const url = `https://chrome.google.com/webstore/devconsole/${dash}${id}/edit`
        console.log(c.magenta('📋 Dashboard: ') + url)
        openUrl(url)
        await prompt('\n' + c.bold('Press ENTER once the listing description is verified/updated > '))
    } else {
        console.log(c.yellow('⚠ Non-interactive run: verify the listing description in the dashboard after this publish.'))
    }

    console.log('\n' + c.yellow('[3/3] Publishing...'))
    const pub = await (await fetch(`${API}/chromewebstore/v1.1/items/${id}/publish`, {
        method: 'POST', headers: headers(token),
    })).json()
    if (pub.status?.[0] === 'OK') console.log(c.green('✔ Published! (goes live once review clears)'))
    else {
        console.error(c.red('Publish failed or returned warnings:'), JSON.stringify(pub))
        process.exit(1)
    }
}

async function main() {
    requireEnv(['CHROME_EXTENSION_ID', 'CHROME_CLIENT_ID', 'CHROME_CLIENT_SECRET', 'CHROME_REFRESH_TOKEN'])
    const version = getManifest().version
    assertVersionInDescription(version)
    console.log(c.cyan(`🚀 Chrome publish flow for v${version}`))

    // Always upload a freshly built chrome.zip — a stale one could be from an
    // older commit. (Dev builds live in dist-chrome-dev/, so no dev-leak risk.)
    console.log(c.yellow('Building production chrome.zip...'))
    const build = spawnSync('yarn', ['build-chrome'], { stdio: 'inherit' })
    if (build.status !== 0 || !fs.existsSync(CONFIG.chromeZip)) {
        console.error(c.red('build-chrome failed.'))
        process.exit(1)
    }

    try {
        await uploadAndPublish()
    } catch (error) {
        if (!error.invalidGrant) throw error
        console.error('\n' + c.red('Chrome Web Store token expired or invalid.'))
        if (!isInteractive()) {
            console.error('Run `yarn refresh:chrome` locally to mint a new CHROME_REFRESH_TOKEN.')
            process.exit(1)
        }
        const answer = await prompt('\nRun the token refresh flow now? (Y/n) > ')
        if (answer.toLowerCase() !== 'y' && answer.trim() !== '') process.exit(1)
        const dir = path.dirname(fileURLToPath(import.meta.url))
        const r = spawnSync('node', [path.join(dir, 'refresh-chrome-token.mjs')], { stdio: 'inherit' })
        if (r.status !== 0) {
            console.error(c.red('Token refresh failed or was aborted.'))
            process.exit(1)
        }
        delete process.env.CHROME_REFRESH_TOKEN // re-read the value the refresh flow just saved
        loadDotEnv()
        console.log('\n' + c.green('✔ Token refreshed — retrying...'))
        await uploadAndPublish()
    }
}

main().catch(e => {
    console.error(c.red('Chrome publish failed:'), e.message || e)
    process.exit(1)
})
