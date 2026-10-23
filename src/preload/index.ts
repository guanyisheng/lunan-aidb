import { contextBridge, ipcRenderer } from 'electron'
import { IPC_BRIDGE_VERSION, IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '@shared/ipc'
import type { AidbBridge, EventMap, EventName, MethodMap, MethodName } from '@shared/ipc'

/**
 * The ONLY surface exposed to the renderer. No Node APIs, no database handles,
 * no filesystem, no arbitrary channel names: every call goes through the single
 * allow-listed invoke channel and is validated again in the main process.
 */
const bridge: AidbBridge = {
  version: IPC_BRIDGE_VERSION,
  platform: process.platform,

  invoke<K extends MethodName>(method: K, payload: MethodMap[K]['req']) {
    return ipcRenderer.invoke(IPC_INVOKE_CHANNEL, method, payload)
  },

  invokeSafe<K extends MethodName>(method: K, payload: MethodMap[K]['req']) {
    return ipcRenderer.invoke(IPC_INVOKE_CHANNEL, method, payload)
  },

  on<K extends EventName>(type: K, listener: (payload: EventMap[K]) => void) {
    const handler = (_event: unknown, message: { type?: string; payload?: unknown }): void => {
      if (!message || message.type !== type) return
      listener(message.payload as EventMap[K])
    }
    ipcRenderer.on(IPC_EVENT_CHANNEL, handler as never)
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, handler as never)
    }
  }
}

contextBridge.exposeInMainWorld('aidb', bridge)
