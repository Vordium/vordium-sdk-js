// The node's published vectors, read from the vendored files (pinned by SHA256SUMS). No value is typed into a test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Wallet, TypedDataEncoder, keccak256, toUtf8Bytes } from 'ethers'
import * as sdk from '../dist/esm/index.js'

const dir = new URL('./vectors/', import.meta.url)
const sums = Object.fromEntries(readFileSync(new URL('SHA256SUMS', dir), 'utf8').trim().split('\n').map((l) => l.split(/\s+/).reverse()))
const load = (f) => {
  const b = readFileSync(new URL(f, dir))
  assert.equal(createHash('sha256').update(b).digest('hex'), sums[f], `${f} is the pinned file`)
  return sdk.parseExactJson(b.toString('utf8'))
}
const AG = load('agent-ops-vectors-2c1c0679.json')
const RB = load('rollb-client-vectors-2c1c0679.json')
const SC = load('schedule-cancel-vectors.json')
const TW = load('twap-spec-v6.json')

const chain = AG.network.chainId, genesis = AG.network.genesis_sha256

test('the VordCore domain derived from the genesis equals the published one (salt and separator)', () => {
  assert.equal(sdk.salt('VordCore', genesis), AG.domain.salt)
  assert.equal(sdk.separator('VordCore', chain, genesis), AG.domain.domainSeparator)
  assert.equal(sdk.separator('VordCore', RB.network.chainId, RB.network.genesis_sha256), RB.domain.domainSeparator)
  assert.equal(sdk.separator('VordCore', SC.chain_id, SC.genesis_sha256), SC.domain_separator)
})

test('the agent operations in force: type strings, typeHashes, digests, signatures by the account key and /submit bodies (node vectors)', async () => {
  const owner = new Wallet(AG.test_keys.owner.private_key), agent = new Wallet(AG.test_keys.agent.private_key)
  const dom = sdk.domain('VordCore', RB.network.chainId, RB.network.genesis_sha256)
  for (const v of RB.ops) {
    const op = v.submit.body.op
    assert.equal(sdk.TYPE_STRINGS[op], v.typeString, `${op} type string`)
    assert.equal(TypedDataEncoder.from(sdk.typesFor(op)).encodeType(op), v.typeString)
    const value = { ...v.fields }
    assert.equal(sdk.digest(dom, op, value), v.digest, `${op} digest`)
    const sig = await sdk.signOp(owner, dom, op, value)
    assert.equal(sig, v.signed.signature, `${op} signature by the account's key, byte for byte`)
    assert.deepEqual(sdk.submitBody(op, value, sig), v.submit.body, `${op} /submit body`)
    const asAgent = await sdk.signOp(agent, dom, op, value)
    assert.equal(asAgent, v.signed_by_agent_key.signature, `${op} agent-key signature (the chain refuses it except to tighten a policy)`)
  }
})

test('RevokeAgent and SetAgentMarketLimit: digests and signatures from the agent-op vectors', async () => {
  const owner = new Wallet(AG.test_keys.owner.private_key)
  const dom = sdk.domain('VordCore', chain, genesis)
  let n = 0
  for (const v of AG.signed_vectors.vectors) {
    if (v.op !== 'RevokeAgent' && v.op !== 'SetAgentMarketLimit') continue
    assert.equal(sdk.digest(dom, v.op, v.message), v.digest, `${v.op} digest`)
    const c = v.cases.find((x) => x.signedBy === 'test owner key')
    assert.equal(await sdk.signOp(owner, dom, v.op, v.message), c.signature.toLowerCase(), `${v.op} signature`)
    n++
  }
  for (const v of AG.canonical_vectors.vectors) {
    if (v.op !== 'RevokeAgent' && v.op !== 'SetAgentMarketLimit') continue
    assert.equal(TypedDataEncoder.hashStruct(v.op, sdk.typesFor(v.op), v.message), v.structHash)
    assert.equal(sdk.digest(dom, v.op, v.message), v.digest)
    n++
  }
  assert.equal(n, 4)
})

test('ScheduleCancel: typeHash, struct hashes and digests (node vectors)', () => {
  const dom = sdk.domain('VordCore', SC.chain_id, SC.genesis_sha256)
  assert.equal(TypedDataEncoder.from(sdk.typesFor('ScheduleCancel')).encodeType('ScheduleCancel'), sdk.TYPE_STRINGS.ScheduleCancel)
  assert.equal(keccak256(toUtf8Bytes(sdk.TYPE_STRINGS.ScheduleCancel)), SC.type_hash)
  for (const c of SC.cases) {
    const v = { owner: c.owner, cancelAtMs: c.cancel_at_ms, nonce: c.nonce }
    assert.equal(TypedDataEncoder.hashStruct('ScheduleCancel', sdk.typesFor('ScheduleCancel'), v), c.struct_hash)
    assert.equal(sdk.digest(dom, 'ScheduleCancel', v), c.digest)
  }
})

test('the name rule: every judged name in the node table, in the chain\'s step order', () => {
  assert.deepEqual([...sdk.RESERVED_WORDS_DEFAULT], RB.name_rule.default_reserved_words)
  for (const e of RB.name_rule.table) {
    const name = Buffer.from(e.name_hex.slice(2), 'hex').toString('utf8')
    const step = sdk.nameRefusalStep(name)
    // the node names a reserved word inside its result: Reserved("vordium")
    const word = step === 'Reserved' ? sdk.RESERVED_WORDS_DEFAULT.find((w) => sdk.nameSkeleton(name).includes(w)) : null
    assert.equal(step === null ? 'accepted' : word ? `Reserved("${word}")` : step, e.result, `"${name}"`)
    assert.equal(sdk.nameSkeleton(name), e.skeleton)
  }
})

test('TWAP rules from the published spec section', () => {
  const r = sdk.readTwapRules(TW)
  assert.equal(r.path, TW.twap.place.path)
  assert.ok(r.minDurationMs > 0 && r.maxDurationMs >= r.minDurationMs && r.maxSlices > 0)
  const [n, every] = sdk.planTwap(r.minDurationMs, r)
  assert.ok(n >= 1 && every * n <= r.minDurationMs)
  assert.throws(() => sdk.readTwapRules({ twap: { ...TW.twap, place: { ...TW.twap.place, typeString: 'PlaceTwap(address owner)' } } }), sdk.NotAvailable)
  assert.throws(() => sdk.readTwapRules({ twap: { available: false, reason: 'x' } }), sdk.NotAvailable)
})
