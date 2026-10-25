/**
 * The EIP-712 types the chain signs, as its own type strings. Field order, names and solidity types are byte-exact with
 * the chain's signing code: never reorder or rename a field. Each string is parsed into the `types` object a signer
 * takes, so the strings below are the single source.
 */
export type TypeField = { name: string; type: string }
export type Types = Record<string, TypeField[]>

export const TYPE_STRINGS = {
  // VordCore — orders
  PlaceOrder: 'PlaceOrder(address owner,uint32 pairId,uint8 side,uint128 size,uint64 price,uint32 leverageBps,uint8 orderType,bool reduceOnly,bool postOnly,uint64 triggerPrice8dec,uint8 triggerDir,uint64 clientNonce)',
  CancelOrder: 'CancelOrder(address owner,uint64 orderId)',
  SetTpSl: 'SetTpSl(address owner,uint32 pairId,uint64 positionId,uint64 takeProfit8dec,uint64 stopLoss8dec)',
  BatchAction: 'BatchAction(uint8 kind,uint32 pairId,uint8 side,uint128 size,uint64 price,uint32 leverageBps,uint8 orderType,bool reduceOnly,bool postOnly,uint64 clientNonce,uint64 orderId)',
  BatchOrders: 'BatchOrders(address owner,uint64 nonce,BatchAction[] actions)',
  CancelAllOrders: 'CancelAllOrders(address owner,uint32 pairId,uint64 nonce)',
  ModifyOrderV2: 'ModifyOrderV2(address owner,uint64 orderId,uint64 newPrice,uint128 newSize,uint64 clientNonce)',
  SetMmp: 'SetMmp(address owner,uint64 windowMs,uint32 maxFills,uint128 maxFilledNotional6dec,uint128 maxNetSize18dec,uint64 freezeMs,uint64 nonce)',
  ScheduleCancel: 'ScheduleCancel(address owner,uint64 cancelAtMs,uint64 nonce)',
  // VordCore — account
  PlaceTwap: 'PlaceTwap(address owner,uint32 pairId,uint8 side,uint128 totalSize18dec,uint32 numSlices,uint64 durationMs,uint32 leverageBps,uint32 slippageBps,bool randomize,uint64 triggerPrice8dec,uint8 triggerDir,uint64 minPrice8dec,uint64 maxPrice8dec,uint64 clientNonce)',
  CancelTwap: 'CancelTwap(address owner,uint64 twapId,uint64 clientNonce)',
  SetMarginMode: 'SetMarginMode(address owner,uint32 pairId,uint8 mode,uint64 nonce)',
  // VordCore — agents (the operations in force)
  RegisterAgentV2: 'RegisterAgentV2(address owner,address agent,string name,string mandate,uint64 expiresMs,uint64 nonce)',
  SetAgentName: 'SetAgentName(address owner,address agent,string name,uint64 nonce)',
  SetAgentPolicyV1: 'SetAgentPolicyV1(address owner,address agent,uint32 capsBitmask,uint8 sideMode,uint128 maxTotalExposure6dec,uint32 maxLeverageBps,uint128 dailyLossLimit6dec,uint128 dailyFeeCap6dec,uint32 opsPerWindow,uint32 opsWindowMs,uint32 activeFromMsOfDay,uint32 activeToMsOfDay,uint32 oracleBandBps,bool lockAutoClear,uint64 expiresMs,bool enabled,uint64 nonce)',
  SetAgentMarketLimit: 'SetAgentMarketLimit(address owner,address agent,uint32 pair,bool allowed,uint128 maxOrder18dec,uint128 maxPosition18dec,uint32 maxLeverageBps,uint64 nonce)',
  ClearAgentLock: 'ClearAgentLock(address owner,address agent,uint64 lockSinceMs,uint64 nonce)',
  RevokeAgent: 'RevokeAgent(address owner,address agent,uint64 nonce)',
  // VordexSession
  SessionCreate: 'SessionCreate(address sessionKey,uint256 expiresAt,uint256 nonce)',
  SessionRevoke: 'SessionRevoke(address owner,uint256 nonce)',
} as const

export type PrimaryType = Exclude<keyof typeof TYPE_STRINGS, 'BatchAction'>

export function parseTypeString(s: string): { name: string; fields: TypeField[] } {
  const m = /^([A-Za-z0-9]+)\(([^()]*)\)$/.exec(s)
  if (!m) throw new Error(`not a type string: ${s}`)
  const fields = m[2] === '' ? [] : m[2].split(',').map((f) => {
    const [type, name] = f.split(' ')
    return { name, type }
  })
  return { name: m[1], fields }
}

/** The `types` object for one primary type (with the structs it references). */
export function typesFor(primary: PrimaryType): Types {
  const own = parseTypeString(TYPE_STRINGS[primary])
  const out: Types = { [own.name]: own.fields }
  for (const f of own.fields) {
    const base = f.type.replace(/\[\]$/, '')
    if (base in TYPE_STRINGS) out[base] = parseTypeString(TYPE_STRINGS[base as keyof typeof TYPE_STRINGS]).fields
  }
  return out
}

/** Which domain each operation is signed in. */
export function domainOf(primary: PrimaryType): 'VordCore' | 'VordexSession' {
  return primary === 'SessionCreate' || primary === 'SessionRevoke' ? 'VordexSession' : 'VordCore'
}
