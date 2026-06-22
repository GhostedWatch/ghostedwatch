// Notification, badge and alarm helpers. Adapted from the reveddit real-time
// extension's common.ts, trimmed to what this extension needs.

export const ALARM_NAME = 'win-notifyme'

const ACTION_API = __BUILT_FOR__ === 'chrome' ? 'action' : 'browserAction'

export function setAlarm(periodInMinutes: number): void {
    chrome.alarms.clear(ALARM_NAME)
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes })
}

export function setUnseenBadge(count: number): void {
    try {
        const api = (chrome as any)[ACTION_API]
        api.setBadgeBackgroundColor({ color: 'red' })
        api.setBadgeText({ text: count > 0 ? String(count) : '' })
    } catch {
        /* action API unavailable in some contexts */
    }
}

export function setWarningBadge(errorStatus?: string): void {
    try {
        const api = (chrome as any)[ACTION_API]
        api.setBadgeText({ text: '!' })
        api.setBadgeBackgroundColor({ color: '#ffcc00' })
        if (errorStatus) chrome.storage.local.set({ error_status: errorStatus })
    } catch {
        /* ignored */
    }
}

export function createTab(url: string): void {
    chrome.tabs.create({ url, active: true })
}

// Fallback origin when we don't yet know where the user is active (e.g. a record
// saved before any session capture). The base62 uuids resolve on any .win alias.
export const DEFAULT_ORIGIN = 'https://patriots.win'

// Build a permalink on the given .win origin. For a comment, link to it within its
// post; for a post, link to the post itself. The base62 uuids are stable across the
// site's aliases, so the choice of origin only affects which alias you land on.
export function permalink(
    postUuid: string,
    uuid: string,
    type: 'post' | 'comment' = 'comment',
    origin: string = DEFAULT_ORIGIN,
): string {
    if (type === 'post') return `${origin}/p/${postUuid}/`
    return `${origin}/p/${postUuid}/x/c/${uuid}`
}

export function createNotification({
    notificationId,
    title,
    message,
}: {
    notificationId: string
    title: string
    message: string
}): Promise<boolean> {
    return new Promise(resolve => {
        const uniqueId = notificationId.includes('|') ? notificationId : `${notificationId}|${Date.now()}`
        const options: chrome.notifications.NotificationCreateOptions = {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icons/128.png'),
            title,
            message,
        }
        const fallback = () => {
            try {
                const reg = (self as any).registration
                if (reg?.showNotification) {
                    reg.showNotification(title, { body: message, icon: chrome.runtime.getURL('icons/128.png') })
                }
            } catch {
                /* ignored */
            }
        }
        try {
            chrome.notifications.create(uniqueId, options, () => {
                if ((chrome.runtime as any)?.lastError) {
                    fallback()
                    resolve(false)
                } else {
                    resolve(true)
                }
            })
        } catch {
            fallback()
            resolve(false)
        }
    })
}
