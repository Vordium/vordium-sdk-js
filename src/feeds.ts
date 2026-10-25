import { InvalidRequest } from './errors.js'

/**
 * Live feeds over one WebSocket: order book, trades, your orders and your fills.
 *
 * Subscribe with `{method:"subscribe", channel:"book"|"trades", pair}` or `{method:"subscribe", channel:"orders"|"fills",
 * account}`. Every subscription starts with a snapshot, then updates. `seq` only rises on a subscription; each message's
 * `prev_seq` names the message before it (null on the snapshot). A `prev_seq` that is not the last `seq` seen means a
 * message was missed: the only correct move is to subscribe again and start from the new snapshot — {@link Feeds} does
 * that by itself. Book updates list only the levels that changed; a size of "0" removes the level.
 */
export const CHANNELS = ['book', 'trades', 'orders', 'fills'] as const
export type Channel = typeof CHANNELS[number]
const MARKET = new Set<Channel>(['book', 'trades'])

export type FeedMessage = Record<string, unknown>
export type SubKey = string

export function subKey(channel: Channel, target: number | string): SubKey {
  if (!CHANNELS.includes(channel)) throw new InvalidRequest(`channel is one of ${CHANNELS.join(', ')}, not ${String(channel)}.`)
  if (MARKET.has(channel)) {
    if (typeof target !== 'number' || !Number.isSafeInteger(target)) throw new InvalidRequest(`${channel} needs a pair id.`)
    return `${channel}:${target}`
  }
  if (typeof target !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(target)) throw new InvalidRequest(`${channel} needs an account address.`)
  return `${channel}:${target.toLowerCase()}`
}

export function subscribeMessage(channel: Channel, target: number | string, method: 'subscribe' | 'unsubscribe' = 'subscribe'): FeedMessage {
  subKey(channel, target)
  return MARKET.has(channel) ? { method, channel, pair: target } : { method, channel, account: target }
}

/** The subscription a message belongs to, or null (pong, acknowledgements, errors). */
export function keyOf(msg: FeedMessage): SubKey | null {
  const ch = msg.channel
  if ((ch === 'book' || ch === 'trades') && typeof msg.pair === 'number') return `${ch}:${msg.pair}`
  if ((ch === 'orders' || ch === 'fills') && typeof msg.account === 'string') return `${ch}:${msg.account.toLowerCase()}`
  return null
}

export type Verdict = 'snapshot' | 'update' | 'gap' | 'stale' | 'ignore'

/** Per subscription: accept a snapshot, then only an update whose `prev_seq` is the last `seq`. */
export class SeqTracker {
  private last = new Map<SubKey, number>()
  reset(k: SubKey): void { this.last.delete(k) }
  observe(msg: FeedMessage): Verdict {
    const k = keyOf(msg)
    const seq = msg.seq
    if (k === null || typeof seq !== 'number' || !Number.isSafeInteger(seq)) return 'ignore'
    if (msg.type === 'snapshot') { this.last.set(k, seq); return 'snapshot' }
    const last = this.last.get(k)
    if (last === undefined) return 'stale'
    if (seq <= last) return 'stale'
    if (msg.prev_seq !== last) { this.last.delete(k); return 'gap' }
    this.last.set(k, seq)
    return 'update'
  }
}

/** One pair's book from a snapshot and its updates. Prices (8 decimals) and sizes (18 decimals) exact as bigint. */
export class Book {
  bids = new Map<bigint, bigint>()
  asks = new Map<bigint, bigint>()
  seq: number | null = null
  height: number | null = null
  constructor(readonly pair: number) {}
  apply(msg: FeedMessage): void {
    if (msg.type === 'snapshot') { this.bids = new Map(); this.asks = new Map() }
    for (const [side, book] of [['bids', this.bids], ['asks', this.asks]] as const) {
      const levels = Array.isArray(msg[side]) ? (msg[side] as unknown[][]) : []
      for (const lvl of levels) {
        const price = BigInt(String(lvl[0])), size = BigInt(String(lvl[1]))
        if (size === 0n) book.delete(price)
        else book.set(price, size)
      }
    }
    if (typeof msg.seq === 'number') this.seq = msg.seq
    if (typeof msg.height === 'number') this.height = msg.height
  }
  bestBid(): [bigint, bigint] | null { return best(this.bids, (a, b) => a > b) }
  bestAsk(): [bigint, bigint] | null { return best(this.asks, (a, b) => a < b) }
}

function best(m: Map<bigint, bigint>, better: (a: bigint, b: bigint) => boolean): [bigint, bigint] | null {
  let out: [bigint, bigint] | null = null
  for (const [p, s] of m) if (!out || better(p, out[0])) out = [p, s]
  return out
}

/** A wait before a reconnect: a random point between half the backoff and the backoff. */
export function reconnectDelay(backoffMs: number, rand: () => number = Math.random): number {
  return backoffMs * (0.5 + 0.5 * rand())
}

/** The part of a WebSocket the feeds use (the browser's and Node's `ws` both fit). */
export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
}
export type SocketFactory = (url: string) => SocketLike | Promise<SocketLike>

