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

const mode = process.env.NODE_ENV === 'production' ? 'production' : 'development'
const browserIsFirefox = process.env.BROWSER === 'firefox'
const builtFor = browserIsFirefox ? 'firefox' : 'chrome'
const distPath = path.join(__dirname, browserIsFirefox ? 'dist-firefox' : 'dist-chrome')
const distSrcPath = path.join(distPath, 'src')

// Rewrite the MV3 manifest into an MV2 manifest for Firefox. Mirrors the
// transform the reveddit real-time extension does in its webpack config.
function transformManifest(buffer) {
    const manifest = JSON.parse(buffer.toString())
    if (browserIsFirefox) {
        // `scripting` is MV3-only; Firefox MV2 doesn't use it (waits for navigation)
        manifest.permissions = manifest.permissions.filter(p => p !== 'scripting')
        manifest.permissions = manifest.permissions.concat(manifest.host_permissions || [])
        delete manifest.host_permissions
        manifest.manifest_version = 2
        manifest.browser_specific_settings = { gecko: { id: 'ghostedwatch@reveddit.com', strict_min_version: '109.0' } }
        manifest.background = { scripts: [manifest.background.service_worker], persistent: false }
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
            __CHANGELOG__: JSON.stringify(parseChangelog()),
        }),
        new CopyWebpackPlugin({
            patterns: [
                { from: './src/manifest.json', to: distPath, transform: transformManifest },
                { from: 'src/icons', to: path.join(distPath, 'icons') },
                { context: 'src/src/', from: '*.html', to: distSrcPath },
                { context: 'src/src/', from: 'content.css', to: distSrcPath, noErrorOnMissing: true },
            ],
        }),
    ],
}
