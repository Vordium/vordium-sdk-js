import { getAddress } from 'ethers'
import {
  MODE_CODE, cancelTwapBody, marginModeBody, nextNonce, planTwap, readTwapRules, sessionCreateBody, sessionEnd, sessionRevokeBody, twapBody,
  type MarginMode, type TwapRules, type TwapValue,
} from './account.js'
import {
  LOWERCASE_ADDRESS_OPS, loosens, policyFromRead, policyProblems, policyValue, requireName, submitBody, type AgentOp, type PolicyV1,
} from './agents.js'
import { domain, type DomainClass, type TypedDomain } from './domains.js'
import { InvalidRequest, NetworkMismatch, VordiumError } from './errors.js'
import { fetchTransport, type Transport } from './http.js'
import { connectNetwork, nodeIdentity, type Network, type NetworkPreset } from './network.js'
import { nonceClock, type NonceClock } from './nonce.js'
import {
  BATCH_MAX, batchBody, cancelAllBody, cancelOrderBody, modifyBody, placeOrderBody, placeOrderValue, readAnswer, scheduleCancelBody, setTpSlBody,
  type BatchAction, type OrderInput, type Submitted,
} from './orders.js'
import { readAgentRefusals, refusalMeanings, readEquity, readOpenOrders, readPositions, type AgentRefusal, type Equity, type OpenOrder, type Position } from './reads.js'
import { rs64, signOp, type TypedSigner } from './sign.js'
import { U32, U64, U128, safeNumber, uint } from './units.js'
import {
  OrderValueError, SpecsUnavailable, checkNotional, checkSize, marketRules, selectSpec, sizeStep, snapPrice8, snapSize18, snapTrigger8,
  type MarketRules, type PairSpec,
} from './rounding.js'
import { domainOf, type PrimaryType } from './types.js'

/**
 * The result of a write. `applied` is true only once the chain's own read shows the change. A submission (HTTP 202) is
 * not an application: `applied: false` with the chain's answer means the chain has not shown it (yet, or at all).
 */
export interface Result {
  applied: boolean
  status: number
  answer: unknown
  detail: string
}

export interface ConnectOptions {
  network?: 'mainnet' | 'testnet' | NetworkPreset
  transport?: Transport
  timeoutMs?: number
  /** How long a checked node identity is trusted before it is read again (ms). */
  identityTtlMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Read the chain until `fn` is true or `ms` runs out. A failed read counts as "not yet". */
async function waitFor(fn: () => Promise<boolean>, ms: number, stepMs = 1000): Promise<boolean> {
  const end = Date.now() + ms
  for (;;) {
    try { if (await fn()) return true } catch { /* not yet */ }
    if (Date.now() >= end) return false
    await sleep(stepMs)
  }
}

/** A connection to one Vordium network: reads, and the signing domains of its node. */
export class Vordium {
  readonly network: Network
  private readonly transport: Transport
  private readonly timeoutMs: number
  private readonly ttlMs: number
  private checkedAt = Date.now()

  private constructor(network: Network, transport: Transport, timeoutMs: number, ttlMs: number) {
    this.network = network
    this.transport = transport
    this.timeoutMs = timeoutMs
    this.ttlMs = ttlMs
  }

  /** Read and check the network (spec, node and JSON-RPC must agree) and return a client for it. Testnet by default. */
  static async connect(opts: ConnectOptions = {}): Promise<Vordium> {
    const transport = opts.transport ?? fetchTransport
    const timeoutMs = opts.timeoutMs ?? 15000
    const net = await connectNetwork(opts.network ?? 'testnet', { transport, timeoutMs })
    return new Vordium(net, transport, timeoutMs, opts.identityTtlMs ?? 60000)
  }

  /**
   * The signing domain of the node this client posts to. The node's identity is read again after the TTL; a node that
   * now serves another chain is refused, never followed.
   */
  async domain(cls: DomainClass): Promise<TypedDomain> {
    if (Date.now() - this.checkedAt >= this.ttlMs) {
      const id = await nodeIdentity(this.network.api, this.transport, this.timeoutMs)
      if (id.chainId !== this.network.chainId || id.genesis !== this.network.genesis) {
        throw new NetworkMismatch(`The node now serves chain ${id.chainId} genesis ${id.genesis.slice(0, 8)}…, not the chain this client signs for; refusing to sign.`)
      }
      this.checkedAt = Date.now()
    }
    return domain(cls, this.network.chainId, this.network.genesis)
  }

