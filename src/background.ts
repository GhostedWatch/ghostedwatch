import { APP_NAME } from './src/constants'
import { ALARM_NAME, setAlarm, setUnseenBadge, createNotification, createTab, permalink } from './src/common'
import { runCycle } from './src/poller'
import { runOtherCycle, runSourceCycle, watchOtherFromPage } from './src/other'
import {
    getOptions,
    addOwnItem,
    removeOtherItem,
    setWatchComments,
    getOtherIds,
    addSource,
    removeSource,
    getSourceKeys,
    setAuth,
    getAuth,
    getUnseenCount,
    getRemoved,
    markAllRemovedSeen,
    setNotifTargets,
    getNotifTargets,
    getLastOrigin,
    setLastAlarm,
    getLastAlarm,
    INTERVAL_DEFAULT,
    type Auth,
    type OwnItem,
    type OtherItem,
} from './src/storage'

const WIN_TABS = ['https://*.scored.co/*', 'https://*.patriots.win/*', 'https://*.communities.win/*']

// Run one detection cycle (guarded against overlap), notify + refresh on results.
let cycling = false
async function cycle() {
    if (cycling) return
    cycling = true
    try {
        // your own content, then others' you're watching (anonymously, from here):
        // individual posts/comments + whole posts, then whole users / community feeds
        const own = await runCycle()
        const origin = await getLastOrigin()
        const o1 = await runOtherCycle(origin)
        const o2 = await runSourceCycle(origin)
        await notifyCycle({
            ownRemoved: own?.removed || [],
            ownReapproved: own?.reapproved || [],
            backfill: own?.backfill || false,
            otherRemoved: [...o1.removed, ...o2.removed],
            otherReapproved: [...o1.reapproved, ...o2.reapproved],
        })
        setUnseenBadge(await getUnseenCount())
        refreshOpenTabs()
    } finally {
        cycling = false
    }
}

interface NotifItem {
    uuid: string
    post_uuid: string
    type: 'post' | 'comment'
}

interface CycleEvents {
    ownRemoved: OwnItem[]
    ownReapproved: OwnItem[]
    backfill: boolean
    otherRemoved: OtherItem[]
    otherReapproved: OtherItem[]
}

// Fire notifications for a cycle's events, honoring the notifyMode option: 'each'
// (a notification per group) or 'summary' (a single digest).
async function notifyCycle(e: CycleEvents): Promise<void> {
    if ((await getOptions()).notifyMode === 'summary') {
        notifySummary(e)
        return
    }
    if (e.ownRemoved.length) notifyRemovals(e.ownRemoved, e.backfill)
    if (e.ownReapproved.length) notifyReapprovals(e.ownReapproved)
    if (e.otherRemoved.length) notifyOtherRemovals(e.otherRemoved)
    if (e.otherReapproved.length) notifyOtherReapprovals(e.otherReapproved)
}

function notifySummary(e: CycleEvents): void {
    const removedItems = [...e.ownRemoved, ...e.otherRemoved]
    const reappItems = [...e.ownReapproved, ...e.otherReapproved]
    if (removedItems.length + reappItems.length === 0) return
    const parts: string[] = []
    if (removedItems.length) parts.push(`${removedItems.length} removed`)
    if (reappItems.length) parts.push(`${reappItems.length} re-approved`)
    const yours = e.ownRemoved.length + e.ownReapproved.length
    const watched = e.otherRemoved.length + e.otherReapproved.length
    const detail = [yours ? `${yours} yours` : '', watched ? `${watched} watched` : ''].filter(Boolean).join(', ')
    const targets: NotifItem[] = [...removedItems, ...reappItems].map(w => ({
        uuid: w.uuid,
        post_uuid: w.post_uuid,
        type: w.type,
    }))
    fireNotification(`summary-${Date.now()}`, APP_NAME, `${parts.join(' · ')} — ${detail}`, targets)
}

// "posts" / "comments" / "posts/comments" depending on the mix.
function pluralNoun(items: NotifItem[]): string {
    return items.every(r => r.type === 'post')
        ? 'posts'
        : items.every(r => r.type === 'comment')
          ? 'comments'
          : 'posts/comments'
}

// Fire one notification and record what clicking it should open.
function fireNotification(notifId: string, title: string, body: string, items: NotifItem[]) {
    createNotification({ notificationId: notifId, title, message: body })
    setNotifTargets(
        notifId,
        items.map(r => ({ uuid: r.uuid, post_uuid: r.post_uuid, type: r.type })),
    )
}

