import type { ProfileComment } from './win-api'
import {
    getOwnItems,
    setOwnItems,
    trimOwnItems,
    getRemoved,
    addRemovedRecord,
    markReapproved,
    fillRemovedSources,
    getNotifiedIds,
    addNotifiedIds,
    removeNotifiedIds,
    pushChange,
    setLastCheck,
    getUnseenCount,
    REMOVAL_CONFIRM_THRESHOLD,
    REAPPROVAL_CONFIRM_THRESHOLD,
    type OwnItem,
} from './storage'
import { setUnseenBadge, permalink } from './common'

// The shared anti-flap core, used for both your own content and watched comments.
// It folds one observation (removed or not) into a consecutive-count hysteresis:
// a removal confirms only after `confirmThreshold` consecutive "removed" observations,
// and a recorded removal re-approves only after `reapproveThreshold` consecutive
// "visible" ones. A lone transient blip in either direction just resets the opposing
// counter and fires nothing — which is what prevents remove/re-approve notification
// storms, with no ad-hoc post-hoc guards.
export interface RemovalState {
    is_removed: boolean
    removal_count: number
    visible_count: number
    recorded: boolean
}
export function foldRemoval(
    s: RemovalState,
    observedRemoved: boolean,
    confirmThreshold = REMOVAL_CONFIRM_THRESHOLD,
    reapproveThreshold = REAPPROVAL_CONFIRM_THRESHOLD,
): { next: RemovalState; newlyRemoved: boolean; newlyReapproved: boolean } {
    if (observedRemoved) {
        // a removed observation cancels any in-progress re-approval streak
        const next = { is_removed: true, removal_count: s.removal_count + 1, visible_count: 0, recorded: s.recorded }
        const newlyRemoved = !s.recorded && next.removal_count >= confirmThreshold
        if (newlyRemoved) next.recorded = true
        return { next, newlyRemoved, newlyReapproved: false }
    }
    // observed visible: an unconfirmed removal streak is abandoned immediately...
    const next = { is_removed: false, removal_count: 0, visible_count: 0, recorded: s.recorded }
    if (!s.recorded) return { next, newlyRemoved: false, newlyReapproved: false }
    // ...but a *recorded* removal re-approves only after enough CONSECUTIVE visibles.
    next.visible_count = (s.visible_count || 0) + 1
    const newlyReapproved = next.visible_count >= reapproveThreshold
    if (newlyReapproved) {
        next.recorded = false
        next.visible_count = 0
    }
    return { next, newlyRemoved: false, newlyReapproved }
}

// Pure transition logic, unit-tested without storage/network. Folds one profile
// observation into a tracked comment and reports whether this observation is the one
// that confirms a newly-detected removal or a re-approval.
export function applyProfileObservation(
    prev: OwnItem | undefined,
    item: ProfileComment,
    confirmThreshold = REMOVAL_CONFIRM_THRESHOLD,
    reapproveThreshold = REAPPROVAL_CONFIRM_THRESHOLD,
): { next: OwnItem; newlyRemoved: boolean; newlyReapproved: boolean } {
    const base: OwnItem = prev || {
        id: item.id,
        uuid: item.uuid,
        type: item.type,
        title: item.title,
        post_id: item.post_id,
        post_uuid: item.post_uuid,
        community: item.community,
        created: item.created,
        text: '',
        is_removed: false,
        removal_source: '',
        removal_count: 0,
        visible_count: 0,
        recorded: false,
    }
    const next: OwnItem = {
        ...base,
        uuid: item.uuid || base.uuid,
        type: item.type || base.type,
        title: item.title || base.title,
        post_id: item.post_id || base.post_id,
        post_uuid: item.post_uuid || base.post_uuid,
        community: item.community || base.community,
        created: item.created || base.created,
        removal_source: item.removal_source || base.removal_source,
    }
    // keep any text we already have, or take the live text the profile exposes
    if (!next.text && item.text) next.text = item.text

    // Removal signal: trust the API's is_removed flag. As a backstop (in case the
    // platform ever drops/renames is_removed), also treat a comment whose content
    // the feed has BLANKED as removed — but only when we previously had its text,
    // so an always-empty item can't produce a false positive.
    const blanked = item.text.trim() === '' && base.text.trim().length > 0
    const observedRemoved = item.is_removed === true || blanked

    const f = foldRemoval(base, observedRemoved, confirmThreshold, reapproveThreshold)
    next.is_removed = f.next.is_removed
    next.removal_count = f.next.removal_count
    next.visible_count = f.next.visible_count
    next.recorded = f.next.recorded
    return { next, newlyRemoved: f.newlyRemoved, newlyReapproved: f.newlyReapproved }
}

