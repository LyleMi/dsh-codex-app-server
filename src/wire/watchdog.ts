/** Resettable two-stage deadline used by one active App Server turn. */
export class TurnWatchdog {
  private idleTimer: NodeJS.Timeout | undefined
  private deadlineTimer: NodeJS.Timeout | undefined

  constructor(
    private readonly idleMs: number,
    private readonly deadlineMs: number,
  ) {}

  touch(onIdle: () => void): void {
    if (this.deadlineTimer !== undefined) return
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      onIdle()
    }, this.idleMs)
    this.idleTimer.unref()
  }

  armDeadline(onDeadline: () => void): void {
    if (this.deadlineTimer !== undefined) return
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = undefined
      onDeadline()
    }, this.deadlineMs)
    this.deadlineTimer.unref()
  }

  clear(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    if (this.deadlineTimer !== undefined) clearTimeout(this.deadlineTimer)
    this.idleTimer = undefined
    this.deadlineTimer = undefined
  }
}
