import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { parseJsonRpc } from '../src/wire/protocol.js'

describe('Codex 0.147.0 sanitized protocol recording', () => {
  it('accepts every recorded frame, omitted jsonrpc fields, and unknown extensions', async () => {
    const recording = await readFile(new URL('./fixtures/app-server/codex-0.147.0.jsonl', import.meta.url), 'utf8')
    const messages = recording
      .trim()
      .split('\n')
      .map((line) => parseJsonRpc(line))
    expect(messages).toHaveLength(7)
    expect(messages.every((message) => message.jsonrpc === undefined)).toBe(true)
    expect(messages.find((message) => 'method' in message && message.method === 'turn/completed')).toBeDefined()
    expect(recording).not.toMatch(/authorization|bearer|auth\.json|account|\/home\//i)
  })
})
