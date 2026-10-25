// Pure rules: units, order bodies, refusals, answers, policy checks, feeds sequencing, exact JSON.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Wallet } from 'ethers'
import * as sdk from '../dist/esm/index.js'

test('units are exact and refuse rounding', () => {
  assert.equal(sdk.toUnits('2420.5', 6), 2420500000n)
  assert.equal(sdk.toUnits(0.0869, 6), 86900n)
  assert.equal(sdk.toUnits(1e-7, 8), 10n)
  assert.throws(() => sdk.toUnits('1.0000001', 6), sdk.InvalidRequest)
  assert.throws(() => sdk.toUnits('-1', 6), sdk.InvalidRequest)
  assert.equal(sdk.limitPrice8('2420.123456'), 242012345600n)
  assert.throws(() => sdk.limitPrice8('2420.1234567'), sdk.InvalidRequest)
  assert.equal(sdk.size18('0.0062'), 6200000000000000n)
  assert.equal(sdk.fromUnits(242012345600n, 8), '2420.123456')
})

const base = { owner: '0x' + '11'.repeat(20), pairId: 1, side: 'buy', size: '0.01', clientNonce: 1792000000000 }

test('a limit order: signed price at 8 decimals, body with the decimal price and the case-sensitive names', () => {
  const v = sdk.placeOrderValue({ ...base, orderType: 'Limit', price: '2420.5', leverage: 2 })
  assert.equal(v.price, 242050000000n); assert.equal(v.orderType, 1); assert.equal(v.leverageBps, 20000)
  const b = sdk.placeOrderBody(v, '0x' + '22'.repeat(20), '0x' + 'ab'.repeat(64))
  assert.equal(b.side, 'buy'); assert.equal(b.orderType, 'Limit'); assert.equal(b.price, 2420.5); assert.equal(b.size_18dec, '10000000000000000')
  assert.equal(JSON.stringify(Object.keys(b)), JSON.stringify(['owner', 'pairId', 'side', 'size_18dec', 'orderType', 'reduceOnly', 'leverageBps', 'clientNonce', 'sessionKey', 'post_only', 'trigger_price_8dec', 'trigger_dir', 'signature', 'price']))
})

test('a market order carries no price; stop orders and priced market orders are refused before signing', () => {
  const v = sdk.placeOrderValue({ ...base, orderType: 'Market' })
  assert.equal(v.price, 0n)
  assert.ok(!('price' in sdk.placeOrderBody(v, base.owner, '0x' + 'ab'.repeat(64))))
  assert.throws(() => sdk.placeOrderValue({ ...base, orderType: 'Market', price: 1 }), sdk.InvalidRequest)
  assert.throws(() => sdk.placeOrderValue({ ...base, orderType: 'Limit' }), sdk.InvalidRequest)
  assert.throws(() => sdk.placeOrderValue({ ...base, orderType: 'StopMarket' }), sdk.NotAvailable)
  assert.throws(() => sdk.placeOrderBody({ ...v, orderType: 2 }, base.owner, '0x'), sdk.NotAvailable)
  assert.throws(() => sdk.placeOrderBody({ ...v, triggerPrice8dec: 5n }, base.owner, '0x'), sdk.NotAvailable)
  assert.throws(() => sdk.placeOrderValue({ ...base, orderType: 'Market', postOnly: true }), sdk.InvalidRequest)
})

