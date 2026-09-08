export type ZoneData = { id: string; name: string; colour: string; zoneGroupId: string | null; requiresApproval: boolean | null; assets: AssetData[] }
export type ZoneGroupData = { id: string; name: string; floorId: string }
export type AssetData = { id: string; name: string; status: string; amenities: string[]; isBookable?: boolean }
/** @deprecated use AssetData */
export type DeskData = AssetData
export const DESK_STATUSES = ['OPEN', 'RESTRICTED', 'ASSIGNED', 'DISABLED'] as const
export const STATUS_LABELS: Record<string, string> = { OPEN: 'Open', RESTRICTED: 'Restricted', ASSIGNED: 'Assigned', DISABLED: 'Disabled' }
export const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = { OPEN: 'secondary', RESTRICTED: 'outline', ASSIGNED: 'default', DISABLED: 'destructive' }
