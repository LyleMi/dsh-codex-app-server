import { spawn } from 'node:child_process'
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'
import { delimiter, posix, win32 } from 'node:path'
import { access } from 'node:fs/promises'
import type { ResolvedConfig } from './config.js'
import { CodexAppServerError, redactDiagnostic } from './errors.js'

export interface SpawnSpec {
  command: string
  args: string[]
  options: SpawnOptionsWithoutStdio
}

const INHERITED_ENV = [
  'PATH',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'TMPDIR',
  'CODEX_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
] as const

/** Build a fixed executable/argv tuple. User prompts never enter this tuple. */
export function buildSpawnSpec(config: ResolvedConfig, cwd: string, platform = process.platform): SpawnSpec {
  const pathApi = platform === 'win32' ? win32 : posix
  if (!pathApi.isAbsolute(cwd)) throw new CodexAppServerError('CONFIG_INVALID', 'session cwd must be absolute')
  const env: NodeJS.ProcessEnv = {}
  for (const name of INHERITED_ENV) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  const appArgs = ['app-server', '--stdio', ...config.args]
  if (platform !== 'win32' || !config.command.toLowerCase().endsWith('.cmd')) {
    return {
      command: config.command,
      args: appArgs,
      options: { cwd, env, detached: platform !== 'win32', windowsHide: true },
    }
  }
  const commandInterpreter = process.env['ComSpec'] ?? 'cmd.exe'
  const escapedCommand = `"${config.command.replaceAll('"', '""')}"`
  return {
    command: commandInterpreter,
    args: ['/d', '/s', '/c', escapedCommand, ...appArgs],
    options: { cwd, env, windowsHide: true },
  }
}

/** Resolve an executable through PATH for early load/start diagnostics. */
export async function executableExists(command: string): Promise<boolean> {
  if (command.includes('/') || command.includes('\\')) {
    try {
      await access(command)
      return true
    } catch {
      return false
    }
  }
  const extensions = process.platform === 'win32' ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const directory of (process.env['PATH'] ?? '').split(delimiter)) {
    for (const extension of extensions) {
      try {
        await access(`${directory}/${command}${extension}`)
        return true
      } catch {
        // This candidate is absent; continue through the finite PATH list.
      }
    }
  }
  return false
}

/** One owned Codex App Server child with bounded, redacted stderr. */
export class CodexProcess {
  readonly child: ChildProcessWithoutNullStreams
  readonly exited: Promise<{
    code: number | null
    signal: NodeJS.Signals | null
    error?: Error
  }>
  private stderr = ''
  private disposing = false

  constructor(
    readonly config: ResolvedConfig,
    cwd: string,
  ) {
    const spec = buildSpawnSpec(config, cwd)
    try {
      this.child = spawn(spec.command, spec.args, {
        ...spec.options,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error: unknown) {
      throw new CodexAppServerError('PROCESS_START_FAILED', `failed to start ${config.command}`, { cause: error })
    }
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      this.stderr = redactDiagnostic(`${this.stderr}${chunk}`, config.stderrMaxBytes)
    })
    this.exited = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => resolve({ code, signal }))
      this.child.once('error', (error) => {
        this.stderr = redactDiagnostic(`${this.stderr}${error.message}`, config.stderrMaxBytes)
        resolve({ code: null, signal: null, error })
      })
    })
  }

  /** Safe bounded stderr for user-facing exit diagnostics. */
  get diagnostic(): string {
    return this.stderr
  }

  /** Interrupt protocol I/O, then terminate the complete owned process group. */
  async dispose(): Promise<void> {
    if (this.disposing) {
      await this.exited
      return
    }
    this.disposing = true
    this.child.stdin.end()
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.terminate('SIGTERM')
    const grace = new Promise<'timeout'>((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), this.config.disposeGraceMs)
      timer.unref()
    })
    if ((await Promise.race([this.exited, grace])) === 'timeout') {
      this.terminate('SIGKILL')
      await this.exited
    }
  }

  private terminate(signal: NodeJS.Signals): void {
    const pid = this.child.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      const taskkill = spawn('taskkill.exe', ['/pid', String(pid), '/t', ...(signal === 'SIGKILL' ? ['/f'] : [])], {
        stdio: 'ignore',
        windowsHide: true,
      })
      taskkill.on('error', () => {})
      return
    }
    try {
      process.kill(-pid, signal)
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH') throw error
    }
  }
}