  // ── reads ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** GET a path of the REST API; null on 404, raises on another failure. */
  async get(path: string): Promise<unknown> {
    const r = await this.transport.get(this.network.api + path, this.timeoutMs)
    if (r.status === 404) return null
    if (r.status !== 200) throw new VordiumError('read_failed', `The read ${path} answered HTTP ${r.status}.`)
    return r.body
  }

  async post(path: string, body: string): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
    return this.transport.post(this.network.api + path, body, this.timeoutMs)
  }

  status() { return this.get('/status') }
  /** Perpetual markets with their lifecycle and limits. */
  markets() { return this.get('/api/pairs/perps') }
  /** Per-market rules from committed state: tick, lot, margins, fees, limits. */
  marketSpecs() { return this.get('/markets/specs') }
  /** The market rules read now (never cached): every market's tick, lot and minimums. */
  async marketRules(): Promise<MarketRules> {
    let j: unknown
    try { j = await this.marketSpecs() } catch (e) {
      throw new SpecsUnavailable(`The market rules could not be read (${(e as Error).message}); nothing was signed.`)
    }
    if (!j || typeof j !== 'object' || !(j as { specs?: unknown }).specs) throw new SpecsUnavailable('The market rules read has no specs; nothing was signed.')
    return marketRules(j)
  }
  orderbook(pairId: number) { return this.get(`/orderbook/${pairId}`) }
  oracle(pairId: number) { return this.get(`/oracle/${pairId}`) }
  funding(pairId: number) { return this.get(`/funding/${pairId}`) }
  /** The truth endpoint: facts the network vouches for. */
  truth() { return this.get('/truth/v1') }

  async equity(address: string): Promise<Equity> { return readEquity(await this.get(`/account/equity/${address}`)) }
  async positions(address: string): Promise<Position[]> { return readPositions((await this.get(`/positions/${address}`)) ?? []) }
  async openOrders(address: string): Promise<OpenOrder[]> { return readOpenOrders((await this.get(`/orders/${address}`)) ?? []) }
  /** The account's fills (newest first). */
  orderHistory(address: string, limit = 50) { return this.get(`/orders/history/${address}?limit=${limit}`) }
  /** The account's order records (order_placed, fill, order_closed with its status, …), newest first. */
  async orderRecords(address: string, limit = 50): Promise<Array<Record<string, unknown>>> {
    const j = await this.get(`/events/account/${address.toLowerCase()}?limit=${limit}`)
    const ev = j && typeof j === 'object' ? (j as { events?: unknown }).events : null
    return Array.isArray(ev) ? (ev as Array<Record<string, unknown>>) : []
  }

  /** The session the chain holds for `owner`: {session_key, expires_at, confirmed}, or null. */
  async session(owner: string): Promise<{ session_key: string; expires_at: number; confirmed?: boolean } | null> {
    const j = await this.get(`/session/get?owner=${owner}`)
    return j && typeof j === 'object' && typeof (j as { session_key?: unknown }).session_key === 'string' ? (j as { session_key: string; expires_at: number; confirmed?: boolean }) : null
  }

