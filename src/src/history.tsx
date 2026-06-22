import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getRemoved, getLastOrigin, type RemovedRecord } from './storage'
import { RemovedItemView } from './RemovedItemView'
import { EyeMark } from './Ghost'

type Filter = 'all' | 'yours' | 'others'

function HistoryPage() {
    const [removed, setRemoved] = useState<RemovedRecord[]>([])
    const [origin, setOrigin] = useState<string>()
    const [filter, setFilter] = useState<Filter>('all')

    useEffect(() => {
        getRemoved().then(map => setRemoved(Object.values(map).sort((a, b) => b.observed_utc - a.observed_utc)))
        getLastOrigin().then(setOrigin)
    }, [])

    const shown = removed.filter(r =>
        filter === 'all' ? true : filter === 'others' ? r.source === 'other' : r.source !== 'other',
    )

    return (
        <div>
            <div className="gw-bar">
                <EyeMark size={26} />
                <div className="gw-bar-id">
                    <span className="gw-bar-title">GhostedWatch</span>
                    <span className="gw-bar-sub">Detected removals</span>
                </div>
                <select
                    className="gw-bar-select"
                    value={filter}
                    aria-label="Filter removals"
                    onChange={e => setFilter(e.target.value as Filter)}
                >
                    <option value="all">All</option>
                    <option value="yours">Your content</option>
                    <option value="others">Others' content</option>
                </select>
            </div>

            <div className="gw-page2 gw-list">
                {shown.length === 0 ? (
                    <div className="muted">
                        {removed.length === 0 ? 'Nothing detected yet.' : 'Nothing matches this filter.'}
                    </div>
                ) : (
                    shown.map(rec => <RemovedItemView key={rec.id} rec={rec} origin={origin} linkLabel="Permalink" />)
                )}
            </div>
        </div>
    )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<HistoryPage />)
