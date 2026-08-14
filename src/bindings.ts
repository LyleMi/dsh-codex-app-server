import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { CodexAppServerError } from './errors.js'

export interface DurableThreadBinding {
  version: 1
  sessionId: string
  threadId: string
  cwdFingerprint: string
  cliVersion: string
  ephemeral: false
}

/** Hash a normalized absolute workspace path without persisting the path itself. */
export function workspaceFingerprint(cwd: string): string {
  return createHash('sha256').update(resolve(cwd)).digest('hex')
}

/** Plugin-owned durable DSH-session to Codex-thread mapping. */
export class ThreadBindingStore {
  readonly root: string

  constructor(root?: string) {
    this.root = resolve(root ?? join(homedir(), '.dsh', 'codex-app-server-bindings'))
  }

  async read(sessionId: SessionId, cwd: string): Promise<DurableThreadBinding> {
    let value: unknown
    try {
      value = JSON.parse(await readFile(this.path(sessionId), 'utf8')) as unknown
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new CodexAppServerError('THREAD_MISMATCH', `no durable Codex thread binding for DSH session ${sessionId}`)
      }
      throw new CodexAppServerError('THREAD_MISMATCH', `cannot read Codex thread binding for ${sessionId}`, {
        cause: error,
      })
    }
    if (!isBinding(value) || value.sessionId !== sessionId) {
      throw new CodexAppServerError('THREAD_MISMATCH', `invalid Codex thread binding for DSH session ${sessionId}`)
    }
    if (value.cwdFingerprint !== workspaceFingerprint(cwd) || value.ephemeral) {
      throw new CodexAppServerError(
        'THREAD_MISMATCH',
        `Codex thread binding workspace does not match session ${sessionId}`,
      )
    }
    return value
  }

  async write(binding: DurableThreadBinding): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const target = this.path(binding.sessionId)
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, `${JSON.stringify(binding)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    await rename(temporary, target)
  }

  async remove(sessionId: SessionId): Promise<void> {
    await rm(this.path(sessionId), { force: true })
  }

  private path(sessionId: string): string {
    const key = createHash('sha256').update(sessionId).digest('hex')
    return join(this.root, `${key}.json`)
  }
}

function isBinding(value: unknown): value is DurableThreadBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    record['version'] === 1 &&
    typeof record['sessionId'] === 'string' &&
    typeof record['threadId'] === 'string' &&
    typeof record['cwdFingerprint'] === 'string' &&
    typeof record['cliVersion'] === 'string' &&
    record['ephemeral'] === false
  )
}