  agents(owner: string) { return this.get(`/agents/${owner}`) }
  /** One agent's committed record (name, status, policy_v1, risk_v1, market limits), or null. */
  async agent(owner: string, agent: string): Promise<Record<string, unknown> | null> {
    const j = await this.get(`/agents/${owner}/${agent}`)
    return j && typeof j === 'object' && (j as { found?: unknown }).found !== false ? (j as Record<string, unknown>) : null
  }
  /** The actions the chain refused for an agent, with the reason it wrote (a refused agent order is answered 202). */
  async agentRefusals(agent: string, limit = 50): Promise<AgentRefusal[]> {
    return readAgentRefusals(await this.get(`/events/agent/${agent.toLowerCase()}?limit=${limit}`), this.refusalMeanings())
  }
  /** Agent refusal reasons and their meanings as the network publishes them (empty when it does not). */
  refusalMeanings(): Map<string, string> { return refusalMeanings(this.network.specRead) }
  /** The rename wait (ms) the network publishes for agent names, or null when it publishes none. */
  renameWaitMs(): number | null {
    const v = ((this.network.specRead.agents as Record<string, unknown> | undefined)?.nameRule as Record<string, unknown> | undefined)?.renameCooldownMs
    const n = v && typeof v === 'object' ? (v as { value?: unknown }).value : v
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  async twaps(owner: string): Promise<Array<Record<string, unknown>>> {
    const j = await this.get(`/twaps/${owner.toLowerCase()}`)
    const rows = j && typeof j === 'object' && !Array.isArray(j) ? (j as { twaps?: unknown }).twaps : j
    return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []
  }
  /** The cross-margin read: account value, maintenance, withdrawable, each market's mode. */
  crossMargin(owner: string) { return this.get(`/account/cross/${owner}`) }
  /** The dead-man switch's committed state and limits. */
  scheduleCancelState(owner: string) { return this.get(`/schedule-cancel/${owner}`) }

  /** The TWAP route and limits from the network spec (refused when not published). */
  twapRules(): TwapRules { return readTwapRules(this.network.specRead) }

  /** A trading account: `owner` signs account operations; `sessionSigner` (a session or agent key) signs orders. */
  async account(owner: TypedSigner, opts: { sessionSigner?: TypedSigner; nonce?: NonceClock; specs?: unknown } = {}): Promise<Account> {
    const address = getAddress(await owner.getAddress())
    return new Account(this, address, owner, opts.sessionSigner ?? null, opts.nonce ?? nonceClock(address), opts.specs === undefined ? null : marketRules(opts.specs))
  }

  /** An agent's own handle: places orders with the agent key for its owner, and may tighten its own policy. */
  async agentKey(owner: string, agentSigner: TypedSigner, opts: { specs?: unknown } = {}): Promise<Account> {
    const o = getAddress(owner)
    return new Account(this, o, null, agentSigner, nonceClock(o), opts.specs === undefined ? null : marketRules(opts.specs))
  }
}

/** One account's writes. Every write is signed under the node's own genesis-bound domain. */
export class Account {
  constructor(
    readonly client: Vordium,
    readonly owner: string,
    private readonly ownerSigner: TypedSigner | null,
    private readonly sessionSigner: TypedSigner | null,
    readonly nonce: NonceClock,
    /** Market rules this handle holds; null = read them from the node for each order. */
    readonly specs: MarketRules | null = null,
  ) {}

  /** The rules an order uses: the ones this handle holds, else read from the node now. */
  async rules(): Promise<MarketRules> { return this.specs ?? (await this.client.marketRules()) }
  /** One market's tick, lot and minimums. */
  async pairSpec(pairId: number): Promise<PairSpec> { return selectSpec(await this.rules(), pairId) }

  private needOwner(what: string): TypedSigner {
    if (!this.ownerSigner) throw new InvalidRequest(`${what} is signed by the account's own key; this handle holds only an agent or session key.`)
    return this.ownerSigner
  }
  /** Orders are signed by the session (or agent) key, else by the owner key. */
  private orderSigner(): TypedSigner {
    const s = this.sessionSigner ?? this.ownerSigner
    if (!s) throw new InvalidRequest('No key to sign orders with.')
    return s
  }
  private async sign(signer: TypedSigner, primary: PrimaryType, value: Record<string, unknown>): Promise<string> {
    return signOp(signer, await this.client.domain(domainOf(primary)), primary, value)
  }
  private async send(path: string, body: unknown): Promise<Submitted> {
    const r = await this.client.post(path, typeof body === 'string' ? body : JSON.stringify(body))
    return readAnswer(r.status, r.body, r.retryAfter, this.client.refusalMeanings())
  }

  // ── orders ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Sign and submit one order (Market or Limit). The answer is a submission; the order is on the book when
   * {@link Vordium.openOrders} lists its `clientNonce`, or filled when the account's fills show it. Use
   * {@link waitForOrder} to read it back.
   */
  async placeOrder(o: Omit<OrderInput, 'owner' | 'clientNonce'> & { clientNonce?: number }): Promise<Submitted & { clientNonce: number }> {
    const signer = this.orderSigner()
    const clientNonce = o.clientNonce ?? this.nonce.next()
    placeOrderValue({ ...o, owner: this.owner, clientNonce })            // refusals that need no market rules come first
    const v = placeOrderValue({ ...o, owner: this.owner, clientNonce }, await this.pairSpec(o.pairId))
    const sig = await this.sign(signer, 'PlaceOrder', v as unknown as Record<string, unknown>)
    const body = placeOrderBody(v, getAddress(await signer.getAddress()), rs64(sig))
    const r = await this.client.post('/order/place', JSON.stringify(body))
    const s = readAnswer(r.status === 200 && (r.body as { status?: unknown })?.status === 'submitted' ? 202 : r.status, r.body, r.retryAfter, this.client.refusalMeanings())
    return { ...s, status: r.status, clientNonce }
  }

