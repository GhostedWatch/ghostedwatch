# GhostedWatch

Reveddit-style browser extension for the .win sites
(patriots.win / scored.co / communities.win — same backend, different aliases).
It watches **your own** posts and comments and notifies you when one is removed or
**shadow-removed**, and lets you see whether your content is being hidden from
other users.

## How it works

Detection runs in the **background service worker**, so it keeps working with no
.win tab open (like reveddit real-time). The content script's only jobs are to
capture your session and paint in-page highlights — all polling/detection is in the
background.

- **Session capture (content script).** The site keeps per-user API tokens in
  `localStorage`; sent as `X-Api-Key` / `X-Api-Secret` headers, they authenticate
  independently of cookies. The content script reads them, resolves your username
  (`user/about.json?user=me`), and hands `{user, origin, apiKey, apiSecret}` to the
  background. It re-captures on every page load so the session stays fresh.
- **Polling (background).** Using those tokens the background polls your own
  **`content/profile.json`** (authenticated) — one call returns your recent posts
  and comments with `is_removed` / `removal_source` flags. The service worker has
  host permissions, so it makes these cross-origin calls itself, with no tab open.
  On first run it pages through your whole history once (bounded to ~500 items,
  ~0.8s between pages) to find existing removals — recorded **without** per-item
  notifications, summarized as a single "found N removed" notice. After that,
  ongoing checks fetch the first page each minute (~1 request; a page is 25 items,
  about a day for an active poster), and every 6 hours the next three pages too, so
  a removal or re-approval of something that has slid off page 1 is still caught.
  Those pages are read too rarely for the usual two sightings: one confirms there,
  and the record is marked like a history-scan find, so timings leave it out. A
  `chrome.alarms` timer (with a watchdog) drives the cycle.
- **Confirm + notify.** Each observation is folded into stored state; after two
  sightings in a row on page 1 (one on the pages read every 6 hours) a removal is
  recorded, a notification fires, and the badge updates (each id notifies at most
  once, ever).
- **Recovering your text.** A removed item's **list entry appears immediately** (its
  permalink is built from the uuid — no lookup needed). The **text** fills in right
  after:
  - posts/comments you made while installed already have their text, captured from
    the page's own `create_comment` / `create_post` traffic — shown instantly;
  - for backlog removals the background recovers your own copy via the ordinary
    `comment/thread?id=…` endpoint (authenticated with your tokens — the same call
    the site uses to render any permalink, verified to return a removed comment's
    content to its author). Until it arrives the popup shows a "loading…" indicator.

**Public-view audit**: for each removed comment or post, the background also fetches
the logged-out view (the same `comment/thread` / `post.json` endpoints, but
*without* tokens) and compares it to your authored view. This (a) corroborates the
removal independently of the `is_removed` flag, (b) corrects false positives — if
the public still shows your content, the record is dropped — and (c) classifies the
removal as a visible placeholder vs. *hidden from others entirely*.

**Posts too**: the profile feed carries the same removal fields for your posts, so
removed posts are detected, listed, notified and highlighted exactly like comments
(a removed post shows you its title; the public sees it blanked). Highlighting marks
the `post` block; comments mark the `comment` block.

**In-thread highlighting (content script)**: on .win pages (threads *and* your user
page, on both patriots.win and scored.co), the content script outlines any of your
own posts/comments it knows are removed and adds a small attributed banner — an
extension tag (click → options) and a removal-source pill ("community filter" /
"moderator" / …, with a tooltip), plus a "hidden from others" pill when the audit
found the public can't see it at all. A `MutationObserver` re-marks items loaded
later (SPA navigation, "load more").

**Problem reports**: the background keeps a diagnostic log of its checks
(`diaglog.ts`): which requests went out and how they failed, the session check,
removals and re-approvals by item id, installs, updates and option changes. A quiet
hour of checks is one line, so the log holds about a week. It never holds the
username, tokens, post text, or who and what is watched. "Report a problem" in the
popup (or on the Help page) opens ghostedwatch.com/feedback.html with the version,
a status summary and the log in the link's `#fragment`, which never goes to the
server; nothing is sent until the person presses Send (`report.ts`). There they can
send it privately (stored by the site and filed as an issue in a private repo) or
post it as a public issue here, from `.github/ISSUE_TEMPLATE/problem.yml`, with the
item ids hidden.

