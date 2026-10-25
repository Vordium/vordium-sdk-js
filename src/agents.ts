import { InvalidRequest } from './errors.js'

/**
 * Agents: a key that trades for an account within the limits its owner signs. The operations in force:
 * RegisterAgentV2 (a name is required), SetAgentName, SetAgentPolicyV1, SetAgentMarketLimit, ClearAgentLock and
 * RevokeAgent. Each is signed by the OWNER in the VordCore domain and sent to `POST /submit`; only SetAgentPolicyV1 may
 * also be signed by the agent itself, and then only to tighten the stored policy.
 */

// ── Names ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const NAME_MIN_BYTES = 3
export const NAME_MAX_BYTES = 32
export const RESERVED_WORDS_DEFAULT = ['admin', 'helpdesk', 'moderator', 'official', 'support', 'validator', 'vordex', 'vordium', 'vordscan'] as const

export type NameStep = 'NonAscii' | 'ControlChar' | 'BadChar' | 'TooShort' | 'TooLong' | 'NotCanonical' | 'NoAlphanumeric' | 'Reserved'

/** What is signed: NFKC, every run of ASCII whitespace becomes one space, no space at either end. */
export function normalizeName(raw: string): string {
  let s = raw.normalize('NFKC').replace(/[ \t\n\r\f\v]+/g, ' ')
  if (s.startsWith(' ')) s = s.slice(1)
  if (s.endsWith(' ')) s = s.slice(0, -1)
  return s
}

/** ASCII letters lower-cased, with `space - _ .` removed: what reserved words are matched in (as the node builds it). */
export function nameSkeleton(name: string): string {
  return name.replace(/[A-Z]/g, (c) => c.toLowerCase()).replace(/[ \-_.]/g, '')
}

function judge(name: string, reserved: readonly string[]): [NameStep, string] | null {
  if (!name) return ['TooShort', 'Enter a name.']
  if ([...name].some((c) => c.codePointAt(0)! > 0x7f)) return ['NonAscii', 'Use plain letters and digits: no accents, emoji or other symbols.']
  if (/[\x00-\x1f\x7f]/.test(name)) return ['ControlChar', 'No tabs, line breaks or other control characters.']
  if (!/^[A-Za-z0-9 \-_.]+$/.test(name)) return ['BadChar', 'Use only letters, digits, spaces, hyphens (-), underscores (_) and dots (.).']
  if (name.length < NAME_MIN_BYTES) return ['TooShort', `Use at least ${NAME_MIN_BYTES} characters.`]
  if (name.length > NAME_MAX_BYTES) return ['TooLong', `Use at most ${NAME_MAX_BYTES} characters.`]
  if (name.startsWith(' ') || name.endsWith(' ') || name.includes('  ')) return ['NotCanonical', 'No space at the start or end, and no double spaces.']
  if (!/[A-Za-z0-9]/.test(name)) return ['NoAlphanumeric', 'Include at least one letter or digit.']
  const sk = nameSkeleton(name)
  for (const w of reserved) if (sk.includes(w)) return ['Reserved', `A name can't contain the reserved word "${w}".`]
  return null
}

/**
 * The chain's form rule for an ALREADY-normalised name, in the chain's own step order: `null` when accepted, else the
 * refusing step. Uniqueness among the owner's agents, the rename wait and the live-agent limit are the chain's to judge.
 */
export function nameRefusalStep(name: string, reserved: readonly string[] = RESERVED_WORDS_DEFAULT): NameStep | null {
  return judge(name, reserved)?.[0] ?? null
}

/** Normalise then check: the name to sign, or InvalidRequest with the reason. */
export function requireName(raw: string, reserved: readonly string[] = RESERVED_WORDS_DEFAULT): string {
  const n = normalizeName(raw)
  const j = judge(n, reserved)
  if (j) throw new InvalidRequest(j[1])
  return n
}

// ── Policy ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const CAPABILITY_BITS = { place: 0, cancel: 1, modify: 2, tpsl: 3, close: 4, vault: 5 } as const
export const CAPS_ALL = 0b111111
export const ORACLE_BAND_MIN_BPS = 1
export const ORACLE_BAND_MAX_BPS = 1000
export const MAX_LEVERAGE_BPS = 500_000
export const DAY_MS = 86_400_000