  /**
   * Where the order with `clientNonce` stands, from the chain: `resting` while the book holds it, else what the account's
   * order records say (`filled`, `cancelled`, `expired`), or null when the chain has no record of it (a refused order
   * has none). Reads until it is known or `ms` runs out. With `final: true` (a market order, or an order you expect to
   * end) it waits for the order's closing record: the book can list an order for a moment before it fills.
   */
  async waitForOrder(clientNonce: number, ms = 20000, opts: { final?: boolean } = {}): Promise<'resting' | 'filled' | 'cancelled' | 'expired' | null> {
    let state: 'resting' | 'filled' | 'cancelled' | 'expired' | null = null
    await waitFor(async () => {
      if (!opts.final && (await this.client.openOrders(this.owner)).some((x) => x.clientNonce === clientNonce)) { state = 'resting'; return true }
      const closed = (await this.client.orderRecords(this.owner)).find((e) => e.kind === 'order_closed' && String(e.client_nonce) === String(clientNonce))
      const st = closed ? String(closed.status) : ''
      if (st === 'filled' || st === 'cancelled' || st === 'expired') { state = st; return true }
      return false
    }, ms)
    return state
  }

  async cancelOrder(orderId: bigint | number): Promise<Submitted> {
    const signer = this.orderSigner()
    const id = uint(orderId, U64, 'orderId')
    const sig = await this.sign(signer, 'CancelOrder', { owner: this.owner, orderId: id })
    const r = await this.client.post('/order/cancel', JSON.stringify(cancelOrderBody(this.owner, getAddress(await signer.getAddress()), id, rs64(sig))))
    return readAnswer(r.status === 200 && (r.body as { status?: unknown })?.status === 'submitted' ? 202 : r.status, r.body, r.retryAfter, this.client.refusalMeanings())
  }

  /** Take-profit / stop-loss on an open position (8-decimal prices; 0 leaves a leg unset). */
  async setTpSl(pairId: number, positionId: bigint | number, takeProfit8: bigint, stopLoss8: bigint): Promise<Submitted> {
    const signer = this.orderSigner()
    const p = safeNumber(uint(pairId, U32, 'pairId'), 'pairId')
    const spec = await this.pairSpec(p)
    const value = { owner: this.owner, pairId: p, positionId: uint(positionId, U64, 'positionId'),
      takeProfit8dec: snapTrigger8(uint(takeProfit8, U64, 'takeProfit'), spec), stopLoss8dec: snapTrigger8(uint(stopLoss8, U64, 'stopLoss'), spec) }
    const sig = await this.sign(signer, 'SetTpSl', value)
    return this.send('/tpsl/set', setTpSlBody(this.owner, getAddress(await signer.getAddress()), value.pairId, value.positionId, value.takeProfit8dec, value.stopLoss8dec, sig))
  }

  /** Up to the published maximum of place / cancel actions in one signed batch. Cancels apply first. */
  async batch(actions: BatchAction[], opts: { nonce?: number; maxActions?: number } = {}): Promise<Submitted & { nonce: number }> {
    const max = opts.maxActions ?? BATCH_MAX
    if (actions.length < 1 || actions.length > max) throw new InvalidRequest(`A batch holds 1 to ${max} actions, not ${actions.length}.`)
    actions = await this.onSteps(actions)
    const nonce = opts.nonce ?? this.nonce.next()
    const sig = await this.sign(this.orderSigner(), 'BatchOrders', { owner: this.owner, nonce, actions })
    return { ...(await this.send('/order/batch-signed', batchBody(this.owner, nonce, actions, sig))), nonce }
  }

  /**
   * The batch as it will be signed: every place action's price and size on its market's tick and lot (one rules read
   * per batch). Refuses, before signing, a size that rounds to 0 or an order below the network's minimum.
   */
  async onSteps(actions: BatchAction[]): Promise<BatchAction[]> {
    if (!actions.some((a) => a.kind === 0)) return actions
    const rules = await this.rules()
    return actions.map((a) => {
      if (a.kind !== 0) return a
      const spec = selectSpec(rules, a.pairId)
      const price = snapPrice8(a.price, spec, a.side === 0 ? 'buy' : 'sell')          // a market order keeps price 0
      const size = snapSize18(a.size, spec)
      checkNotional(size, price, spec)
      return { ...a, price, size }
    })
  }

