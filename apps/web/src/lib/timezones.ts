/**
 * Every IANA timezone the runtime knows about, sorted for a predictable
 * dropdown order. 'UTC' is prepended explicitly — Intl.supportedValuesOf
 * only enumerates canonical IANA "Zone" entries, not the "UTC" link, even
 * though it's a valid, working timeZone value and the org/building default
 * throughout this codebase — without it, the default couldn't even be
 * re-selected once a different value was picked.
 */
export const IANA_TIMEZONES: string[] = ['UTC', ...Intl.supportedValuesOf('timeZone').sort()]
