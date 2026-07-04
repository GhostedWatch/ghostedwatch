import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { getAuth } from './storage'
import { APP_NAME } from './constants'

function Welcome() {
    const [connected, setConnected] = useState(false)

    useEffect(() => {
        const check = () => getAuth().then(a => setConnected(!!a))
        check()
        const id = setInterval(check, 2000) // flips to connected once you open + log into a .win tab
        return () => clearInterval(id)
    }, [])

    return (
        <div style={{ maxWidth: 560, margin: '0 auto', padding: '8px 4px' }}>
            <h1>{APP_NAME}</h1>
            <p>
                It watches <strong>your own</strong> posts and comments on the .win communities (patriots.win,
                scored.co, kotakuinaction2.win, and the other dedicated community domains) and tells you when one is
                removed — including the kind where you still see your content but everyone else sees a "removed by
                community filter" placeholder.
            </p>

            <h2>Connect your account</h2>
            <p className="muted">
                Open and log into the site once so the extension can check your content (it then keeps watching even
                with no tab open). It only reads your own content and never posts or votes for you.
            </p>
            <div className="row">
                <a href="https://patriots.win/" target="_blank" rel="noreferrer">
                    <button>Open patriots.win</button>
                </a>
                <a href="https://scored.co/" target="_blank" rel="noreferrer">
                    <button>Open scored.co</button>
                </a>
            </div>

            <div className="result" style={{ marginTop: 16 }}>
                {connected ? (
                    <>
                        <strong>✓ Connected.</strong> {APP_NAME} is now watching your posts &amp; comments.
                    </>
                ) : (
                    <>Waiting for a logged-in .win tab… (open one of the links above and log in)</>
                )}
            </div>
        </div>
    )
}

const root = document.getElementById('root')
if (root) createRoot(root).render(<Welcome />)