  /** Cancel every open order on `pairId` (0 = every market). */
  async cancelAll(pairId = 0): Promise<Submitted> {
    const nonce = this.nonce.next()
    const p = safeNumber(uint(pairId, U32, 'pairId'), 'pairId')
    const sig = await this.sign(this.orderSigner(), 'CancelAllOrders', { owner: this.owner, pairId: p, nonce })
    return this.send('/order/cancel-all', cancelAllBody(this.owner, p, nonce, sig))
  }

  /**
   * Cancel-and-replace at a new price and size (a new order id, no time priority). The new price and size go onto the
   * order's market tick and lot (a buy's price down, a sell's up, the size down); the market and side come from `opts`,
   * else from the account's open orders.
   */
  async modify(orderId: bigint | number, newPrice8: bigint, newSize18: bigint, opts: { pairId?: number; side?: 'buy' | 'sell' } = {}): Promise<Submitted & { clientNonce: number }> {
    const id = uint(orderId, U64, 'orderId')
    let p = uint(newPrice8, U64, 'newPrice8'), s = uint(newSize18, U128, 'newSize18')
    if (p === 0n || s === 0n) throw new InvalidRequest('A modified order needs a price and a size.')
    let { pairId, side } = opts
    if (pairId === undefined || side === undefined) {
      const mine = (await this.client.openOrders(this.owner)).find((o) => BigInt(o.orderId) === id)
      if (!mine) throw new OrderValueError(`Order ${id} is not open on this account; pass pairId and side.`)
      pairId = mine.pairId; side = mine.side as 'buy' | 'sell'
    }
    const spec = await this.pairSpec(pairId)
    p = snapPrice8(p, spec, side); s = snapSize18(s, spec)
    checkNotional(s, p, spec)
    const clientNonce = this.nonce.next()
    const sig = await this.sign(this.orderSigner(), 'ModifyOrderV2', { owner: this.owner, orderId: id, newPrice: p, newSize: s, clientNonce })
    return { ...(await this.send('/order/modify', modifyBody(this.owner, id, p, s, clientNonce, sig))), clientNonce }
  }

  /**
   * The dead-man switch: at the first block at or past `cancelAtMs` the chain cancels every open order and TWAP of the
   * account. Call again with a later time to keep orders alive; 0 clears it.
   */
  async scheduleCancel(cancelAtMs: number): Promise<Submitted & { nonce: number }> {
    const nonce = this.nonce.next()
    const at = safeNumber(uint(cancelAtMs, U64, 'cancelAtMs'), 'cancelAtMs')
    const sig = await this.sign(this.orderSigner(), 'ScheduleCancel', { owner: this.owner, cancelAtMs: at, nonce })
    return { ...(await this.send('/schedule-cancel', scheduleCancelBody(this.owner, at, nonce, sig))), nonce }
  }

  // ── session key ───────────────────────────────────────────────────────────────────────────────────────────────────

  async revokeSession(waitMs = 30000): Promise<Result> {
    const signer = this.needOwner('Ending a session')
    const held = await this.client.session(this.owner)
    if (!held) return { applied: true, status: 0, answer: null, detail: 'no session to revoke' }
    const n = nextNonce()
    const sig = await this.sign(signer, 'SessionRevoke', { owner: this.owner, nonce: n })
    const r = await this.client.post('/session/revoke', sessionRevokeBody(this.owner, held.session_key, n, sig))
    const ok = r.status >= 200 && r.status < 300 && (await waitFor(async () => (await this.client.session(this.owner)) === null, waitMs))
    return { applied: ok, status: r.status, answer: r.body, detail: ok ? '' : 'the chain still holds the session' }
  }

  /**
   * Give `sessionKey` (a session key, or a registered agent's key) this account's session until `endMs`. A session the
   * chain holds for another key is revoked first (one more signature). Applied only once the chain shows it confirmed.
   */
  async createSession(sessionKey: string, endMs: number, waitMs = 60000): Promise<Result> {
    const signer = this.needOwner('A session')
    const key = getAddress(sessionKey)
    const held = await this.client.session(this.owner)
    let after = 0
    if (held && held.session_key.toLowerCase() !== key.toLowerCase()) {
      const r = await this.revokeSession()
      if (!r.applied) return { ...r, applied: false, detail: "the account's other session could not be ended" }
      after = nextNonce()
    }
    const n = nextNonce(after), exp = sessionEnd(endMs)
    const sig = await this.sign(signer, 'SessionCreate', { sessionKey: key, expiresAt: exp, nonce: n })
    const r = await this.client.post('/session/create', sessionCreateBody(this.owner, key, exp, n, sig))
    const mine = async () => { const s = await this.client.session(this.owner); return !!s && s.session_key.toLowerCase() === key.toLowerCase() && s.confirmed === true }
    const ok = r.status >= 200 && r.status < 300 && (await waitFor(mine, waitMs))
    return { applied: ok, status: r.status, answer: r.body, detail: ok ? '' : 'the chain does not show the session as confirmed' }
  }

