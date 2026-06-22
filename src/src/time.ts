// Relative "pretty" time, shown wherever the extension displays a time. We use a
// compact form — the two most-significant units, abbreviated (e.g. "6h 4m", "5d 11h",
// "3h", "45m") — shorter and calmer than "6 hours, 4 minutes". Operates on a DURATION
// in seconds; the wrappers below adapt it to this extension, where all timestamps are
// millisecond `Date.now()` values.

export const getPrettyTimeLength = (seconds: number): string => {
    // [number of this unit per the next-larger unit, abbreviation]
    const thresholds: [number, string][] = [
        [60, 's'],
        [60, 'm'],
        [24, 'h'],
        [7, 'd'],
        [365 / 12 / 7, 'w'],
        [12, 'mo'],
        [Infinity, 'y'],
    ]
    let time = Math.max(0, seconds)
    for (let i = 0; i < thresholds.length; i++) {
        const [divisor, unit] = thresholds[i]
        if (time < divisor) {
            let whole = Math.floor(time)
            // remainder, expressed in the next-smaller unit (only for h and above)
            let rem = i > 0 ? Math.round((time - whole) * thresholds[i - 1][0]) : 0
            if (i > 0 && rem === thresholds[i - 1][0]) {
                // rounding filled a whole lower unit → carry it up (avoid "1h 60m")
                whole += 1
                rem = 0
            }
            return i >= 2 && rem > 0 ? `${whole}${unit} ${rem}${thresholds[i - 1][1]}` : `${whole}${unit}`
        }
        time = time / divisor
    }
    return '0s'
}

// Pretty length of a duration given in milliseconds (e.g. the gap between when an
// item was created and when its removal was observed).
export function prettyDuration(ms: number): string {
    return getPrettyTimeLength(Math.max(0, Math.floor(ms / 1000))) || '0 seconds'
}

// "<length> ago" for a millisecond timestamp.
export function prettyAgo(ms: number): string {
    return prettyDuration(Date.now() - ms) + ' ago'
}

// Absolute timestamp, shown in the tooltip behind a pretty time.
export function fullTimestamp(ms: number): string {
    return new Date(ms).toLocaleString()
}
