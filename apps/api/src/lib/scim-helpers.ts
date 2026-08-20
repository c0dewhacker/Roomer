import crypto from 'crypto'
import { env } from '../env.js'

export const SCIM_SCHEMAS = {
  USER: 'urn:ietf:params:scim:schemas:core:2.0:User',
  GROUP: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  ENTERPRISE_USER: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
  LIST_RESPONSE: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  PATCH_OP: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  ERROR: 'urn:ietf:params:scim:api:messages:2.0:Error',
  SPC: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  SCHEMA: 'urn:ietf:params:scim:schemas:core:2.0:Schema',
  RESOURCE_TYPE: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
}

type ScimUser = Record<string, unknown>
type ScimGroup = Record<string, unknown>

export function scimUserLocation(id: string): string {
  return `${env.API_PUBLIC_URL}/scim/v2/Users/${id}`
}

export function scimGroupLocation(id: string): string {
  return `${env.API_PUBLIC_URL}/scim/v2/Groups/${id}`
}

export function userToScim(user: {
  id: string
  email: string
  displayName: string
  accountStatus: string
  externalId: string | null
  createdAt: Date
  updatedAt: Date
  department?: { name: string } | null
}): ScimUser {
  const [givenName, ...rest] = user.displayName.split(' ')
  const schemas: string[] = [SCIM_SCHEMAS.USER]
  if (user.department) schemas.push(SCIM_SCHEMAS.ENTERPRISE_USER)

  return {
    schemas,
    id: user.id,
    externalId: user.externalId ?? undefined,
    userName: user.email,
    displayName: user.displayName,
    name: {
      formatted: user.displayName,
      givenName: givenName ?? user.displayName,
      familyName: rest.join(' ') || undefined,
    },
    emails: [{ value: user.email, primary: true, type: 'work' }],
    active: user.accountStatus === 'ACTIVE',
    ...(user.department ? { [SCIM_SCHEMAS.ENTERPRISE_USER]: { department: user.department.name } } : {}),
    meta: {
      resourceType: 'User',
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
      location: scimUserLocation(user.id),
      version: `W/"${user.updatedAt.getTime()}"`,
    },
  }
}

export function groupToScim(
  group: { id: string; name: string; createdAt: Date; updatedAt: Date },
  members: Array<{ id: string; email: string }> | null,
): ScimGroup {
  const obj: ScimGroup = {
    schemas: [SCIM_SCHEMAS.GROUP],
    id: group.id,
    displayName: group.name,
    externalId: group.id,
    meta: {
      resourceType: 'Group',
      created: group.createdAt.toISOString(),
      lastModified: group.updatedAt.toISOString(),
      location: scimGroupLocation(group.id),
    },
  }
  if (members !== null) {
    obj.members = members.map((m) => ({
      value: m.id,
      display: m.email,
      '$ref': scimUserLocation(m.id),
    }))
  }
  return obj
}

export function scimError(status: number, detail: string): Record<string, unknown> {
  return { schemas: [SCIM_SCHEMAS.ERROR], status: String(status), detail }
}

export function listResponse(
  resources: unknown[],
  totalResults: number,
  startIndex: number,
): Record<string, unknown> {
  return {
    schemas: [SCIM_SCHEMAS.LIST_RESPONSE],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  }
}

/**
 * Parse SCIM `attr eq "value"` filter strings.
 * Only handles the two operators Entra actually emits: `eq` on a single attribute.
 * Returns null for unparseable expressions.
 */