  // ── TWAP (owner key only) ─────────────────────────────────────────────────────────────────────────────────────────

  async placeTwap(t: { pairId: number; side: 'buy' | 'sell'; totalSize18: bigint; durationMs: number; leverageBps?: number; slippageBps?: number
    randomize?: boolean; numSlices?: number; minPrice8?: bigint; maxPrice8?: bigint }, waitMs = 30000): Promise<Result & { clientNonce: number }> {
    const signer = this.needOwner('A TWAP order')
    const rules = this.client.twapRules()
    const slip = t.slippageBps ?? 100
    if (slip < 0 || slip > rules.maxSlippageBps) throw new InvalidRequest("The slippage is above the network's TWAP limit.")
    const numSlices = t.numSlices ?? planTwap(t.durationMs, rules)[0]
    const [total, lo, hi] = twapOnSteps(await this.pairSpec(t.pairId), uint(t.totalSize18, U128, 'totalSize18'), numSlices, t.minPrice8 ?? 0n, t.maxPrice8 ?? 0n)
    const clientNonce = nextNonce()
    const v: TwapValue = {
      owner: this.owner, pairId: t.pairId, side: t.side === 'buy' ? 0 : 1, totalSize18dec: total,
      numSlices, durationMs: t.durationMs, leverageBps: t.leverageBps ?? 10000, slippageBps: slip,
      randomize: !!t.randomize, triggerPrice8dec: 0n, triggerDir: 0, minPrice8dec: lo, maxPrice8dec: hi, clientNonce,
    }
    const sig = await this.sign(signer, 'PlaceTwap', v as unknown as Record<string, unknown>)
    const r = await this.client.post(rules.path, twapBody(v, sig))
    const ok = r.status >= 200 && r.status < 300 && (await waitFor(async () => (await this.client.twaps(this.owner)).some((x) => String(x.client_nonce) === String(clientNonce)), waitMs))
    return { applied: ok, status: r.status, answer: r.body, detail: ok ? '' : 'the chain does not list the TWAP', clientNonce }
  }

  async cancelTwap(twapId: bigint | number, waitMs = 30000): Promise<Result> {
    const signer = this.needOwner('Cancelling a TWAP')
    const rules = this.client.twapRules()
    const cn = nextNonce()
    const sig = await this.sign(signer, 'CancelTwap', { owner: this.owner, twapId: uint(twapId, U64, 'twapId'), clientNonce: cn })
    const r = await this.client.post(rules.cancelPath, cancelTwapBody(this.owner, twapId, cn, sig))
    const gone = async () => (await this.client.twaps(this.owner)).every((x) => String(x.twap_id ?? x.id) !== String(twapId))
    const ok = r.status >= 200 && r.status < 300 && (await waitFor(gone, waitMs))
    return { applied: ok, status: r.status, answer: r.body, detail: ok ? '' : 'the chain still lists the TWAP' }
  }

  // ── margin mode (owner key only) ──────────────────────────────────────────────────────────────────────────────────

  /** The market's margin mode as the chain reads it ("cross" | "isolated"), or null. */
  async marginMode(pairId: number): Promise<MarginMode | null> {
    const j = (await this.client.crossMargin(this.owner)) as { modes?: Array<{ pair_id?: unknown; mode?: unknown }>; default_mode?: unknown } | null
    if (!j || !Array.isArray(j.modes)) return null
    const m = j.modes.find((x) => String(x.pair_id) === String(pairId))?.mode ?? j.default_mode
    const map: Record<string, MarginMode> = { 1: 'cross', 2: 'isolated', cross: 'cross', isolated: 'isolated' }
    return map[String(m)] ?? null
  }

