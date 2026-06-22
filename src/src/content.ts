// Content script. Runs on the .win site and does only what needs the page context:
//   1. injects inject.js to capture the ids/text of posts & comments you submit,
//   2. captures the site's API tokens + your username and hands them to the
//      background, which then polls for removals on its own (even with no tab open),
//   3. paints the in-page highlights for known removals,
//   4. adds a "Watch" button to every comment (to monitor other users' comments).
// All detection lives in the background poller — there is no polling here.
import { MSG_SOURCE } from './constants'
import { setRemovedSet, startHighlighting, type RemovedLite } from './highlight'
import { startWatchButtons } from './watch-ui'

export {} // module scope

// Runs fresh on each injection (manifest load, navigation, or the background's
// install/reload executeScript) so it always re-captures the session. The only
// thing that must not double-run is the page-context fetch/XHR wrapping, which is
// guarded inside inject.ts itself.
main()

function main() {
    function injectPageScript() {
        const script = document.createElement('script')
        script.src = chrome.runtime.getURL('src/inject.js')
        script.onload = () => script.remove()
        ;(document.head || document.documentElement).appendChild(script)
    }

    // Relay captured posts/comments from the page-context inject script.
    window.addEventListener('message', event => {
        if (event.source !== window) return
        const data = event.data
        if (!data || data.source !== MSG_SOURCE) return
        if (data.type === 'created-comment' || data.type === 'created-post') {
            chrome.runtime.sendMessage({
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

    // The site keeps its API tokens in localStorage and authenticates with them via
    // headers (independent of cookies). Hand them + the username to the background so
    // it can poll without a tab open. Returns true once captured.
    async function sendAuth(): Promise<boolean> {
        const apiKey = localStorage.getItem('api_key') || ''
        const apiSecret = localStorage.getItem('api_secret') || ''
        if (!apiKey || !apiSecret) return false
        try {
            const res = await fetch('/api/v2/user/about.json?user=me', {
                credentials: 'include',
                headers: { 'X-Api-Key': apiKey, 'X-Api-Secret': apiSecret },
            })
            const user = (await res.json())?.users?.[0]?.username
            if (!user) return false
            chrome.runtime.sendMessage({ action: 'set-auth', auth: { user, origin: location.origin, apiKey, apiSecret } })
            return true
        } catch {
            return false // not logged in yet / transient
        }
    }

    // The SPA populates its tokens after load, so retry until we've captured them
    // (this runs fresh on every page load), then keep them fresh on an interval.
    async function captureLoop() {
        for (let i = 0; i < 12; i++) {
            if (await sendAuth()) return
            await sleep(1500)
        }
    }

    // Repaint highlights from the background's known-removed set.
    async function refreshHighlights() {
        const list: RemovedLite[] = await new Promise(resolve =>
            chrome.runtime.sendMessage({ action: 'list-removed' }, resp => resolve(resp?.removed || [])),
        )
        setRemovedSet(list)
    }

    chrome.runtime.onMessage.addListener(msg => {
        if (msg?.action === 'refresh') refreshHighlights()
        else if (msg?.action === 'send-auth-now') sendAuth() // popup "reconnect"
    })

    injectPageScript()
    startHighlighting()
    startWatchButtons() // add the "Watch" button to comments + load watched state
    refreshHighlights() // instant from the store; no network
    captureLoop()
    setInterval(sendAuth, 5 * 60 * 1000) // refresh stored tokens periodically
}