function notifyRemovals(removed: OwnItem[], backfill: boolean) {
    const count = removed.length
    const noun = pluralNoun(removed)
    let title = APP_NAME
    let body: string
    if (backfill) body = `Found ${count} of your ${noun} removed.`
    else if (count === 1) {
        title = `Your ${removed[0].type} was removed`
        body = `In c/${removed[0].community}. Click the extension to view it.`
    } else body = `${count} of your ${noun} were removed.`
    fireNotification(backfill ? 'backfill-summary' : `removed-${Date.now()}`, title, body, removed)
}

function notifyReapprovals(reapproved: OwnItem[]) {
    const count = reapproved.length
    let title = APP_NAME
    let body: string
    if (count === 1) {
        title = `Your ${reapproved[0].type} was re-approved`
        body = `In c/${reapproved[0].community}. It's visible to others again.`
    } else body = `${count} of your ${pluralNoun(reapproved)} were re-approved.`
    fireNotification(`reapproved-${Date.now()}`, title, body, reapproved)
}

// Watched items (other users' posts/comments) get their own, clearly-attributed copy.
function otherTargets(items: OtherItem[]): NotifItem[] {
    return items.map(w => ({ uuid: w.uuid, post_uuid: w.post_uuid, type: w.type }))
}
function notifyOtherRemovals(removed: OtherItem[]) {
    const count = removed.length
    let title = APP_NAME
    const body =
        count === 1
            ? `A ${removed[0].type} you're watching (by ${removed[0].author}) was removed in c/${removed[0].community}.`
            : `${count} items you're watching were removed.`
    if (count === 1) title = `Watched ${removed[0].type} removed`
    fireNotification(`watched-removed-${Date.now()}`, title, body, otherTargets(removed))
}
function notifyOtherReapprovals(reapproved: OtherItem[]) {
    const count = reapproved.length
    let title = APP_NAME
    const body =
        count === 1
            ? `A ${reapproved[0].type} you're watching (by ${reapproved[0].author}) is visible again in c/${reapproved[0].community}.`
            : `${count} items you're watching were re-approved.`
    if (count === 1) title = `Watched ${reapproved[0].type} re-approved`
    fireNotification(`watched-reapproved-${Date.now()}`, title, body, otherTargets(reapproved))
}

// Tell any open .win tabs to repaint highlights from the updated store.
function refreshOpenTabs() {
    chrome.tabs.query({ url: WIN_TABS }, tabs => {
        for (const t of tabs) if (t.id != null) chrome.tabs.sendMessage(t.id, { action: 'refresh' }).catch(() => {})
    })
}

async function init() {
    const options = await getOptions()
    setAlarm(options.interval || INTERVAL_DEFAULT)
    setUnseenBadge(await getUnseenCount())
}

// On install/update the content script isn't in already-open .win tabs yet, so
// inject it now (they capture the session and send set-auth). Returns how many.
async function injectIntoOpenTabs(): Promise<number> {
    if (!chrome.scripting?.executeScript) return 0 // MV3 only; Firefox MV2 waits for navigation
    const tabs = await chrome.tabs.query({ url: WIN_TABS })
    const open = tabs.filter(t => t.id != null)
    for (const t of open) {
        chrome.scripting.executeScript({ target: { tabId: t.id! }, files: ['src/content.js'] }).catch(() => {})
    }
    return open.length
}

chrome.runtime.onInstalled.addListener(async details => {
    await init()
    const injected = await injectIntoOpenTabs() // connect via any already-open .win tab
    if (await getAuth()) {
        cycle() // session already captured — check right away
    } else if (details.reason === 'install' && injected === 0) {
        // first install, nothing to connect through yet — onboard the user
        chrome.tabs.create({ url: chrome.runtime.getURL('src/welcome.html') })
    }
})
chrome.runtime.onStartup.addListener(() => {
    init()
    cycle()
})

// Reliability: chrome.alarms persists across service-worker eviction, but ensure it
// exists whenever the worker spins back up.
chrome.alarms.get(ALARM_NAME).then(a => {
    if (!a) getOptions().then(o => setAlarm(o.interval || INTERVAL_DEFAULT))
})

// Alarm watchdog (cf. reveddit real-time): MV3 alarms can silently stop firing
// (crbug 1316588). While the worker is alive, re-create the alarm if it goes quiet.
async function alarmWatchdog() {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        await new Promise(r => setTimeout(r, 65000))
        if (Date.now() - (await getLastAlarm()) > 130000) {
            const o = await getOptions()
            setAlarm(o.interval || INTERVAL_DEFAULT)
        }
    }
}
alarmWatchdog()

chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM_NAME) {
        setLastAlarm(Date.now()) // watchdog heartbeat
        cycle()
    }
})

