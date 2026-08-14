/** Stable failures exposed at the process and protocol boundary. */
export type CodexErrorCode =
  | 'CONFIG_INVALID'
  | 'PROCESS_START_FAILED'
  | 'PROCESS_EXITED'
  | 'PROTOCOL_INVALID'
  | 'PROTOCOL_CLOSED'
  | 'REQUEST_TIMEOUT'
  | 'UNKNOWN_SERVER_REQUEST'
  | 'THREAD_MISMATCH'

/** Error carrying a stable code and safe diagnostic text. */
export class CodexAppServerError extends Error {
  constructor(
    readonly code: CodexErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'CodexAppServerError'
  }
}

const SECRET_PATTERNS = [
  /\b(?:access|refresh|id)[_-]?token\b\s*[:=]\s*["']?[^\s,"'}]+/giu,
  /\bauthorization\b\s*[:=]\s*["']?(?:bearer\s+)?[^\s,"'}]+/giu,
  /\b(?:sk|sess)-[a-z0-9_-]{16,}\b/giu,
]

/** Remove common credential forms from bounded diagnostics. */
export function redactDiagnostic(value: string, maxBytes: number): string {
  let redacted = value
  for (const pattern of SECRET_PATTERNS) redacted = redacted.replace(pattern, '[REDACTED]')
  const bytes = Buffer.from(redacted)
  if (bytes.byteLength <= maxBytes) return redacted
  return `${bytes.subarray(0, maxBytes).toString('utf8')}\n[truncated]`
}
