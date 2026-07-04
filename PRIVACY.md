# Privacy

GhostedWatch is built to keep everything on your own machine.

## What it accesses

- **Only your own content.** It reads your posts/comments from the site's own
  `content/profile.json` (the same data the site shows on your profile) to detect
  removals, and the public view of a removed item to confirm what others see.
- **Your session, your requests.** All API calls are the same ones the site itself
  makes, from your own logged-in browser. The extension adds no third-party servers.

## What it stores — locally only

- Tracked posts/comments, detected removals (with the text you authored), recent
  changes, your username, and settings.
- Stored via `chrome.storage` (local + sync). `sync` data is handled by your
  browser's own account sync; nothing is sent to the extension's authors.

## What it does NOT do

- No analytics, no telemetry, no tracking, no ads.
- No external/third-party network requests. It talks only to the .win site you're
  already using.
- It never sends your content, credentials, or browsing anywhere off your machine.
- It performs no writes on the site (no posting, voting, editing on your behalf).

## Permissions, and why

- `notifications` — to tell you when your content is removed.
- `alarms` — to schedule periodic checks.
- `storage` — to remember what it's watching and what it found.
- host access to the .win community sites (`*.scored.co`, `*.patriots.win`,
  `*.communities.win`, `*.kotakuinaction2.win`, `*.greatawakening.win`,
  `*.conspiracies.win`, `*.omegacanada.win`) — to read your content and
  highlight removals on those pages.

## Removing your data

Removing the extension deletes its local storage. You can also clear it from the
browser's extension settings at any time.
