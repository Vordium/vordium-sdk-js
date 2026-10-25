import { InvalidRequest, NotAvailable } from './errors.js'
import { U32, U64, U128, fromUnits, safeNumber, toUnits, uint } from './units.js'
import { checkNotional, leverageBpsExact, price8OnTick, size18OnLot, type PairSpec } from './rounding.js'

/**
 * Orders on the Vordex central limit order book.
 *
 * Units — signed fields use two scales: prices are 8-decimal integers (`price8`), sizes 18-decimal integers (`size18`).
 * The chain keeps a limit price at 6 decimals, so a signed price must be a multiple of 100.
 *
 * Single orders (`/order/place`) carry `side` and `orderType` by NAME ("buy"/"sell"; "Market"/"Limit", case-sensitive)
 * and the limit price as a decimal number; the signed digest carries the numbers. Stop orders are not available.
 */
export const SIDE = { buy: 0, sell: 1 } as const
export const ORDER_TYPE = { Market: 0, Limit: 1 } as const
export type Side = keyof typeof SIDE
export type OrderType = keyof typeof ORDER_TYPE

export const PRICE_DECIMALS = 8
export const SIZE_DECIMALS = 18
export const PRICE_STEP_8DEC = 100n

export const STOP_REFUSAL = 'Stop orders are not available: set a take-profit or stop-loss on the position instead.'

/** A limit price as signed: at most 6 decimals (the precision the chain keeps), as the 8-decimal integer. */
export function limitPrice8(price: string | number): bigint {
  const p = toUnits(price, 6, 'A limit price') * PRICE_STEP_8DEC
  if (p <= 0n || p > U64) throw new InvalidRequest('A limit price must be above zero.')
  return p
}

export function size18(size: string | number): bigint {
  const s = toUnits(size, SIZE_DECIMALS, 'A size')
  if (s <= 0n || s > U128) throw new InvalidRequest('A size must be above zero.')
  return s
}

/** Leverage as basis points, exactly from its decimal form (10x = 100000). */
export function leverageBps(leverage: number | string): number {
  if (typeof leverage === 'number' && !Number.isFinite(leverage)) throw new InvalidRequest('Leverage is at least 1x.')
  const b = leverageBpsExact(leverage)
  if (b < 10000n || b > U32) throw new InvalidRequest('Leverage is at least 1x.')
  return Number(b)
}

export interface PlaceOrderValue {
  owner: string
  pairId: number
  side: number
  size: bigint
  price: bigint
  leverageBps: number
  orderType: number
  reduceOnly: boolean
  postOnly: boolean
  triggerPrice8dec: bigint
  triggerDir: number
  clientNonce: number
}

export interface OrderInput {
  owner: string
  pairId: number
  side: Side
  /** Decimal size in the market's base unit, e.g. "0.05" (a bigint is a whole number of the base unit). */
  size: string | number | bigint
  orderType: OrderType
  /** Decimal limit price; required for Limit, refused for Market. */
  price?: string | number | bigint
  leverage?: number | string
  reduceOnly?: boolean
  postOnly?: boolean
  clientNonce: number
}

/**
 * The signed PlaceOrder value. Refuses stop orders, a priced market order and an unpriced limit order. The size and a
 * limit price go onto the market's lot and tick (`spec`; none = only the signed units): a buy's price rounds down and a
 * sell's up (at most 6 decimals), the size rounds down. A size that rounds to 0, below the market's smallest size, or a
 * limit order below the network's smallest order value is refused before signing.
 */
