import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getOtherItems, getSources, getLastOrigin, type OtherItem, type WatchSource } from './storage'
import { sendMessage } from './ui-common'
import { permalink } from './common'
import api from './api'
import { EyeMark } from './Ghost'

const base = (origin?: string) => origin || 'https://patriots.win'

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

function Section({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
    return (
        <>
            <div className="gw-sec">
                <span className="gw-sec-label">{label}</span>
                <span className="gw-sec-count">{count}</span>
            </div>
            <div className="gw-list">{children}</div>
        </>
    )
}

function ManagePage() {
    // exclude `auto` comments — they belong to a whole-post watch, shown under its post
    const [items, setItems] = useState<OtherItem[]>([])
    const [sources, setSources] = useState<WatchSource[]>([])
    const [origin, setOrigin] = useState<string>()

    const load = async () => {
        setItems(Object.values(await getOtherItems()).filter(w => !w.auto))
        setSources(Object.values(await getSources()))
        setOrigin(await getLastOrigin())
    }
    useEffect(() => {
        load()
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
                {nothing && (
                    <p className="muted">
                        You're not watching anyone else's content yet. Use the Watch button on a post or comment, or
                        watch a user/community from the popup. (Your own content is watched automatically.)
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
