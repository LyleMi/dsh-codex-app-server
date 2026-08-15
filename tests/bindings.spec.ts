import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import { ThreadBindingStore, workspaceFingerprint } from '../src/bindings.js'

describe('ThreadBindingStore', () => {
  it('round-trips an exact non-ephemeral workspace binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'binding-store-'))
    const store = new ThreadBindingStore(root)
    const sessionId = SessionId('../opaque/session')
    try {
      await store.write({
        version: 1,
        sessionId,
        threadId: 'thread-1',
        cwdFingerprint: workspaceFingerprint('/workspace'),
        cliVersion: '0.147.0',
        ephemeral: false,
      })
      await expect(store.read(sessionId, '/workspace')).resolves.toMatchObject({ threadId: 'thread-1' })
      await expect(store.read(sessionId, '/other')).rejects.toMatchObject({ code: 'THREAD_MISMATCH' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails explicitly when a session has no binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'binding-store-'))
    try {
      await expect(new ThreadBindingStore(root).read(SessionId('missing'), '/workspace')).rejects.toThrow(
        'no durable Codex thread binding',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('atomically replaces an existing binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'binding-store-'))
    const store = new ThreadBindingStore(root)
    const sessionId = SessionId('replace-binding')
    try {
      await store.write({
        version: 1,
        sessionId,
        threadId: 'thread-1',
        cwdFingerprint: workspaceFingerprint('/workspace'),
        cliVersion: '0.147.0',
        ephemeral: false,
      })
      await store.write({
        version: 1,
        sessionId,
        threadId: 'thread-2',
        cwdFingerprint: workspaceFingerprint('/workspace'),
        cliVersion: '0.147.0',
        ephemeral: false,
      })

      await expect(store.read(sessionId, '/workspace')).resolves.toMatchObject({ threadId: 'thread-2' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