export function placeOrderValue(o: OrderInput, spec: PairSpec | null = null): PlaceOrderValue {
  if (!(o.side in SIDE)) throw new InvalidRequest(`side is buy or sell, not ${String(o.side)}.`)
  if (!(o.orderType in ORDER_TYPE)) throw new NotAvailable(STOP_REFUSAL)
  const priced = o.orderType === 'Limit'
  if (priced && (o.price === undefined || o.price === null)) throw new InvalidRequest('A limit order needs a price.')
  if (!priced && o.price !== undefined && o.price !== null) throw new InvalidRequest('A market order carries no price (it is signed with price 0).')
  if (o.postOnly && !priced) throw new InvalidRequest('Post-only applies to a limit order.')
  const size = size18OnLot(o.size, spec)
  const price = priced ? price8OnTick(o.price, spec, o.side, true) : 0n
  checkNotional(size, price, spec)
  return {
    owner: o.owner,
    pairId: safeNumber(uint(o.pairId, U32, 'pairId'), 'pairId'),
    side: SIDE[o.side],
    size,
    price,
    leverageBps: leverageBps(o.leverage ?? 1),
    orderType: ORDER_TYPE[o.orderType],
    reduceOnly: !!o.reduceOnly,
    postOnly: !!o.postOnly,
    triggerPrice8dec: 0n,
    triggerDir: 0,
    clientNonce: safeNumber(uint(o.clientNonce, U64, 'clientNonce'), 'clientNonce'),
  }
}

const SIDE_NAME = ['buy', 'sell'] as const
const TYPE_NAME = ['Market', 'Limit'] as const

/** The `/order/place` body for a signed PlaceOrder (`signature` = the 64-byte r‖s form). */
export function placeOrderBody(v: PlaceOrderValue, sessionKey: string, signature: string): Record<string, unknown> {
  if (v.orderType !== 0 && v.orderType !== 1) throw new NotAvailable(STOP_REFUSAL)
  if (v.triggerPrice8dec !== 0n || v.triggerDir !== 0) throw new NotAvailable('Trigger price and direction belong to stop orders, which are not available; send 0 for both.')
  const body: Record<string, unknown> = {
    owner: v.owner,
    pairId: v.pairId,
    side: SIDE_NAME[v.side],
    size_18dec: v.size.toString(),
    orderType: TYPE_NAME[v.orderType],
    reduceOnly: v.reduceOnly,
    leverageBps: v.leverageBps,
    clientNonce: v.clientNonce,
    sessionKey,
    post_only: v.postOnly,
    trigger_price_8dec: 0,
    trigger_dir: 0,
    signature,
  }
  if (v.orderType === 1) {
    if (v.price <= 0n || v.price % PRICE_STEP_8DEC !== 0n) throw new InvalidRequest('A limit price has at most 6 decimals.')
    body.price = Number(fromUnits(v.price, PRICE_DECIMALS))
  } else if (v.price !== 0n) {
    throw new InvalidRequest('A market order carries no price (it is signed with price 0).')
  }
  return body
}

export function cancelOrderBody(owner: string, sessionKey: string, orderId: bigint | number, signature: string): Record<string, unknown> {
  return { order_id: safeNumber(uint(orderId, U64, 'orderId'), 'orderId'), owner, session_key: sessionKey, signature }
}

/** The `/tpsl/set` body (prices are 8-decimal integers; 0 leaves a leg unset). */
export function setTpSlBody(owner: string, sessionKey: string, pairId: number, positionId: bigint | number, tp8: bigint, sl8: bigint, signature: string): Record<string, unknown> {
  return {
    action: 'perp_tpsl', owner, pair_id: pairId, position_id: safeNumber(uint(positionId, U64, 'positionId'), 'positionId'),
    take_profit_8dec: safeNumber(uint(tp8, U64, 'takeProfit'), 'takeProfit'), stop_loss_8dec: safeNumber(uint(sl8, U64, 'stopLoss'), 'stopLoss'),
    session_key: sessionKey, signature,
  }
}

// ── Batches (market makers) ─────────────────────────────────────────────────────────────────────────────────────────

export const ACTION_KIND = { place: 0, cancel: 1, cancelByClientNonce: 2 } as const
/** Batch order types: limit (good till cancelled), ioc, fok, market. */
export const BATCH_ORDER_TYPE = { market: 0, limit: 1, ioc: 4, fok: 5 } as const
export type BatchOrderType = keyof typeof BATCH_ORDER_TYPE
export const BATCH_MAX = 50

export interface BatchAction {
  kind: number; pairId: number; side: number; size: bigint; price: bigint; leverageBps: number
  orderType: number; reduceOnly: boolean; postOnly: boolean; clientNonce: number; orderId: bigint
}