export interface PolicyV1 {
  capsBitmask: number
  /** 0 open and reduce, 1 reduce only. */
  sideMode: number
  maxTotalExposure6dec: bigint
  /** 0 = unlimited. */
  maxLeverageBps: number
  dailyLossLimit6dec: bigint
  /** 0 = unlimited. */
  dailyFeeCap6dec: bigint
  /** Both 0 = unlimited. */
  opsPerWindow: number
  opsWindowMs: number
  /** Both 0 = always. */
  activeFromMsOfDay: number
  activeToMsOfDay: number
  oracleBandBps: number
  lockAutoClear: boolean
  expiresMs: number
  enabled: boolean
}

const isU = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : String(n))

/** Why the chain would refuse this policy at apply (it refuses silently); [] = none of the stateless reasons. */
export function policyProblems(p: PolicyV1, nowMs: number): string[] {
  const out: string[] = []
  if (!isU(p.capsBitmask) || (p.capsBitmask & ~CAPS_ALL) !== 0) out.push('Choose capabilities from the list only.')
  if (p.sideMode !== 0 && p.sideMode !== 1) out.push('Choose whether the agent may open positions or only reduce them.')
  if (typeof p.maxTotalExposure6dec !== 'bigint' || p.maxTotalExposure6dec <= 0n) out.push('Set a total exposure above zero.')
  if (typeof p.dailyLossLimit6dec !== 'bigint' || p.dailyLossLimit6dec <= 0n) out.push('Set a daily loss limit above zero.')
  if (typeof p.dailyFeeCap6dec !== 'bigint' || p.dailyFeeCap6dec < 0n) out.push('The daily fee cap cannot be negative.')
  if (!isU(p.maxLeverageBps) || p.maxLeverageBps > MAX_LEVERAGE_BPS) out.push(`Leverage can be at most ${fmt(MAX_LEVERAGE_BPS / 10000)}x (or 0 for no limit).`)
  if (!isU(p.oracleBandBps) || p.oracleBandBps < ORACLE_BAND_MIN_BPS || p.oracleBandBps > ORACLE_BAND_MAX_BPS) {
    out.push(`The oracle band must be between ${fmt(ORACLE_BAND_MIN_BPS / 100)}% and ${fmt(ORACLE_BAND_MAX_BPS / 100)}%.`)
  }
  const bothZero = p.opsPerWindow === 0 && p.opsWindowMs === 0
  if (!isU(p.opsPerWindow) || !isU(p.opsWindowMs) || !(bothZero || (p.opsPerWindow > 0 && p.opsWindowMs > 0 && p.opsWindowMs <= DAY_MS))) {
    out.push('Set both the operations per window and a window of at most a day, or leave both at zero for no limit.')
  }
  if (!isU(p.activeFromMsOfDay) || !isU(p.activeToMsOfDay) || p.activeFromMsOfDay >= DAY_MS || p.activeToMsOfDay >= DAY_MS
    || (p.activeFromMsOfDay === p.activeToMsOfDay && p.activeFromMsOfDay !== 0)) {
    out.push('Set active hours that start and end at different times within the day, or leave both at midnight for always.')
  }
  if (!isU(p.expiresMs) || p.expiresMs <= nowMs) out.push('Set an expiry in the future.')
  return out
}

/** What in `next` would LOOSEN `prev`; [] = a tightening or no change (and always [] with nothing stored). */
export function loosens(prev: PolicyV1 | null, next: PolicyV1): string[] {
  if (!prev) return []
  const out: string[] = []
  const higherOrUnlimited = (a: bigint, b: bigint) => (b === 0n ? a !== 0n : a !== 0n && b > a)
  if ((next.capsBitmask & ~prev.capsBitmask) !== 0) out.push('adds a capability')
  if (next.sideMode < prev.sideMode) out.push('lets the agent open positions')
  if (next.maxTotalExposure6dec > prev.maxTotalExposure6dec) out.push('raises the total exposure')
  if (higherOrUnlimited(BigInt(prev.maxLeverageBps), BigInt(next.maxLeverageBps))) out.push('raises the leverage')
  if (next.dailyLossLimit6dec > prev.dailyLossLimit6dec) out.push('raises the daily loss limit')
  if (higherOrUnlimited(prev.dailyFeeCap6dec, next.dailyFeeCap6dec)) out.push('raises the daily fee cap')
  if (next.expiresMs > prev.expiresMs) out.push('extends the expiry')
  if (next.oracleBandBps > prev.oracleBandBps) out.push('widens the oracle band')
  if (next.lockAutoClear && !prev.lockAutoClear) out.push('turns on automatic lock clearing')
  if (next.enabled && !prev.enabled) out.push('turns the policy on')
  if (next.opsPerWindow !== prev.opsPerWindow || next.opsWindowMs !== prev.opsWindowMs) out.push('changes the operations limit')
  if (next.activeFromMsOfDay !== prev.activeFromMsOfDay || next.activeToMsOfDay !== prev.activeToMsOfDay) out.push('changes the active hours')
  return out
}

