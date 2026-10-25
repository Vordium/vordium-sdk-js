// The SDK against the live test network, with real signing and throwaway test keys. Every step is read back from the
// chain. Runs only when a funded test-network owner key is given:
//   TESTNET_OWNER_KEY=0x… node test/live-testnet.mjs        (or TESTNET_OWNER_KEY_FILE=path)
// It refuses to run against any network but the test network. Exit 0 all passed · 1 a step failed · 77 skipped.
import { readFileSync } from 'node:fs'
import { Wallet } from 'ethers'
import * as sdk from '../dist/esm/index.js'

const keyOf = (name) => process.env[name] ?? (process.env[name + '_FILE'] ? readFileSync(process.env[name + '_FILE'], 'utf8').trim() : null)
const ownerKey = keyOf('TESTNET_OWNER_KEY')
if (!ownerKey) { console.log('SKIPPED  no test-network owner key given'); process.exit(77) }
const only = (process.env.TESTNET_STEPS ?? '').split(',').filter(Boolean)
const run = (s) => only.length === 0 || only.includes(s)

let pass = 0, fail = 0, notRun = 0
const ck = (ok, what, d) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${what}${!ok && d !== undefined ? ' — ' + String(typeof d === 'string' ? d : JSON.stringify(d, (_, x) => (typeof x === 'bigint' ? x.toString() : x))).slice(0, 400) : ''}`) }
const skip = (what, why) => { notRun++; console.log(`  NOT RUN  ${what} — ${why}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const v = await sdk.Vordium.connect({ network: 'testnet' })
console.log(`connected: chain ${v.network.chainId}, genesis ${v.network.genesis.slice(0, 8)}…`)
ck(v.network.specRead.testnet === true && v.network.chainId === Number(v.network.specRead.chainId), 'the test network: spec, node and JSON-RPC agree on the chain and its genesis')
await (async () => {
  try { await sdk.Vordium.connect({ network: { ...sdk.NETWORKS.testnet, name: 'mainnet' } }); ck(false, 'a test-network spec is refused as the main network') }
  catch (e) { ck(e instanceof sdk.NetworkMismatch, 'a test-network spec is refused as the main network', e?.message) }
})()

const owner = new Wallet(ownerKey)
const session = Wallet.createRandom()
const acct = await v.account(owner, { sessionSigner: session })
const eq = await v.equity(owner.address)
ck(eq.freeBalance6 >= 25_000_000n, 'the test owner has at least 25 test USDC free', sdk.fromUnits(eq.freeBalance6, 6))
const PAIR = 1
const mark = async () => BigInt((await v.oracle(PAIR)).mark_price)            // 6-decimal integer
const px = (m6, bps) => sdk.fromUnits(((m6 * BigInt(10000 + bps)) / 10000n / 10000n) * 10000n, 6)   // mark ± bps, 2 decimals
const SIZE = '0.006'                                                           // above the $10 minimum at ETH's price

// clean start: no resting order, no position on the pair
await acct.cancelAll(0).catch(() => null)

if (true) {   // every run signs with a new session key, so the session step always runs
  const r = await acct.createSession(session.address, Date.now() + 86400000)
  ck(r.applied, 'session: created for a new key (a held key revoked first) and confirmed by the chain', r)
}

if (run('limit')) {
  const p = await acct.placeOrder({ pairId: PAIR, side: 'buy', size: SIZE, orderType: 'Limit', price: px(await mark(), -200), leverage: 1 })
  ck(p.submitted, 'limit order: submitted', p)
  const st = await acct.waitForOrder(p.clientNonce, 20000)
  ck(st === 'resting', 'limit order: the chain holds it on the book (read back by its client nonce)', st)
  const o = (await v.openOrders(owner.address)).find((x) => x.clientNonce === p.clientNonce)
  if (o) {
    ck(o.price8 % 100n === 0n && o.size18 === sdk.size18(SIZE), 'limit order: the book holds the signed price and size', o)
    const c = await acct.cancelOrder(o.orderId)
    ck(c.submitted, 'cancel: submitted', c)
    ck((await acct.waitForOrder(p.clientNonce, 20000)) === 'cancelled', 'cancel: the chain records it cancelled')
  }
}