test('batch actions: names on the wire, the published refusals', () => {
  const a = sdk.batchPlace({ pairId: 1, side: 'sell', size18: 10n ** 16n, price8: 242000000000n, clientNonce: 5, orderType: 'ioc' })
  assert.deepEqual(sdk.batchActionBody(a), { kind: 'place', pairId: 1, side: 'sell', size_18dec: '10000000000000000', price_8dec: 242000000000, leverageBps: 10000, orderType: 'ioc', postOnly: false, reduceOnly: false, clientNonce: 5 })
  assert.deepEqual(sdk.batchActionBody(sdk.batchCancel(9)), { kind: 'cancel', orderId: 9 })
  assert.deepEqual(sdk.batchActionBody(sdk.batchCancelByClientNonce(7)), { kind: 'cancelByClientNonce', clientNonce: 7 })
  assert.throws(() => sdk.batchPlace({ pairId: 1, side: 'buy', size18: 1n, price8: 1n, clientNonce: 1, orderType: 'ioc', postOnly: true }), sdk.InvalidRequest)
  assert.throws(() => sdk.batchPlace({ pairId: 1, side: 'buy', size18: 0n, price8: 1n, clientNonce: 1 }), sdk.InvalidRequest)
  assert.throws(() => sdk.batchPlace({ pairId: 1, side: 'buy', size18: 1n, price8: 1n, clientNonce: 1, orderType: 'market' }), sdk.InvalidRequest)
})

test('tick and lot: rounding never makes an order more aggressive or larger', () => {
  assert.equal(sdk.roundPrice(1055n, 100n, 'buy'), 1000n)
  assert.equal(sdk.roundPrice(1055n, 100n, 'sell'), 1100n)
  assert.equal(sdk.roundPrice(1055n, 0n, 'sell'), 1055n)
  assert.equal(sdk.roundSize(1055n, 100n), 1000n)
})

test('an answer is a success only in its published shape; a 202 is a submission', () => {
  const ok = sdk.readAnswer(202, { status: 'submitted', actions: [{ index: 0, status: 'accepted' }, { index: 1, status: 'refused', code: 'unknown_order', error: 'x' }] })
  assert.equal(ok.submitted, true); assert.equal(ok.actions[1].refusal.message, sdk.MESSAGES.unknown_order)
  assert.equal(sdk.readAnswer(200, { ok: true }).submitted, false)
  assert.equal(sdk.readAnswer(429, {}, '2').refusal.code, 'mempool_full')
  assert.equal(sdk.readAnswer(400, { error: 'price too far from mark' }).refusal.code, 'price_band')
})

const goodPolicy = () => ({ capsBitmask: 0b10011, sideMode: 0, maxTotalExposure6dec: 80_000_000n, maxLeverageBps: 20000, dailyLossLimit6dec: 20_000_000n,
  dailyFeeCap6dec: 2_000_000n, opsPerWindow: 0, opsWindowMs: 0, activeFromMsOfDay: 0, activeToMsOfDay: 0, oracleBandBps: 100, lockAutoClear: false,
  expiresMs: Date.now() + 86400000, enabled: true })

test('policy: the stateless refusals, and what loosens', () => {
  assert.deepEqual(sdk.policyProblems(goodPolicy(), Date.now()), [])
  for (const [k, v] of [['capsBitmask', 64], ['sideMode', 2], ['maxTotalExposure6dec', 0n], ['dailyLossLimit6dec', 0n], ['maxLeverageBps', 500001], ['oracleBandBps', 0], ['oracleBandBps', 1001], ['opsPerWindow', 5], ['activeFromMsOfDay', 86400000], ['expiresMs', 1]]) {
    assert.equal(sdk.policyProblems({ ...goodPolicy(), [k]: v }, Date.now()).length, 1, `${k}=${v}`)
  }
  const p = goodPolicy()
  assert.deepEqual(sdk.loosens(p, { ...p, maxLeverageBps: 10000 }), [])
  assert.deepEqual(sdk.loosens(p, { ...p, maxLeverageBps: 0 }), ['raises the leverage'])
  assert.deepEqual(sdk.loosens(p, { ...p, capsBitmask: 0b111111 }), ['adds a capability'])
  assert.deepEqual(sdk.loosens(null, p), [])
})