// ── Values and the /submit body ─────────────────────────────────────────────────────────────────────────────────────

export type AgentOp = 'RegisterAgentV2' | 'SetAgentName' | 'SetAgentPolicyV1' | 'SetAgentMarketLimit' | 'ClearAgentLock' | 'RevokeAgent'

type Kind = 'address' | 'string' | 'bool' | 'u8' | 'u32' | 'u64' | 'u128'
/** Per operation: [struct name, wire name, kind], in the order the node reads them. */
export const SUBMIT_FIELDS: Record<AgentOp, Array<[string, string, Kind]>> = {
  RegisterAgentV2: [['owner', 'owner', 'address'], ['agent', 'agent', 'address'], ['name', 'name', 'string'], ['mandate', 'mandate', 'string'], ['expiresMs', 'expires_ms', 'u64'], ['nonce', 'nonce', 'u64']],
  SetAgentName: [['owner', 'owner', 'address'], ['agent', 'agent', 'address'], ['name', 'name', 'string'], ['nonce', 'nonce', 'u64']],
  SetAgentPolicyV1: [['owner', 'owner', 'address'], ['agent', 'agent', 'address'], ['capsBitmask', 'caps_bitmask', 'u32'], ['sideMode', 'side_mode', 'u8'],
    ['maxTotalExposure6dec', 'max_total_exposure_6dec', 'u128'], ['maxLeverageBps', 'max_leverage_bps', 'u32'], ['dailyLossLimit6dec', 'daily_loss_limit_6dec', 'u128'],
    ['dailyFeeCap6dec', 'daily_fee_cap_6dec', 'u128'], ['opsPerWindow', 'ops_per_window', 'u32'], ['opsWindowMs', 'ops_window_ms', 'u32'],
    ['activeFromMsOfDay', 'active_from_ms_of_day', 'u32'], ['activeToMsOfDay', 'active_to_ms_of_day', 'u32'], ['oracleBandBps', 'oracle_band_bps', 'u32'],
    ['lockAutoClear', 'lock_auto_clear', 'bool'], ['expiresMs', 'expires_ms', 'u64'], ['enabled', 'enabled', 'bool'], ['nonce', 'nonce', 'u64']],
  SetAgentMarketLimit: [['owner', 'owner', 'address'], ['agent', 'agent', 'address'], ['pair', 'pair', 'u32'], ['allowed', 'allowed', 'bool'],
    ['maxOrder18dec', 'max_order_18dec', 'u128'], ['maxPosition18dec', 'max_position_18dec', 'u128'], ['maxLeverageBps', 'max_leverage_bps', 'u32'], ['nonce', 'nonce', 'u64']],
  ClearAgentLock: [['owner', 'owner', 'address'], ['agent', 'agent', 'address'], ['lockSinceMs', 'lock_since_ms', 'u64'], ['nonce', 'nonce', 'u64']],
  RevokeAgent: [['owner', 'owner', 'address'], ['agent', 'agent', 'address'], ['nonce', 'nonce', 'u64']],
}

/** These operations carry their addresses in lower case on the wire; the others as given. */
export const LOWERCASE_ADDRESS_OPS: ReadonlySet<AgentOp> = new Set(['RegisterAgentV2', 'SetAgentName', 'SetAgentPolicyV1', 'ClearAgentLock'])

