import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import webpack from 'webpack'
import CopyWebpackPlugin from 'copy-webpack-plugin'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const manifestVersion = JSON.parse(fs.readFileSync(path.join(__dirname, 'src', 'manifest.json'), 'utf8')).version

// Parse the VERSION HISTORY section of STORE_DESCRIPTION.txt into a changelog
// (single source of truth, shared with the store listing). Each entry is a version
// line followed by its notes line.
function parseChangelog() {
    const file = path.join(__dirname, 'STORE_DESCRIPTION.txt')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').split('\n')
    const start = lines.findIndex(l => l.startsWith('VERSION HISTORY'))
    if (start === -1) return []
    const out = []
    for (let i = start + 1; i < lines.length; i++) {
        const v = lines[i].trim()
        if (/^\d+\.\d+/.test(v)) out.push({ version: v, notes: (lines[i + 1] || '').trim() })
    }
    return out
}

// Refuse to build a version the store description has no release note for (the
// reveddit extension has the same guard): bump src/manifest.json together with a
// new VERSION HISTORY entry.
const changelog = parseChangelog()
if (!changelog.some(e => e.version === manifestVersion && e.notes)) {
    throw new Error(
        `STORE_DESCRIPTION.txt has no changelog entry for manifest version ${manifestVersion}. ` +
            'Add one at the top of VERSION HISTORY (the version on its own line, then its note) before building.',
    )
}

const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development'
const browserIsFirefox = process.env.BROWSER === 'firefox'
const builtFor = browserIsFirefox ? 'firefox' : 'chrome'
// Dev and prod builds land in separate dirs so a dev build (debug breadcrumbs,
// inline source maps) can never be mistaken for — or shipped as — a store artifact.
const distPath = path.join(__dirname, `dist-${builtFor}${mode === 'development' ? '-dev' : ''}`)
const distSrcPath = path.join(distPath, 'src')

// Rewrite the MV3 manifest into an MV2 manifest for Firefox. Mirrors the
// transform the reveddit real-time extension does in its webpack config.
function transformManifest(buffer) {
    const manifest = JSON.parse(buffer.toString())
    if (browserIsFirefox) {
        manifest.permissions = manifest.permissions.concat(manifest.host_permissions || [])
        delete manifest.host_permissions
        manifest.manifest_version = 2
        // Firefox's data settings: none required. A problem report's details (version,
        // browser, status, log) are technical data, so they're optional, and Report a
        // problem asks Firefox for them first (report.ts reportProblem).
        manifest.browser_specific_settings = { gecko: { id: 'ghostedwatch@reveddit.com', strict_min_version: '109.0', data_collection_permissions: { required: ['none'], optional: ['technicalAndInteraction'] } } }
        manifest.background.scripts = [manifest.background.service_worker]
        manifest.background.persistent = true
        delete manifest.background.service_worker
        manifest.browser_action = manifest.action
        delete manifest.action
        manifest.web_accessible_resources = manifest.web_accessible_resources[0].resources
        manifest.content_security_policy = manifest.content_security_policy.extension_pages
    }
    return JSON.stringify(manifest, null, 2)
}

const contentScripts = {
    content: './src/src/content.ts',
    inject: './src/src/inject.ts',
}
const extensionPages = {
    popup: './src/src/popup.tsx',
    options: './src/src/options.tsx',
    history: './src/src/history.tsx',
    welcome: './src/src/welcome.tsx',
    help: './src/src/help.tsx',
    insights: './src/src/insights.tsx',
    manage: './src/src/manage.tsx',
}

export default {
    mode,
    devtool: 'inline-source-map',
    entry: {
        background: './src/background.ts',
        ...contentScripts,
        ...extensionPages,
    },
    output: {
        publicPath: '',
        path: distPath,
        filename: pathData => (pathData.chunk.name === 'background' ? '[name].js' : 'src/[name].js'),
        clean: true,
    },
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                exclude: /node_modules/,
                use: { loader: 'ts-loader', options: { transpileOnly: true } },
            },
        ],
    },
    resolve: { extensions: ['.tsx', '.ts', '.js'] },
    plugins: [
        new webpack.DefinePlugin({
            __BUILT_FOR__: JSON.stringify(builtFor),
            __DEV__: JSON.stringify(mode !== 'production'),
            __VERSION__: JSON.stringify(manifestVersion),
            __CHANGELOG__: JSON.stringify(changelog),
        }),
        new CopyWebpackPlugin({
            patterns: [
                { from: './src/manifest.json', to: distPath, transform: transformManifest },
                { from: 'src/icons', to: path.join(distPath, 'icons'), globOptions: { ignore: ['**/.DS_Store'] } },
                { context: 'src/src/', from: '*.html', to: distSrcPath },
                { context: 'src/src/', from: 'content.css', to: distSrcPath, noErrorOnMissing: true },
            ],
        }),
    ],
}
