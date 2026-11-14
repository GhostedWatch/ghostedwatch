import { MSG_SOURCE } from './constants'
import api, { extensionAlive } from './api'
import { setRemovedSet, startHighlighting, type RemovedLite } from './highlight'
import { startWatchButtons } from './watch-ui'

export {} // module scope

// Dev-build breadcrumbs: console lines + DOM attributes that automated tests
// (and humans) can read to see which stage of the pipeline was reached.
const dlog = (...args: unknown[]) => { if (__DEV__) console.log('[GhostedWatch]', ...args) }
const stamp = (k: string, v: string) => { if (__DEV__) document.documentElement.setAttribute(`data-gw-${k}`, v) }

main()

function main() {
    // One live copy per tab. A tab gets this script from the manifest and from the
    // background's injectIntoOpenTabs(), so a second run here must not stack another
    // set of listeners, observers and timers. A copy left behind by an extension update
    // is dead (its runtime is gone): it doesn't count, and this copy takes over.
    const tab = window as unknown as { __ghostedwatchAlive?: () => boolean }
    if (tab.__ghostedwatchAlive?.()) return
    tab.__ghostedwatchAlive = extensionAlive

    dlog('content script injected on', location.href)
    stamp('cs', 'injected')
    function injectPageScript() {
        const script = document.createElement('script')
        script.src = api.runtime.getURL('src/inject.js')
        script.onload = () => script.remove()
        ;(document.head || document.documentElement).appendChild(script)
    }

    window.addEventListener('message', event => {
        if (event.source !== window || !extensionAlive()) return
        const data = event.data
        if (!data || data.source !== MSG_SOURCE) return
        if (data.type === 'created-comment' || data.type === 'created-post') {
            api.runtime.sendMessage({
                action: 'watch-own',
                comment: {
                    id: data.id,
                    uuid: data.uuid,
                    type: data.type === 'created-post' ? 'post' : 'comment',
                    title: data.title || '',
                    post_id: data.post_id,
                    post_uuid: data.post_uuid,
                    community: data.community,
                    created: data.created,
                    text: data.text || '',
                },
            })
        }
    })

    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

    async function sendAuth(): Promise<boolean> {
        const apiKey = localStorage.getItem('api_key') || ''
        const apiSecret = localStorage.getItem('api_secret') || ''
        if (!apiKey || !apiSecret) {
            stamp('tokens', 'missing')
            return false
        }
        stamp('tokens', 'present')
        try {
            // Absolute URL: Firefox content-script fetch has no base URL, so a
            // relative path throws "not a valid URL" (Chrome resolves it via the page).
            const res = await fetch(`${location.origin}/api/v2/user/about.json?user=me`, {
                credentials: 'include',
                headers: { 'X-Api-Key': apiKey, 'X-Api-Secret': apiSecret },
            })
            const user = (await res.json().catch(() => null))?.users?.[0]?.username
            if (!user) {
                dlog('sendAuth: tokens present but about.json returned no user (status', res.status + ')')
                stamp('auth', 'no-user')
                return false
            }
            dlog('sendAuth: captured session for', user, '— sending set-auth')
            try {
                const resp = await api.runtime.sendMessage({
                    action: 'set-auth',
                    auth: { user, origin: location.origin, apiKey, apiSecret },
                })
                dlog('set-auth acknowledged:', JSON.stringify(resp))
                stamp('auth', 'sent-ok')
            } catch (e) {
                dlog('set-auth sendMessage FAILED:', e instanceof Error ? e.message : String(e))
                stamp('auth', 'send-failed')
                return false
            }
            return true
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            dlog('sendAuth fetch failed:', msg)
            stamp('auth', 'fetch-failed: ' + msg.slice(0, 60))
            return false
        }
    }

    async function captureLoop() {
        for (let i = 0; i < 12; i++) {
            if (await sendAuth()) return
            await sleep(1500)
        }
    }

    async function refreshHighlights() {
        try {
            const resp = await api.runtime.sendMessage({ action: 'list-removed' })
            setRemovedSet(resp?.removed || [])
            dlog('background round-trip OK (list-removed:', (resp?.removed || []).length, 'items)')
            stamp('bg', 'ok')
        } catch (e) {
            dlog('background round-trip FAILED:', e instanceof Error ? e.message : String(e))
            stamp('bg', 'unreachable')
            setRemovedSet([])
        }
    }

    api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
        // 'ping' lets the background skip tabs that already have a live copy
        if (msg?.action === 'ping') sendResponse({ ok: true })
        else if (msg?.action === 'refresh') refreshHighlights()
        else if (msg?.action === 'send-auth-now') sendAuth()
    })

    injectPageScript()
    startHighlighting()
    startWatchButtons()
    refreshHighlights()
    captureLoop()
    // a copy orphaned by an extension update stops re-checking the session
    const authTimer = setInterval(() => (extensionAlive() ? sendAuth() : clearInterval(authTimer)), 5 * 60 * 1000)
    // Logging in through the site's pop-up doesn't reload the page, and the tab keeps
    // this one copy, so watch for the session's tokens to appear or change: a
    // localStorage read every 2 s, and a check with the site only when they do.
    const tokens = () => `${localStorage.getItem('api_key') || ''}|${localStorage.getItem('api_secret') || ''}`
    let seenTokens = tokens()
    const tokenWatch = setInterval(() => {
        if (!extensionAlive()) return clearInterval(tokenWatch)
        const now = tokens()
        if (now === seenTokens) return
        seenTokens = now
        if (now !== '|') sendAuth()
    }, 2000)
}
