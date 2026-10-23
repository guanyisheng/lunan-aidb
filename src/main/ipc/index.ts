import { registerCoreHandlers } from './handlers/core'
import { registerSchemaSqlHandlers } from './handlers/schema-sql'
import { registerAiHandlers } from './handlers/ai'
import { registerTimeMachineHandlers } from './handlers/timemachine'

export { dispatch, registeredMethods } from './registry'
export type { HandlerContext } from './registry'

let registered = false

/**
 * Populates the IPC allow-list exactly once. Called from the main process after
 * services are constructed; tests may call it to inspect the registry.
 */
export function registerAllHandlers(): void {
  if (registered) return
  registerCoreHandlers()
  registerSchemaSqlHandlers()
  registerAiHandlers()
  registerTimeMachineHandlers()
  registered = true
}