// Clicking a notification opens the right place: one item → that item; several in
// one thread → the thread; several across threads → the extension history page.
chrome.notifications.onClicked.addListener(async notifId => {
    const targets = await getNotifTargets(notifId)
    const origin = await getLastOrigin()
    let url: string
    if (targets.length === 1) {
        url = permalink(targets[0].post_uuid, targets[0].uuid, targets[0].type, origin)
    } else if (targets.length > 1 && targets.every(t => t.post_uuid === targets[0].post_uuid)) {
        url = `${origin}/p/${targets[0].post_uuid}/`
    } else {
        url = chrome.runtime.getURL('src/history.html')
    }
    createTab(url)
    chrome.notifications.clear(notifId)
    await markAllRemovedSeen()
    setUnseenBadge(0)
})

chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.options) {
        const interval = (changes.options.newValue as { interval?: number })?.interval || INTERVAL_DEFAULT
        setAlarm(interval)
    }
})

type Message =
    | {
          action: 'watch-own'
          comment: Pick<
              OwnItem,
              'id' | 'uuid' | 'type' | 'title' | 'post_id' | 'post_uuid' | 'community' | 'created' | 'text'
          >
      }
    | {
          // the page sends only the ids; the background enriches author/title/text
          // from the public thread via watchOtherFromPage
          action: 'watch-other'
          item: Pick<OtherItem, 'id' | 'uuid' | 'type' | 'post_id' | 'post_uuid'> & { watch_comments?: boolean }
      }
    | { action: 'unwatch-other'; id: number }
    | { action: 'set-watch-comments'; id: number; watch_comments: boolean }
    | { action: 'watch-source'; kind: 'user' | 'feed'; name: string }
    | { action: 'unwatch-source'; key: string }
    | { action: 'list-other' }
    | { action: 'set-auth'; auth: Auth }
    | { action: 'check-now' }
    | { action: 'mark-seen' }
    | { action: 'open-options' }
    | { action: 'get-auth-status' }
    | { action: 'reconnect' }
    | { action: 'list-removed' }

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
    switch (message.action) {
        case 'watch-own':
            addOwnItem(message.comment).then(() => {
                sendResponse({ ok: true })
                setTimeout(cycle, 4000) // give the server a moment, then detect the new item
            })
            return true
        case 'watch-other':
            getLastOrigin()
                .then(origin => watchOtherFromPage(origin, message.item))
                .then(() => sendResponse({ ok: true }))
            return true
        case 'unwatch-other':
            removeOtherItem(message.id).then(() => sendResponse({ ok: true }))
            return true
        case 'set-watch-comments':
            setWatchComments(message.id, message.watch_comments).then(() => {
                sendResponse({ ok: true })
                if (message.watch_comments) setTimeout(cycle, 1500) // pick up the comments soon
            })
            return true
        case 'watch-source':
            addSource(message.kind, message.name).then(() => {
                sendResponse({ ok: true })
                cycle() // poll the new source right away
            })
            return true
        case 'unwatch-source':
            removeSource(message.key).then(() => sendResponse({ ok: true }))
            return true
        case 'list-other':
            Promise.all([getOtherIds(), getSourceKeys()]).then(([ids, sources]) => sendResponse({ ids, sources }))
            return true
        case 'set-auth':
            setAuth(message.auth).then(() => {
                sendResponse({ ok: true })
                cycle() // we can now poll without a tab
            })
            return true
        case 'check-now':
            cycle()
            sendResponse({ ok: true })
            return true
        case 'mark-seen':
            markAllRemovedSeen().then(() => {
                setUnseenBadge(0)
                sendResponse({ ok: true })
            })
            return true
        case 'open-options':
            chrome.runtime.openOptionsPage()
            sendResponse({ ok: true })
            return true
        case 'get-auth-status':
            getAuth().then(a => sendResponse({ connected: !!a, user: a?.user || '' }))
            return true
        case 'reconnect':
            // Re-capture the session: nudge any open .win tab to re-send its tokens;
            // if none is open, open patriots.win so the user can connect.
            chrome.tabs.query({ url: WIN_TABS }, tabs => {
                const open = tabs.filter(t => t.id != null)
                for (const t of open) chrome.tabs.sendMessage(t.id!, { action: 'send-auth-now' }).catch(() => {})
                if (open.length === 0) chrome.tabs.create({ url: 'https://patriots.win/' })
                sendResponse({ ok: true, hadOpenTab: open.length > 0 })
            })
            return true
        case 'list-removed':
            getRemoved().then(map =>
                sendResponse({
                    // re-approved items are no longer removed → don't highlight them
                    removed: Object.values(map)
                        .filter(r => !r.reapproved_utc)
                        .map(r => ({
                            id: r.id,
                            uuid: r.uuid,
                            type: r.type,
                            community: r.community,
                            removal_source: r.removal_source,
                            hidden: r.hidden,
                            // the recovered original text, so the page can show it back
                            text: r.text,
                            title: r.title,
                        })),
                }),
            )
            return true
        default:
            return false
    }
})
