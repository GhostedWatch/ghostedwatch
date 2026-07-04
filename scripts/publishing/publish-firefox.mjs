// Firefox AMO publish flow (ported from reveddit's publish-firefox.js):
// zip the source for review (git archive — AMO requires readable source for
// webpack builds), sign/submit the listed version via web-ext, then update the
// store description through the AMO API. `--text-only` updates the description
// without publishing. The add-on id defaults from the built manifest's gecko id.
import fs from 'fs'
import path from 'path'
import { execSync, spawnSync } from 'child_process'
import webExt from 'web-ext'
import {
    CONFIG, ROOT, c, getManifest, readDescription, assertVersionInDescription,
    amoJwt, requireEnv, setupAbortHandler,
} from './common.mjs'

setupAbortHandler()

function extensionId() {
    if (process.env.FIREFOX_EXTENSION_ID) return process.env.FIREFOX_EXTENSION_ID
    try {
        const dist = JSON.parse(fs.readFileSync(path.join(CONFIG.firefoxDist, 'manifest.json'), 'utf8'))
        return dist.browser_specific_settings.gecko.id
    } catch {
        console.error(c.red('Cannot determine the AMO add-on id — build dist-firefox or set FIREFOX_EXTENSION_ID.'))
        process.exit(1)
    }
}

function createSourceZip() {
    console.log('\n' + c.yellow('[1/3] Zipping source for review...'))
    // Committed files only — never .env or other untracked/ignored content.
    execSync('git archive --format=zip -o source.zip HEAD', { cwd: ROOT, stdio: 'inherit' })
    console.log(c.green('✔ source.zip written (git archive HEAD)'))
    return CONFIG.sourceZip
}

async function updateStoreListing(version) {
    console.log('\n' + c.yellow('[3/3] Updating AMO store description...'))
    const description = readDescription()
    if (!description) {
        console.log('No description file — skipping metadata update.')
        return
    }
    const url = `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(extensionId())}/`
    try {
        const res = await fetch(url, {
            method: 'PATCH',
            headers: {
                Authorization: `JWT ${amoJwt(process.env.FIREFOX_JWT_ISSUER, process.env.FIREFOX_JWT_SECRET)}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ description: { 'en-US': description } }),
        })
        if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`)
        console.log(c.green('✔ Store description updated!'))
    } catch (error) {
        // Non-fatal by design (matches reveddit): the version submission already succeeded.
        console.error(c.red('Description update failed:'), error.message)
        console.error(`Update it by hand or retry with: yarn publish:firefox:text  (v${version})`)
    }
}

async function main() {
    requireEnv(['FIREFOX_JWT_ISSUER', 'FIREFOX_JWT_SECRET'])
    const version = getManifest().version
    assertVersionInDescription(version)

    if (process.argv.includes('--text-only')) {
        console.log(c.cyan(`🚀 Updating Firefox store description only (v${version})`))
        await updateStoreListing(version)
        return
    }

    console.log(c.cyan(`🚀 Firefox publish flow for v${version}`))

    // Always sign a freshly built dist-firefox — a stale one could be from an
    // older commit. (Dev builds live in dist-firefox-dev/, so no dev-leak risk.)
    console.log(c.yellow('Building production dist-firefox...'))
    const build = spawnSync('yarn', ['build-firefox'], { stdio: 'inherit' })
    if (build.status !== 0 || !fs.existsSync(path.join(CONFIG.firefoxDist, 'manifest.json'))) {
        console.error(c.red('build-firefox failed.'))
        process.exit(1)
    }

    const sourceZip = createSourceZip()
    console.log('\n' + c.yellow('[2/3] Signing & submitting to AMO (listed channel)...'))
    await webExt.cmd.sign(
        {
            apiKey: process.env.FIREFOX_JWT_ISSUER,
            apiSecret: process.env.FIREFOX_JWT_SECRET,
            sourceDir: CONFIG.firefoxDist,
            artifactsDir: path.join(ROOT, 'web-ext-artifacts'),
            channel: 'listed',
            amoBaseUrl: 'https://addons.mozilla.org/api/v5/',
            uploadSourceCode: sourceZip,
        },
        { shouldExitProgram: false },
    )
    console.log(c.green('✔ Submitted to AMO! (review usually clears quickly)'))
    fs.rmSync(sourceZip, { force: true })

    await updateStoreListing(version)
}

main().catch(e => {
    console.error(c.red('Firefox publish failed:'), e.message || e)
    process.exit(1)
})