/** The WebSocket of the runtime: the global one (browsers, Node 22+), else the `ws` package. */
export async function defaultSocket(url: string): Promise<SocketLike> {
  const G = (globalThis as { WebSocket?: new (u: string) => SocketLike }).WebSocket
  if (G) return new G(url)
  const mod = (await import('ws')) as unknown as { default?: new (u: string) => SocketLike; WebSocket?: new (u: string) => SocketLike }
  const C = mod.WebSocket ?? mod.default
  if (!C) throw new InvalidRequest('No WebSocket is available in this runtime.')
  return new C(url)
}

export type FeedEvent =
  | { kind: 'snapshot' | 'update'; message: FeedMessage }
  | { kind: 'resubscribed'; key: SubKey }
  | { kind: 'reconnected'; error: string }

/**
 * One connection, any number of subscriptions, resubscribed by itself after a gap or a reconnect. Listen with
 * `onEvent`; book state per pair is kept in `books` for book subscriptions. A connection that delivers nothing for
 * `idleMs` is pinged once and replaced if the ping is not answered.
 */
export class Feeds {
  readonly books = new Map<number, Book>()
  private subs = new Map<SubKey, FeedMessage>()
  private seq = new SeqTracker()
  private sock: SocketLike | null = null
  /** True once the socket is open: a message sent while it is still connecting is refused by the runtime. */
  private ready = false
  private closed = false
  private backoffMs = 1000
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private pinged = false
  onEvent: (e: FeedEvent) => void = () => {}

  constructor(readonly url: string, private readonly opts: { socket?: SocketFactory; maxBackoffMs?: number; idleMs?: number } = {}) {}

  async open(): Promise<void> {
    this.closed = false
    const s = await (this.opts.socket ?? defaultSocket)(this.url)
    this.sock = s
    this.ready = false
    s.onopen = () => {
      this.ready = true
      for (const [k, m] of this.subs) { this.seq.reset(k); s.send(JSON.stringify(m)) }
      this.armIdle()
    }
    s.onmessage = (ev) => {
      this.armIdle()
      this.pinged = false
      let msg: unknown
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return
      this.backoffMs = 1000   // reset only once a connection has delivered a message
      try { this.handle(msg as FeedMessage) } catch { /* a malformed message is skipped */ }
    }
    s.onclose = () => this.lost('the connection closed')
    s.onerror = () => { /* onclose follows */ }
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    const idle = this.opts.idleMs ?? 30000
    this.idleTimer = setTimeout(() => {
      if (this.closed || !this.sock) return
      if (this.pinged) { this.sock.close(); return }   // no message and no answer to a ping
      this.pinged = true
      try { this.sock.send(JSON.stringify({ method: 'ping' })) } catch { /* onclose follows */ }
      this.armIdle()
    }, idle)
  }

  /** Send now when the socket is open; otherwise the subscription list is sent when it opens. */
  private send(m: FeedMessage): void {
    if (this.sock && this.ready) this.sock.send(JSON.stringify(m))
  }

  private lost(error: string): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null }
    this.sock = null
    this.ready = false
    if (this.closed) return
    const wait = reconnectDelay(this.backoffMs)
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 30000)
    this.onEvent({ kind: 'reconnected', error })
    setTimeout(() => { if (!this.closed) this.open().catch((e) => this.lost(String(e?.message ?? e))) }, wait)
  }

  subscribe(channel: Channel, target: number | string): void {
    const k = subKey(channel, target)
    const m = subscribeMessage(channel, target)
    this.subs.set(k, m)
    if (channel === 'book') this.books.set(target as number, this.books.get(target as number) ?? new Book(target as number))
    this.seq.reset(k)
    this.send(m)
  }

  unsubscribe(channel: Channel, target: number | string): void {
    const k = subKey(channel, target)
    this.subs.delete(k)
    this.seq.reset(k)
    if (channel === 'book') this.books.delete(target as number)
    this.send(subscribeMessage(channel, target, 'unsubscribe'))
  }

  /** Apply one message; returns its kind (null for messages that are not feed data). */
  handle(msg: FeedMessage): Verdict | 'resubscribed' | null {
    const verdict = this.seq.observe(msg)
    const k = keyOf(msg)
    if (verdict === 'gap' && k && this.subs.has(k)) {
      if (k.startsWith('book:')) { const p = Number(k.slice(5)); this.books.set(p, new Book(p)) }
      this.send(this.subs.get(k) as FeedMessage)
      this.onEvent({ kind: 'resubscribed', key: k })
      return 'resubscribed'
    }
    if (verdict === 'snapshot' || verdict === 'update') {
      if (k && k.startsWith('book:')) {
        const p = Number(k.slice(5))
        const b = this.books.get(p) ?? new Book(p)
        b.apply(msg)
        this.books.set(p, b)
      }
      this.onEvent({ kind: verdict, message: msg })
      return verdict
    }
    return null
  }

  close(): void {
    this.closed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    try { this.sock?.close() } catch { /* closed */ }
    this.sock = null
  }
}
