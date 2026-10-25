import { InvalidRequest } from './errors.js'

export const U32 = 2n ** 32n - 1n
export const U64 = 2n ** 64n - 1n
export const U128 = 2n ** 128n - 1n

/**
 * A decimal amount as an exact integer of base units. Accepts a decimal string ("2420.5") or a number; refuses more
 * decimals than the unit has (nothing is rounded silently: a rounded value would be a different signed value).
 */
export function toUnits(x: string | number | bigint, decimals: number, what = 'amount'): bigint {
  if (typeof x === 'bigint') {
    if (x < 0n) throw new InvalidRequest(`${what} cannot be negative.`)
    return x * 10n ** BigInt(decimals)
  }
  const s = typeof x === 'number' ? numberToDecimal(x) : x.trim()
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s)
  if (!m) throw new InvalidRequest(`${what} is not a positive decimal number (${String(x)}).`)
  const frac = (m[2] ?? '').replace(/0+$/, '')
  if (frac.length > decimals) throw new InvalidRequest(`${what} has more than ${decimals} decimals (${String(x)}).`)
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')
}

/** A number written out in full decimal form (no exponent), shortest round-trip digits. */
export function numberToDecimal(n: number): string {
  if (!Number.isFinite(n) || n < 0) throw new InvalidRequest(`${n} is not a positive number.`)
  const s = String(n)
  if (!/e/i.test(s)) return s
  const [mant, expS] = s.toLowerCase().split('e')
  const exp = Number(expS)
  const [ip, fp = ''] = mant.split('.')
  const digits = ip + fp
  const point = ip.length + exp
  if (point <= 0) return '0.' + '0'.repeat(-point) + digits
  if (point >= digits.length) return digits + '0'.repeat(point - digits.length)
  return digits.slice(0, point) + '.' + digits.slice(point)
}

/** Base units back to a decimal string, without trailing zeros. */
export function fromUnits(v: bigint, decimals: number): string {
  const neg = v < 0n
  const a = neg ? -v : v
  const d = 10n ** BigInt(decimals)
  const frac = (a % d).toString().padStart(decimals, '0').replace(/0+$/, '')
  return (neg ? '-' : '') + (a / d).toString() + (frac ? '.' + frac : '')
}

/** A whole number within range, as a bigint (accepts number, bigint or a digit string). */
export function uint(v: unknown, max: bigint, what: string): bigint {
  let b: bigint
  if (typeof v === 'bigint') b = v
  else if (typeof v === 'number' && Number.isSafeInteger(v)) b = BigInt(v)
  else if (typeof v === 'string' && /^\d+$/.test(v)) b = BigInt(v)
  else throw new InvalidRequest(`${what} is not a whole number.`)
  if (b < 0n || b > max) throw new InvalidRequest(`${what} is out of range.`)
  return b
}

/** A whole number that the body carries as a JSON number: it must be exact in JavaScript. */
export function safeNumber(v: bigint, what: string): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new InvalidRequest(`${what} is past the exact-integer range.`)
  return Number(v)
}
