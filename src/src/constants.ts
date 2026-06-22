// Shared brand/namespace constants (no dependencies, importable from any context).

// Display name.
export const APP_NAME = 'GhostedWatch'

// Prefix for everything we inject into site pages (CSS classes, data attributes),
// kept distinctive to avoid colliding with the site's own classes.
export const NS = 'ghostedwatch'

// window.postMessage "source" tag between the page-context inject script and the
// content script.
export const MSG_SOURCE = 'GHOSTEDWATCH'

// The brand ghost silhouette (viewBox 0 0 24 24) — one source of truth for the
// in-page Watch button, the extension pages, and the icon.
export const GHOST_PATH =
    'M12 1.5c-4.7 0-8 3.6-8 8.6v10.1c0 .85.98 1.3 1.6.74l1.75-1.57 1.95 1.75c.4.36 1.01.36 1.4 0l1.75-1.57 1.75 1.57c.4.36 1.01.36 1.4 0l1.95-1.75 1.75 1.57c.62.56 1.6.11 1.6-.74V10.1c0-5-3.3-8.6-8-8.6z'
export const GHOST_ACCENT = '#d93a00'
