import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getOptions, setOptions, INTERVAL_DEFAULT, type Options } from './storage'
import { clampInterval } from './common'
import api from './api'
import { EyeMark } from './Ghost'

function OptionsPage() {
    const [interval, setIntervalValue] = useState(INTERVAL_DEFAULT)
    const [watchButtons, setWatchButtons] = useState(true)
    const [notifyMode, setNotifyMode] = useState<'each' | 'summary'>('each')
    const [saved, setSaved] = useState(false)

    useEffect(() => {
        getOptions().then(o => {
            setIntervalValue(o.interval)
            setWatchButtons(o.watchButtons)
            setNotifyMode(o.notifyMode)
        })
    }, [])

    const flashSaved = () => {
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
    }
    // Merge into what's saved, so a switch saves only itself, never an interval still
    // being typed (that's saved, clamped, by Save changes).
    const persist = async (over: Partial<Options>) => {
        await setOptions({ ...(await getOptions()), ...over })
        flashSaved()
    }
    const saveChanges = async () => {
        const clamped = clampInterval(interval)
        setIntervalValue(clamped)
        await persist({ interval: clamped })
    }
    const toggleButtons = async () => {
        const v = !watchButtons
        setWatchButtons(v)
        await persist({ watchButtons: v })
    }
    const changeNotifyMode = async (v: 'each' | 'summary') => {
        setNotifyMode(v)
        await persist({ notifyMode: v })
    }

    return (
        <div className="opt-wrap">
            <div className="opt-card">
                <div className="opt-head">
                    <EyeMark size={26} />
                    <div className="opt-head-title">GhostedWatch</div>
                    <a
                        className="opt-head-link"
                        href="#"
                        onClick={() => api.tabs.create({ url: api.runtime.getURL('src/help.html') })}
                    >
                        How it works →
                    </a>
                </div>

                <div className="opt-body">
                    <div className="opt-section-label">Monitoring</div>

                    <div className="opt-group">
                        <div className="opt-row">
                            <div className="opt-row-main">
                                <div className="opt-row-title">Check interval</div>
                                <div className="opt-row-desc">
                                    How often we poll your profile. Lower = faster detection, more requests.
                                </div>
                            </div>
                            <div className="opt-control">
                                <input
                                    id="interval"
                                    className="opt-num"
                                    type="number"
                                    min={1}
                                    max={60}
                                    value={interval}
                                    onChange={e => setIntervalValue(Number(e.target.value))}
                                />
                                <span className="opt-unit">min</span>
                            </div>
                        </div>

                        <div className="opt-divider" />

                        <div className="opt-row">
                            <div className="opt-row-main">
                                <div className="opt-row-title">Show “Watch” buttons in-page</div>
                                <div className="opt-row-desc">
                                    Adds a Watch button to others' posts and comments. Your own content is watched
                                    automatically.
                                </div>
                            </div>
                            <button
                                className={`opt-toggle${watchButtons ? ' on' : ''}`}
                                role="switch"
                                aria-checked={watchButtons}
                                aria-label="Show Watch buttons in-page"
                                onClick={toggleButtons}
                            >
                                <span className="opt-knob" />
                            </button>
                        </div>

                        <div className="opt-divider" />

                        <div className="opt-row">
                            <div className="opt-row-main">
                                <div className="opt-row-title">Notifications</div>
                                <div className="opt-row-desc">
                                    “Digest” collapses everything from one check into a single alert — good for busy
                                    feeds.
                                </div>
                            </div>
                            <select
                                className="opt-select"
                                value={notifyMode}
                                onChange={e => changeNotifyMode(e.target.value as 'each' | 'summary')}
                            >
                                <option value="each">One per removal</option>
                                <option value="summary">Digest per check</option>
                            </select>
                        </div>
                    </div>

                    <div className="opt-save-row">
                        <button className="opt-save" onClick={saveChanges}>
                            Save changes
                        </button>
                        {saved ? <span className="opt-saved">✓ Saved</span> : null}
                    </div>

                    <div className="opt-about">
                        <span className="opt-ver">v{__VERSION__}</span>
                        <span className="opt-about-txt">
                            Monitors removals, recovers your text, audits the public view.
                        </span>
                    </div>
                </div>
            </div>
        </div>
    )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<OptionsPage />)
