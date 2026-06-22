import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getRemoved, getOwnItems, getLastOrigin, getLastCheck, type RemovedRecord } from './storage'
import { sendMessage } from './ui-common'
import { permalink } from './common'
import { prettyAgo } from './time'
import { EyeMark } from './Ghost'

// Parse the active .win tab's URL into a watchable user or community feed, if any.
type Page = { kind: 'user' | 'feed'; name: string }
function parsePage(url?: string): Page | null {
    if (!url) return null
    let path: string
    let host: string
    try {
        const u = new URL(url)
        path = u.pathname
        host = u.hostname
    } catch {
        return null
    }
    if (!/(^|\.)(scored\.co|patriots\.win|communities\.win)$/.test(host)) return null
    const um = path.match(/\/u\/([^/]+)/)
    if (um) return { kind: 'user', name: decodeURIComponent(um[1]) }
    if (/\/p\//.test(path)) return null // a post/thread page, not a feed
    const cm = path.match(/\/c\/([^/]+)/)
    if (cm) return { kind: 'feed', name: decodeURIComponent(cm[1]) }
    if (host.endsWith('patriots.win')) return { kind: 'feed', name: 'TheDonald' }
    return null
}
const keyOf = (p: Page) => `${p.kind}:${p.name.toLowerCase()}`
const pageLabel = (p: Page) => (p.kind === 'user' ? `u/${p.name}` : `c/${p.name}`)

const openPage = (file: string) => chrome.tabs.create({ url: chrome.runtime.getURL(file), active: true })

// A compact, scannable removal row (the popup keeps it terse; the history page has full detail).
function RemovedRow({ rec, origin }: { rec: RemovedRecord; origin?: string }) {
    const reapproved = !!rec.reapproved_utc
    const cls = reapproved ? 'reapproved' : rec.status
    const isPost = rec.type === 'post'
    return (
        <a
            className={`gw-rrow ${cls}`}
            href={permalink(rec.post_uuid, rec.uuid, rec.type, origin)}
            target="_blank"
            rel="noreferrer"
        >
            <div className="gw-rrow-bar" />
            <div className="gw-rrow-main">
                <div className="gw-rrow-head">
                    <span className="gw-rrow-kind">{isPost ? 'Post' : 'Comment'}</span>
                    <span className="gw-rrow-sub">c/{rec.community}</span>
                    <span className="gw-rrow-ago">{prettyAgo(rec.observed_utc)}</span>
                </div>
                <div className="gw-rrow-txt">
                    {isPost ? rec.title || '(title unavailable)' : rec.text || '(text unavailable)'}
                </div>
            </div>
        </a>
    )
}

function Popup() {
    const [removed, setRemoved] = useState<RemovedRecord[]>([])
    const [trackedCount, setTrackedCount] = useState(0)
    const [checking, setChecking] = useState(false)
    const [auth, setAuth] = useState<{ connected: boolean; user: string } | null>(null)
    const [origin, setOrigin] = useState<string>()
    const [sources, setSources] = useState<string[]>([])
    const [page, setPage] = useState<Page | null>(null)
    const [lastCheck, setLastCheck] = useState<number | undefined>()

    const loadSources = async () => setSources(((await sendMessage({ action: 'list-other' }))?.sources as string[]) || [])

    const load = async () => {
        const map = await getRemoved()
        setRemoved(Object.values(map).sort((a, b) => b.observed_utc - a.observed_utc))
        setTrackedCount(Object.keys(await getOwnItems()).length)
        setAuth(await sendMessage({ action: 'get-auth-status' }))
        setLastCheck(await getLastCheck())
        setOrigin(await getLastOrigin())
        await loadSources()
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        setPage(parsePage(tab?.url))
    }

    const watchSource = async (p: Page) => {
        await sendMessage({ action: 'watch-source', kind: p.kind, name: p.name })
        await loadSources()
    }
    const unwatchSource = async (key: string) => {
        await sendMessage({ action: 'unwatch-source', key })
        await loadSources()
    }

    useEffect(() => {
        // opening the popup counts as seeing them: clear unseen + the badge
        load().then(() => sendMessage({ action: 'mark-seen' }))
    }, [])

    const checkNow = async () => {
        setChecking(true)
        await sendMessage({ action: 'check-now' })
        setTimeout(() => load().then(() => setChecking(false)), 1500)
    }
    const reconnect = async () => {
        await sendMessage({ action: 'reconnect' })
        setTimeout(load, 2000) // re-capture happens in the .win tab; re-check shortly
    }

    // --- derive the single status state ---
    const ownRemoved = removed.filter(r => r.source !== 'other' && !r.reapproved_utc)
    const hidden = ownRemoved.filter(r => r.hidden).length
    const connected = !!auth?.connected
    const state: 'alarm' | 'clear' | 'disconnected' = !connected
        ? 'disconnected'
        : ownRemoved.length > 0
          ? 'alarm'
          : 'clear'

    let statusIcon: string
    let statusText: string
    if (state === 'disconnected') {
        statusIcon = '⊘'
        statusText = 'Disconnected — open a .win site and log in to resume watching.'
    } else if (state === 'alarm') {
        const n = ownRemoved.length
        statusIcon = '⚠'
        statusText = `${n} of your recent ${n === 1 ? 'post/comment is' : 'posts/comments are'} currently removed${
            hidden > 0 ? ` — ${hidden} hidden from others entirely` : ''
        }.`
    } else {
        statusIcon = '✓'
        statusText = 'All clear — none of your recent posts or comments are removed.'
    }

    const watchingPage = page && sources.includes(keyOf(page))
    const visibleRemoved = removed.slice(0, 6)

    const nav: { label: string; icon: string; go: () => void }[] = [
        { label: 'History', icon: '≡', go: () => openPage('src/history.html') },
        { label: 'Insights', icon: '◔', go: () => openPage('src/insights.html') },
        { label: 'Watching', icon: '☆', go: () => openPage('src/manage.html') },
        { label: 'Options', icon: '⚙', go: () => chrome.runtime.openOptionsPage() },
    ]

    return (
        <div className="gw-pop">
            <div className="gw-head">
                <EyeMark size={22} />
                <div className="gw-head-id">
                    <div className="gw-head-title">GhostedWatch</div>
                    <div className="gw-head-sub">
                        {connected ? (auth?.user ? `u/${auth.user}` : 'connected') : 'not connected'}
                    </div>
                </div>
                <button className="gw-iconbtn" title="Check now" onClick={checkNow} disabled={checking || !connected}>
                    {checking ? '…' : '⟳'}
                </button>
                <button className="gw-iconbtn" title="Settings" onClick={() => chrome.runtime.openOptionsPage()}>
                    ⚙
                </button>
            </div>

            <div className={`gw-status ${state}`}>
                <div className="gw-status-ico">{statusIcon}</div>
                <div className="gw-status-txt">{statusText}</div>
            </div>

            <div className="gw-body">
                {state === 'disconnected' && (
                    <button className="gw-reconnect" onClick={reconnect}>
                        Reconnect
                    </button>
                )}

                {visibleRemoved.map(rec => (
                    <RemovedRow key={rec.id} rec={rec} origin={origin} />
                ))}
                {removed.length > visibleRemoved.length && (
                    <a className="gw-more" href="#" onClick={() => openPage('src/history.html')}>
                        View all {removed.length} removals →
                    </a>
                )}

                {connected && removed.length === 0 && (
                    <div className="gw-clear-card">
                        <EyeMark size={34} />
                        <div style={{ flex: 1 }}>
                            <div className="gw-clear-title">
                                Watching {trackedCount} of your item{trackedCount === 1 ? '' : 's'}
                                {sources.length > 0 ? ` · ${sources.length} user${sources.length === 1 ? '' : 's'}/feeds` : ''}
                            </div>
                            <div className="gw-clear-sub">
                                {lastCheck ? `Last checked ${prettyAgo(lastCheck)}` : 'Watching in the background'} · nothing
                                removed
                            </div>
                        </div>
                    </div>
                )}

                {page &&
                    (watchingPage ? (
                        <div className="gw-watch-ctx watching">
                            <div className="gw-watch-ctx-main">
                                <div className="gw-watch-ctx-title">
                                    ✓ Watching {page.kind === 'user' ? 'this user' : 'this community'}
                                </div>
                                <div className="gw-watch-ctx-name">{pageLabel(page)}</div>
                                <div className="gw-watch-ctx-note">
                                    {page.kind === 'user'
                                        ? "We check this user's posts & comments and alert you when any is removed."
                                        : 'We check this community’s new feed and alert you when a post is removed.'}
                                </div>
                            </div>
                            <button className="gw-ctx-off" onClick={() => unwatchSource(keyOf(page))}>
                                Unwatch
                            </button>
                        </div>
                    ) : (
                        <div className="gw-watch-ctx">
                            <div className="gw-watch-ctx-main">
                                <div className="gw-watch-ctx-title">
                                    Watch {page.kind === 'user' ? 'this user' : 'this community'}
                                </div>
                                <div className="gw-watch-ctx-name">{pageLabel(page)}</div>
                                <div className="gw-watch-ctx-note">
                                    {page.kind === 'user'
                                        ? "Get alerted when any of this user's posts or comments is removed."
                                        : 'Get alerted when a post in this community’s new feed is removed.'}
                                </div>
                            </div>
                            <button onClick={() => watchSource(page)}>
                                {page.kind === 'user' ? 'Watch user' : 'Watch new'}
                            </button>
                        </div>
                    ))}
            </div>

            <div className="gw-nav">
                {nav.map(n => (
                    <button key={n.label} className="gw-nav-btn" onClick={n.go}>
                        <span className="gw-nav-ico">{n.icon}</span>
                        <span className="gw-nav-lbl">{n.label}</span>
                    </button>
                ))}
            </div>
        </div>
    )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Popup />)