  /** Cross or isolated for one market — only while it holds no open position and no resting order of the account. */
  async setMarginMode(pairId: number, mode: MarginMode, waitMs = 30000): Promise<Result> {
    const signer = this.needOwner('The margin mode')
    if (!(mode in MODE_CODE)) throw new InvalidRequest('The mode is cross or isolated.')
    const n = nextNonce()
    const sig = await this.sign(signer, 'SetMarginMode', { owner: this.owner, pairId, mode: MODE_CODE[mode], nonce: n })
    const r = await this.client.post('/margin/mode', marginModeBody(this.owner, pairId, MODE_CODE[mode], n, sig))
    const ok = r.status === 202 && (await waitFor(async () => (await this.marginMode(pairId)) === mode, waitMs))
    return { applied: ok, status: r.status, answer: r.body, detail: ok ? '' : 'the chain does not show the new mode' }
  }

  // ── agents (owner key; the agent may tighten its own policy) ──────────────────────────────────────────────────────

  private async submitAgentOp(signer: TypedSigner, op: AgentOp, value: Record<string, unknown>, shows: (rec: Record<string, unknown> | null) => boolean, agent: string, waitMs: number): Promise<Result> {
    const sig = await this.sign(signer, op, value)
    const body = submitBody(op, value, sig)
    const r = await this.client.post('/submit', JSON.stringify(body))
    const ok = r.status >= 200 && r.status < 300 && (await waitFor(async () => shows(await this.client.agent(this.owner, agent)), waitMs))
    return { applied: ok, status: r.status, answer: r.body, detail: ok ? '' : 'the chain does not show the change' }
  }

  private addr(a: string, op: AgentOp): string {
    const c = getAddress(a)
    return LOWERCASE_ADDRESS_OPS.has(op) ? c.toLowerCase() : c
  }

  /** Register an agent key with a name (the chain's name rule) and a mandate; applied once the chain lists it. */
  async registerAgent(a: { agent: string; name: string; mandate: string; expiresMs: number }, waitMs = 30000): Promise<Result> {
    const signer = this.needOwner('Registering an agent')
    const op: AgentOp = 'RegisterAgentV2'
    const value = { owner: this.addr(this.owner, op), agent: this.addr(a.agent, op), name: requireName(a.name), mandate: a.mandate, expiresMs: a.expiresMs, nonce: nextNonce() }
    return this.submitAgentOp(signer, op, value, (rec) => !!rec && rec.status === 'active' && rec.name === value.name, value.agent, waitMs)
  }

  /**
   * Rename an agent. The chain applies one rename per wait (registering is the first naming) and ignores an earlier one
   * silently: where the network publishes the wait it is refused here, before signing; otherwise the result says the
   * chain did not show the new name.
   */
  async renameAgent(agent: string, name: string, waitMs = 30000): Promise<Result> {
    const signer = this.needOwner('Renaming an agent')
    const op: AgentOp = 'SetAgentName'
    const value = { owner: this.addr(this.owner, op), agent: this.addr(agent, op), name: requireName(name), nonce: nextNonce() }
    const rec = await this.client.agent(this.owner, value.agent)
    const named = typeof rec?.named_at_ms === 'number' ? rec.named_at_ms : null
    const wait = this.client.renameWaitMs()
    if (rec?.name === value.name) return { applied: true, status: 0, answer: null, detail: 'the agent already has this name' }
    if (named !== null && wait !== null && Date.now() < named + wait) {
      throw new InvalidRequest(`The chain allows one rename per ${Math.round(wait / 3600000)} hours; this agent can be renamed after ${new Date(named + wait).toISOString()}.`)
    }
    const r = await this.submitAgentOp(signer, op, value, (x) => !!x && x.name === value.name, value.agent, waitMs)
    return r.applied ? r : { ...r, detail: 'the chain does not show the new name (a rename within the wait after the last naming is ignored)' }
  }

  async revokeAgent(agent: string, waitMs = 30000): Promise<Result> {
    const signer = this.needOwner('Revoking an agent')
    const op: AgentOp = 'RevokeAgent'
    const value = { owner: this.addr(this.owner, op), agent: this.addr(agent, op), nonce: nextNonce() }
    return this.submitAgentOp(signer, op, value, (rec) => !!rec && rec.status === 'revoked', value.agent, waitMs)
  }

