// Every order value on its market's tick and lot, exactly, for every market of both networks. The two recorded
// `GET /markets/specs` answers are pinned by SHA256SUMS; for every market in them, many prices and sizes (strings,
// numbers and bigints, on the step and off it) must be signed as a multiple of the step, on the passive side of the
// price asked (a buy's at or below, a sell's at or above, less than one step away), with the size at or below the size
// asked and less than one lot below it — and equal to an independent reference computed with fractions.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Wallet } from 'ethers'
import * as sdk from '../dist/esm/index.js'

const dir = new URL('./vectors/', import.meta.url)
const sums = Object.fromEntries(readFileSync(new URL('SHA256SUMS', dir), 'utf8').trim().split('\n').map((l) => l.split(/\s+/).reverse()))
const load = (f) => {
  const b = readFileSync(new URL(f, dir))
  assert.equal(createHash('sha256').update(b).digest('hex'), sums[f], `${f} is the pinned file`)
  return JSON.parse(b.toString('utf8'))
}
const READS = { testnet: load('markets-specs-testnet.json'), mainnet: load('markets-specs-mainnet.json') }
const SPECS = Object.fromEntries(Object.entries(READS).map(([n, r]) => [n, sdk.pairSpecs(r)]))
const MARKETS = Object.entries(SPECS).flatMap(([n, m]) => [...m.keys()].map((p) => [n, p]))

// seeded randomness
let seed = 14008
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo))
const big = (lo, hi) => BigInt(lo) + BigInt(Math.floor(rnd() * Number(BigInt(hi) - BigInt(lo))))
const pick = (a) => a[Math.floor(rnd() * a.length)]

// an independent reference: a decimal string as a fraction of bigints
function frac(x) {
  if (typeof x === 'bigint') return [x, 1n]
  let s = typeof x === 'number' ? sdk.numberToDecimal(x) : x
  const m = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s)
  let n = BigInt((m[1] || '0') + (m[2] || '')), e = -(m[2] || '').length + Number(m[3] || 0), d = 1n
  if (e >= 0) n *= 10n ** BigInt(e); else d = 10n ** BigInt(-e)
  return [n, d]
}
const gcd = (a, b) => (b ? gcd(b, a % b) : a)
function refPrice(x, spec, side, place = true) {
  const t = spec.tick8
  const step = place ? (t ? (t * 100n) / gcd(t, 100n) : 100n) : (t || 1n)
  const [n, d] = frac(x)
  const num = n * 10n ** 8n, den = d * step
  let q = num / den
  if (num % den && side === 'sell') q += 1n
  return [q * step, step]
}
function refSize(x, spec) {
  const lot = spec.lot18 || 1n
  const [n, d] = frac(x)
  return [((n * 10n ** 18n) / (d * lot)) * lot, lot]
}
const refTrigger = (p, spec) => { const t = spec.tick8 || 1n; const q = p / t, r = p % t; return 2n * r >= t ? (q + 1n) * t : q * t }
function decimalOf(n, d) {           // n/d written out (cut at 30 decimals when it does not end)
  const ip = n / d; let r = n % d, f = ''
  while (r && f.length < 30) { r *= 10n; f += (r / d).toString(); r %= d }
  return f ? `${ip}.${f}` : `${ip}`
}
function form(n, d) {
  const s = decimalOf(n, d)
  const k = pick(['number', 'number', 'string', 'exp'])
  if (k === 'number') return Number(s)
  if (k === 'exp') { const [i, f = ''] = s.split('.'); return `${i}${f ? '.' + f : ''}e0` }
  return s
}
const prices = (spec) => {
  const tick = spec.tick8 || 100n, out = []
  for (let i = 0; i < 120; i++) {
    const k = BigInt(pick([int(1, 100), int(100, 1e6), int(1e6, 1e9)]))
    const on = [k * tick, 10n ** 8n]
    out.push(form(...on))
    const dd = 10n ** BigInt(int(9, 20))
    out.push(form(on[0] * dd + big(1, 1e12) * 10n ** 8n, 10n ** 8n * dd))
  }
  return out.concat([0.1, 0.3, 1.005, 2420.5, 1343.8712346, '0.00000123456789', '97000.123456789', '.5', '1e-4'])
}
const sizes = (spec) => {
  const lot = spec.lot18 || 10n ** 12n, out = []
  for (let i = 0; i < 120; i++) {
    const k = BigInt(pick([int(1, 50), int(50, 1e5), int(1e5, 1e8)]))
    out.push(form(k * lot, 10n ** 18n))
    const dd = 10n ** BigInt(int(10, 25))
    out.push(form(k * lot * dd + big(1, 1e9) * 10n ** 18n, 10n ** 18n * dd))
  }
  return out.concat([0.29, 0.0062, 1.1, 0.57, 15 / 2420.5, '0.000000000000000001', 3n])
}

