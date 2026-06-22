import React from 'react'
import { GHOST_PATH, GHOST_ACCENT } from './constants'

// The brand ghost, matching the in-page Watch button. Use this instead of the 👻
// emoji (which renders as a different, system-specific glyph) so the icon is
// consistent everywhere.
export function Ghost({ size = 14 }: { size?: number }) {
    return (
        <svg
            viewBox="0 0 24 24"
            width={size}
            height={size}
            aria-hidden="true"
            style={{ verticalAlign: '-0.15em', flex: 'none' }}
        >
            <path fill={GHOST_ACCENT} d={GHOST_PATH} />
            <circle cx="9.3" cy="10.6" r="1.45" fill="#fff" />
            <circle cx="14.7" cy="10.6" r="1.45" fill="#fff" />
        </svg>
    )
}

// The product mark — the fatter "eyeup2" ghost with one raised eye, matching the
// toolbar icon. Used in the popup/options headers.
export function EyeMark({ size = 22 }: { size?: number }) {
    return (
        <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" style={{ flex: 'none' }}>
            <g transform="translate(12 12) scale(1.32 1.12) translate(-12 -12)">
                <path fill={GHOST_ACCENT} d={GHOST_PATH} />
            </g>
            <circle cx="12" cy="7.8" r="4.7" fill="#fff" />
            <circle cx="12" cy="7.8" r="2.5" fill="#15151a" />
            <circle cx="13.25" cy="6.55" r="0.85" fill="#fff" />
        </svg>
    )
}
