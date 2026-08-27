import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto'

export const PBKDF2_ITERATIONS = 310_000

export const ONE_HEALTH_ROLES = [
  'administrator',
  'data-entry',
  'reviewer',
  'steward',
  'auditor',
  'sync-agent'
] as const

export type OneHealthRole = (typeof ONE_HEALTH_ROLES)[number]

export interface OneHealthIdentity {
  id: string
  username: string
  roles: OneHealthRole[]
}

export type OneHealthPermission =
  | 'event:create'
  | 'event:create:direct-care'
  | 'event:create:regulatory'
  | 'event:read'
  | 'event:review'
  | 'metrics:read'
  | 'action:manage'
  | 'audit:read'
  | 'users:manage'
  | 'exchange:read'
  | 'exchange:update'
  | 'health:create'

const ROLE_PERMISSIONS: Readonly<Record<OneHealthRole, ReadonlySet<OneHealthPermission | '*'>>> = {
  administrator: new Set(['*']),
  'data-entry': new Set(['event:create', 'event:read']),
  reviewer: new Set(['event:read', 'event:review', 'metrics:read']),
  steward: new Set([
    'event:create', 'event:create:direct-care', 'event:create:regulatory', 'event:read',
    'event:review', 'action:manage', 'metrics:read', 'exchange:read', 'exchange:update'
  ]),
  auditor: new Set(['event:read', 'metrics:read', 'audit:read']),
  'sync-agent': new Set(['exchange:read', 'exchange:update', 'health:create'])
}

export function normalizeRoles(input: readonly string[]): OneHealthRole[] {
  const supported = new Set<string>(ONE_HEALTH_ROLES)
  return [...new Set(input.map((role) => role.trim().toLocaleLowerCase()).filter((role) => supported.has(role)))]
    .sort() as OneHealthRole[]
}

export function allows(roles: readonly string[], permission: OneHealthPermission): boolean {
  for (const role of normalizeRoles(roles)) {
    const permissions = ROLE_PERMISSIONS[role]
    if (permissions.has('*') || permissions.has(permission)) return true
  }
  return false
}

export function requirePermission(identity: OneHealthIdentity, permission: OneHealthPermission): void {
  if (!allows(identity.roles, permission)) {
    throw new Error(`Role not permitted for ${permission}.`)
  }
}

export function requireCapturePermission(identity: OneHealthIdentity, purpose: string): void {
  requirePermission(identity, 'event:create')
  if (purpose === 'direct-care') requirePermission(identity, 'event:create:direct-care')
  if (purpose === 'regulatory') requirePermission(identity, 'event:create:regulatory')
}

export function hashPassword(password: string, salt = randomBytes(16)): string {
  const digest = pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, 32, 'sha256')
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${salt.toString('hex')}$${digest.toString('hex')}`
}

export function verifyPassword(password: string, encoded: string): boolean {
  try {
    const [algorithm, iterationsText, saltHex, expectedHex, ...extra] = encoded.split('$')
    if (algorithm !== 'pbkdf2_sha256' || extra.length || !/^\d+$/.test(iterationsText ?? '')) return false
    if (!saltHex || !expectedHex) return false
    const iterations = Number(iterationsText)
    if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 2_000_000) return false
    if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(expectedHex)) return false
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(expectedHex, 'hex')
    if (salt.length < 16 || expected.length !== 32) return false
    const actual = pbkdf2Sync(password, salt, iterations, expected.length, 'sha256')
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]))
  }
  return value
}

/** Python json.dumps(..., sort_keys=True, separators=(",", ":"), ensure_ascii=True) compatible. */
export function canonicalAuditJson(value: unknown): string {
  const json = JSON.stringify(canonicalValue(value))
  let encoded = ''
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index)
    encoded += code > 0x7f ? `\\u${code.toString(16).padStart(4, '0')}` : json[index]
  }
  return encoded
}

/**
 * A commitment to an audit entry's details, without the details.
 *
 * The chain hashes this rather than the payload, so a lawful erasure request can destroy
 * the plaintext while the chain still verifies. What survives is proof that the entry
 * existed, when, by whom, and that the sequence was not altered — deliberately not what it
 * contained. Hashing the plaintext directly would put a tamper-evident log and a right to
 * erasure in permanent conflict.
 */
export function auditDetailsDigest(details: unknown): string {
  return createHash('sha256').update(canonicalAuditJson(details), 'utf8').digest('hex')
}

export function auditHash(previousHash: string | null | undefined, entry: Record<string, unknown>): string {
  return createHash('sha256').update(`${previousHash ?? ''}${canonicalAuditJson(entry)}`, 'utf8').digest('hex')
}

export interface OneHealthSessionStatus {
  authenticated: boolean
  identity: OneHealthIdentity | null
  expiresAt: string | null
}

/** In-memory identity only. The renderer receives status, never a reusable credential or session token. */
export class OneHealthSession {
  private identity: OneHealthIdentity | null = null
  private expiresAt = 0

  constructor(private readonly idleTimeoutMs = 30 * 60 * 1_000) {}

  establish(identity: OneHealthIdentity): OneHealthSessionStatus {
    this.identity = { ...identity, roles: [...identity.roles] }
    this.expiresAt = Date.now() + this.idleTimeoutMs
    return this.status()
  }

  clear(): void {
    this.identity = null
    this.expiresAt = 0
  }

  current(): OneHealthIdentity {
    if (!this.identity || Date.now() >= this.expiresAt) {
      this.clear()
      throw new Error('One Health authentication is required.')
    }
    this.expiresAt = Date.now() + this.idleTimeoutMs
    return { ...this.identity, roles: [...this.identity.roles] }
  }

  status(): OneHealthSessionStatus {
    if (this.identity && Date.now() >= this.expiresAt) this.clear()
    return {
      authenticated: Boolean(this.identity),
      identity: this.identity ? { ...this.identity, roles: [...this.identity.roles] } : null,
      expiresAt: this.identity ? new Date(this.expiresAt).toISOString() : null
    }
  }
}
