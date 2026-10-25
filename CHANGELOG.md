# Changelog

## 0.1.1
- First public release of `@vordium/sdk` for Node.js 20+ and the browser.
- `Vordium.connect({ network })` reads the network spec, the node's `/status` and `eth_chainId`, and refuses unless all
  three name the same chain and genesis; every signature is bound to that genesis.
- Orders: Market and Limit, cancel, cancel-all, modify, batch with time in force, take-profit / stop-loss, a dead-man
  switch. Prices and sizes are put on each market's tick and lot exactly (a buy rounds down, a sell up, a size down).
- Session keys (a held key is revoked first), agents (register, name, policy, market limits, lock clear, revoke) with the
  network's own refusal meanings, TWAP orders, margin mode, account reads and live feeds.
- Every account write reports `applied` only once the chain reads it back.
