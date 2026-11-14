import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
    getAuth,
    getOwnItems,
    getLastCheck,
    getOtherItems,
    getSources,
    getLastOrigin,
    autoCommentRoom,
    type Auth,
    type OtherItem,
    type WatchSource,
} from './storage'
import { sendMessage, threadLimitNote } from './ui-common'
import { permalink } from './common'
import { APP_NAME } from './constants'
import api from './api'
import { prettyAgo } from './time'
import { EyeMark } from './Ghost'

const base = (origin?: string) => origin || 'https://patriots.win'

// storage keys this page shows; a change to any of them re-renders it live (e.g. the
// login captured in another tab, a finished check, a new watch)
const SHOWN_KEYS = ['auth', 'own_items', 'last_check', 'other_items', 'watch_sources', 'last_origin']

// Your own account, watched automatically while you're logged in.
interface Account {
    auth: Auth | null
    tracked: number // how many of your own posts/comments are being checked
    lastCheck: number
}

function Toggle({ on, onClick, title }: { on: boolean; onClick: () => void; title?: string }) {
    return (
        <button
            className={`opt-toggle${on ? ' on' : ''}`}
            role="switch"
            aria-checked={on}
            title={title}
            onClick={onClick}
        >
            <span className="opt-knob" />
        </button>
    )
}

function Section({ label, count, children }: { label: string; count?: number; children: React.ReactNode }) {
    return (
        <>
            <div className="gw-sec">
                <span className="gw-sec-label">{label}</span>
                {count !== undefined ? <span className="gw-sec-count">{count}</span> : null}
            </div>
            <div className="gw-list">{children}</div>
        </>
    )
}

// Your own account first: it's always watched once you're logged in. Without a login,
// point to the site instead (that's where the session gets picked up).
function AccountRow({ account, origin }: { account: Account; origin?: string }) {
    const { auth, tracked, lastCheck } = account
    if (!auth) {
        const site = base(origin)
        return (
            <div className="wrow">
                <div className="wrow-bar warn" />
                <div className="wrow-main">
                    <div className="wrow-type warn">Not connected</div>
                    <div className="wrow-note">
                        Log in on a .win site and {APP_NAME} watches your own posts and comments automatically.
                    </div>
                </div>
                <a className="wrow-cta" href={`${site}/`} target="_blank" rel="noreferrer">
                    Open {new URL(site).host} to log in
                </a>
            </div>
        )
    }
    return (
        <div className="wrow">
            <div className="wrow-bar" />
            <div className="wrow-main">
                <div className="wrow-type">You</div>
                <a className="wrow-title" href={`${auth.origin}/u/${auth.user}`} target="_blank" rel="noreferrer">
                    u/{auth.user}
                </a>
                <div className="wrow-sub">
                    Your posts &amp; comments · {tracked} tracked
                    {lastCheck ? ` · checked ${prettyAgo(lastCheck)}` : ''}
                </div>
            </div>
            <span className="wrow-pill">Automatic</span>
        </div>
    )
}