export function parseScimFilter(filter: string | undefined): { attr: string; value: string } | null {
  if (!filter) return null
  const m = filter.match(/^([\w.[\]"=]{1,100})\s+eq\s+["']([^"']{0,1000})["']$/i)
  if (!m) return null
  const raw = m[1].trim()
  let attr: string
  if (/externalId/i.test(raw)) attr = 'externalId'
  else if (/userName/i.test(raw)) attr = 'userName'
  else if (/email/i.test(raw)) attr = 'email'
  else if (/displayName/i.test(raw)) attr = 'displayName'
  else attr = raw
  return { attr, value: m[2] }
}

export interface UserPatch {
  email?: string
  displayName?: string
  accountStatus?: 'ACTIVE' | 'BLOCKED'
  externalId?: string
  /** Resolved from the EnterpriseUser extension — callers must convert to departmentId */
  departmentName?: string
  /** Raw manager.value from the EnterpriseUser extension — callers pass to recordManagerRef */
  managerRef?: string
}

/**
 * Collapse a SCIM PatchOp Operations array into a Roomer user update.
 * Entra emits op values in mixed case (Replace, Add, Remove) — compared case-insensitively.
 */
export function applyUserPatchOps(
  operations: Array<{ op: string; path?: string; value?: unknown }>,
): UserPatch {
  const patch: UserPatch = {}

  for (const op of operations) {
    const lower = op.op.toLowerCase()
    if (lower !== 'replace' && lower !== 'add') continue

    const path = op.path ?? ''
    const val = op.value

    // Valueless path: `{ op, value: { active: false, displayName: "..." } }`
    const obj = (path === '' && typeof val === 'object' && val !== null) ? val as Record<string, unknown> : null

    const active = path === 'active' ? val : obj?.active
    if (active !== undefined) patch.accountStatus = active ? 'ACTIVE' : 'BLOCKED'

    const dn = path === 'displayName' ? val : obj?.displayName
    if (typeof dn === 'string') patch.displayName = dn

    const un = path === 'userName' ? val : obj?.userName
    if (typeof un === 'string') patch.email = un

    // emails[type eq "work"].value
    if (/emails/.test(path) && /value/.test(path) && typeof val === 'string') patch.email = val

    // emails array with primary flag
    if (path === 'emails' && Array.isArray(val)) {
      const work = (val as Array<{ value?: string; primary?: boolean; type?: string }>)
        .find((e) => e.primary || e.type === 'work')
      if (work?.value) patch.email = work.value
    }

    const eid = path === 'externalId' ? val : obj?.externalId
    if (typeof eid === 'string') patch.externalId = eid

    // EnterpriseUser department — Entra sends either:
    //   path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department", value: "Engineering"
    //   path: "", value: { "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "Engineering" } }
    const enterprisePrefix = SCIM_SCHEMAS.ENTERPRISE_USER
    if (path.startsWith(enterprisePrefix) && path.endsWith('department') && typeof val === 'string') {
      patch.departmentName = val.trim() || undefined
    } else {
      const enterprise = obj?.[enterprisePrefix] as Record<string, unknown> | undefined
      if (typeof enterprise?.department === 'string' && enterprise.department.trim()) {
        patch.departmentName = enterprise.department.trim()
      }
    }

    // EnterpriseUser manager — RFC 7643 §4.1.2 has this as an object
    // ({ value, $ref, displayName }), not a plain string like department;
    // accept a bare string too since not every IdP is spec-strict about it.
    const managerPath = path.startsWith(enterprisePrefix) && path.endsWith('manager')
    const managerVal = managerPath ? val : (obj?.[enterprisePrefix] as Record<string, unknown> | undefined)?.manager
    if (typeof managerVal === 'string' && managerVal.trim()) {
      patch.managerRef = managerVal.trim()
    } else if (managerVal && typeof managerVal === 'object' && typeof (managerVal as Record<string, unknown>).value === 'string') {
      const ref = ((managerVal as Record<string, unknown>).value as string).trim()
      if (ref) patch.managerRef = ref
    }
  }

  return patch
}

export interface GroupPatch {
  displayName?: string
  addMemberIds: string[]
  removeMemberIds: string[]
}

export function applyGroupPatchOps(
  operations: Array<{ op: string; path?: string; value?: unknown }>,
): GroupPatch {
  const patch: GroupPatch = { addMemberIds: [], removeMemberIds: [] }

  for (const op of operations) {
    const lower = op.op.toLowerCase()
    const path = op.path ?? ''

    if (lower === 'replace' || lower === 'add') {
      if (path === 'displayName' && typeof op.value === 'string') patch.displayName = op.value
      if (path === 'members' || path === '') {
        const members = (path === 'members' ? op.value : (op.value as Record<string, unknown>)?.members)
        if (Array.isArray(members)) {
          for (const m of members as Array<{ value?: string }>) {
            if (m.value) patch.addMemberIds.push(m.value)
          }
        }
      }
    }

    if (lower === 'remove') {
      if (path === 'members' && Array.isArray(op.value)) {
        for (const m of op.value as Array<{ value?: string }>) {
          if (m.value) patch.removeMemberIds.push(m.value)
        }
      } else {
        // RFC 7644 §3.5.2.2 single-member removal via path filter, e.g.
        // `members[value eq "<id>"]` — the form Entra sends when its
        // "SCIM compliant" provisioning flag is enabled, and the form
        // most other IdPs (Okta, OneLogin, ...) use by default. No
        // `value` is sent; the target member id is embedded in the path.
        const m = path.match(/^members\[\s*value\s+eq\s+["']([^"']+)["']\s*\]$/i)
        if (m) patch.removeMemberIds.push(m[1])
      }
    }
  }

  return patch
}

export function hashScimToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function generateScimToken(): string {
  return crypto.randomBytes(32).toString('hex')
}