function encode(op: AgentOp, kind: Kind, wire: string, v: unknown): unknown {
  if (kind === 'address') {
    if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new InvalidRequest(`${wire} is not an address.`)
    return LOWERCASE_ADDRESS_OPS.has(op) ? v.toLowerCase() : v
  }
  if (kind === 'string') { if (typeof v !== 'string') throw new InvalidRequest(`${wire} is not text.`); return v }
  if (kind === 'bool') { if (typeof v !== 'boolean') throw new InvalidRequest(`${wire} is not true or false.`); return v }
  let b: bigint
  if (typeof v === 'bigint') b = v
  else if (typeof v === 'number' && Number.isSafeInteger(v)) b = BigInt(v)
  else if (typeof v === 'string' && /^\d+$/.test(v)) b = BigInt(v)
  else throw new InvalidRequest(`${wire} is not a whole number.`)
  if (b < 0n) throw new InvalidRequest(`${wire} is not a whole number.`)
  if (kind === 'u128') return b.toString()
  if (b > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidRequest(`${wire} is past the exact-integer range.`)
  return Number(b)
}

/** The exact `POST /submit` body for one signed agent operation (every field, in wire order). */
export function submitBody(op: AgentOp, value: Record<string, unknown>, signature: string): Record<string, unknown> {
  const fields = SUBMIT_FIELDS[op]
  if (!fields) throw new InvalidRequest(`${String(op)} is not an agent operation in force.`)
  const s = signature.toLowerCase()
  if (!/^0x[0-9a-f]{130}$/.test(s)) throw new InvalidRequest('The signature is not 65 bytes of hex.')
  const body: Record<string, unknown> = { op }
  for (const [struct, wire, kind] of fields) {
    if (!(struct in value)) throw new InvalidRequest(`${struct} is missing from the signed operation.`)
    body[wire] = encode(op, kind, wire, value[struct])
  }
  body.signature = s
  return body
}

export function policyValue(owner: string, agent: string, p: PolicyV1, nonce: number): Record<string, unknown> {
  return {
    owner, agent, capsBitmask: p.capsBitmask, sideMode: p.sideMode, maxTotalExposure6dec: p.maxTotalExposure6dec, maxLeverageBps: p.maxLeverageBps,
    dailyLossLimit6dec: p.dailyLossLimit6dec, dailyFeeCap6dec: p.dailyFeeCap6dec, opsPerWindow: p.opsPerWindow, opsWindowMs: p.opsWindowMs,
    activeFromMsOfDay: p.activeFromMsOfDay, activeToMsOfDay: p.activeToMsOfDay, oracleBandBps: p.oracleBandBps, lockAutoClear: p.lockAutoClear,
    expiresMs: p.expiresMs, enabled: p.enabled, nonce,
  }
}

/** The stored policy from `GET /agents/{owner}/{agent}` (`policy_v1`, the node's snake_case names), or null. */
export function policyFromRead(x: unknown): PolicyV1 | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const n = (k: string): number | null => (typeof o[k] === 'number' && Number.isSafeInteger(o[k]) && (o[k] as number) >= 0 ? (o[k] as number)
    : typeof o[k] === 'string' && /^\d+$/.test(o[k] as string) && Number.isSafeInteger(Number(o[k])) ? Number(o[k]) : null)
  const b = (k: string): bigint | null => (typeof o[k] === 'number' && Number.isSafeInteger(o[k]) && (o[k] as number) >= 0 ? BigInt(o[k] as number)
    : typeof o[k] === 'string' && /^\d+$/.test(o[k] as string) ? BigInt(o[k] as string) : null)
  const t = (k: string): boolean | null => (typeof o[k] === 'boolean' ? (o[k] as boolean) : null)
  const p = {
    capsBitmask: n('caps_bitmask'), sideMode: n('side_mode'), maxTotalExposure6dec: b('max_total_exposure_6dec'), maxLeverageBps: n('max_leverage_bps'),
    dailyLossLimit6dec: b('daily_loss_limit_6dec'), dailyFeeCap6dec: b('daily_fee_cap_6dec'), opsPerWindow: n('ops_per_window'), opsWindowMs: n('ops_window_ms'),
    activeFromMsOfDay: n('active_from_ms_of_day'), activeToMsOfDay: n('active_to_ms_of_day'), oracleBandBps: n('oracle_band_bps'),
    lockAutoClear: t('lock_auto_clear'), expiresMs: n('expires_ms'), enabled: t('enabled'),
  }
  return Object.values(p).some((v) => v === null) ? null : (p as PolicyV1)
}