The extension only ever reads your own session's normal endpoints and stores text
you authored — **no undocumented content-recovery endpoint**. Default poll interval
is 1 minute (one bulk request per check).

See `src/background.ts` (service-worker orchestration), `src/src/poller.ts` (the
detection cycle), `monitoring.ts` (removal transition logic + recording),
`win-api.ts` (id↔uuid encoding, profile normalization, public-view classifier),
`content.ts` / `inject.ts` (session + post capture, highlighting), `diaglog.ts` /
`report.ts` (the log and problem reports), and `storage.ts`.

## Develop

This project uses **Yarn 4** (vendored at `.yarn/releases/`), matching the
reveddit website/extension. The supply-chain settings in `.yarnrc.yml` are
intentional: `npmMinimalAgeGate: 7d` (refuse packages younger than 7 days),
`enableScripts: false` (no dependency install scripts run), and
`checksumBehavior: throw`. Dependency versions are pinned to releases at least 30
days old.

```bash
yarn install         # respects the 7-day age gate, runs no install scripts
yarn typecheck
yarn test            # vitest: id<->uuid encoding, profile normalization, removal-detection
                     #   threshold, notify-once orchestration, url parsing, public-view classifier
yarn build-chrome    # PROD -> dist-chrome/ and chrome.zip
yarn build-firefox   # PROD -> dist-firefox/ and firefox.zip  (manifest rewritten to MV2)
yarn build-chrome-dev   # DEV -> dist-chrome-dev/   (debug breadcrumbs, inline maps)
yarn build-firefox-dev  # DEV -> dist-firefox-dev/  — dev and prod never share a dir,
                        #   so a dev build can't be shipped by mistake
yarn test:e2e        # Playwright: loads the real built extension in Chromium and
                     #   checks the popup/options/history pages. Runs headless (no
                     #   window); WIN_E2E_HEADED=1 shows the browser. Live-site runs
                     #   (WIN_E2E_LIVE / WIN_E2E_NET) stay headed. Other runs can't
                     #   reach the real sites: their hosts don't resolve, and pages
                     #   come from routed fakes.
                     #   First time: `yarn playwright install chromium`.
yarn e2e:login       # one-time: opens Chromium with the extension + a persistent
                     #   profile; log in by hand, press Enter to save the session.
                     #   Then: WIN_E2E_LIVE=1 yarn test:e2e   (runs logged-in tests)
yarn test:firefox    # headless-Firefox smoke test over Marionette: installs the
                     #   built dist-firefox as a temporary add-on and asserts the
                     #   whole pipeline (background, alarm, content script on the
                     #   live site, messaging, popup, auth). With WIN_USER/WIN_PASS
                     #   in .env it also does a REAL login and asserts live session
                     #   capture. Build with build-firefox-dev first (dev builds
                     #   carry the data-gw-* breadcrumbs the test reads).
yarn test:api        # live, no login: checks that the site's API still has the
                     #   fields the extension reads (6 GETs, 1 s apart). Exit 0 =
                     #   as expected, 1 = changed, 2 = no answer. For a daily
                     #   schedule and before each release.
```

Load unpacked (dev builds): Chrome → `chrome://extensions` → Developer mode → Load
unpacked → `dist-chrome-dev/`. Firefox → `about:debugging` → Load Temporary Add-on →
any file in `dist-firefox-dev/`.

## Release

One-time setup: fill the publishing block in `.env` (see `.env.example` — the
variable names match the reveddit real-time extension, so account-level values
copy over; only `CHROME_EXTENSION_ID` is per-extension). Credentials guides:
Chrome OAuth client —
https://github.com/fregante/chrome-webstore-upload/blob/main/How%20to%20generate%20Google%20API%20keys.md;
AMO keys — https://addons.mozilla.org/developers/addon/api/key/.

