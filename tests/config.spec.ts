import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { redactDiagnostic } from '../src/errors.js'

describe('configuration and diagnostics', () => {
  it('uses conservative defaults', () => {
    expect(resolveConfig()).toMatchObject({
      command: 'codex',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      unknownNotificationPolicy: 'ignore',
    })
  })

  it('rejects transport and credential arguments', () => {
    expect(() => resolveConfig({ args: ['--listen=ws://0.0.0.0:3000'] })).toThrow(/unsupported Codex argument/)
    expect(() => resolveConfig({ args: ['--config', 'oauth_token=secret'] })).toThrow(/unsupported Codex argument/)
  })

  it('redacts secrets before truncating stderr', () => {
    expect(redactDiagnostic('Authorization: Bearer secret-value\nhello', 1_000)).toBe('[REDACTED]\nhello')
    expect(redactDiagnostic('abcdefghijklmnopqrstuvwxyz', 8)).toBe('abcdefgh\n[truncated]')
  })
})