test('the /submit body: wire order, u128 as text, lower-case addresses where the node reads them so', () => {
  const owner = '0x6e7f9Fc6CAAFA3A5Ebfd9f27c13C559afefEF551', agent = '0x705b803E72B85900854704C9917bA11FFD24d3c6'
  const b = sdk.submitBody('SetAgentMarketLimit', { owner, agent, pair: 1, allowed: true, maxOrder18dec: 2n ** 70n, maxPosition18dec: 1n, maxLeverageBps: 0, nonce: 3 }, '0x' + 'AB'.repeat(65))
  assert.equal(b.owner, owner); assert.equal(b.max_order_18dec, (2n ** 70n).toString()); assert.equal(b.signature, '0x' + 'ab'.repeat(65))
  const r = sdk.submitBody('SetAgentName', { owner, agent, name: 'Desk', nonce: 1 }, '0x' + 'ab'.repeat(65))
  assert.equal(r.owner, owner.toLowerCase())
  assert.throws(() => sdk.submitBody('RegisterAgent', {}, '0x' + 'ab'.repeat(65)), sdk.InvalidRequest)
  assert.throws(() => sdk.submitBody('RevokeAgent', { owner, agent, nonce: 2 ** 60 }, '0x' + 'ab'.repeat(65)), sdk.InvalidRequest)
})

test('session, TWAP and margin bodies: exact digits, the chain\'s field order', () => {
  assert.equal(sdk.sessionCreateBody('0xA', '0xB', 5, 6, '0xs'), '{"owner":"0xA","session_key":"0xB","expires_at":5,"nonce":6,"signature":"0xs"}')
  assert.equal(sdk.marginModeBody('0xAB', 1, 2, 3, '0xs'), '{"owner":"0xab","pair_id":1,"mode":2,"nonce":3,"signature":"0xs"}')
  const t = sdk.twapBody({ owner: '0xA', pairId: 1, side: 0, totalSize18dec: 2n ** 80n, numSlices: 4, durationMs: 600000, leverageBps: 10000, slippageBps: 100, randomize: false,
    triggerPrice8dec: 0n, triggerDir: 0, minPrice8dec: 0n, maxPrice8dec: 0n, clientNonce: 1 }, '0xs')
  assert.deepEqual(Object.keys(JSON.parse(t)), sdk.TWAP_BODY)
  assert.ok(t.includes(`"total_size_18dec":${(2n ** 80n).toString()}`))
  assert.ok(sdk.sessionEnd(Date.now() + 365 * 86400000) <= Math.floor(Date.now() / 1000) + sdk.SESSION_MAX_SECONDS)
})

test('a signature that does not recover to the signer is refused', async () => {
  const w = Wallet.createRandom(), other = Wallet.createRandom()
  const liar = { getAddress: async () => w.address, signTypedData: (d, t, v) => other.signTypedData(d, t, v) }
  const dom = sdk.domain('VordCore', 101102, '8b'.repeat(32))
  await assert.rejects(sdk.signOp(liar, dom, 'CancelOrder', { owner: w.address, orderId: 1 }), sdk.InvalidRequest)
  const s = await sdk.signOp(w, dom, 'CancelOrder', { owner: w.address, orderId: 1 })
  assert.match(s, /^0x[0-9a-f]{130}$/); assert.equal(sdk.rs64(s).length, 130)
})

test('nonce clock: rising, never repeated, above a nonce the chain holds', () => {
  let t = 1000
  const c = new sdk.NonceClock(() => t)
  assert.equal(c.next(), 1000); assert.equal(c.next(), 1001); c.seen(5000); assert.equal(c.next(), 5001); t = 9000; assert.equal(c.next(), 9000)
  assert.equal(sdk.nonceClock('0xAB'), sdk.nonceClock('0xab'))
})

