import React from 'react'
import type { RemovedRecord } from './storage'
import { statusLabel } from './ui-common'
import { permalink } from './common'
import { prettyAgo, prettyDuration, fullTimestamp } from './time'
import { Tooltip } from './Tooltip'
import { downloadCard } from './card'

const userUrl = (origin: string | undefined, name: string) => `${origin || 'https://patriots.win'}/u/${name}`
const commUrl = (origin: string | undefined, name: string) => `${origin || 'https://patriots.win'}/c/${name}`

// One removal as an accent-bar card (History page): a tag row (Removed / Watched +
// who/where), the removed/restored text, then a calm secondary row with the
// removed-by / observed details and the Permalink · Save image actions.
export function RemovedItemView({
    rec,
    linkLabel,
    origin,
}: {
    rec: RemovedRecord
    linkLabel: string
    origin?: string // the .win origin the user is active on; falls back to the default
}) {
    const isPost = rec.type === 'post'
    const reapproved = !!rec.reapproved_utc
    const other = rec.source === 'other' // someone else's content the user watched
    const cls = reapproved ? 'reapproved' : rec.status
    const kind = isPost ? 'post' : 'comment'
    const observed = `observed ${fullTimestamp(rec.observed_utc)}${rec.created ? ` · posted ${fullTimestamp(rec.created)}` : ''}`
    return (
        <div className={`hcard ${cls}`}>
            <div className="hcard-bar" />
            <div className="hcard-main">
                <div className="hcard-tags">
                    <span className={`badge ${cls}`}>{statusLabel(rec)}</span>
                    {other ? <span className="badge other">others</span> : null}
                    <span className="hcard-meta">
                        {other ? (
                            <>
                                {kind}
                                {rec.author ? (
                                    <>
                                        {' by '}
                                        <a href={userUrl(origin, rec.author)} target="_blank" rel="noreferrer">
                                            {rec.author}
                                        </a>
                                    </>
                                ) : null}
                            </>
                        ) : (
                            `your ${kind}`
                        )}
                        {' · '}
                        <a href={commUrl(origin, rec.community)} target="_blank" rel="noreferrer">
                            c/{rec.community}
                        </a>
                    </span>
                </div>

                {isPost ? (
                    <div className="hcard-text">{rec.title || <em className="muted">(title unavailable)</em>}</div>
                ) : (
                    <div className="hcard-text">
                        {rec.text ? (
                            rec.text
                        ) : rec.text_loading ? (
                            <em className="muted">loading the text you posted…</em>
                        ) : (
                            <em className="muted">(text unavailable)</em>
                        )}
                    </div>
                )}

                <div className="hcard-foot">
                    {rec.removal_source ? (
                        <span>
                            removed by <span className="src">{rec.removal_source}</span>
                        </span>
                    ) : null}
                    <Tooltip text={observed}>
                        observed {prettyAgo(rec.observed_utc)}
                        {rec.created ? ` · ${prettyDuration(rec.observed_utc - rec.created)} after posting` : ''}
                    </Tooltip>
                    {reapproved ? (
                        <span>
                            · re-approved{' '}
                            <Tooltip text={fullTimestamp(rec.reapproved_utc!)}>{prettyAgo(rec.reapproved_utc!)}</Tooltip>
                        </span>
                    ) : null}
                    <span className="hcard-actions">
                        <a href={permalink(rec.post_uuid, rec.uuid, rec.type, origin)} target="_blank" rel="noreferrer">
                            {linkLabel}
                        </a>
                        <a
                            href="#"
                            onClick={e => {
                                e.preventDefault()
                                downloadCard(rec)
                            }}
                        >
                            Save image
                        </a>
                    </span>
                </div>
            </div>
        </div>
    )
}
