import React, { useRef } from 'react'

// A custom tooltip for the extension's React pages, matching the in-page highlight
// tooltip (white-on-black, appears instantly — not the slow, low-contrast native
// `title`). One shared element is appended to <body> and positioned with viewport
// coordinates, so it never gets clipped by the popup's bounds.
let tip: HTMLDivElement | null = null
function ensureTip(): HTMLDivElement {
    if (!tip) {
        tip = document.createElement('div')
        tip.className = 'gw-tooltip'
        document.body.appendChild(tip)
    }
    return tip
}

export function Tooltip({ text, children }: { text: string; children: React.ReactNode }) {
    const ref = useRef<HTMLSpanElement>(null)
    const show = () => {
        const el = ref.current
        if (!el) return
        const t = ensureTip()
        t.textContent = text
        t.style.display = 'block'
        const r = el.getBoundingClientRect()
        // place above the anchor, flipping below if that would clip the top edge,
        // and clamp horizontally so it stays within the viewport
        const above = r.top - t.offsetHeight - 6
        const left = Math.max(4, Math.min(r.left, window.innerWidth - t.offsetWidth - 4))
        t.style.left = `${left}px`
        t.style.top = `${above >= 4 ? above : r.bottom + 6}px`
    }
    const hide = () => {
        if (tip) tip.style.display = 'none'
    }
    return (
        <span ref={ref} className="gw-tip-anchor" onMouseEnter={show} onMouseLeave={hide}>
            {children}
        </span>
    )
}