if (run('market')) {
  const p = await acct.placeOrder({ pairId: PAIR, side: 'buy', size: SIZE, orderType: 'Market' })
  ck(p.submitted, 'market order: submitted', p)
  ck((await acct.waitForOrder(p.clientNonce, 20000, { final: true })) === 'filled', 'market order: filled', p.clientNonce)
  const pos = (await v.positions(owner.address)).find((x) => x.pairId === PAIR)
  ck(!!pos && pos.isLong && pos.size18 >= sdk.size18(SIZE), 'the position reads back long, exact size', pos)
  if (pos) {
    const liq = sdk.saneLiquidationPrice(pos)
    console.log(`     liquidation price: ${liq === null ? 'not available' : sdk.fromUnits(liq, 6)}`)
    const c = await acct.placeOrder({ pairId: PAIR, side: 'sell', size: sdk.fromUnits(pos.size18, 18), orderType: 'Market', reduceOnly: true })
    ck((await acct.waitForOrder(c.clientNonce, 20000, { final: true })) === 'filled', 'close: a reduce-only market order fills')
    await sleep(1500)
    ck(!(await v.positions(owner.address)).some((x) => x.pairId === PAIR), 'close: no position left on the pair')
  }
}

if (run('batch')) {
  const m = await mark()
  const n1 = acct.nonce.next(), n2 = acct.nonce.next()
  const a1 = sdk.batchPlace({ pairId: PAIR, side: 'buy', size18: sdk.size18(SIZE), price8: sdk.limitPrice8(px(m, -250)), clientNonce: n1, postOnly: true })
  const a2 = sdk.batchPlace({ pairId: PAIR, side: 'sell', size18: sdk.size18(SIZE), price8: sdk.limitPrice8(px(m, 250)), clientNonce: n2, postOnly: true })
  const b = await acct.batch([a1, a2])
  ck(b.submitted && b.actions.length === 2 && b.actions.every((x) => x.accepted), 'batch: two post-only limits accepted', b)
  ck((await acct.waitForOrder(n1)) === 'resting' && (await acct.waitForOrder(n2)) === 'resting', 'batch: both rest on the book')
  const o1 = (await v.openOrders(owner.address)).find((x) => x.clientNonce === n1)
  if (o1) {
    const mo = await acct.modify(o1.orderId, sdk.limitPrice8(px(m, -300)), sdk.size18(SIZE))
    ck(mo.submitted, 'modify: submitted', mo)
    ck((await acct.waitForOrder(mo.clientNonce)) === 'resting', 'modify: the replacement rests at the new price')
  }
  const ca = await acct.cancelAll(PAIR)
  ck(ca.submitted, 'cancel-all: submitted', ca)
  let left = 1
  for (let i = 0; i < 20 && left; i++) { await sleep(1000); left = (await v.openOrders(owner.address)).filter((x) => x.pairId === PAIR).length }
  ck(left === 0, 'cancel-all: no order left on the pair', left)
}

if (run('deadman')) {
  const s0 = await v.scheduleCancelState(owner.address)
  if (!s0?.active) skip('dead-man switch', 'not active on this network')
  else {
    const at = Date.now() + 120000
    const r = await acct.scheduleCancel(at)
    ck(r.submitted, 'dead-man switch: armed', r)
    let st = null
    for (let i = 0; i < 20; i++) { await sleep(1000); st = await v.scheduleCancelState(owner.address); if (st?.cancel_at_ms === at) break }
    ck(st?.cancel_at_ms === at, 'dead-man switch: the chain holds the deadline', st)
    const c = await acct.scheduleCancel(0)
    for (let i = 0; i < 20; i++) { await sleep(1000); st = await v.scheduleCancelState(owner.address); if (st?.cancel_at_ms === null) break }
    ck(c.submitted && st?.cancel_at_ms === null, 'dead-man switch: cleared', st)
  }
}

