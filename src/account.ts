import { InvalidRequest, NotAvailable } from './errors.js'
import { TYPE_STRINGS } from './types.js'

/**
 * Session keys, TWAP orders and margin mode — signed by the account's own key.
 *
 * Session key: SessionCreate / SessionRevoke in the VordexSession domain. The chain keeps one session per account, so a
 * session it holds for another key is revoked first. Each nonce is larger than the last.
 * TWAP: PlaceTwap / CancelTwap in the VordCore domain, owner key only (a session key is refused). The route and limits
 * come from the network spec's `twap` section.
 * Margin mode: SetMarginMode in the VordCore domain — cross or isolated per market, only while the market has no open
 * position and no resting order of the account.
 */

export const SESSION_MAX_SECONDS = 90 * 86400 - 3600
export const MODE_CODE = { cross: 1, isolated: 2 } as const
export type MarginMode = keyof typeof MODE_CODE

/** Larger than the last nonce: the time in ms, or the previous nonce + 1. */
export function nextNonce(after = 0, nowMs: number = Date.now()): number {
  return Math.max(Math.floor(nowMs), after + 1)
}

/** The session's end in seconds: the asked end, at most 90 days less an hour from now. */
export function sessionEnd(endMs: number, nowMs: number = Date.now()): number {
  return Math.min(Math.floor(endMs / 1000), Math.floor(nowMs / 1000) + SESSION_MAX_SECONDS)
}

export function sessionCreateBody(owner: string, sessionKey: string, expiresAt: number, nonce: number, signature: string): string {
  return JSON.stringify({ owner, session_key: sessionKey, expires_at: expiresAt, nonce, signature })
}

export function sessionRevokeBody(owner: string, sessionKey: string, nonce: number, signature: string): string {
  return JSON.stringify({ owner, session_key: sessionKey, nonce, signature })
}

export interface TwapValue {
  owner: string; pairId: number; side: number; totalSize18dec: bigint; numSlices: number; durationMs: number
  leverageBps: number; slippageBps: number; randomize: boolean; triggerPrice8dec: bigint; triggerDir: number
  minPrice8dec: bigint; maxPrice8dec: bigint; clientNonce: number
}

const digits = (v: bigint | number) => BigInt(v).toString()

/** snake_case, the chain's field order, every integer as its exact digits. */
export function twapBody(v: TwapValue, signature: string): string {
  const parts: Array<[string, string]> = [
    ['owner', JSON.stringify(v.owner)], ['pair_id', digits(v.pairId)], ['side', digits(v.side)], ['total_size_18dec', digits(v.totalSize18dec)],
    ['num_slices', digits(v.numSlices)], ['duration_ms', digits(v.durationMs)], ['leverage_bps', digits(v.leverageBps)], ['slippage_bps', digits(v.slippageBps)],
    ['randomize', v.randomize === true ? 'true' : 'false'], ['trigger_price_8dec', digits(v.triggerPrice8dec)], ['trigger_dir', digits(v.triggerDir)],
    ['min_price_8dec', digits(v.minPrice8dec)], ['max_price_8dec', digits(v.maxPrice8dec)], ['client_nonce', digits(v.clientNonce)], ['signature', JSON.stringify(signature)],
  ]
  return '{' + parts.map(([k, x]) => `${JSON.stringify(k)}:${x}`).join(',') + '}'
}

export function cancelTwapBody(owner: string, twapId: bigint | number, clientNonce: number, signature: string): string {
  return `{"owner":${JSON.stringify(owner)},"twap_id":${digits(twapId)},"client_nonce":${digits(clientNonce)},"signature":${JSON.stringify(signature)}}`
}

export function marginModeBody(owner: string, pairId: number, mode: number, nonce: number, signature: string): string {
  return `{"owner":"${owner.toLowerCase()}","pair_id":${digits(pairId)},"mode":${digits(mode)},"nonce":${digits(nonce)},"signature":"${signature}"}`
}

export interface TwapRules {
  path: string; cancelPath: string; minDurationMs: number; maxDurationMs: number; minIntervalMs: number
  maxSlices: number; maxSlippageBps: number; minSliceNotional6dec: number; minTotalNotional6dec: number
}

export const TWAP_BODY = ['owner', 'pair_id', 'side', 'total_size_18dec', 'num_slices', 'duration_ms', 'leverage_bps', 'slippage_bps',
  'randomize', 'trigger_price_8dec', 'trigger_dir', 'min_price_8dec', 'max_price_8dec', 'client_nonce', 'signature']

