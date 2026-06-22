import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getRemoved, getOwnItems, type RemovedRecord } from './storage'
import { computeStats, toCSV, toJSON, type Stats, type Tally } from './stats'
import { prettyDuration } from './time'
import { EyeMark } from './Ghost'

// Trigger a client-side download of generated text (no server involved).
function download(filename: string, content: string, mime: string): void {
    const url = URL.createObjectURL(new Blob([content], { type: mime }))
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const Bar = ({ name, count, max }: { name: string; count: number; max: number }) => (
    <div>
        <div className="ins-dist-head">
            <span className="ins-dist-name">{name}</span>
            <span className="ins-dist-count">{count}</span>
        </div>
        <div className="ins-dist-track">
            <span className="ins-dist-fill" style={{ width: `${max ? (count / max) * 100 : 0}%` }} />
        </div>
    </div>
)

function Dist({ label, items, max }: { label: string; items: Tally[]; max: number }) {
    return (
        <div>
            <div className="ins-label">{label}</div>
            <div className="ins-dist">
                {items.map(t => (
                    <Bar key={t.name} name={t.name} count={t.count} max={max} />
                ))}
            </div>
        </div>
    )
}

function Header() {
    return (
        <div className="gw-bar">
            <EyeMark size={26} />
            <div className="gw-bar-id">
                <span className="gw-bar-title">GhostedWatch</span>
                <span className="gw-bar-sub">Insights</span>
            </div>
            <a
                className="gw-bar-link"
                href="#"
                onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('src/help.html') })}
            >
                How it works →
            </a>
        </div>
    )
}

function StatsPage() {
    const [stats, setStats] = useState<Stats | null>(null)
    const [records, setRecords] = useState<RemovedRecord[]>([])
    const [ownCount, setOwnCount] = useState(0)

    useEffect(() => {
        getRemoved().then(m => {
            const recs = Object.values(m)
            setRecords(recs)
            setStats(computeStats(recs))
        })
        getOwnItems().then(m => setOwnCount(Object.keys(m).length))
    }, [])

    const today = new Date().toISOString().slice(0, 10)
    const exportJson = () => download(`ghostedwatch-removals-${today}.json`, toJSON(records), 'application/json')
    const exportCsv = () => download(`ghostedwatch-removals-${today}.csv`, toCSV(records), 'text/csv')

    if (!stats || stats.total === 0) {
        return (
            <div>
                <Header />
                <div className="gw-page2">
                    {stats ? (
                        <p className="muted">
                            No removals detected yet — once something you or someone you watch posts gets removed, your
                            stats appear here.
                        </p>
                    ) : null}
                </div>
            </div>
        )
    }

    const maxOf = (nums: number[]) => nums.reduce((m, n) => (n > m ? n : m), 1)
    const rate = ownCount > 0 ? Math.round((stats.own / ownCount) * 100) : null
    const maxCommunity = maxOf(stats.byCommunity.map(t => t.count))
    const maxSource = maxOf(stats.bySource.map(t => t.count))
    const maxDay = maxOf(stats.perDay.map(d => d.count))

    return (
        <div>
            <Header />
            <div className="gw-page2">
                {/* headline metrics */}
                <div className="ins-hero">
                    <div className="ins-hero-card">
                        <div className="ins-hero-n">{stats.total}</div>
                        <div className="ins-hero-l">removals detected</div>
                    </div>
                    {rate !== null ? (
                        <div className="ins-hero-card">
                            <div className="ins-hero-n">
                                {rate}
                                <span className="ins-pct">%</span>
                            </div>
                            <div className="ins-hero-l">of your {ownCount} monitored items removed</div>
                        </div>
                    ) : null}
                    {stats.medianTimeToRemovalMs !== null ? (
                        <div className="ins-hero-card">
                            <div className="ins-hero-n">{prettyDuration(stats.medianTimeToRemovalMs)}</div>
                            <div className="ins-hero-l">typical time to removal</div>
                        </div>
                    ) : null}
                </div>

                {/* breakdown by kind */}
                <div className="ins-strip">
                    {(
                        [
                            ['#ff5a2a', stats.own, 'your content'],
                            ['#4f7bff', stats.other, "others' content"],
                            ['#a23bd6', stats.hidden, 'hidden'],
                            ['#3fbf7f', stats.reapproved, 're-approved'],
                        ] as [string, number, string][]
                    ).map(([color, n, label]) => (
                        <div className="ins-chip" key={label}>
                            <span className="ins-dot" style={{ background: color }} />
                            <span className="ins-chip-n">{n}</span>
                            <span className="ins-chip-l">{label}</span>
                        </div>
                    ))}
                </div>

                {/* 14-day trend */}
                <div className="ins-label">Removals — last 14 days</div>
                <div className="ins-chart">
                    <div className="ins-bars">
                        {stats.perDay.map(d => (
                            <div
                                key={d.day}
                                className={`ins-bar${d.count > 0 ? ' hit' : ''}`}
                                title={`${d.day}: ${d.count}`}
                                style={{ height: d.count > 0 ? `${Math.max(14, (d.count / maxDay) * 112)}px` : '4px' }}
                            />
                        ))}
                    </div>
                    <div className="ins-axis">
                        <span>14 days ago</span>
                        <span>today</span>
                    </div>
                </div>

                {/* distributions */}
                <div className="ins-dist-grid">
                    <Dist label="Top communities" items={stats.byCommunity.slice(0, 8)} max={maxCommunity} />
                    <Dist label="By removal source" items={stats.bySource} max={maxSource} />
                </div>

                {/* export */}
                <div className="ins-export">
                    <div className="ins-export-main">
                        <div className="ins-export-title">Export your removal history</div>
                        <div className="ins-export-sub">Your full records, to keep or share as evidence.</div>
                    </div>
                    <button className="ins-export-btn" onClick={exportJson}>
                        Export JSON
                    </button>
                    <button className="ins-export-btn outline" onClick={exportCsv}>
                        Export CSV
                    </button>
                </div>
            </div>
        </div>
    )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<StatsPage />)