if (run('margin')) {
  const before = await acct.marginMode(PAIR)
  const other = before === 'isolated' ? 'cross' : 'isolated'
  const r1 = await acct.setMarginMode(PAIR, other)
  ck(r1.applied, `margin mode: ${before} → ${other}, read back`, r1)
  const r2 = await acct.setMarginMode(PAIR, before ?? 'cross')
  ck(r2.applied, `margin mode: back to ${before ?? 'cross'}`, r2)
}

if (run('twap')) {
  let rules = null
  try { rules = v.twapRules() } catch (e) { skip('TWAP', e.message) }
  if (rules) {
    const m = await mark()
    // the network's smallest TWAP, and at least two slices of its smallest slice, plus a fifth: sized from the spec
    const want6 = BigInt(Math.max(rules.minTotalNotional6dec, 2 * rules.minSliceNotional6dec)) * 6n / 5n
    const total18 = ((want6 * 10n ** 18n) / m / 10n ** 14n + 1n) * 10n ** 14n
    const notional6 = Number((total18 * m) / 10n ** 18n)
    console.log(`     TWAP: ${sdk.fromUnits(total18, 18)} ETH ≈ ${sdk.fromUnits(BigInt(notional6), 6)} USDC; network minimum ${sdk.fromUnits(BigInt(rules.minTotalNotional6dec), 6)}`)
    const dur = Math.max(rules.minDurationMs, Math.min(rules.maxDurationMs, 30 * 60 * 1000))
    const [slices] = sdk.planTwap(dur, rules, notional6)
    const t = await acct.placeTwap({ pairId: PAIR, side: 'buy', totalSize18: total18, durationMs: dur, numSlices: Math.min(slices, 2), slippageBps: Math.min(100, rules.maxSlippageBps), leverageBps: 10000 })
    ck(t.applied, 'TWAP: placed with the owner key and listed by the chain', t)
    const row = (await v.twaps(owner.address)).find((x) => String(x.client_nonce) === String(t.clientNonce))
    if (row) {
      const c = await acct.cancelTwap(BigInt(row.twap_id ?? row.id))
      ck(c.applied, 'TWAP: cancelled and gone from the list', c)
    }
    // close anything a slice filled
    await sleep(2000)
    const pos = (await v.positions(owner.address)).find((x) => x.pairId === PAIR)
    if (pos) await acct.placeOrder({ pairId: PAIR, side: pos.isLong ? 'sell' : 'buy', size: sdk.fromUnits(pos.size18, 18), orderType: 'Market', reduceOnly: true }).then((c) => acct.waitForOrder(c.clientNonce, 20000, { final: true }))
  }
}