export function batchPlace(a: {
  pairId: number; side: Side; size18: bigint | string; price8: bigint | string; clientNonce: number
  orderType?: BatchOrderType; postOnly?: boolean; reduceOnly?: boolean; leverageBps?: number
}): BatchAction {
  const ot = a.orderType ?? 'limit'
  if (!(a.side in SIDE)) throw new InvalidRequest(`side is buy or sell, not ${String(a.side)}.`)
  if (!(ot in BATCH_ORDER_TYPE)) throw new InvalidRequest(`order type is one of fok, ioc, limit, market; not ${String(ot)}.`)
  if (a.postOnly && ot !== 'limit') throw new InvalidRequest('Post-only applies to a resting limit order only.')
  const size = uint(a.size18, U128, 'size18')
  if (size === 0n) throw new InvalidRequest('size18 is zero.')
  const price = uint(a.price8, U64, 'price8')
  if (ot === 'market' && price !== 0n) throw new InvalidRequest('A market order carries no price (price8 0).')
  if (ot !== 'market' && price === 0n) throw new InvalidRequest(`A ${ot} order needs a price.`)
  return {
    kind: 0, pairId: safeNumber(uint(a.pairId, U32, 'pairId'), 'pairId'), side: SIDE[a.side], size, price,
    leverageBps: safeNumber(uint(a.leverageBps ?? 10000, U32, 'leverageBps'), 'leverageBps'), orderType: BATCH_ORDER_TYPE[ot],
    reduceOnly: !!a.reduceOnly, postOnly: !!a.postOnly, clientNonce: safeNumber(uint(a.clientNonce, U64, 'clientNonce'), 'clientNonce'), orderId: 0n,
  }
}

export function batchCancel(orderId: bigint | number): BatchAction {
  return { kind: 1, pairId: 0, side: 0, size: 0n, price: 0n, leverageBps: 0, orderType: 0, reduceOnly: false, postOnly: false, clientNonce: 0, orderId: uint(orderId, U64, 'orderId') }
}

export function batchCancelByClientNonce(clientNonce: number): BatchAction {
  return { kind: 2, pairId: 0, side: 0, size: 0n, price: 0n, leverageBps: 0, orderType: 0, reduceOnly: false, postOnly: false, clientNonce: safeNumber(uint(clientNonce, U64, 'clientNonce'), 'clientNonce'), orderId: 0n }
}

const BATCH_TYPE_NAME: Record<number, BatchOrderType> = { 0: 'market', 1: 'limit', 4: 'ioc', 5: 'fok' }

export function batchActionBody(a: BatchAction): Record<string, unknown> {
  if (a.kind === 1) return { kind: 'cancel', orderId: safeNumber(a.orderId, 'orderId') }
  if (a.kind === 2) return { kind: 'cancelByClientNonce', clientNonce: a.clientNonce }
  return {
    kind: 'place', pairId: a.pairId, side: SIDE_NAME[a.side], size_18dec: a.size.toString(), price_8dec: safeNumber(a.price, 'price8'),
    leverageBps: a.leverageBps, orderType: BATCH_TYPE_NAME[a.orderType], postOnly: a.postOnly, reduceOnly: a.reduceOnly, clientNonce: a.clientNonce,
  }
}

export function batchBody(owner: string, nonce: number, actions: BatchAction[], signature: string): Record<string, unknown> {
  return { owner, nonce, signature, actions: actions.map(batchActionBody) }
}

export function cancelAllBody(owner: string, pairId: number, nonce: number, signature: string): Record<string, unknown> {
  return { owner, pairId, nonce, signature }
}

export function modifyBody(owner: string, orderId: bigint, newPrice8: bigint, newSize18: bigint, clientNonce: number, signature: string): Record<string, unknown> {
  return { owner, orderId: safeNumber(orderId, 'orderId'), newPrice8dec: safeNumber(newPrice8, 'newPrice8'), newSize18dec: newSize18.toString(), clientNonce, signature }
}

export function scheduleCancelBody(owner: string, cancelAtMs: number, nonce: number, signature: string): Record<string, unknown> {
  return { owner, cancel_at_ms: cancelAtMs, nonce, signature }
}

