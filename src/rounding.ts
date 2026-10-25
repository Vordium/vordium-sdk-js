import { InvalidRequest } from './errors.js'
import { U64, U128, numberToDecimal } from './units.js'

/**
 * Exact order units on each market's tick and lot.
 *
 * The chain keeps a price step (`tick_8dec`) and a size step (`lot_18dec`) per market, published in `GET /markets/specs`,
 * and does not apply an order that is off them. Every order this SDK signs is put on them first:
 *
 * - a number is read exactly from its decimal form: a decimal string ("2420.5", ".5", "1e-4"), a bigint, or a number from
 *   its shortest decimal form (0.1 is 0.1). Nothing is multiplied as a floating-point number;
 * - a limit price rounds toward the passive side: a buy's DOWN, a sell's UP onto the tick (never a worse price than
 *   asked). On `/order/place` it is also kept at 6 decimals (a multiple of 100 in 8-decimal units);
 * - a take-profit / stop-loss trigger goes to the NEAREST tick (a half tick rounds up);
 * - a size rounds DOWN onto the lot (never more than asked);
 * - a tick or lot of 0 means the network sets none: only the signed unit applies.
 *
 * Refused before anything is signed ({@link OrderValueError}): a size that rounds to 0 or is below the market's smallest
 * size, a limit price that rounds to 0, a priced order below the network's smallest order value, a market the network does
 * not list.
 */

export class OrderValueError extends InvalidRequest {
  constructor(message: string) {
    super(message)
    this.name = 'OrderValueError'
  }
}

/** The market rules (`GET /markets/specs`) could not be read, so no order value can be put on its step. */
export class SpecsUnavailable extends OrderValueError {
  constructor(message: string) {
    super(message)
    this.name = 'SpecsUnavailable'
  }
}

export interface PairSpec {
  pairId: number
  symbol: string
  tick8: bigint
  lot18: bigint
  minSize18: bigint
  minNotional6: bigint
}

const PRICE_DECIMALS = 8
const SIZE_DECIMALS = 18
export const PLACE_PRICE_STEP_8DEC = 100n

const PLAIN = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/** `x` × 10^`decimals` as an exact fraction [numerator, denominator]. */
export function scaled(x: unknown, decimals: number, what = 'a value'): [bigint, bigint] {
  let s: string
  if (typeof x === 'bigint') {
    if (x < 0n) throw new OrderValueError(`${what} cannot be negative (${x}).`)
    return [x * 10n ** BigInt(decimals), 1n]
  } else if (typeof x === 'number') {
    if (!Number.isFinite(x)) throw new OrderValueError(`${what} is not a finite number (${x}).`)
    if (x < 0) throw new OrderValueError(`${what} cannot be negative (${x}).`)
    s = numberToDecimal(x)
  } else if (typeof x === 'string') {
    if (!PLAIN.test(x)) throw new OrderValueError(`${what} is not a plain decimal number (${JSON.stringify(x)}).`)
    s = x
  } else {
    throw new OrderValueError(`${what} is not a number (${String(x)}).`)
  }
  const [mant, expS] = s.toLowerCase().split('e')
  const [ip, fp = ''] = mant.split('.')
  let n = BigInt((ip || '0') + fp || '0')
  let exp = BigInt(decimals) - BigInt(fp.length) + (expS === undefined ? 0n : BigInt(expS))
  let d = 1n
  if (exp >= 0n) n *= 10n ** exp
  else d = 10n ** -exp
  return [n, d]
}

/** A count of base units: a whole number (bigint, safe-integer number, digit string, or an integral decimal). */
export function whole(x: unknown, what = 'a value'): bigint {
  const [n, d] = scaled(x, 0, what)
  if (n % d !== 0n) throw new OrderValueError(`${what} is a count of base units and must be a whole number (${String(x)}).`)
  return n / d
}

function gcd(a: bigint, b: bigint): bigint {
  while (b) [a, b] = [b, a % b]
  return a
}

/** num/den onto a multiple of `step`: down, up, or nearest (a half step rounds up). */
export function onStep(num: bigint, den: bigint, step: bigint, mode: 'down' | 'up' | 'nearest'): bigint {
  if (step <= 0n) throw new RangeError('a step is at least 1')
  const q = num / (den * step), r = num % (den * step)
  if (r === 0n || mode === 'down') return q * step
  if (mode === 'up') return (q + 1n) * step
  return 2n * r >= den * step ? (q + 1n) * step : q * step
}

function sideOf(side: unknown): 'buy' | 'sell' {
  if (side === 'buy' || side === 0) return 'buy'
  if (side === 'sell' || side === 1) return 'sell'
  throw new OrderValueError(`side is buy or sell, not ${String(side)}.`)
}

export function priceStep(spec: PairSpec | null, placeRoute = true): bigint {
  const tick = spec?.tick8 ?? 0n
  const base = placeRoute ? PLACE_PRICE_STEP_8DEC : 1n
  return tick > 0n ? (tick * base) / gcd(tick, base) : base
}

export function sizeStep(spec: PairSpec | null): bigint {
  const lot = spec?.lot18 ?? 0n
  return lot > 0n ? lot : 1n
}

function inPrice(out: bigint, what: string): bigint {
  if (out <= 0n) throw new OrderValueError(`${what} rounds to 0 on this market's tick.`)
  if (out > U64) throw new OrderValueError(`${what} is out of range.`)
  return out
}

/** A limit price as the signed 8-decimal integer on the tick: a buy's rounds down, a sell's up. */
export function price8OnTick(price: unknown, spec: PairSpec | null, side: unknown, placeRoute = true): bigint {
  const [n, d] = scaled(price, PRICE_DECIMALS, 'a limit price')
  return inPrice(onStep(n, d, priceStep(spec, placeRoute), sideOf(side) === 'buy' ? 'down' : 'up'), `the limit price ${String(price)}`)
}

