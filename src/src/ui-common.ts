import type { RemovedRecord } from './storage'
import api from './api'

export function sendMessage<T = any>(message: unknown): Promise<T> {
    return api.runtime.sendMessage(message)
}

// Short, human label for a removed item's status (no "publicly_" noise).
export function statusLabel(rec: RemovedRecord): string {
    if (rec.reapproved_utc) return 're-approved'
    if (rec.status === 'deleted') return 'deleted'
    if (rec.status === 'shadow_removed') return 'hidden'
    return 'removed'
}