// Fold a batch of profile comments (from the authenticated content-script poll)
// into stored state, recording any newly confirmed removals. Returns the list of
// newly recorded removals so the caller can fire a single, collapsed notification
// for the whole check.
// `confirmThreshold` defaults to the usual 2-consecutive-observation confirmation;
// the initial history backfill passes 1 so pre-existing removals show immediately.
export async function processProfileComments(
    items: ProfileComment[],
    confirmThreshold = REMOVAL_CONFIRM_THRESHOLD,
): Promise<{ removed: OwnItem[]; reapproved: OwnItem[] }> {
    const map = await getOwnItems()
    // Idempotency guard: never re-record/re-notify something already in the removed
    // store, even if the tracked map (local) was cleared while removed persisted.
    const alreadyRemoved = await getRemoved()
    const newlyRemoved: OwnItem[] = []
    const newlyReapproved: OwnItem[] = []
    for (const item of items) {
        if (!item.id) continue
        const obs = applyProfileObservation(map[String(item.id)], item, confirmThreshold)
        map[String(item.id)] = obs.next
        const prevRec = alreadyRemoved[String(item.id)]
        // record a removal when it's new, OR when the existing record was already
        // re-approved (this is a fresh removal of an item that came back, then went)
        if (obs.newlyRemoved && (!prevRec || prevRec.reapproved_utc)) newlyRemoved.push(obs.next)
        // a re-approval only matters if there's a recorded removal not already re-approved
        else if (obs.newlyReapproved && prevRec && !prevRec.reapproved_utc) newlyReapproved.push(obs.next)
    }
    await setOwnItems(trimOwnItems(map))

    for (const t of newlyRemoved) await recordRemoval(t)
    const now = Date.now()
    for (const t of newlyReapproved) {
        await markReapproved(t.id, now)
        await pushChange({ id: t.id, status: 'live', ts: now, community: t.community })
    }
    // re-approval clears the notify-once flag so a future re-removal alerts again
    if (newlyReapproved.length) await removeNotifiedIds(newlyReapproved.map(t => t.id))

    // self-heal: ensure existing removed records carry the removal source
    const sources: Record<string, string> = {}
    for (const item of items) if (item.is_removed && item.removal_source) sources[String(item.id)] = item.removal_source
    await fillRemovedSources(sources)
    await setLastCheck(now)
    setUnseenBadge(await getUnseenCount())

    // Notify removals at most once ever per id, regardless of churn above.
    const notified = new Set(await getNotifiedIds())
    const toNotify = newlyRemoved.filter(t => !notified.has(t.id))
    if (toNotify.length) await addNotifiedIds(toNotify.map(t => t.id))
    // Re-approvals are naturally once-per-removal-cycle (the state machine resets
    // after firing), so they don't use the persistent notify-once guard.
    return { removed: toNotify, reapproved: newlyReapproved }
}

async function recordRemoval(t: OwnItem): Promise<void> {
    await addRemovedRecord({
        id: t.id,
        uuid: t.uuid,
        type: t.type,
        post_uuid: t.post_uuid,
        community: t.community,
        title: t.title || '',
        text: t.text || '',
        // a post's title/body come from the feed; a comment may still need recovery
        text_loading: t.type === 'comment' && !t.text,
        status: 'publicly_removed',
        removal_source: t.removal_source || '',
        created: t.created || 0,
        observed_utc: Date.now(),
        unseen: true,
    })
    await pushChange({ id: t.id, status: 'publicly_removed', ts: Date.now(), community: t.community })
}

export { permalink }
