import React from 'react'
import { createRoot } from 'react-dom/client'
import { APP_NAME } from './constants'
import { EyeMark } from './Ghost'

const SITE = 'https://ghostedwatch.com/'

const watchHow: [string, React.ReactNode][] = [
    ['A comment', <>Click Watch directly on it.</>],
    [
        'A thread',
        <>
            Click Watch on the <em>post</em> and choose <strong>“post + all comments.”</strong> New comments are picked
            up automatically.
        </>,
    ],
    [
        'A user',
        <>
            Open their <code>/u/…</code> page and hit <strong>“Watch user”</strong> in the popup.
        </>,
    ],
    [
        'A community',
        <>
            Open the community and hit <strong>“Watch … (new)”</strong> to follow its new feed.
        </>,
    ],
]

const legend: [string, string, React.ReactNode][] = [
    ['publicly_removed', 'removed', 'Taken down.'],
    ['shadow_removed', 'hidden', 'No one can see it — not even a placeholder.'],
    ['reapproved', 're-approved', 'Became visible again.'],
    ['other', 'others', "Someone else's content you chose to watch (your own is unlabeled)."],
]

const more: React.ReactNode[] = [
    <>
        <strong>Insights</strong> — your removal rate, top filtering communities, typical time-to-removal, and a 14-day
        trend.
    </>,
    <>
        <strong>Watching</strong> — manage posts, comments, users, and communities in one place.
    </>,
    <>
        <strong>Export</strong> — download your full removal history as JSON or CSV.
    </>,
    <>
        <strong>Save image</strong> — generate a shareable card of any removal.
    </>,
    <>
        <strong>Notifications</strong> — one alert per event, or a single digest per check.
    </>,
]

function Help() {
    return (
        <div>
            <div className="gw-bar">
                <EyeMark size={26} />
                <div className="gw-bar-id">
                    <span className="gw-bar-title">GhostedWatch</span>
                    <span className="gw-bar-sub">How it works</span>
                </div>
                <a className="gw-bar-link" href={SITE} target="_blank" rel="noreferrer">
                    ghostedwatch.com →
                </a>
            </div>

            <div className="help-body">
                <h1 className="help-h1">Know the moment your posts go quiet.</h1>
                <p className="help-lead">
                    {APP_NAME} tells you when content on the <strong>.win sites</strong> (patriots.win, scored.co,
                    communities.win) is removed — including the silent kind, where the author still sees it but everyone
                    else gets a “removed by community filter” placeholder, or nothing at all.
                </p>

                <section className="help-sec">
                    <div className="help-eyebrow">Automatic</div>
                    <h2 className="help-h2">Your own content</h2>
                    <p>
                        Once you log into a .win site, {APP_NAME} watches the posts and comments you make and checks them
                        in the background — <strong>even with no tab open</strong>. When one is removed it notifies you,
                        saves the text you wrote, and shows who and how it was removed. If a removed item is later
                        re-approved, it tells you that too.
                    </p>
                    <div className="help-callout">
                        <div className="help-callout-bar" />
                        <p>
                            The <strong>status line</strong> at the top of the popup is your quick “am I shadowbanned
                            right now?” read — it shows whether your recent content is still visible to others.
                        </p>
                    </div>
                </section>

                <section className="help-sec">
                    <div className="help-eyebrow">Watching</div>
                    <h2 className="help-h2">Other people's content</h2>
                    <p>
                        A{' '}
                        <span className="help-chip">
                            <EyeMark size={13} /> Watch
                        </span>{' '}
                        button is added to every post and comment. Click it to be alerted if that item is removed — it
                        turns to <span className="help-chip on">Watching ✓</span>. Your own content shows the button
                        greyed out, since it's already watched automatically.
                    </p>
                    <div className="help-table">
                        {watchHow.map(([k, v]) => (
                            <div className="help-trow" key={k}>
                                <span className="help-tkey">{k}</span>
                                <span className="help-tval">{v}</span>
                            </div>
                        ))}
                    </div>
                    <p className="help-note">
                        The <strong>Watching</strong> page lists everything you follow this way and lets you remove any
                        of it.
                    </p>
                </section>

                <section className="help-sec">
                    <div className="help-eyebrow">Reference</div>
                    <h2 className="help-h2">What the labels mean</h2>
                    <div className="help-grid">
                        {legend.map(([cls, label, desc]) => (
                            <div className="help-legend" key={cls}>
                                <span className={`badge ${cls}`}>{label}</span>
                                <span>{desc}</span>
                            </div>
                        ))}
                    </div>
                    <p className="help-note">
                        <strong>“Hidden” is a precaution.</strong> It flags content that has vanished from the public
                        thread entirely — not even a placeholder — rather than being shown as removed. We haven't
                        observed the .win sites doing this in practice; the check exists so that if they ever changed how
                        they filter, it couldn't slip past unnoticed.
                    </p>
                    <p className="help-note">
                        Each removal also shows its <em>source</em> — “community filter” (the automatic system),
                        “moderator,” and so on — and a relative time (hover for the exact timestamp).
                    </p>
                </section>

                <section className="help-sec">
                    <div className="help-eyebrow">On the site</div>
                    <h2 className="help-h2">In-page highlights</h2>
                    <p>
                        As you browse, {APP_NAME} outlines any of your removed posts and comments it knows about, and
                        adds a small banner explaining what happened.
                    </p>
                </section>

                <section className="help-sec">
                    <div className="help-eyebrow">Elsewhere</div>
                    <h2 className="help-h2">More in the popup</h2>
                    <div className="help-bullets">
                        {more.map((m, i) => (
                            <div className="help-bullet" key={i}>
                                <span className="help-dot" />
                                <span>{m}</span>
                            </div>
                        ))}
                    </div>
                </section>

                <div className="help-privacy">
                    <div className="help-privacy-head">
                        <span className="badge reapproved">private</span>
                        <span className="help-privacy-title">Everything stays on your machine</span>
                    </div>
                    <p>
                        No analytics, no tracking, no third-party servers. It only talks to the .win site you're already
                        using, and it never posts, votes, or edits on your behalf. You can turn the in-page Watch buttons
                        off in Options.
                    </p>
                </div>

                <div className="help-foot">
                    <a href={SITE} target="_blank" rel="noreferrer">
                        ghostedwatch.com
                    </a>
                </div>
            </div>
        </div>
    )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Help />)
