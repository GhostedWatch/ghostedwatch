import { APP_NAME, WIN_TAB_PATTERNS } from './src/constants'
import { ALARM_NAME, setAlarm, setUnseenBadge, createNotification, createTab, permalink } from './src/common'
import api from './src/api'
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

const WIN_TABS = WIN_TAB_PATTERNS

// Dev-build breadcrumbs, mirrored by the content script's (see content.ts).
const dlog = (...args: unknown[]) => { if (__DEV__) console.log('[GhostedWatch bg]', ...args) }

let cycling = false
async function cycle() {
    if (cycling) return
    cycling = true
    try {
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

function pluralNoun(items: NotifItem[]): string {
    return items.every(r => r.type === 'post')
        ? 'posts'
        : items.every(r => r.type === 'comment')
          ? 'comments'
          : 'posts/comments'
}

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

async function refreshOpenTabs() {
    const tabs = await api.tabs.query({ url: WIN_TABS })
    for (const t of tabs) if (t.id != null) api.tabs.sendMessage(t.id, { action: 'refresh' }).catch(() => {})
}

async function init() {
    const options = await getOptions()
    setAlarm(options.interval || INTERVAL_DEFAULT)
    setUnseenBadge(await getUnseenCount())
}

async function injectIntoOpenTabs(): Promise<number> {
    try {
        if (!api.scripting?.executeScript) return 0
        const tabs = await api.tabs.query({ url: WIN_TABS })
        const open = tabs.filter(t => t.id != null)
        for (const t of open) {
            try { await api.scripting.executeScript({ target: { tabId: t.id! }, files: ['src/content.js'] }) } catch {}
        }
        return open.length
    } catch {
        return 0
    }
}

api.runtime.onInstalled.addListener(async (details: chrome.runtime.InstalledDetails) => {
    dlog('onInstalled:', details.reason)
    await init()
    const injected = await injectIntoOpenTabs()
    dlog('injected content script into', injected, 'open .win tab(s)')
    if (await getAuth()) {
        dlog('auth already stored — starting cycle')
        cycle()
    } else if (details.reason === 'install' && injected === 0) {
        api.tabs.create({ url: 'https://patriots.win/' })
    }
})
api.runtime.onStartup.addListener(() => {
    init()
    cycle()
})

api.alarms.get(ALARM_NAME).then(a => {
    if (!a) getOptions().then(o => setAlarm(o.interval || INTERVAL_DEFAULT))
})

injectIntoOpenTabs()

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

api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM_NAME) {
        dlog('alarm fired — running cycle')
        setLastAlarm(Date.now())
        cycle()
    }
})

api.notifications.onClicked.addListener(async (notifId: string) => {
    const targets = await getNotifTargets(notifId)
    const origin = await getLastOrigin()
    let url: string
    if (targets.length === 1) {
        url = permalink(targets[0].post_uuid, targets[0].uuid, targets[0].type, origin)
    } else if (targets.length > 1 && targets.every(t => t.post_uuid === targets[0].post_uuid)) {
        url = `${origin}/p/${targets[0].post_uuid}/`
    } else {
        url = api.runtime.getURL('src/history.html')
    }
    createTab(url)
    api.notifications.clear(notifId)
    await markAllRemovedSeen()
    setUnseenBadge(0)
})

api.storage.onChanged.addListener((changes: Record<string, chrome.storage.StorageChange>, area: string) => {
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

api.runtime.onMessage.addListener((message: Message, _sender: chrome.runtime.MessageSender, sendResponse: (response?: any) => void) => {
    dlog('message received:', message.action)
    switch (message.action) {
        case 'watch-own':
            addOwnItem(message.comment).then(() => {
                sendResponse({ ok: true })
                setTimeout(cycle, 4000)
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
                if (message.watch_comments) setTimeout(cycle, 1500)
            })
            return true
        case 'watch-source':
            addSource(message.kind, message.name).then(() => {
                sendResponse({ ok: true })
                cycle()
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
                dlog('auth stored for', message.auth.user, '@', message.auth.origin)
                sendResponse({ ok: true })
                cycle()
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
            api.runtime.openOptionsPage()
            sendResponse({ ok: true })
            return true
        case 'get-auth-status':
            getAuth().then(a => sendResponse({ connected: !!a, user: a?.user || '' }))
            return true
        case 'reconnect':
            api.tabs.query({ url: WIN_TABS }).then(tabs => {
                const open = tabs.filter(t => t.id != null)
                for (const t of open) api.tabs.sendMessage(t.id!, { action: 'send-auth-now' }).catch(() => {})
                if (open.length === 0) api.tabs.create({ url: 'https://patriots.win/' })
                sendResponse({ ok: true, hadOpenTab: open.length > 0 })
            })
            return true
        case 'list-removed':
            getRemoved().then(map =>
                sendResponse({
                    removed: Object.values(map)
                        .filter(r => !r.reapproved_utc)
                        .map(r => ({
                            id: r.id,
                            uuid: r.uuid,
                            type: r.type,
                            community: r.community,
                            removal_source: r.removal_source,
                            hidden: r.hidden,
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

// Last line of the module: if this prints, every listener above registered.
dlog('background started (v' + __VERSION__ + ', ' + __BUILT_FOR__ + ')')
