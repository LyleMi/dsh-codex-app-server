import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.js'
import { buildSpawnSpec, CodexProcess } from '../src/process.js'

describe('process argv', () => {
  it('uses direct POSIX argv without a shell', () => {
    expect(buildSpawnSpec(resolveConfig({}, 'linux'), '/workspace', 'linux')).toMatchObject({
      command: 'codex',
      args: ['app-server', '--stdio'],
      options: { cwd: '/workspace', detached: true },
    })
  })

  it('uses a fixed cmd.exe tuple for codex.cmd on Windows', () => {
    const spec = buildSpawnSpec(resolveConfig({}, 'win32'), 'C:\\workspace', 'win32')
    expect(spec.command).toBe(process.env['ComSpec'] ?? 'cmd.exe')
    expect(spec.args).toEqual(['/d', '/s', '/v:off', '/c', '""codex.cmd" "app-server" "--stdio""'])
    expect(spec.options).not.toHaveProperty('shell')
    expect(spec.options.windowsVerbatimArguments).toBe(true)
  })

  it('accepts an absolute Windows command override', () => {
    const spec = buildSpawnSpec(resolveConfig({ command: 'C:\\tools\\codex.cmd' }, 'win32'), 'C:\\workspace', 'win32')
    expect(spec.args).toEqual(['/d', '/s', '/v:off', '/c', '""C:\\tools\\codex.cmd" "app-server" "--stdio""'])
    expect(spec.options).not.toHaveProperty('shell')
  })

  it.runIf(process.platform === 'win32')('executes a cmd shim whose path contains spaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cmd-spawn-'))
    const command = join(root, 'codex probe.cmd')
    try {
      await writeFile(command, '@echo off\r\necho %*\r\n')
      const spec = buildSpawnSpec(resolveConfig({ command }, 'win32'), root, 'win32')
      const child = spawn(spec.command, spec.args, { ...spec.options, stdio: ['ignore', 'pipe', 'pipe'] })
      const stdout: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk))
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
      expect(code).toBe(0)
      expect(Buffer.concat(stdout).toString('utf8').trim()).toBe('"app-server" "--stdio"')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects cmd.exe expansion syntax in Windows command tokens', () => {
    expect(() =>
      buildSpawnSpec(resolveConfig({ args: ['--enable=%PATH%'] }, 'win32'), 'C:\\workspace', 'win32'),
    ).toThrow('unsafe cmd.exe syntax')
  })

  it('never places prompt text in argv', () => {
    const spec = buildSpawnSpec(resolveConfig(), '/workspace', 'linux')
    expect(JSON.stringify(spec)).not.toContain('user prompt')
  })

  it.runIf(process.platform !== 'win32')('settles and disposes after an asynchronous spawn failure', async () => {
    const child = new CodexProcess(resolveConfig({ command: '/definitely/not/a/codex-binary' }), process.cwd())
    const result = await child.exited
    expect(result).toMatchObject({ code: null, signal: null })
    expect(result.error).toBeInstanceOf(Error)
    await expect(child.dispose()).resolves.toBeUndefined()
    expect(child.diagnostic).toContain('ENOENT')
  })
})