  /**
   * Set an agent's policy. Refused before signing when the chain would refuse it at apply (it does so silently). The
   * agent itself may sign only a tightening of the stored policy, with its own nonce; the owner may loosen (the chain
   * allows that once per cooldown).
   */
  async setAgentPolicy(agent: string, policy: PolicyV1, waitMs = 30000): Promise<Result> {
    const op: AgentOp = 'SetAgentPolicyV1'
    const problems = policyProblems(policy, Date.now())
    if (problems.length) throw new InvalidRequest('The chain would refuse this policy: ' + problems.join(' '))
    const agentAddr = this.addr(agent, op)
    let signer = this.ownerSigner
    if (!signer) {
      signer = this.sessionSigner
      if (!signer || getAddress(await signer.getAddress()).toLowerCase() !== agentAddr) throw new InvalidRequest('Only the owner, or the agent itself, signs a policy.')
      const stored = policyFromRead((await this.client.agent(this.owner, agentAddr))?.policy_v1)
      if (!stored) throw new InvalidRequest('An agent may only tighten a policy its owner has set; there is no stored policy to tighten.')
      const wider = loosens(stored, policy)
      if (wider.length) throw new InvalidRequest(`An agent may only tighten its own policy; this ${wider.join(', ')} — only the owner may sign that.`)
    }
    const value = policyValue(this.addr(this.owner, op), agentAddr, policy, nextNonce())
    const same = (rec: Record<string, unknown> | null) => {
      const p = policyFromRead(rec?.policy_v1)
      return !!p && JSON.stringify(p, (_, x) => (typeof x === 'bigint' ? x.toString() : x)) === JSON.stringify(policy, (_, x) => (typeof x === 'bigint' ? x.toString() : x))
    }
    return this.submitAgentOp(signer, op, value, same, agentAddr, waitMs)
  }

  /** Per-market limits for an agent (sizes in 18-decimal units; 0 leverage = the policy's). */
  async setAgentMarketLimit(agent: string, m: { pair: number; allowed: boolean; maxOrder18: bigint; maxPosition18: bigint; maxLeverageBps: number }, waitMs = 30000): Promise<Result> {
    const signer = this.needOwner("An agent's market limit")
    const op: AgentOp = 'SetAgentMarketLimit'
    const value = { owner: this.addr(this.owner, op), agent: this.addr(agent, op), pair: m.pair, allowed: m.allowed,
      maxOrder18dec: uint(m.maxOrder18, U128, 'maxOrder18'), maxPosition18dec: uint(m.maxPosition18, U128, 'maxPosition18'), maxLeverageBps: m.maxLeverageBps, nonce: nextNonce() }
    const shows = (rec: Record<string, unknown> | null) => (Array.isArray(rec?.market_limits) ? rec!.market_limits as Array<Record<string, unknown>> : [])
      .some((l) => l.pair === m.pair && l.allowed === m.allowed && String(l.max_order_18dec) === value.maxOrder18dec.toString() && String(l.max_position_18dec) === value.maxPosition18dec.toString())
    return this.submitAgentOp(signer, op, value, shows, value.agent.toLowerCase(), waitMs)
  }

  /** Clear the agent's active lock (owner only); `lockSinceMs` names the lock, so a clear signed early never clears a later one. */
  async clearAgentLock(agent: string, lockSinceMs: number, waitMs = 30000): Promise<Result> {
    const signer = this.needOwner("Clearing an agent's lock")
    if (!Number.isSafeInteger(lockSinceMs) || lockSinceMs <= 0) throw new InvalidRequest('lockSinceMs is the start of the active lock (from the agent read).')
    const op: AgentOp = 'ClearAgentLock'
    const value = { owner: this.addr(this.owner, op), agent: this.addr(agent, op), lockSinceMs, nonce: nextNonce() }
    const shows = (rec: Record<string, unknown> | null) => (rec?.risk_v1 as { lock_active?: unknown } | undefined)?.lock_active === false
    return this.submitAgentOp(signer, op, value, shows, value.agent, waitMs)
  }
}

/**
 * A TWAP's signed size and price bounds on the market's lot and tick: the total DOWN to a whole number of lots per slice
 * (every slice on the lot, never more than asked), the lowest price UP and the highest DOWN (the band never widens).
 */
export function twapOnSteps(spec: PairSpec, total18: bigint, numSlices: number, minPrice8: bigint, maxPrice8: bigint): [bigint, bigint, bigint] {
  if (!Number.isSafeInteger(numSlices) || numSlices < 1) throw new OrderValueError('A TWAP has at least one slice.')
  const step = sizeStep(spec) * BigInt(numSlices)
  const total = checkSize(total18 - (total18 % step), spec, total18)
  const lo = minPrice8 ? snapPrice8(minPrice8, spec, 'sell') : 0n
  const hi = maxPrice8 ? snapPrice8(maxPrice8, spec, 'buy') : 0n
  if (lo && hi && hi < lo) throw new OrderValueError("The TWAP's price band holds no tick of this market.")
  return [total, lo, hi]
}
