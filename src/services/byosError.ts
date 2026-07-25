export type ByosErrorCode =
  | 'authorization-failed'
  | 'configuration-required'
  | 'credential-failed'
  | 'disconnect-failed'
  | 'randomness-failed'
  | 'reconnect-required'
  | 'session-failed'
  | 'state-mismatch'
  | 'token-failed';

export class ByosError extends Error {
  readonly code: ByosErrorCode;

  constructor(code: ByosErrorCode, message: string) {
    super(message);
    this.name = 'ByosError';
    this.code = code;
  }
}

export function byosError(code: ByosErrorCode, message: string): ByosError {
  return new ByosError(code, message);
}
