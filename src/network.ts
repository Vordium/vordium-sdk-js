import { NetworkMismatch, VordiumError } from './errors.js'
import { fetchTransport, type Transport } from './http.js'
import { genesisHex } from './domains.js'

/**
 * Where the SDK asks. A preset never supplies a chain id or a genesis: those are read from the network itself, and the
 * three sources (the network spec, the node's `/status` and the JSON-RPC `eth_chainId`) must agree before anything is
 * signed.
 */
export interface NetworkPreset {
  name: string
  /** The network spec (JSON). */
  spec: string
  /** JSON-RPC (POST). */
  rpc: string
  /** The REST API: orders, accounts, sessions, agents. */
  api: string
  /** The live feeds WebSocket, when the network publishes one. */
  feeds?: string
}

export const NETWORKS: Record<'mainnet' | 'testnet', NetworkPreset> = {
  mainnet: {
    name: 'mainnet',
    spec: 'https://rpc.vordium.com/network-spec.json',
    rpc: 'https://rpc.vordium.com',
    api: 'https://rpc.vordium.com',
    feeds: 'wss://rpc.vordium.com/feeds',
  },
  testnet: {
    name: 'testnet',
    spec: 'https://testnet.vordex.xyz/network-spec.json',
    rpc: 'https://rpc-testnet.vordium.com',
    api: 'https://testnet.vordex.xyz/chain',
    feeds: 'wss://testnet.vordex.xyz/chain/feeds',
  },
}

/** A network the SDK has read and checked. */
export interface Network extends NetworkPreset {
  chainId: number
  /** 64 lower-case hex, no 0x. */
  genesis: string
  /** The network spec as read. */
  specRead: Record<string, unknown>
}

export interface NodeIdentity { chainId: number; genesis: string }

/** A node identity from a `/status` answer; refused unless it names both. */
export function readIdentity(status: unknown): NodeIdentity {
  if (!status || typeof status !== 'object') throw new VordiumError('no_identity', "The node's /status is not an object; refusing to sign.")
  const s = status as Record<string, unknown>
  let cid = s.chain_id
  if (typeof cid === 'string' && /^\d+$/.test(cid)) cid = Number(cid)
  if (typeof cid !== 'number' || !Number.isSafeInteger(cid) || cid <= 0) throw new VordiumError('no_identity', "The node's /status names no chain id; refusing to sign.")
  let g: string
  try { g = genesisHex(String(s.genesis_sha256 ?? '')) } catch { throw new VordiumError('no_identity', "The node's /status names no genesis; refusing to sign.") }
  return { chainId: cid, genesis: g }
}

/** Where a node's `/status` is read: under the API's own path first, then at the host root. */
export function statusUrls(api: string): string[] {
  const u = new URL(api)
  const own = `${u.origin}${u.pathname.replace(/\/$/, '')}/status`
  const root = `${u.origin}/status`
  return own === root ? [own] : [own, root]
}

export async function nodeIdentity(api: string, transport: Transport = fetchTransport, timeoutMs = 8000): Promise<NodeIdentity> {
  let last: unknown = null
  for (const url of statusUrls(api)) {
    try {
      const r = await transport.get(url, timeoutMs)
      if (r.status === 200) return readIdentity(r.body)
      last = new Error(`HTTP ${r.status}`)
    } catch (e) {
      last = e
    }
  }
  throw new VordiumError('no_identity', `The node at ${api} did not give its chain id and genesis; refusing to sign.`, String((last as Error)?.message ?? last))
}

async function rpcChainId(rpc: string, transport: Transport, timeoutMs: number): Promise<number> {
  const r = await transport.post(rpc, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), timeoutMs)
  const res = (r.body as { result?: unknown } | null)?.result
  if (r.status !== 200 || typeof res !== 'string' || !/^0x[0-9a-f]+$/i.test(res)) {
    throw new VordiumError('no_identity', `The JSON-RPC endpoint ${rpc} did not answer eth_chainId.`)
  }
  return Number(BigInt(res))
}

/**
 * Read and check a network. Refuses (NetworkMismatch, nothing signed) unless the spec, the node's `/status` and
 * `eth_chainId` name the same chain id, the spec and the node the same genesis, and the spec's `testnet` flag matches
 * the preset (a test network never stands in for the main network, nor the reverse).
 */
export async function connectNetwork(
  network: 'mainnet' | 'testnet' | NetworkPreset = 'testnet',
  opts: { transport?: Transport; timeoutMs?: number } = {},
): Promise<Network> {
  const p = typeof network === 'string' ? NETWORKS[network] : network
  if (!p) throw new VordiumError('unknown_network', `Unknown network ${String(network)}; known: mainnet, testnet.`)
  const t = opts.transport ?? fetchTransport
  const ms = opts.timeoutMs ?? 10000
  const sr = await t.get(p.spec, ms)
  if (sr.status !== 200 || !sr.body || typeof sr.body !== 'object') throw new VordiumError('no_spec', `The network spec at ${p.spec} could not be read.`)
  const spec = sr.body as Record<string, unknown>
  const specChain = Number(spec.chainId)
  if (!Number.isSafeInteger(specChain) || specChain <= 0) throw new VordiumError('no_spec', 'The network spec names no chain id.')
  const specTest = spec.testnet === true
  if (p.name === 'testnet' && !specTest) throw new NetworkMismatch('The spec at the testnet address does not say it is the test network; refusing to sign.')
  if (p.name === 'mainnet' && specTest) throw new NetworkMismatch('The spec at the main-network address says it is a test network; refusing to sign.')
  const [ident, rpcChain] = await Promise.all([nodeIdentity(p.api, t, ms), rpcChainId(p.rpc, t, ms)])
  if (ident.chainId !== specChain || rpcChain !== specChain) {
    throw new NetworkMismatch(`The spec says chain ${specChain}, the node ${ident.chainId}, JSON-RPC ${rpcChain}; refusing to sign.`)
  }
  let specGenesis: string | null = null
  try { specGenesis = genesisHex(String(spec.genesisSha256 ?? '')) } catch { specGenesis = null }
  if (specGenesis !== null && specGenesis !== ident.genesis) {
    throw new NetworkMismatch(`The spec names genesis ${specGenesis.slice(0, 8)}…, the node ${ident.genesis.slice(0, 8)}…; refusing to sign.`)
  }
  return { ...p, chainId: ident.chainId, genesis: ident.genesis, specRead: spec }
}