```bash
yarn publish:all           # checks → preflight → Chrome (waits for you) → Firefox
                           #   (only waits on AMO); a rerun publishes only to the
                           #   stores still missing this version
yarn publish:chrome        # CWS: fresh prod build → upload zip → pauses while you
                           #   paste the description (the CWS API can't update listing
                           #   text; it's copied to your clipboard + the dashboard
                           #   opens) → publish. Expired refresh token? It offers
                           #   `yarn refresh:chrome` (localhost OAuth flow that
                           #   rewrites .env) and retries.
yarn publish:firefox       # AMO: fresh prod build → source.zip (git archive of the
                           #   built commit) → web-ext sign (listed; returns once AMO
                           #   has the version, without waiting for approval) →
                           #   updates the store description through the AMO API.
yarn publish:firefox:text  # only push STORE_DESCRIPTION.txt to the AMO listing
```

`preflight` (run by every publish command) is typecheck + unit tests + Chromium
e2e against the dev build + the headless-Firefox live probe (`test:firefox`).
Once it passes, the same code skips it for 24 hours (the key hashes every
tracked or untracked-but-not-ignored file plus the test settings), so retrying
a publish that failed for another reason starts right away;
`PREFLIGHT_FORCE=1` runs it anyway.

A store that fails doesn't stop the other. Each store that takes the current
version is recorded in `.publish-status.json` (gitignored), so after fixing a
failure (an expired token, say), run `yarn publish:all` again: it publishes only
to the stores still missing this version. `publish:chrome` and `publish:firefox`
record their store the same way. Every publish refuses uncommitted or untracked
changes to the extension's files (everything but tests, scripts, docs and repo
config), so each store's version is a commit, and refuses to give a store
other code under a version another store already has: bump the version instead.
If a Firefox run stopped after AMO took the version, the rerun's "already exists"
counts as published when every earlier submission of that version was this code;
`PUBLISH_FIREFOX_ACCEPT_EXISTING=1` accepts it otherwise.

Dev builds go to `dist-*-dev/`, prod to `dist-*/` — and the publish scripts each
rebuild their production artifact right before uploading, so nothing stale (or
dev) can end up in a store submission.

Both flows refuse to run if `STORE_DESCRIPTION.txt` has no entry for the current
manifest version. AMO requires human-readable source for webpack-bundled
submissions — reviewers rebuild with the steps in **Develop** above (Node 20,
`yarn install`, `yarn build-firefox`).

CI alternative: tag `v<version>` (must equal `src/manifest.json` version) and push —
`release.yml` builds, publishes both stores (secrets: `CWS_*`, `AMO_JWT_*`), and
attaches the zips to the GitHub release. Interactive steps are skipped in CI, so
verify the Chrome listing description in the dashboard after a tagged release.

## Verified against live data (throwaway test account)

- `removal_source: communityFilter` / `communityFilterPending` = automatic filter
  removal; `moderator` / `nuke` = manual. The auto-filter targets certain slurs and
  terms; new accounts (`is_new_user: true`) also get held.
- A community-filtered comment is **present** in the anonymous thread with
  `is_removed: true` and empty content (shown to others as "removed by community
  filter") → classified `publicly_removed`.
- Author content recovery: `comment/profile.json` blanks the content even for the
  author, but **`comment/thread?id=…` (authenticated with your API tokens) returns
  the author's `raw_content`** — this is what backlog recovery uses.

## Known open items

- Backlog recovery + polling fetch `${origin}/api/v2/...` from the background with
  your `X-Api-Key` / `X-Api-Secret` tokens; verified against patriots.win — confirm
  scored.co / communities.win serve `/api/v2` on their own origin under header-token
  auth too (the service worker's host permissions cover all three).
- Removal detection trusts `content/profile.json`'s `is_removed` flag, and also
  treats a comment whose content the feed has blanked (once we'd seen its text) as
  removed, so it survives the site dropping/renaming that flag. The per-item
  public-view audit runs only on already-flagged removals (to confirm + classify),
  not as a primary detector — if the feed ever stopped exposing removal state at
  all, detection would need to fall back to auditing every tracked item.
- Page-size params are ignored by the API (fixed 25/page); pagination uses the
  verified `&post=N&comment=M` running-count cursor.