test('the recordings hold every market with its rules', () => {
  assert.equal(SPECS.testnet.size, 16); assert.equal(SPECS.mainnet.size, 16)
  const eth = SPECS.testnet.get(1)
  assert.equal(eth.tick8, 10n ** 7n); assert.equal(eth.lot18, 10n ** 14n)
  assert.ok([...SPECS.mainnet.values()].every((s) => s.tick8 === 0n && s.lot18 === 0n))
  assert.ok([...SPECS.testnet.values(), ...SPECS.mainnet.values()].every((s) => s.minNotional6 === 10000000n))
})

for (const [net, pid] of MARKETS) {
  test(`${net} market ${pid}: every price and size lands exactly on the step`, () => {
    const spec = SPECS[net].get(pid)
    let checked = 0
    for (const x of prices(spec)) {
      for (const side of ['buy', 'sell']) for (const place of [true, false]) {
        const [want, step] = refPrice(x, spec, side, place)
        if (want === 0n) { assert.throws(() => sdk.price8OnTick(x, spec, side, place), sdk.OrderValueError); continue }
        const got = sdk.price8OnTick(x, spec, side, place)
        const [n, d] = frac(x), asked = [n * 10n ** 8n, d]
        assert.equal(got, want, `${net} ${pid} ${x} ${side}`); assert.equal(got % step, 0n)
        if (side === 'buy') assert.ok(got * asked[1] <= asked[0] && asked[0] < (got + step) * asked[1])
        else assert.ok((got - step) * asked[1] < asked[0] && asked[0] <= got * asked[1])
        if (spec.tick8) assert.equal(got % spec.tick8, 0n)
        checked++
      }
    }
    for (const x of sizes(spec)) {
      const [want, lot] = refSize(x, spec)
      if (want === 0n) { assert.throws(() => sdk.size18OnLot(x, spec), sdk.OrderValueError); continue }
      const got = sdk.size18OnLot(x, spec)
      const [n, d] = frac(x)
      assert.equal(got, want); assert.equal(got % lot, 0n)
      assert.ok(got * d <= n * 10n ** 18n && n * 10n ** 18n < (got + lot) * d)
      checked++
    }
    for (let i = 0; i < 200; i++) {
      const p = big(1, 1e16)
      if (refTrigger(p, spec) === 0n) assert.throws(() => sdk.snapTrigger8(p, spec), sdk.OrderValueError)
      else assert.equal(sdk.snapTrigger8(p, spec), refTrigger(p, spec))
      const s = big(1, 1e15) * 10n ** 9n, want = s - (s % (spec.lot18 || 1n))
      if (want) assert.equal(sdk.snapSize18(s, spec), want)
      for (const side of ['buy', 'sell']) {
        const r = refPrice(`${p}e-8`, spec, side, false)[0]           // p is already in 8-decimal units
        if (r === 0n) assert.throws(() => sdk.snapPrice8(p, spec, side), sdk.OrderValueError)
        else assert.equal(sdk.snapPrice8(p, spec, side), r)
      }
    }
    assert.ok(checked > 900)
  })
}