test('feeds: snapshot then in-order updates; a gap resubscribes; the book applies level changes', () => {
  const sent = []
  let sock
  const f = new sdk.Feeds('wss://x', { socket: () => (sock = { send: (m) => sent.push(JSON.parse(m)), close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }) })
  return f.open().then(() => {
    f.subscribe('book', 1)
    assert.equal(sent.length, 0, 'nothing is sent while the socket is still connecting')
    sock.onopen()
    assert.deepEqual(sent.at(-1), { method: 'subscribe', channel: 'book', pair: 1 }, 'the subscription is sent once it opens')
    assert.equal(f.handle({ channel: 'book', pair: 1, type: 'update', seq: 3, prev_seq: 2, bids: [] }), null)   // before any snapshot
    assert.equal(f.handle({ channel: 'book', pair: 1, type: 'snapshot', seq: 10, prev_seq: null, bids: [['100', '5']], asks: [['110', '1']] }), 'snapshot')
    assert.equal(f.handle({ channel: 'book', pair: 1, type: 'update', seq: 11, prev_seq: 10, bids: [['100', '0'], ['99', '2']] }), 'update')
    assert.deepEqual(f.books.get(1).bestBid(), [99n, 2n])
    assert.equal(f.handle({ channel: 'book', pair: 1, type: 'update', seq: 13, prev_seq: 12, bids: [] }), 'resubscribed')
    assert.deepEqual(sent.at(-1), { method: 'subscribe', channel: 'book', pair: 1 })
    assert.equal(f.books.get(1).bids.size, 0)
    f.close()
  })
})

test('exact JSON: whole numbers past 2^53 come back as digit strings', () => {
  const j = sdk.parseExactJson('{"a":123456789012345678901,"b":[1,2.5,"x:99999999999999999999"],"c":-9007199254740993}')
  assert.equal(j.a, '123456789012345678901'); assert.deepEqual(j.b, [1, 2.5, 'x:99999999999999999999']); assert.equal(j.c, '-9007199254740993')
})

test('network: a node identity needs both a chain id and a genesis', () => {
  assert.deepEqual(sdk.readIdentity({ chain_id: 101102, genesis_sha256: '0x' + 'AB'.repeat(32) }), { chainId: 101102, genesis: 'ab'.repeat(32) })
  assert.throws(() => sdk.readIdentity({ chain_id: 101102 }))
  assert.throws(() => sdk.readIdentity({ genesis_sha256: 'ab'.repeat(32) }))
  assert.deepEqual(sdk.statusUrls('https://h.example/chain'), ['https://h.example/chain/status', 'https://h.example/status'])
})

test('agent refusal codes: meanings from the spec, the intake answer and the event records', () => {
  const spec = { agents: { refusalCodes: { reasons: [{ key: 'registration_not_live', meaning: "The agent's registration is revoked or expired." }, { key: 'x' }] } } }
  const m = sdk.refusalMeanings(spec)
  assert.equal(m.size, 1); assert.equal(sdk.refusalMeanings({}).size, 0)
  const a = sdk.readAnswer(403, { code: 'agent_refused', reason: 'registration_not_live' }, null, m)
  assert.equal(a.submitted, false); assert.equal(a.refusal.code, 'agent_refused'); assert.equal(a.refusal.detail, 'registration_not_live')
  assert.equal(a.refusal.message, "The agent's registration is revoked or expired.")
  assert.match(sdk.readAnswer(403, { code: 'agent_refused', reason: 'zzz' }).refusal.message, /zzz/)
  const ev = sdk.readAgentRefusals({ events: [{ kind: 'order_placed' }, { kind: 'agent_refused', reason: 'registration_not_live', at_ms: 5, height: 9 }, { kind: 'agent_refused', reason: 'new_one' }] }, m)
  assert.equal(ev.length, 2); assert.equal(ev[0].meaning, "The agent's registration is revoked or expired."); assert.equal(ev[0].timestampMs, 5); assert.equal(ev[1].meaning, null)
})

test('every operation is signed in its own domain: sessions in VordexSession, everything else in VordCore', () => {
  for (const op of Object.keys(sdk.TYPE_STRINGS)) {
    if (op === 'BatchAction') continue
    assert.equal(sdk.domainOf(op), op === 'SessionCreate' || op === 'SessionRevoke' ? 'VordexSession' : 'VordCore', op)
  }
})
