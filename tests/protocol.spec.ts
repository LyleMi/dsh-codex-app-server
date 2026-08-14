import { describe, expect, it } from 'vitest'
import { parseJsonRpc, parseThreadResult, parseTurn } from '../src/wire/protocol.js'

describe('protocol validation', () => {
  it('preserves extension fields on known envelopes and items', () => {
    const frame = parseJsonRpc('{"jsonrpc":"2.0","method":"future/event","params":{"future":true}}')
    expect(frame).toMatchObject({
      method: 'future/event',
      params: { future: true },
    })
    const turn = parseTurn({
      id: 'turn-1',
      status: 'completed',
      items: [{ type: 'futureItem', id: 'item-1', future: true }],
      error: null,
      future: true,
    })
    expect(turn.items[0]).toMatchObject({ type: 'futureItem', future: true })
  })

  it('accepts Codex frames that omit the optional JSON-RPC version marker', () => {
    expect(parseJsonRpc('{"id":1,"result":{"ok":true}}')).toEqual({ id: 1, result: { ok: true } })
    expect(() => parseJsonRpc('{"jsonrpc":"1.0","id":1,"result":{}}')).toThrow('unsupported jsonrpc version')
  })

  it('validates durable thread binding fields', () => {
    expect(
      parseThreadResult({
        thread: { id: 'thread-1', ephemeral: false, cliVersion: '0.147.0' },
        cwd: '/workspace',
        model: 'gpt-5',
        modelProvider: 'openai',
      }),
    ).toMatchObject({
      thread: { id: 'thread-1', ephemeral: false },
      cwd: '/workspace',
    })
    expect(() => parseThreadResult({ thread: {}, cwd: '/workspace' })).toThrow(/thread result\.thread\.id/)
  })
})