test('without the step, sizes typed at 6 decimals are signed off the lot; with it, never', () => {
  let n = 0, off = 0
  for (const [pid, spec] of SPECS.testnet) {
    if (!spec.lot18) continue
    for (let i = 0; i < 400; i++) {
      const price = Math.round((0.05 + rnd() * 120000) * 1e6) / 1e6
      const size = Math.round(((15 + rnd() * 5000) / price) * 1e6) / 1e6
      n++
      if (sdk.size18(size) % spec.lot18 || sdk.limitPrice8(price) % spec.tick8) off++   // the units alone
      if (refSize(size, spec)[0] === 0n) assert.throws(() => sdk.size18OnLot(size, spec), sdk.OrderValueError)
      else assert.equal(sdk.size18OnLot(size, spec) % spec.lot18, 0n)
      assert.equal(sdk.price8OnTick(price, spec, pick(['buy', 'sell'])) % spec.tick8, 0n)
      void pid
    }
  }
  console.log(`# units alone, no step: ${off} of ${n} off the step (${((100 * off) / n).toFixed(1)}%)`)
  assert.ok(off > n / 2)
})

test('refused before signing: not a plain positive decimal, a size below one lot or the minimum, a small order', () => {
  const none = sdk.selectSpec(sdk.NO_RULES, 1)
  for (const bad of [true, NaN, Infinity, -1, '-1', '1_000', ' 1', '1,5', '0x10', '', null, [1], -1n]) {
    assert.throws(() => sdk.size18OnLot(bad, none), sdk.OrderValueError, String(bad))
  }
  const eth = SPECS.testnet.get(1)
  assert.throws(() => sdk.size18OnLot('0.00009', eth), /rounds to 0/)
  assert.equal(sdk.size18OnLot('0.00019', eth), 10n ** 14n)
  assert.throws(() => sdk.size18OnLot('0.005', { ...eth, minSize18: 10n ** 16n }), /smallest order/)
  assert.throws(() => sdk.checkNotional(10n ** 15n, 10n ** 11n, eth), /smallest order the network takes/)
  assert.throws(() => sdk.selectSpec(SPECS.testnet, 999), /lists no market 999/)
  assert.throws(() => sdk.pairSpecs({ specs: { pairs: [{ pair: { pair_id: 1 }, tick_8dec: '0.1', lot_18dec: '1' }] } }), sdk.OrderValueError)
  assert.equal(sdk.leverageBps(2.3), 23000); assert.equal(sdk.leverageBps('10'), 100000)
  for (const neg of [-2, -0.25, -3n]) assert.throws(() => sdk.leverageBpsExact(neg), sdk.OrderValueError, String(neg))
  assert.equal(sdk.size18OnLot(0.57, none), 570000000000000000n)
})

// ── the client signs on the step (a node answered locally) ──────────────────────────────────────────────────────

const GENESIS = '3'.repeat(64)
function fakeNode(net) {
  const posts = []
  const t = {
    async get(url) {
      if (url.endsWith('/network-spec.json')) return { status: 200, body: { chainId: 101102, testnet: true, genesisSha256: GENESIS } }
      if (url.endsWith('/status')) return { status: 200, body: { chain_id: 101102, genesis_sha256: GENESIS } }
      if (url.endsWith('/markets/specs')) return { status: 200, body: READS[net] }
      if (/\/orders\/0x/i.test(url)) return { status: 200, body: [{ id: 77, client_nonce: 1, pair_id: t.orderPair, side: t.orderSide, size: '1', price_8dec: 1 }] }
      return { status: 404, body: null }
    },
    async post(url, body) {
      if (url.includes('rpc-testnet')) return { status: 200, body: { result: '0x18aee' }, retryAfter: null }
      posts.push([url, JSON.parse(body)])
      return { status: 202, body: { status: 'submitted' }, retryAfter: null }
    },
    posts, orderPair: 1, orderSide: 'buy',
  }
  return t
}

