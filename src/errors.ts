/** Every error the SDK raises is a {@link VordiumError}: a plain sentence, with the chain's code kept as a field. */
export class VordiumError extends Error {
  readonly code: string
  readonly detail: string
  constructor(code: string, message: string, detail = '') {
    super(message)
    this.name = 'VordiumError'
    this.code = code
    this.detail = detail
  }
}

/** The node, the network spec or the configured network disagree about which chain this is. Nothing was signed. */
export class NetworkMismatch extends VordiumError {
  constructor(message: string) {
    super('network_mismatch', message)
    this.name = 'NetworkMismatch'
  }
}

/** An argument the chain would refuse, caught before anything was signed or sent. */
export class InvalidRequest extends VordiumError {
  constructor(message: string) {
    super('invalid_request', message)
    this.name = 'InvalidRequest'
  }
}

/** Something the chain does not offer (stop orders, trigger fields, an op that is not in force). Nothing was signed. */
export class NotAvailable extends VordiumError {
  constructor(message: string) {
    super('not_available', message)
    this.name = 'NotAvailable'
  }
}
