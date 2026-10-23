/**
 * Dependency injection helpers for the time-machine module.
 *
 * The service container has a cyclic shape: RecoveryService needs
 * BackupService, while the container itself owns both. Rather than
 * constructing with a half-initialised object, every class accepts either the
 * fully built `Services` object or a provider callback. Services are resolved
 * lazily at call time, which keeps the container wiring order flexible and
 * (importantly) prevents a stale reference if the container swaps a service.
 */
import type { Services } from '@main/service-contracts'

export type ServicesProvider = Services | (() => Services)

export function resolveServices(provider: ServicesProvider): Services {
  const services = typeof provider === 'function' ? provider() : provider
  if (!services || typeof services !== 'object') {
    throw new Error('Time machine: services container is not available')
  }
  return services
}

/** Resolved paths with a directory that is guaranteed to exist. */
export interface TimeMachinePaths {
  backups: string
  recoveryPoints: string
  logs: string
  temp: string
}

export function pathsOf(services: Services): TimeMachinePaths {
  return {
    backups: services.paths.backups,
    recoveryPoints: services.paths.recoveryPoints,
    logs: services.paths.logs,
    temp: services.paths.temp
  }
}