for (const net of ['testnet', 'mainnet']) {
  test(`${net}: placeOrder, batch, modify, take-profit and TWAP are signed on the step`, async () => {
    const t = fakeNode(net)
    const v = await sdk.Vordium.connect({ network: 'testnet', transport: t })
    const acct = await v.account(Wallet.createRandom())
    let placed = 0, refused = 0
    for (const [pid, spec] of SPECS[net]) {
      for (let i = 0; i < 6; i++) {
        const side = pick(['buy', 'sell'])
        const tick = spec.tick8 || 10n ** 6n, lot = spec.lot18 || 10n ** 15n
        const p = form(BigInt(int(1, 1e6)) * tick * 7n + BigInt(int(0, 1e8)), 7n * 10n ** 8n)
        const s = form(BigInt(int(1, 1e6)) * lot + BigInt(int(0, 1e12)), 10n ** 18n)
        const [wp] = refPrice(p, spec, side), [ws] = refSize(s, spec)
        const before = t.posts.length
        if (!wp || !ws || sdk.notional6(ws, wp) < spec.minNotional6) {
          await assert.rejects(acct.placeOrder({ pairId: pid, side, size: s, orderType: 'Limit', price: p }), sdk.OrderValueError)
          assert.equal(t.posts.length, before); refused++
          continue
        }
        await acct.placeOrder({ pairId: pid, side, size: s, orderType: 'Limit', price: p })
        const b = t.posts.at(-1)[1]
        assert.equal(BigInt(b.size_18dec), ws)
        assert.equal(sdk.price8OnTick(String(b.price), null, side), wp)
        placed++
        const p8 = frac(p), s8 = frac(s)
        const price8 = (p8[0] * 10n ** 8n) / p8[1], size18 = (s8[0] * 10n ** 18n) / s8[1]
        const bp = refPrice(`${price8}e-8`, spec, side, false)[0]
        if (bp && sdk.notional6(ws, bp) >= spec.minNotional6) {
          await acct.batch([sdk.batchPlace({ pairId: pid, side, size18, price8, clientNonce: 5 })])
          const a = t.posts.at(-1)[1].actions[0]
          assert.equal(BigInt(a.size_18dec), ws); assert.equal(BigInt(a.price_8dec), bp)
          t.orderPair = pid; t.orderSide = side
          await acct.modify(77, price8, size18)                       // market and side read from the open orders
          const m = t.posts.at(-1)[1]
          assert.equal(BigInt(m.newPrice8dec), bp); assert.equal(BigInt(m.newSize18dec), ws)
        }
        const tp = big(1e8, 1e14)
        await acct.setTpSl(pid, 3, tp, 0n)
        assert.equal(BigInt(t.posts.at(-1)[1].take_profit_8dec), refTrigger(tp, spec))
        const n = int(1, 30), total = big(1, 1e22)
        const step = (spec.lot18 || 1n) * BigInt(n)
        if (total - (total % step) === 0n) assert.throws(() => sdk.twapOnSteps(spec, total, n, 0n, 0n), sdk.OrderValueError)
        else { const [tt] = sdk.twapOnSteps(spec, total, n, 0n, 0n); assert.equal(tt % step, 0n); assert.ok(tt <= total && total - tt < step) }
      }
    }
    assert.ok(placed > 20 && placed + refused === 96, `${placed} placed, ${refused} refused`)
  })
}

test('nothing is signed or sent when the market rules cannot be read', async () => {
  const t = fakeNode('testnet')
  const g = t.get
  t.get = async (url) => (url.endsWith('/markets/specs') ? { status: 503, body: null } : g(url))
  const v = await sdk.Vordium.connect({ network: 'testnet', transport: t })
  const acct = await v.account(Wallet.createRandom())
  await assert.rejects(acct.placeOrder({ pairId: 1, side: 'buy', size: '1', orderType: 'Limit', price: '100' }), sdk.SpecsUnavailable)
  assert.equal(t.posts.length, 0)
})

test('halves: a trigger rounds up, leverage to even', () => {
  const eth = SPECS.testnet.get(1)                                // tick 0.1
  assert.equal(sdk.snapTrigger8(15000000n, eth), 20000000n)
  assert.equal(sdk.snapTrigger8(14999999n, eth), 10000000n)
  assert.equal(sdk.trigger8OnTick('0.25', eth), 30000000n); assert.equal(sdk.trigger8OnTick(0.2499, eth), 20000000n)
  assert.equal(sdk.leverageBpsExact('2.00005'), 20000n); assert.equal(sdk.leverageBpsExact('2.00015'), 20002n)
})
