import { Signature, TypedDataEncoder, Wallet, getAddress, recoverAddress } from 'ethers'
import type { TypedDomain } from './domains.js'
import { InvalidRequest } from './errors.js'
import { typesFor, type PrimaryType } from './types.js'

/**
 * Anything that can sign EIP-712 typed data: an ethers `Wallet` or `Signer`, a browser wallet wrapped by ethers, or your
 * own key-management adapter.
 */
export interface TypedSigner {
  getAddress(): Promise<string>
  signTypedData(domain: TypedDomain, types: Record<string, Array<{ name: string; type: string }>>, value: Record<string, unknown>): Promise<string>
}

/**
 * A signer from a private key (an ethers `Wallet`). A key that is not 32 bytes of hex is refused with a message that
 * never carries the value (the library's own error would print it).
 */
export function keySigner(privateKey: string): TypedSigner {
  const k = typeof privateKey === 'string' ? privateKey.trim() : ''
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(k)) {
    throw new InvalidRequest('A private key must be 32 bytes written as 64 hex characters (the value is not shown).')
  }
  try {
    return new Wallet(k.startsWith('0x') ? k : '0x' + k) as unknown as TypedSigner
  } catch {
    throw new InvalidRequest('The private key is not a valid key (the value is not shown).')
  }
}

/** The 32-byte digest the chain verifies: keccak256(0x1901 ‖ domainSeparator ‖ hashStruct(value)). */
export function digest(dom: TypedDomain, primary: PrimaryType, value: Record<string, unknown>): string {
  return TypedDataEncoder.hash(dom, typesFor(primary), value)
}

/**
 * Sign one operation. Returns the 65-byte `r‖s‖v` signature as lower-case 0x-hex (v = 27 or 28), and checks that it
 * recovers the signer's address before it is used.
 */
export async function signOp(signer: TypedSigner, dom: TypedDomain, primary: PrimaryType, value: Record<string, unknown>): Promise<string> {
  const types = typesFor(primary)
  const raw = await signer.signTypedData(dom, types, value)
  const sig = Signature.from(raw)
  const by = TypedDataEncoder.hash(dom, types, value)
  if (getAddress(recoverAddress(by, sig)) !== getAddress(await signer.getAddress())) {
    throw new InvalidRequest('The signature does not recover to the signer: the wallet signed something else.')
  }
  return sig.serialized.toLowerCase()
}

/** The first 64 bytes (`r‖s`) of a 65-byte signature: the form the single-order intake reads. */
export function rs64(sig65: string): string {
  if (!/^0x[0-9a-f]{130}$/.test(sig65)) throw new InvalidRequest('A signature is 65 bytes of lower-case hex.')
  return sig65.slice(0, 130)
}