const val = (x: unknown) => (x && typeof x === 'object' && 'value' in (x as object) ? (x as { value: unknown }).value : x)
const num = (src: unknown, k: string): number | null => {
  const v = src && typeof src === 'object' ? val((src as Record<string, unknown>)[k]) : undefined
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  return null
}

/**
 * The spec's `twap` section. Refuses (NotAvailable, nothing signed) when it is not published, names another route, signs
 * another type or sends another body than this SDK, or does not publish its limits.
 */
export function readTwapRules(spec: unknown): TwapRules {
  const t = spec && typeof spec === 'object' ? (spec as Record<string, unknown>).twap as Record<string, unknown> | undefined : undefined
  if (!t || typeof t !== 'object' || t.liveToday === false || t.available === false) {
    const why = t && typeof t.reason === 'string' ? ` (${t.reason})` : ''
    throw new NotAvailable('The network does not publish TWAP placement' + why + '.')
  }
  const place = t.place as Record<string, unknown> | undefined
  const cancel = (t.cancel && typeof t.cancel === 'object' ? t.cancel : {}) as Record<string, unknown>
  if (!place || typeof place !== 'object') throw new NotAvailable("The network's TWAP section names no placement route.")
  const path = place.path
  if (place.method !== 'POST' || typeof path !== 'string' || !path.startsWith('/')) throw new NotAvailable('The network publishes a TWAP route this SDK cannot use.')
  if (val(place.typeString) !== TYPE_STRINGS.PlaceTwap) throw new NotAvailable('The network signs PlaceTwap in another format than this SDK; nothing is signed.')
  const body = (Array.isArray(place.body) ? place.body : []).map((b) => (b && typeof b === 'object' ? (b as { name?: unknown }).name : b)).filter((b) => b !== 'reduce_only')
  if (JSON.stringify(body) !== JSON.stringify(TWAP_BODY)) throw new NotAvailable('The network publishes a TWAP body this SDK does not send; nothing is signed.')
  const ct = val(cancel.typeString)
  if (ct !== undefined && ct !== null && ct !== TYPE_STRINGS.CancelTwap) throw new NotAvailable('The network signs CancelTwap in another format than this SDK; nothing is signed.')
  const lim = place.limits ?? t.limits
  const d = t.durationMs, so = t.subOrders
  let v: Array<number | null>
  if (lim && typeof lim === 'object') {
    v = [num(lim, 'minDurationMs'), num(lim, 'maxDurationMs'), num(lim, 'minIntervalMs'), num(lim, 'maxNumSlices'), num(lim, 'maxSlippageBps'),
      num(lim, 'minSubOrderNotional6dec') ?? 0, num(lim, 'minTotalNotional6dec')]
  } else if (d && typeof d === 'object' && so && typeof so === 'object') {
    v = [num(d, 'min'), num(d, 'max'), num(so, 'minIntervalMs'), num(so, 'maxNumSlices'), num(so, 'maxSlippageBpsPerSubOrder'),
      num(so, 'minSubOrderNotional6dec') ?? 0, num(so, 'minTotalNotional6dec')]
  } else v = [null]
  if (v.some((x) => x === null) || (v[0] as number) > (v[1] as number)) throw new NotAvailable('The network does not publish its TWAP limits, so an order cannot be checked before signing.')
  const [a, b, c, e, f, g, h] = v as number[]
  return { path, cancelPath: typeof cancel.path === 'string' ? cancel.path : '/twap/cancel', minDurationMs: a, maxDurationMs: b, minIntervalMs: c,
    maxSlices: e, maxSlippageBps: f, minSliceNotional6dec: g, minTotalNotional6dec: h }
}

/** [slices, interval ms]: as many slices as the limits allow, the interval being the duration shared out. */
export function planTwap(durationMs: number, r: TwapRules, totalNotional6dec?: number): [number, number] {
  if (durationMs < r.minDurationMs || durationMs > r.maxDurationMs) throw new InvalidRequest("The running time is outside the network's TWAP range.")
  let n = Math.min(r.maxSlices, Math.floor(durationMs / Math.max(1, r.minIntervalMs)))
  if (totalNotional6dec !== undefined) {
    if (totalNotional6dec < r.minTotalNotional6dec) throw new InvalidRequest("The order is smaller than the network's smallest TWAP.")
    n = Math.min(n, Math.floor(totalNotional6dec / Math.max(1, r.minSliceNotional6dec)))
  }
  if (n < 1) throw new InvalidRequest("No plan fits the network's TWAP limits.")
  return [n, Math.floor(durationMs / n)]
}
