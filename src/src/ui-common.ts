import { MAX_AUTO_PER_POST, MAX_AUTO_TOTAL, type RemovedRecord } from './storage'
import api from './api'

const LIMIT = `the ${MAX_AUTO_TOTAL.toLocaleString('en-US')}-comment limit is reached`
// What a whole-post watch can't follow, if anything, for its row on the Watching page.
// `followed` is how many of its comments it follows; `room` is autoCommentRoom().
// A post at its own cap first: making room elsewhere wouldn't help it.
export function threadLimitNote(followed: number, room: number): string {
    if (followed >= MAX_AUTO_PER_POST) return `New comments aren't followed: ${MAX_AUTO_PER_POST} is the most for one post.`
    if (room <= 0) {
        const which = followed ? 'New comments' : 'Its comments'
        return `${which} aren't followed: ${LIMIT}. Turn off All comments on another post to make room.`
    }
    return ''
}
// The in-page post menu's note on "Watch post + all comments" when there's no room.
export const MENU_FULL_NOTE = `Comments won't be followed: ${LIMIT}. Make room on the Watching page.`

export function sendMessage<T = any>(message: unknown): Promise<T> {
    return api.runtime.sendMessage(message)
}

// A removed item's state for styling. The public-view audit marks an item hidden from
// others with `hidden`; detection itself only records publicly_removed or deleted.
export function displayStatus(rec: RemovedRecord): string {
    if (rec.reapproved_utc) return 'reapproved'
    if (rec.status === 'deleted') return 'deleted'
    if (rec.hidden || rec.status === 'shadow_removed') return 'shadow_removed'
    return rec.status
}

// Short, human label for a removed item's status (no "publicly_" noise).
export function statusLabel(rec: RemovedRecord): string {
    const s = displayStatus(rec)
    return s === 'reapproved' ? 're-approved' : s === 'deleted' ? 'deleted' : s === 'shadow_removed' ? 'hidden' : 'removed'
}