// ── Tick and lot ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A price onto the pair's tick: a bid rounds down, an ask up (never more aggressive). Tick 0 = not enforced. */
export function roundPrice(price8: bigint, tick8: bigint, side: Side): bigint {
  if (tick8 <= 0n || price8 === 0n) return price8
  const r = price8 % tick8
  if (r === 0n) return price8
  return side === 'buy' ? price8 - r : price8 - r + tick8
}

/** A size down onto the pair's lot (never more than asked). Lot 0 = not enforced. */
export function roundSize(size18v: bigint, lot18: bigint): bigint {
  return lot18 <= 0n ? size18v : size18v - (size18v % lot18)
}

// ── Answers ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MESSAGES: Record<string, string> = {
  invalid_body: 'The request was refused before any signature check; a field is missing or malformed.',
  batch_size: 'A batch holds between 1 and the published maximum of actions.',
  unknown_order: 'That order is not open on this account.',
  insufficient_balance: "The account's free balance is too small for this.",
  bad_signature: 'The signature does not belong to the account or to a live session key of it.',
  not_active: 'This is not active on this network yet.',
  mempool_full: 'The network is busy; try again in a moment.',
  rate_limited: 'Order rate limit reached; this order was not placed. Cancels are never limited.',
  rate_burst: 'Too many orders in one block; spread them over the next blocks.',
  min_notional: 'The order is below the smallest order size.',
  too_many_open_orders: 'The account has reached its open-order limit.',
  price_band: 'The price is too far from the mark price.',
  price: 'The price is not accepted (it may be too far from the mark price or off the tick size).',
}

export interface Refusal { code: string; message: string; detail: string; retryAfter: number | null }
export interface ActionStatus { index: number; accepted: boolean; refusal: Refusal | null }
/** The answer to one write. `submitted` = accepted for a coming block (HTTP 202) — not applied. */
export interface Submitted { submitted: boolean; status: number; refusal: Refusal | null; actions: ActionStatus[]; answer: unknown }

export function refusal(code: string | null | undefined, error: unknown = '', retryAfter: number | null = null): Refusal {
  const text = error === null || error === undefined ? '' : String(error)
  if ((code ?? '') === 'price_band' || /too far from (the )?mark/i.test(text)) return { code: 'price_band', message: MESSAGES.price_band, detail: text, retryAfter }
  const c = code || (text ? 'refused' : 'http_error')
  return { code: c, message: MESSAGES[c] ?? (text || 'The request was refused.'), detail: text, retryAfter }
}

/** Read a write's answer by its published shape. Anything else is a refusal, never a success. */
export function readAnswer(status: number, body: unknown, retryAfter: string | null = null, meanings?: Map<string, string>): Submitted {
  const j = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  const ra = retryAfter !== null && Number.isFinite(Number(retryAfter)) ? Number(retryAfter) : null
  if (status === 202 && j.status === 'submitted') {
    const actions: ActionStatus[] = []
    for (const a of Array.isArray(j.actions) ? j.actions : []) {
      if (!a || typeof a !== 'object' || typeof (a as { index?: unknown }).index !== 'number') continue
      const x = a as { index: number; status?: unknown; code?: string; error?: unknown }
      actions.push(x.status === 'accepted' ? { index: x.index, accepted: true, refusal: null } : { index: x.index, accepted: false, refusal: refusal(x.code, x.error) })
    }
    return { submitted: true, status, refusal: null, actions, answer: body }
  }
  let code = typeof j.code === 'string' ? j.code : null
  if (status === 429 && !code) code = 'mempool_full'
  if (code === 'agent_refused') {   // an agent check at intake: the reason key and its meaning, as the chain gives them
    const reason = typeof j.reason === 'string' ? j.reason : ''
    const meaning = typeof j.meaning === 'string' ? j.meaning : (meanings?.get(reason) ?? '')
    return { submitted: false, status, refusal: { code: 'agent_refused', message: meaning || `The agent's action was refused (${reason || 'no reason given'}).`, detail: reason, retryAfter: ra }, actions: [], answer: body }
  }
  const err = j.error ?? j.reason ?? (status ? `HTTP ${status}` : '')
  return { submitted: false, status, refusal: refusal(code, err, ra), actions: [], answer: body }
}
