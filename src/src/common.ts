import api from './api'

export const ALARM_NAME = 'win-notifyme'

const ACTION_API = __BUILT_FOR__ === 'chrome' ? 'action' : 'browserAction'

// The check interval the options allow: whole minutes, 1 to 60. Anything else (an
// empty box, a typo, a stray stored value) becomes the nearest allowed value, or 1.
export function clampInterval(minutes: number): number {
    return Math.max(1, Math.min(60, Math.round(minutes) || 1))
}

export function setAlarm(periodInMinutes: number): void {
    api.alarms.clear(ALARM_NAME)
    api.alarms.create(ALARM_NAME, { delayInMinutes: 1, periodInMinutes: clampInterval(periodInMinutes) })
}

export function setUnseenBadge(count: number): void {
    try {
        const a = (api as any)[ACTION_API]
        a.setBadgeBackgroundColor({ color: 'red' })
        a.setBadgeText({ text: count > 0 ? String(count) : '' })
    } catch {
        /* action API unavailable in some contexts */
    }
}

export function setWarningBadge(errorStatus?: string): void {
    try {
        const a = (api as any)[ACTION_API]
        a.setBadgeText({ text: '!' })
        a.setBadgeBackgroundColor({ color: '#ffcc00' })
        if (errorStatus) api.storage.local.set({ error_status: errorStatus })
    } catch {
        /* ignored */
    }
}

export function createTab(url: string): void {
    api.tabs.create({ url, active: true })
}

export const DEFAULT_ORIGIN = 'https://patriots.win'

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
    const uniqueId = notificationId.includes('|') ? notificationId : `${notificationId}|${Date.now()}`
    const options: chrome.notifications.NotificationCreateOptions = {
        type: 'basic',
        iconUrl: api.runtime.getURL('icons/128.png'),
        title,
        message,
    }
    const fallback = () => {
        try {
            const reg = (self as any).registration
            if (reg?.showNotification) {
                reg.showNotification(title, { body: message, icon: api.runtime.getURL('icons/128.png') })
            }
        } catch {
            /* ignored */
        }
    }
    return api.notifications.create(uniqueId, options).then(
        () => true,
        () => { fallback(); return false },
    )
}