/** A size as the signed 18-decimal integer, down onto the lot. */
export function size18OnLot(size: unknown, spec: PairSpec | null): bigint {
  const [n, d] = scaled(size, SIZE_DECIMALS, 'a size')
  return checkSize(onStep(n, d, sizeStep(spec), 'down'), spec, size)
}

/** A take-profit / stop-loss trigger as the 8-decimal integer, to the nearest tick (0 = no trigger). */
export function trigger8OnTick(price: unknown, spec: PairSpec | null): bigint {
  const [n, d] = scaled(price, PRICE_DECIMALS, 'a trigger price')
  if (n === 0n) return 0n
  return inPrice(onStep(n, d, priceStep(spec, false), 'nearest'), `the trigger price ${String(price)}`)
}

/** A signed 8-decimal price already in base units, onto the tick by the passive rule (0 stays 0: no price). */
export function snapPrice8(price8: unknown, spec: PairSpec | null, side: unknown, placeRoute = false): bigint {
  const p = whole(price8, 'price8')
  if (p === 0n) return 0n
  return inPrice(onStep(p, 1n, priceStep(spec, placeRoute), sideOf(side) === 'buy' ? 'down' : 'up'), `the price ${p}`)
}

export function snapSize18(size18: unknown, spec: PairSpec | null): bigint {
  const s = whole(size18, 'size18')
  return checkSize(s - (s % sizeStep(spec)), spec, size18)
}

export function snapTrigger8(price8: unknown, spec: PairSpec | null): bigint {
  const p = whole(price8, 'trigger price')
  if (p === 0n) return 0n
  return inPrice(onStep(p, 1n, priceStep(spec, false), 'nearest'), `the trigger price ${p}`)
}

export function checkSize(size18: bigint, spec: PairSpec | null, asked?: unknown): bigint {
  if (size18 <= 0n) {
    const lot = sizeStep(spec)
    throw new OrderValueError(lot > 1n ? `the size ${String(asked)} rounds to 0 on this market's lot (${lot} base units).` : `the size ${String(asked)} is below one base unit.`)
  }
  if (size18 > U128) throw new OrderValueError('the size is out of range.')
  const min = spec?.minSize18 ?? 0n
  if (min > 0n && size18 < min) throw new OrderValueError(`the size is below this market's smallest order (${min} base units).`)
  return size18
}

/** size × price in USDC base units (6 decimals), rounded down. */
export function notional6(size18: bigint, price8: bigint): bigint {
  return (size18 * price8) / 10n ** 20n
}

export function checkNotional(size18: bigint, price8: bigint, spec: PairSpec | null): void {
  const min = spec?.minNotional6 ?? 0n
  if (min > 0n && price8 > 0n && notional6(size18, price8) < min) {
    throw new OrderValueError(`the order's value is below the smallest order the network takes (${Number(min) / 1e6} USDC).`)
  }
}

/** Leverage (2 or "2.5") as basis points, exactly (half to even). */
export function leverageBpsExact(leverage: unknown): bigint {
  const [n, d] = scaled(leverage, 4, 'leverage')
  const q = n / d, r = n % d
  return q + (2n * r > d || (2n * r === d && q % 2n === 1n) ? 1n : 0n)
}

// ── the market rules ────────────────────────────────────────────────────────────────────────────────────────────

/** Every market without a tick, lot or minimum: for dry runs and offline tests. Never what a network publishes. */
export const NO_RULES = Object.freeze({ noRules: true as const })
export type MarketRules = Map<number, PairSpec> | typeof NO_RULES

function count(v: unknown): bigint {
  if (typeof v === 'bigint' && v >= 0n) return v
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v)
  if (v === undefined || v === null || v === '') return 0n
  throw new OrderValueError(`a market rule is not a whole number (${String(v)}).`)
}

/** Each market's tick, lot and smallest size from a `/markets/specs` read, with the network's smallest order value. */
export function pairSpecs(read: unknown): Map<number, PairSpec> {
  const s = read && typeof read === 'object' ? (read as { specs?: unknown }).specs : null
  if (!s || typeof s !== 'object') throw new OrderValueError('the market rules read has no specs; nothing was signed.')
  const sp = s as { pairs?: unknown; min_order_notional_6dec?: unknown }
  const minNotional6 = count(sp.min_order_notional_6dec)
  const out = new Map<number, PairSpec>()
  for (const p of Array.isArray(sp.pairs) ? sp.pairs : []) {
    const pr = (p && typeof p === 'object' ? (p as { pair?: unknown }).pair : null) as Record<string, unknown> | null
    const pid = pr?.pair_id
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid)) continue
    const q = p as Record<string, unknown>
    out.set(pid, { pairId: pid, symbol: String(pr?.symbol ?? pr?.name ?? pid), tick8: count(q.tick_8dec), lot18: count(q.lot_18dec),
      minSize18: count(pr?.min_size_18dec), minNotional6 })
  }
  return out
}

/** One market's rules; a market the read does not list is refused. */
export function selectSpec(rules: MarketRules, pairId: number): PairSpec {
  if ('noRules' in rules) return { pairId, symbol: String(pairId), tick8: 0n, lot18: 0n, minSize18: 0n, minNotional6: 0n }
  const s = rules.get(pairId)
  if (!s) throw new OrderValueError(`the network lists no market ${pairId} (GET /markets/specs).`)
  return s
}

/** A /markets/specs read, a parsed map, or NO_RULES, as market rules. */
export function marketRules(x: unknown): MarketRules {
  if (x === NO_RULES) return NO_RULES
  if (x instanceof Map) return x as Map<number, PairSpec>
  return pairSpecs(x)
}