function ManagePage() {
    // exclude `auto` comments — they belong to a whole-post watch, shown under its post
    const [items, setItems] = useState<OtherItem[]>([])
    // per watched post, how many of its comments a whole-post watch follows; and how many
    // more all of them together may add, so a row can say when a limit stops it
    const [followed, setFollowed] = useState<Record<number, number>>({})
    const [room, setRoom] = useState(Infinity)
    const [sources, setSources] = useState<WatchSource[]>([])
    const [origin, setOrigin] = useState<string>()
    const [account, setAccount] = useState<Account | null>(null) // null until first loaded

    const load = async () => {
        const map = await getOtherItems()
        const all = Object.values(map)
        const counts: Record<number, number> = {}
        for (const w of all) if (w.auto) counts[w.post_id] = (counts[w.post_id] || 0) + 1
        setItems(all.filter(w => !w.auto))
        setFollowed(counts)
        setRoom(autoCommentRoom(map))
        setSources(Object.values(await getSources()))
        setOrigin(await getLastOrigin())
        setAccount({
            auth: await getAuth(),
            tracked: Object.keys(await getOwnItems()).length,
            lastCheck: await getLastCheck(),
        })
    }
    useEffect(() => {
        load()
        const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === 'local' && SHOWN_KEYS.some(k => k in changes)) load()
        }
        api.storage.onChanged.addListener(onChanged)
        return () => api.storage.onChanged.removeListener(onChanged)
    }, [])

    const unwatchItem = async (id: number) => {
        await sendMessage({ action: 'unwatch-other', id })
        load()
    }
    const unwatchSource = async (key: string) => {
        await sendMessage({ action: 'unwatch-source', key })
        load()
    }
    const toggleComments = async (w: OtherItem) => {
        await sendMessage({ action: 'set-watch-comments', id: w.id, watch_comments: !w.watch_comments })
        load()
    }

    const posts = items.filter(w => w.type === 'post')
    const comments = items.filter(w => w.type === 'comment')
    const nothing = items.length === 0 && sources.length === 0

    return (
        <div>
            <div className="gw-bar">
                <EyeMark size={26} />
                <div className="gw-bar-id">
                    <span className="gw-bar-title">GhostedWatch</span>
                    <span className="gw-bar-sub">Watching</span>
                </div>
                <a
                    className="gw-bar-link"
                    href="#"
                    onClick={() => api.tabs.create({ url: api.runtime.getURL('src/help.html') })}
                >
                    How watching works →
                </a>
            </div>

            <div className="gw-page2">
                {account && (
                    <Section label="Your account">
                        <AccountRow account={account} origin={origin} />
                    </Section>
                )}
                {account && nothing && (
                    <p className="muted">
                        {account.auth
                            ? 'To also watch someone else, use the Watch button on any post or comment, or open a ' +
                              "user's or community's page and watch it from the popup."
                            : 'No login needed to watch other people: use the Watch button on any post or comment, ' +
                              "or open a user's or community's page and watch it from the popup."}
                    </p>
                )}

                {sources.length > 0 && (
                    <Section label="People & communities" count={sources.length}>
                        {sources.map(s => (
                            <div className="wrow" key={s.key}>
                                <div className="wrow-bar" />
                                <div className="wrow-main">
                                    <div className="wrow-type">{s.kind === 'user' ? 'User' : 'Community'}</div>
                                    <a
                                        className="wrow-title"
                                        href={`${base(origin)}/${s.kind === 'user' ? 'u' : 'c'}/${s.name}`}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        {s.kind === 'user' ? `u/${s.name}` : `c/${s.name}`}
                                    </a>
                                </div>
                                <span className="wrow-pill">Whole history</span>
                                <button className="wrow-x" title="Remove" onClick={() => unwatchSource(s.key)}>
                                    ✕
                                </button>
                            </div>
                        ))}
                    </Section>
                )}

                {posts.length > 0 && (
                    <Section label="Posts" count={posts.length}>
                        {posts.map(w => (
                            <div className="wrow" key={w.id}>
                                <div className="wrow-bar" />
                                <div className="wrow-main">
                                    <div className="wrow-type">Post</div>
                                    <a
                                        className="wrow-title"
                                        href={permalink(w.post_uuid, w.uuid, w.type, origin)}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        {w.title || '(post)'}
                                    </a>
                                    <div className="wrow-sub">
                                        c/{w.community} · by {w.author}
                                    </div>
                                    {w.watch_comments && threadLimitNote(followed[w.id] || 0, room) && (
                                        <div className="wrow-limit">{threadLimitNote(followed[w.id] || 0, room)}</div>
                                    )}
                                </div>
                                <div className="wrow-toggle">
                                    <span className={`wrow-toggle-lbl${w.watch_comments ? ' on' : ''}`}>
                                        All comments
                                    </span>
                                    <Toggle
                                        on={!!w.watch_comments}
                                        onClick={() => toggleComments(w)}
                                        title={
                                            w.watch_comments
                                                ? 'On — also watching every comment in this thread'
                                                : 'Off — watching the post only'
                                        }
                                    />
                                </div>
                                <button className="wrow-x" title="Remove" onClick={() => unwatchItem(w.id)}>
                                    ✕
                                </button>
                            </div>
                        ))}
                    </Section>
                )}

                {comments.length > 0 && (
                    <Section label="Comments" count={comments.length}>
                        {comments.map(w => (
                            <div className="wrow" key={w.id}>
                                <div className="wrow-bar" />
                                <div className="wrow-main">
                                    <div className="wrow-type">Comment</div>
                                    <a
                                        className="wrow-title"
                                        href={permalink(w.post_uuid, w.uuid, w.type, origin)}
                                        target="_blank"
                                        rel="noreferrer"
                                    >
                                        “{(w.text || '(comment)').slice(0, 90)}”
                                    </a>
                                    <div className="wrow-sub">
                                        c/{w.community} · by {w.author}
                                    </div>
                                </div>
                                <span className="wrow-pill">Single comment</span>
                                <button className="wrow-x" title="Remove" onClick={() => unwatchItem(w.id)}>
                                    ✕
                                </button>
                            </div>
                        ))}
                    </Section>
                )}
            </div>
        </div>
    )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<ManagePage />)
