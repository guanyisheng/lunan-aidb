import type { EventBus } from '@main/service-contracts'
import type { EventMap } from '@shared/ipc'
import type { EventName } from '@shared/ipc'

type Listener = (payload: unknown) => void

/**
 * In-process typed event bus. The Electron main process attaches a sink that
 * forwards events to the focused window over the single IPC event channel.
 */
export class BroadcastEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<Listener>>()
  private sink: ((type: string, payload: unknown) => void) | null = null

  attach(sink: (type: string, payload: unknown) => void): void {
    this.sink = sink
  }

  emit<K extends keyof EventMap>(type: K, payload: EventMap[K]): void {
    const set = this.listeners.get(type as string)
    if (set) {
      for (const listener of [...set]) {
        try {
          listener(payload)
        } catch {
          /* a listener failure must not break the emitter */
        }
      }
    }
    if (this.sink) {
      try {
        this.sink(type as string, payload)
      } catch {
        /* window may be gone */
      }
    }
  }

  on<K extends keyof EventMap>(type: K, listener: (payload: EventMap[K]) => void): () => void {
    const key = type as string
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    const fn = listener as unknown as Listener
    set.add(fn)
    return () => {
      set?.delete(fn)
    }
  }

  /** Used by tests / headless runs. */
  waitFor<K extends EventName>(type: K, timeoutMs = 5000): Promise<EventMap[K]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off()
        reject(new Error(`Timed out waiting for event ${type}`))
      }, timeoutMs)
      const off = this.on(type, (payload) => {
        clearTimeout(timer)
        off()
        resolve(payload as EventMap[K])
      })
    })
  }
}
