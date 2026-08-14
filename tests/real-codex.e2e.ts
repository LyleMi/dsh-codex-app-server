import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { CodexProcess, executableExists } from '../src/process.js'
import { AppServerClient } from '../src/wire/client.js'

const enabled = process.env['RUN_REAL_CODEX'] === '1'
let workspace: string | undefined

afterEach(async () => {
  if (workspace !== undefined) await rm(workspace, { recursive: true, force: true })
  workspace = undefined
})

describe.skipIf(!enabled)('real Codex App Server', () => {
  it('keeps thread context across two turns and interrupts safely', async ({ skip }) => {
    if (!(await executableExists('codex'))) skip()
    workspace = await mkdtemp(join(tmpdir(), 'dsh-real-codex-'))
    const config = resolveConfig({
      approvalPolicy: 'never',
      sandboxMode: 'read-only',
      startupTimeoutMs: 30_000,
      requestIdleTimeoutMs: 120_000,
    })
    const process = new CodexProcess(config, workspace)
    const client = new AppServerClient(process, config, () => Promise.reject(new Error('smoke declines interaction')))
    try {
      await client.initialize()
      await client.startThread(workspace)
      const marker = `DSH_SMOKE_${Date.now()}`
      const first = await client.startTurn(`Remember ${marker}. Reply with exactly STORED.`)
      expect(answer(first)).toContain('STORED')
      const second = await client.startTurn('Reply with only the exact marker I asked you to remember.')
      expect(answer(second)).toContain(marker)

      const longTurn = client.startTurn('Print the integers from 1 through 10000, one per line.')
      await new Promise((resolve) => setTimeout(resolve, 100))
      await client.interrupt()
      await expect(longTurn).resolves.toMatchObject({ status: 'interrupted' })
    } catch (error: unknown) {
      if (isUnavailableAccount(error)) skip()
      throw error
    } finally {
      client.close()
      await process.dispose()
    }
  }, 180_000)
})

function answer(turn: { items: readonly { type: string; [key: string]: unknown }[] }): string {
  return turn.items
    .filter((item) => item.type === 'agentMessage' && typeof item['text'] === 'string')
    .map((item) => String(item['text']))
    .join('\n')
}

function isUnavailableAccount(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /unauthorized|not logged in|login required|usage limit|subscription/i.test(message)
}
