import { VordiumError } from './errors.js'

/** Parsers for the account reads. Anything without the published shape raises, never a guess. */

const big = (v: unknown, what: string, allowNull = false): bigint | null => {
  if (v === null || v === undefined) {
    if (allowNull) return null
    throw new VordiumError('bad_read', `${what} is missing from the read.`)
  }
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v)
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v)
  throw new VordiumError('bad_read', `${what} is not a whole number in the read.`)
}

export interface OpenOrder {
  orderId: bigint
  clientNonce: number | null
  pairId: number
  side: 'buy' | 'sell'
  size18: bigint
  /** 0 for an order without a price. */
  price8: bigint
  status: string | null
  /** The key that signed it, as the node names it. */
  signer: string | null
  timestampMs: number | null
}

export function readOpenOrders(j: unknown): OpenOrder[] {
  if (!Array.isArray(j)) throw new VordiumError('bad_read', 'The open-orders read is not a list.')
  return j.map((o) => {
    if (!o || typeof o !== 'object') throw new VordiumError('bad_read', 'An open order is not an object.')
    const r = o as Record<string, unknown>
    const side = String(r.side ?? '').toLowerCase()
    if (side !== 'buy' && side !== 'sell') throw new VordiumError('bad_read', `An open order has no side (${String(r.side)}).`)
    const cn = big(r.client_nonce, 'client_nonce', true)
    const ts = big(r.timestamp_ms, 'timestamp_ms', true)
    return {
      orderId: big(r.id, 'id') as bigint, clientNonce: cn === null ? null : Number(cn), pairId: Number(big(r.pair_id, 'pair_id')), side,
      size18: big(r.size, 'size') as bigint, price8: big(r.price_8dec ?? 0, 'price_8dec') as bigint,
      status: typeof r.status === 'string' ? r.status.toLowerCase() : null, signer: typeof r.agent === 'string' ? r.agent : null,
      timestampMs: ts === null ? null : Number(ts),
    }
  })
}

export interface Position {
  positionId: bigint
  pairId: number
  isLong: boolean
  /** Exact at any size. */
  size18: bigint
  /** As the node gives it (6-decimal integer). */
  entryPrice: bigint
  leverage: bigint
  margin6: bigint
  unrealizedPnl6: bigint
  /** As the node computed it (6-decimal integer); see {@link saneLiquidationPrice}. */
  liquidationPrice: bigint
}

export function readPositions(j: unknown): Position[] {
  if (!Array.isArray(j)) throw new VordiumError('bad_read', 'The positions read is not a list.')
  return j.map((p) => {
    if (!p || typeof p !== 'object' || typeof (p as { is_long?: unknown }).is_long !== 'boolean') throw new VordiumError('bad_read', 'A position does not have the published shape.')
    const r = p as Record<string, unknown>
    return {
      positionId: big(r.id, 'id') as bigint, pairId: Number(big(r.pair_id, 'pair_id')), isLong: r.is_long as boolean, size18: big(r.size, 'size') as bigint,
      entryPrice: big(r.entry_price, 'entry_price') as bigint, leverage: big(r.leverage, 'leverage') as bigint, margin6: big(r.margin, 'margin') as bigint,
      unrealizedPnl6: big(r.unrealized_pnl, 'unrealized_pnl') as bigint, liquidationPrice: big(r.liquidation_price, 'liquidation_price') as bigint,
    }
  })
}

/**
 * The chain's liquidation price, only when it makes sense for the position: below the entry for a long (and no lower
 * than the entry at its leverage less 5%), above it for a short. Otherwise null — "not available", never a guess.
 */
export function saneLiquidationPrice(p: Position): bigint | null {
  const lev = p.leverage >= 1n ? p.leverage : 1n
  const e = p.entryPrice, l = p.liquidationPrice
  if (e <= 0n || l <= 0n) return null
  // long: entry × (1 − 1/lev) − 5% ≤ liq < entry ; short: entry < liq ≤ entry × (1 + 1/lev) + 5%
  if (p.isLong) {
    const floor = (e * (lev - 1n) * 100n) / (lev * 100n) - e / 20n
    return l < e && l >= floor ? l : null
  }
  const ceil = (e * (lev + 1n)) / lev + e / 20n
  return l > e && l <= ceil ? l : null
}

export interface Equity {
  usdcBalance6: bigint; reservedOrders6: bigint; inPositions6: bigint
  /** What a new order can use as margin. */
  freeBalance6: bigint
  unrealizedPnl6: bigint; totalEquity6: bigint
}

export function readEquity(j: unknown): Equity {
  if (!j || typeof j !== 'object') throw new VordiumError('bad_read', 'The equity read is not an object.')
  const r = j as Record<string, unknown>
  return {
    usdcBalance6: big(r.usdc_balance, 'usdc_balance') as bigint, reservedOrders6: big(r.reserved_orders, 'reserved_orders') as bigint,
    inPositions6: big(r.in_positions, 'in_positions') as bigint, freeBalance6: big(r.free_balance, 'free_balance') as bigint,
    unrealizedPnl6: big(r.unrealized_pnl, 'unrealized_pnl') as bigint, totalEquity6: big(r.total_equity, 'total_equity') as bigint,
  }
}

/**
 * The meaning of each agent refusal reason, from the network spec's `agents.refusalCodes.reasons` (key → plain
 * sentence). Empty when the network does not publish them; a reason without a published meaning is then shown as the
 * chain wrote it.
 */
export function refusalMeanings(spec: unknown): Map<string, string> {
  const out = new Map<string, string>()
  const rc = spec && typeof spec === 'object' ? ((spec as Record<string, unknown>).agents as Record<string, unknown> | undefined)?.refusalCodes : undefined
  const reasons = rc && typeof rc === 'object' ? (rc as Record<string, unknown>).reasons : undefined
  if (Array.isArray(reasons)) {
    for (const r of reasons) {
      if (r && typeof r === 'object' && typeof (r as { key?: unknown }).key === 'string' && typeof (r as { meaning?: unknown }).meaning === 'string') {
        out.set((r as { key: string }).key, (r as { meaning: string }).meaning)
      }
    }
  }
  return out
}

/** One action the chain refused for an agent (from `/events/agent/{agent}`): the reason key and, when the network publishes it, its meaning. */
export interface AgentRefusal { reason: string; meaning: string | null; height: number | null; timestampMs: number | null; record: Record<string, unknown> }

export function readAgentRefusals(j: unknown, meanings: Map<string, string> = new Map()): AgentRefusal[] {
  const list = j && typeof j === 'object' ? ((j as Record<string, unknown>).events ?? (j as Record<string, unknown>).records ?? (j as Record<string, unknown>).items) : null
  if (!Array.isArray(list)) return []
  const out: AgentRefusal[] = []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const r = e as Record<string, unknown>
    if (r.kind !== 'agent_refused') continue
    const data = (r.data && typeof r.data === 'object' ? r.data : r) as Record<string, unknown>
    const reason = String(data.reason ?? r.reason ?? '')
    out.push({
      reason, meaning: meanings.get(reason) ?? null, height: typeof r.height === 'number' ? r.height : null,
      timestampMs: typeof r.at_ms === 'number' ? r.at_ms : typeof r.timestamp_ms === 'number' ? r.timestamp_ms : null, record: r,
    })
  }
  return out
}
