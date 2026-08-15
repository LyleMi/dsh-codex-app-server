import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'

const SOURCE = '@deepseek-ai/dsh-system-prompt'
const CLEARED = 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'

/** Retain only changed DSH runtime-context snapshots for this external driver. */
export class RuntimeContextProjection {
  private retained: { seq: number; text: string | undefined } | null | undefined

  constructor(ctx: Context, session: Session) {
    this.restore(session)
    this.follow(ctx, session)
  }

  private restore(session: Session): void {
    const surface = new Set(session.surface.nodes)
    for (let index = session.events.length - 1; index >= 0; index -= 1) {
      const event = session.events[index]
      if (event?.type !== 'user/message' || !isOwned(event.data)) continue
      this.retained ??= null
      if (surface.has(event.seq)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
        break
      }
    }
  }

  private follow(ctx: Context, session: Session): void {
    ctx.on('session/event', (subject, event) => {
      if (subject !== session) return
      if (event.type === 'user/message' && isOwned(event.data)) {
        this.retained = { seq: event.seq, text: textOf(event.data) }
      } else if (
        this.retained &&
        isReplacementSurfaceEvent(event) &&
        event.sourceEventSeqs?.includes(this.retained.seq) === true
      ) {
        this.retained = null
      }
    })
  }

  project(current: string, sections: readonly ContextSnapshotSection[]): UserMessage | undefined {
    if (this.retained === undefined && current.length === 0) return
    const snapshot = current.length === 0 ? CLEARED : current
    if (this.retained?.text === snapshot) return
    return createUserMessage({
      content: [{ type: 'text', text: snapshot }],
      source:
        sections.length === 0
          ? { kind: 'plugin', plugin: SOURCE }
          : { kind: 'plugin', plugin: SOURCE, form: 'snapshot', sections },
    })
  }
}

function isOwned(message: UserMessage): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === SOURCE
}

function textOf(message: UserMessage): string | undefined {
  const [block] = message.content
  return message.content.length === 1 && block?.type === 'text' ? block.text : undefined
}
