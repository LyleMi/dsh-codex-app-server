import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import type { CodexProcess } from '../src/process.js'
import { resolveConfig } from '../src/config.js'
import { AppServerClient } from '../src/wire/client.js'
import type { ProtocolDiagnostic } from '../src/wire/notifications.js'

class ProtocolPeer {
  private buffer = ''
  private readonly frames: Record<string, unknown>[] = []
  private readonly waiters: ((frame: Record<string, unknown>) => void)[] = []

  constructor(readonly fromClient: PassThrough) {
    fromClient.setEncoding('utf8')
    fromClient.on('data', (chunk: string) => {
      this.buffer += chunk
      for (;;) {
        const boundary = this.buffer.indexOf('\n')
        if (boundary < 0) break
        const line = this.buffer.slice(0, boundary)
        this.buffer = this.buffer.slice(boundary + 1)
        this.deliver(JSON.parse(line) as Record<string, unknown>)
      }
    })
  }

  next(): Promise<Record<string, unknown>> {
    const frame = this.frames.shift()
    if (frame !== undefined) return Promise.resolve(frame)
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private deliver(frame: Record<string, unknown>): void {
    const waiter = this.waiters.shift()
    if (waiter === undefined) this.frames.push(frame)
    else waiter(frame)
  }
}

function fixture(config = resolveConfig()): {
  client: AppServerClient
  server: PassThrough
  peer: ProtocolPeer
  dispose: ReturnType<typeof vi.fn>
} {
  const server = new PassThrough()
  const fromClient = new PassThrough()
  const never = new Promise<never>(() => {})
  const dispose = vi.fn(() => Promise.resolve())
  const process = {
    child: { stdout: server, stdin: fromClient },
    exited: never,
    diagnostic: '',
    dispose,
  } as unknown as CodexProcess
  return {
    server,
    peer: new ProtocolPeer(fromClient),
    client: new AppServerClient(process, config, vi.fn()),
    dispose,
  }
}

async function connect(client: AppServerClient, server: PassThrough, peer: ProtocolPeer): Promise<void> {
  const initializing = client.initialize()
  const initialize = await peer.next()
  server.write(
    `${JSON.stringify({
      id: initialize['id'],
      result: { userAgent: 'codex/0.147.0', platformFamily: 'unix', platformOs: 'linux' },
    })}\n`,
  )
  await initializing
  expect(await peer.next()).toMatchObject({ method: 'initialized' })

  const starting = client.startThread('/workspace')
  const start = await peer.next()
  expect(start).toMatchObject({
    method: 'thread/start',
    params: { cwd: '/workspace', ephemeral: false },
  })
  expect(start.params).not.toHaveProperty('historyMode')
  server.write(
    `${JSON.stringify({
      id: start['id'],
      result: {
        thread: { id: 'thread-1', ephemeral: false, cliVersion: '0.147.0' },
        model: 'gpt-5.4',
        modelProvider: 'openai',
        cwd: '/workspace',
      },
    })}\n`,
  )
  await starting
}

describe('AppServerClient protocol fixture', () => {
  it('supports omitted jsonrpc, early notifications, two turns, and cross-thread isolation', async () => {
    const { client, server, peer } = fixture()
    await connect(client, server, peer)
    for (const [turnId, answer] of [
      ['turn-1', 'first'],
      ['turn-2', 'second'],
    ] as const) {
      const running = client.startTurn(`ask ${answer}`)
      const request = await peer.next()
      expect(request).toMatchObject({
        method: 'turn/start',
        params: {
          sandboxPolicy: {
            type: 'workspaceWrite',
            writableRoots: ['/workspace'],
            networkAccess: false,
          },
        },
      })
      server.write(
        `${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-1', turn: turn(turnId) } })}\n`,
      )
      server.write(
        `${JSON.stringify({
          method: 'item/completed',
          params: {
            threadId: 'other-thread',
            turnId,
            item: { type: 'agentMessage', id: 'foreign', text: 'wrong', phase: 'final_answer' },
          },
        })}\n`,
      )
      server.write(`${JSON.stringify({ id: request['id'], result: { turn: turn(turnId) } })}\n`)
      server.write(
        `${JSON.stringify({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: turn(turnId, [{ type: 'agentMessage', id: turnId, text: answer, phase: 'final_answer' }]),
          },
        })}\n`,
      )
      await expect(running).resolves.toMatchObject({ id: turnId, status: 'completed' })
    }
    client.close()
  })

  it('fails the active turn and answers an unknown server request with an error', async () => {
    const { client, server, peer } = fixture()
    await connect(client, server, peer)
    const running = client.startTurn('wait')
    const request = await peer.next()
    server.write(`${JSON.stringify({ id: request['id'], result: { turn: turn('turn-3') } })}\n`)
    server.write(
      `${JSON.stringify({
        id: 99,
        method: 'future/dangerousRequest',
        params: { threadId: 'thread-1', turnId: 'turn-3' },
      })}\n`,
    )
    await expect(running).rejects.toMatchObject({ code: 'UNKNOWN_SERVER_REQUEST' })
    await expect(peer.next()).resolves.toMatchObject({ id: 99, error: { code: -32_601 } })
    client.close()
  })

  it('queues native steer and interrupt until turn/start supplies the turn id', async () => {
    const { client, server, peer } = fixture()
    await connect(client, server, peer)
    const running = client.startTurn('begin')
    const start = await peer.next()
    const steering = client.steer('correction')
    const interrupting = client.interrupt()
    server.write(`${JSON.stringify({ id: start['id'], result: { turn: turn('turn-4') } })}\n`)

    const firstControl = await peer.next()
    const secondControl = await peer.next()
    expect([firstControl['method'], secondControl['method']].sort()).toEqual(['turn/interrupt', 'turn/steer'])
    for (const control of [firstControl, secondControl]) {
      server.write(`${JSON.stringify({ id: control['id'], result: {} })}\n`)
    }
    server.write(
      `${JSON.stringify({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: { ...turn('turn-4'), status: 'interrupted' } },
      })}\n`,
    )
    await expect(Promise.all([running, steering, interrupting])).resolves.toBeDefined()
    client.close()
  })

  it('can fail the active turn on an unknown notification', async () => {
    const { client, server, peer } = fixture(resolveConfig({ unknownNotificationPolicy: 'fail-turn' }))
    await connect(client, server, peer)
    const running = client.startTurn('wait')
    const request = await peer.next()
    server.write(`${JSON.stringify({ id: request['id'], result: { turn: turn('turn-5') } })}\n`)
    server.write(
      `${JSON.stringify({ method: 'future/notification', params: { threadId: 'thread-1', turnId: 'turn-5' } })}\n`,
    )
    await expect(running).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' })
    client.close()
  })

  it('rejects the active turn when a malformed protocol frame closes the transport', async () => {
    const { client, server, peer } = fixture()
    await connect(client, server, peer)
    const running = client.startTurn('wait')
    const request = await peer.next()
    server.write(`${JSON.stringify({ id: request['id'], result: { turn: turn('turn-malformed') } })}\n`)
    server.write('not json\n')
    await expect(running).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' })
    client.close()
  })

  it('interrupts an idle turn and disposes a process that remains stuck', async () => {
    const { client, server, peer, dispose } = fixture(
      resolveConfig({ turnIdleTimeoutMs: 20, interruptGraceMs: 20, requestIdleTimeoutMs: 1_000 }),
    )
    await connect(client, server, peer)
    const running = client.startTurn('wait forever')
    const start = await peer.next()
    server.write(`${JSON.stringify({ id: start['id'], result: { turn: turn('turn-idle') } })}\n`)
    const interrupt = await peer.next()
    expect(interrupt).toMatchObject({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-idle' },
    })
    server.write(`${JSON.stringify({ id: interrupt['id'], result: {} })}\n`)
    await expect(running).rejects.toMatchObject({ code: 'TURN_IDLE_TIMEOUT' })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('fails and disposes when an explicit interrupt request times out', async () => {
    const { client, server, peer, dispose } = fixture(
      resolveConfig({ turnIdleTimeoutMs: 1_000, interruptGraceMs: 20, requestIdleTimeoutMs: 1_000 }),
    )
    await connect(client, server, peer)
    const running = client.startTurn('wait for cancellation')
    const start = await peer.next()
    server.write(
      `${JSON.stringify({ method: 'turn/started', params: { threadId: 'thread-1', turn: turn('turn-interrupt-timeout') } })}\n`,
    )
    server.write(`${JSON.stringify({ id: start['id'], result: { turn: turn('turn-interrupt-timeout') } })}\n`)
    const interrupting = client.interrupt()
    await expect(peer.next()).resolves.toMatchObject({ method: 'turn/interrupt' })
    await expect(interrupting).rejects.toMatchObject({ code: 'INTERRUPT_TIMEOUT' })
    await expect(running).rejects.toMatchObject({ code: 'INTERRUPT_TIMEOUT' })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('surfaces redacted warnings and rejects terminal turn errors', async () => {
    const server = new PassThrough()
    const fromClient = new PassThrough()
    const diagnostics = vi.fn<(diagnostic: ProtocolDiagnostic) => void>()
    const process = {
      child: { stdout: server, stdin: fromClient },
      exited: new Promise<never>(() => {}),
      diagnostic: '',
      dispose: vi.fn(() => Promise.resolve()),
    } as unknown as CodexProcess
    const peer = new ProtocolPeer(fromClient)
    const client = new AppServerClient(process, resolveConfig(), vi.fn(), diagnostics)
    await connect(client, server, peer)
    server.write(`${JSON.stringify({ method: 'configWarning', params: { message: 'access_token=secret-value' } })}\n`)
    expect(diagnostics).toHaveBeenCalledOnce()
    expect(diagnostics.mock.calls[0]?.[0]).toMatchObject({ level: 'warn', method: 'configWarning' })
    expect(diagnostics.mock.calls[0]?.[0].message).not.toContain('secret-value')

    const running = client.startTurn('fail')
    const start = await peer.next()
    server.write(`${JSON.stringify({ id: start['id'], result: { turn: turn('turn-error') } })}\n`)
    server.write(
      `${JSON.stringify({ method: 'error', params: { threadId: 'thread-1', turnId: 'turn-error', message: 'fatal', willRetry: false } })}\n`,
    )
    await expect(running).rejects.toMatchObject({ code: 'PROTOCOL_INVALID', message: 'fatal' })
    client.close()
  })
})

function turn(id: string, items: unknown[] = []): Record<string, unknown> {
  return { id, status: 'completed', items, error: null }
}
