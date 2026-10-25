import { TypedDataEncoder, concat, getBytes, keccak256, toUtf8Bytes } from 'ethers'
import { InvalidRequest } from './errors.js'

/**
 * The genesis-bound EIP-712 domains. Every signing domain on Vordium binds its `salt` to the chain's genesis:
 * `salt = keccak256(tag ‖ genesis_sha256)`, so a signature made for one genesis can never verify on another chain that
 * shares its chain id. The SDK derives each domain from the node's own `/status` and refuses to sign without a genesis.
 */
export const VERIFYING_CONTRACT = '0x0000000000000000000000000000000000001002'

export type DomainClass = 'VordCore' | 'VordexSession'

const TAGS: Record<DomainClass, string> = {
  VordCore: 'VORDIUM_VORDCORE\u0001',
  VordexSession: 'VORDIUM_VORDEXSESSION\u0001',
}

export interface TypedDomain {
  name: string
  version: string
  chainId: bigint
  verifyingContract: string
  salt: string
}

/** 32 bytes of genesis hash as lower-case hex without 0x; refused otherwise. */
export function genesisHex(genesis: string): string {
  const g = genesis.startsWith('0x') || genesis.startsWith('0X') ? genesis.slice(2) : genesis
  if (!/^[0-9a-fA-F]{64}$/.test(g)) throw new InvalidRequest('A genesis hash is 32 bytes of hex.')
  return g.toLowerCase()
}

/** keccak256(tag ‖ genesis bytes): the domain's fifth field. */
export function salt(cls: DomainClass, genesis: string): string {
  return keccak256(concat([toUtf8Bytes(TAGS[cls]), getBytes('0x' + genesisHex(genesis))]))
}

export function domain(cls: DomainClass, chainId: number | bigint, genesis: string): TypedDomain {
  return { name: cls, version: '1', chainId: BigInt(chainId), verifyingContract: VERIFYING_CONTRACT, salt: salt(cls, genesis) }
}

/** The domain separator, 0x-hex. */
export function separator(cls: DomainClass, chainId: number | bigint, genesis: string): string {
  return TypedDataEncoder.hashDomain(domain(cls, chainId, genesis))
}