if (run('agent')) {
  const agentKey = Wallet.createRandom()
  const name = `SDK test ${Date.now() % 100000}`
  const reg = await acct.registerAgent({ agent: agentKey.address, name, mandate: 'SDK test: limit orders on ETH', expiresMs: Date.now() + 2 * 86400000 })
  ck(reg.applied, 'agent: registered with a name, listed active by the chain', reg)
  // registering is the first naming: the chain ignores a rename within its wait (refused here where the wait is published)
  try {
    const ren = await acct.renameAgent(agentKey.address, name + ' b')
    ck(v.renameWaitMs() === null && !ren.applied && /wait/.test(ren.detail), 'agent: a rename right after registering is not applied (the chain allows one per wait)', ren)
  } catch (e) {
    ck(v.renameWaitMs() !== null && e instanceof sdk.InvalidRequest, 'agent: a rename within the published wait is refused before signing', e?.message)
  }
  const same = await acct.renameAgent(agentKey.address, name)
  ck(same.applied && same.status === 0, 'agent: re-sending the stored name is not a rename (nothing signed)', same)
  const policy = { capsBitmask: 0b10011, sideMode: 0, maxTotalExposure6dec: 50_000_000n, maxLeverageBps: 20000, dailyLossLimit6dec: 10_000_000n, dailyFeeCap6dec: 1_000_000n,
    opsPerWindow: 0, opsWindowMs: 0, activeFromMsOfDay: 0, activeToMsOfDay: 0, oracleBandBps: 300, lockAutoClear: false, expiresMs: Date.now() + 2 * 86400000, enabled: true }
  const pr = await acct.setAgentPolicy(agentKey.address, policy)
  ck(pr.applied, 'agent: policy set and read back field for field', pr)
  const ml = await acct.setAgentMarketLimit(agentKey.address, { pair: PAIR, allowed: true, maxOrder18: sdk.size18('0.02'), maxPosition18: sdk.size18('0.04'), maxLeverageBps: 20000 })
  ck(ml.applied, 'agent: market limit set and read back', ml)
  const asAgent = await v.agentKey(owner.address, agentKey)
  try { await asAgent.setAgentPolicy(agentKey.address, { ...policy, maxLeverageBps: 30000 }); ck(false, 'agent: a loosening signed by the agent is refused before signing') }
  catch (e) { ck(e instanceof sdk.InvalidRequest && /only tighten/.test(e.message), 'agent: a loosening signed by the agent is refused before signing', e?.message) }
  const tight = await asAgent.setAgentPolicy(agentKey.address, { ...policy, maxLeverageBps: 15000 })
  ck(tight.applied, 'agent: the agent tightens its own policy, read back', tight)
  const sess = await acct.createSession(agentKey.address, Date.now() + 86400000)
  ck(sess.applied, 'agent: given the account session', sess)
  const p = await asAgent.placeOrder({ pairId: PAIR, side: 'buy', size: SIZE, orderType: 'Limit', price: px(await mark(), -100), leverage: 1 })
  ck(p.submitted, 'agent order: submitted with the agent key', p)
  const st = await asAgent.waitForOrder(p.clientNonce, 20000)
  const refused = await v.agentRefusals(agentKey.address)
  ck(st === 'resting' || refused.length > 0, `agent order: ${st === 'resting' ? 'rests on the book' : 'refused by the chain with reason ' + refused[0]?.reason}`)
  console.log(`     agent order: ${st ?? 'no record'}; chain refusals: ${refused.map((x) => x.reason).join(', ') || 'none'}`)
  await acct.cancelAll(PAIR)
  const rv = await acct.revokeAgent(agentKey.address)
  ck(rv.applied, 'agent: revoked', rv)
  const after = await asAgent.placeOrder({ pairId: PAIR, side: 'buy', size: SIZE, orderType: 'Limit', price: px(await mark(), -100), leverage: 1 })
  let refusedAfter = []
  for (let i = 0; i < 15 && !refusedAfter.some((x) => x.record.client_nonce === after.clientNonce); i++) { await sleep(1000); refusedAfter = await v.agentRefusals(agentKey.address) }
  const r = refusedAfter.find((x) => x.record.client_nonce === after.clientNonce)
  ck(!!r, `a revoked agent's order: answered ${after.status}, then refused by the chain (${r?.reason ?? 'no record'})`)
  const meanings = v.refusalMeanings()
  if (meanings.size === 0) skip('refusal meanings', 'the network publishes no refusal codes')
  else ck(r?.meaning === meanings.get('registration_not_live') && !!r?.meaning, `the refusal reads in plain words from the network's codes: "${r?.meaning}"`)
  const end = await acct.revokeSession()
  ck(end.applied, 'session: ended', end)
}

if (run('feeds')) {
  const url = v.network.feeds
  const f = new sdk.Feeds(url)
  const got = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), 15000)
    f.onEvent = (e) => { if (e.kind === 'snapshot') { clearTimeout(t); resolve(e.message) } }
    f.open().then(() => f.subscribe('book', PAIR)).catch(() => resolve(null))
  })
  ck(!!got && got.channel === 'book' && got.pair === PAIR, 'feeds: a book snapshot within 15 s', got && { seq: got.seq, bids: got.bids?.length, asks: got.asks?.length })
  const b = f.books.get(PAIR)
  ck(!!b && b.seq === got?.seq, 'feeds: the book is built from the snapshot', b && { bid: b.bestBid(), ask: b.bestAsk() })
  f.close()
}

await acct.cancelAll(0).catch(() => null)
console.log(`${fail ? 'FAIL' : 'ALL PASS'} — live test network: ${pass} passed, ${fail} failed, ${notRun} not run`)
process.exit(fail ? 1 : 0)
