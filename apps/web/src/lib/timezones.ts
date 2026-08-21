/** Every IANA timezone the runtime knows about, sorted for a predictable dropdown order. */
export const IANA_TIMEZONES: string[] = Intl.supportedValuesOf('timeZone').sort()
