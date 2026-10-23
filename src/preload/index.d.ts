import type { AidbBridge } from '@shared/ipc'

declare global {
  interface Window {
    aidb: AidbBridge
  }
}

export {}
