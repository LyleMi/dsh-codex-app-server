import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { AppServerTransport } from '../src/wire/transport.js'

async function nextLine(stream: PassThrough): Promise<Record<string, unknown>> {
  const chunk = await new Promise<Buffer>((resolve, reject) => {
    stream.once('data', resolve)
    stream.once('error', reject)
  })
  return JSON.parse(chunk.toString('utf8')) as Record<string, unknown>
}

describe('AppServerTransport', () => {
  it('correlates out-of-order responses', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new AppServerTransport(input, output, 1_000, {
      notification: vi.fn(),
      request: vi.fn(),
      protocolError: vi.fn(),
    })
    const first = transport.request('first')
    const firstFrame = await nextLine(output)
    const second = transport.request('second')
    const secondFrame = await nextLine(output)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: secondFrame['id'], result: 2 })}\n`)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: firstFrame['id'], result: 1 })}\n`)
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2])
    transport.close()
  })

  it('answers server requests and rejects unknown handlers', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new AppServerTransport(input, output, 1_000, {
      notification: vi.fn(),
      request: (request) =>
        request.method === 'known'
          ? Promise.resolve({ decision: 'decline' })
          : Promise.reject(new Error('unsupported request')),
      protocolError: vi.fn(),
    })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'known', params: {} })}\n`)
    await expect(nextLine(output)).resolves.toMatchObject({
      id: 7,
      result: { decision: 'decline' },
    })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'unknown', params: {} })}\n`)
    await expect(nextLine(output)).resolves.toMatchObject({
      id: 8,
      error: { code: -32_601 },
    })
    transport.close()
  })

  it('rejects pending requests on invalid framing', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const protocolError = vi.fn()
    const transport = new AppServerTransport(input, output, 1_000, {
      notification: vi.fn(),
      request: vi.fn(),
      protocolError,
    })
    const pending = transport.request('wait')
    await nextLine(output)
    input.write('not json\n')
    await expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' })
    expect(protocolError).toHaveBeenCalledOnce()
  })

  it('closes on a frame that exceeds the configured byte limit', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const protocolError = vi.fn()
    const transport = new AppServerTransport(
      input,
      output,
      1_000,
      { notification: vi.fn(), request: vi.fn(), protocolError },
      128,
    )
    const pending = transport.request('wait')
    await nextLine(output)
    input.write(`${JSON.stringify({ method: 'x'.repeat(160) })}\n`)
    await expect(pending).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' })
    expect(protocolError).toHaveBeenCalledOnce()
  })

  it('rejects an outbound frame that exceeds the configured byte limit', async () => {
    const transport = new AppServerTransport(
      new PassThrough(),
      new PassThrough(),
      1_000,
      { notification: vi.fn(), request: vi.fn(), protocolError: vi.fn() },
      64,
    )
    await expect(transport.request('oversized', { value: 'x'.repeat(80) })).rejects.toMatchObject({
      code: 'PROTOCOL_INVALID',
    })
    transport.close()
  })
})
