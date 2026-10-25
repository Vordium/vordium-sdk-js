/**
 * Rising millisecond nonces. The chain admits an account's batch nonces, client nonces and dead-man-switch nonces
 * through ONE window (milliseconds, within 2 days before / 1 day after block time, each used once), so a client takes
 * them all from one clock per account: never the same twice, never below the wall clock.
 */
export class NonceClock {
  private last = 0
  constructor(private readonly now: () => number = Date.now) {}
  next(atLeast = 0): number {
    this.last = Math.max(Math.floor(this.now()), this.last + 1, Math.floor(atLeast))
    return this.last
  }
  /** Note a nonce the chain already holds, so the next one is above it. */
  seen(nonce: number): void {
    this.last = Math.max(this.last, Math.floor(nonce))
  }
}

const clocks = new Map<string, NonceClock>()

/** The one nonce clock of `owner` in this process. */
export function nonceClock(owner: string): NonceClock {
  const k = owner.toLowerCase()
  let c = clocks.get(k)
  if (!c) { c = new NonceClock(); clocks.set(k, c) }
  return c
}
