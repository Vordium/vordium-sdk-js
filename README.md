# Vordium JavaScript / TypeScript SDK

Sign and send orders, manage session keys and agents, place TWAP orders, set the margin mode and follow live feeds on
Vordium Chain and the Vordex perpetuals exchange — from Node.js (20+) or the browser.

```bash
npm install @vordium/sdk
```

The SDK's one dependency is [ethers](https://docs.ethers.org/v6/). A signer is anything with `getAddress()` and
`signTypedData()`: an ethers `Wallet`, a browser wallet through ethers, or your own key-management adapter.

## Connect

```ts
import { Vordium } from '@vordium/sdk'

const v = await Vordium.connect({ network: 'testnet' })   // or 'mainnet'
```

`connect` reads the network spec, the node's `/status` and the JSON-RPC `eth_chainId`, and refuses unless all three name
the same chain and the same genesis. Every signature is bound to that genesis (the EIP-712 domain's `salt`), so a
signature made for one network can never be used on another.

## Trade

```ts
import { Wallet } from 'ethers'

const owner = new Wallet(process.env.PRIVATE_KEY!)
const session = Wallet.createRandom()
const me = await v.account(owner, { sessionSigner: session })

await me.createSession(session.address, Date.now() + 7 * 86400_000)   // applied once the chain confirms it

const order = await me.placeOrder({ pairId: 1, side: 'buy', size: '0.01', orderType: 'Limit', price: '2400.5' })
const state = await me.waitForOrder(order.clientNonce)                  // 'resting' | 'filled' | 'cancelled' | …
```

- Order types are `Market` and `Limit`. A limit price keeps 6 decimals; a market order carries no price. Stop orders are
  not available and are refused before anything is signed.
- Market makers: `batch()` (place / cancel / cancel by client nonce, with good-till-cancelled, post-only, IOC and FOK),
  `cancelAll()`, `modify()`, and the dead-man switch `scheduleCancel()`.
- Take-profit and stop-loss on a position: `setTpSl()`.
- Every nonce comes from one millisecond clock per account, so batches, single orders and the dead-man switch never
  collide.

## What "applied" means

A write is answered when the network accepts it for a coming block (HTTP 202). That is a submission, not a result. The
account operations — session keys, agents, TWAP and margin mode — return `{ applied, status, answer, detail }`, and
`applied` is true only once the chain's own read shows the change. Orders return the submission; read them back with
`waitForOrder()`, `openOrders()` and `positions()`.

## Agents

```ts
await me.registerAgent({ agent: agentAddress, name: 'Night Desk', mandate: 'market making on ETH', expiresMs })
await me.setAgentPolicy(agentAddress, policy)          // refused before signing if the chain would refuse it
await me.setAgentMarketLimit(agentAddress, { pair: 1, allowed: true, maxOrder18, maxPosition18, maxLeverageBps: 20000 })
await me.createSession(agentAddress, endMs)            // the agent trades with its own key for this account

const agent = await v.agentKey(owner.address, agentWallet)
await agent.placeOrder({ pairId: 1, side: 'buy', size: '0.01', orderType: 'Limit', price: '2390' })
console.log(await v.agentRefusals(agentAddress))       // what the chain refused, with its reason in plain words
```

Agent names follow the chain's rule (`requireName`, `nameRefusalStep`). The agent may sign only a tightening of its own
policy; every other agent operation is signed by the owner.

## TWAP and margin mode

```ts
const twap = await me.placeTwap({ pairId: 1, side: 'buy', totalSize18, durationMs: 30 * 60_000 })   // owner key only
await me.cancelTwap(twapId)
await me.setMarginMode(1, 'isolated')   // only while the market has no open position and no resting order
```

TWAP limits are read from the network spec; an order outside them is refused before signing.

## Live feeds

```ts
import { Feeds } from '@vordium/sdk'

const f = new Feeds(v.network.feeds!)
f.onEvent = (e) => { if (e.kind === 'update') console.log(f.books.get(1)?.bestBid()) }
await f.open()
f.subscribe('book', 1)          // also: 'trades', and 'orders' / 'fills' for an account
```

Each subscription starts with a snapshot. A missed message is detected from the sequence numbers, and the SDK
subscribes again from a fresh snapshot by itself; a lost connection is reopened with a random back-off.

## Units

Signed prices are 8-decimal integers and sizes 18-decimal integers (`bigint`). `toUnits`, `fromUnits`, `limitPrice8`
and `size18` convert exactly and refuse a value they would have to round.

Each market has a price step (tick) and a size step (lot), published in `GET /markets/specs`; the chain does not apply
an order that is off them. Every order the SDK signs (`placeOrder`, `batch`, `modify`, `setTpSl`, `placeTwap`) is put on
them first: a number is read exactly from its decimal form (a floating-point number is never multiplied), a buy's limit
price rounds down and a sell's up (never a worse price than asked), a take-profit or stop-loss trigger goes to the
nearest tick, and a size rounds down onto the lot (never more than asked). A size that rounds to 0, a size below the
market's smallest size, or a limit order below the network's smallest order value raises `OrderValueError` before
anything is signed. `price8OnTick`, `size18OnLot` and `pairSpecs` apply the same rules on their own.

## Licence

MIT
