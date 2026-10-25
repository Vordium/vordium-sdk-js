// Reads cases (JSON lines) on stdin and answers each with what this SDK computes: digests, signatures and bodies.
// Driven by the cross-check that holds this SDK to the Python SDK.
import { createInterface } from 'node:readline'
import { Wallet } from 'ethers'
import * as sdk from '../dist/esm/index.js'

const big = (v) => (typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : v)
const fix = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => (x && typeof x === 'object' ? fix(x) : big(x))) : big(v)]))
const out = (o) => JSON.stringify(o, (_, x) => (typeof x === 'bigint' ? x.toString() : x))

const rl = createInterface({ input: process.stdin })
for await (const line of rl) {
  if (!line.trim()) continue
  const c = JSON.parse(line)
  let r
  try {
    const dom = sdk.domain(c.cls ?? 'VordCore', c.chainId, c.genesis)
    switch (c.kind) {
      case 'digest': r = { digest: sdk.digest(dom, c.op, fix(c.value)) }; break
      case 'sign': r = { sig: await sdk.signOp(new Wallet(c.key), dom, c.op, fix(c.value)) }; break
      case 'submit': r = { body: sdk.submitBody(c.op, fix(c.value), c.sig) }; break
      case 'order': {
        const v = sdk.placeOrderValue(c.input)
        r = { value: v, digest: sdk.digest(dom, 'PlaceOrder', v), body: sdk.placeOrderBody(v, c.sessionKey, c.sig) }
        break
      }
      case 'batchBody': r = { body: sdk.batchBody(c.owner, c.nonce, c.actions.map(fix), c.sig) }; break
      case 'name': r = { step: sdk.nameRefusalStep(sdk.normalizeName(c.raw)), normalized: sdk.normalizeName(c.raw) }; break
      case 'policy': r = { problems: sdk.policyProblems(fix(c.policy), c.now), loosens: sdk.loosens(c.prev ? fix(c.prev) : null, fix(c.policy)) }; break
      case 'twapBody': r = { body: sdk.twapBody(fix(c.value), c.sig) }; break
      case 'sessionBody': r = { body: sdk.sessionCreateBody(c.owner, c.key, c.exp, c.nonce, c.sig) }; break
      case 'marginBody': r = { body: sdk.marginModeBody(c.owner, c.pair, c.mode, c.nonce, c.sig) }; break
      case 'separator': r = { sep: sdk.separator(c.cls, c.chainId, c.genesis) }; break
      default: r = { error: `unknown kind ${c.kind}` }
    }
  } catch (e) {
    r = { error: e?.constructor?.name ?? 'Error' }
  }
  process.stdout.write(out({ id: c.id, ...r }) + '\n')
}
