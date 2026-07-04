// Shared brand/namespace constants (no dependencies, importable from any context).

// Display name.
export const APP_NAME = 'GhostedWatch'

// Prefix for everything we inject into site pages (CSS classes, data attributes),
// kept distinctive to avoid colliding with the site's own classes.
export const NS = 'ghostedwatch'

// window.postMessage "source" tag between the page-context inject script and the
// content script.
export const MSG_SOURCE = 'GHOSTEDWATCH'

// The scored.co platform's community frontends — the canonical set, taken from the
// site's own JS bundle. communities.win redirects to scored.co but stays listed as
// free dormant coverage. MUST stay in sync with the matches in src/manifest.json
// (host_permissions, content_scripts, web_accessible_resources — the manifest is
// static JSON and can't import this).
export const WIN_DOMAINS = [
    'scored.co',
    'patriots.win',
    'communities.win',
    'kotakuinaction2.win',
    'greatawakening.win',
    'conspiracies.win',
    'omegacanada.win',
]

// Match patterns for tabs.query / injection, covering each domain + subdomains
// (the `m.` mobile frontends included).
export const WIN_TAB_PATTERNS = WIN_DOMAINS.map(d => `https://*.${d}/*`)

// A dedicated domain's front page is its home community's feed (scored.co and
// communities.win are multi-community hubs, so they have no single home feed).
export const HOME_COMMUNITY: Record<string, string> = {
    'patriots.win': 'TheDonald',
    'kotakuinaction2.win': 'KotakuInAction2',
    'greatawakening.win': 'GreatAwakening',
    'conspiracies.win': 'Conspiracies',
    'omegacanada.win': 'OmegaCanada',
}

// The domain (from WIN_DOMAINS) that `host` belongs to, or null.
export function winDomainOf(host: string): string | null {
    return WIN_DOMAINS.find(d => host === d || host.endsWith('.' + d)) || null
}

// The brand ghost silhouette (viewBox 0 0 24 24) — one source of truth for the
// in-page Watch button, the extension pages, and the icon.
export const GHOST_PATH =
    'M12 1.5c-4.7 0-8 3.6-8 8.6v10.1c0 .85.98 1.3 1.6.74l1.75-1.57 1.95 1.75c.4.36 1.01.36 1.4 0l1.75-1.57 1.75 1.57c.4.36 1.01.36 1.4 0l1.95-1.75 1.75 1.57c.62.56 1.6.11 1.6-.74V10.1c0-5-3.3-8.6-8-8.6z'
export const GHOST_ACCENT = '#d93a00'
