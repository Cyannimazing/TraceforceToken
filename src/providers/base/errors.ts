export class ProviderIntegrityError extends Error {
  constructor(message = "Provider evidence did not match the pinned canonical chain.") { super(message); this.name = "ProviderIntegrityError"; }
}

/** The requested address has no bytecode in the pinned finalized Base state. */
export class TokenContractNotFoundError extends Error {
  constructor() { super("The token address has no contract code at the finalized block."); this.name = "TokenContractNotFoundError"; }
}
export class ProviderBudgetError extends Error {
  constructor() { super("The configured provider call budget was exhausted."); this.name = "ProviderBudgetError"; }
}
/** Owned acquisition deadline; separate from provider integrity and caller cancellation. */
export class ProviderDeadlineError extends Error {
  constructor() { super("Blockchain acquisition exceeded its deadline."); this.name = "ProviderDeadlineError"; }
}
export class UpstreamFailure extends Error {
  readonly rpcCode?: number;
  readonly httpStatus?: number;
  constructor(public readonly retryable = false, status: { rpcCode?: number; httpStatus?: number } = {}) { super("The configured data provider could not complete a request."); this.name = "UpstreamFailure"; this.rpcCode = status.rpcCode; this.httpStatus = status.httpStatus; }
}

/** A bounded body exceeded its size cap; no response content is retained. */
export class ProviderResponseLimitError extends UpstreamFailure {}

/** Only an explicit eth_getLogs range/result/body limit permits range splitting. */
export class ProviderLogRangeError extends UpstreamFailure {}

/** Explicit provider rate/quota responses, separate from generic availability. */
export function isProviderThrottle(error: unknown): error is UpstreamFailure {
  return error instanceof UpstreamFailure && !(error instanceof ProviderLogRangeError) && (error.httpStatus === 429 || [429, -32005, -32016].includes(error.rpcCode ?? 0));
}
