export function nowIso(): string {
  return new Date().toISOString()
}

export function addMs(ms: number, from: Date = new Date()): string {
  return new Date(from.getTime() + ms).toISOString()
}

export function addDays(days: number, from: Date = new Date()): string {
  return addMs(days * 24 * 60 * 60 * 1000, from)
}

export function isExpired(iso: string, now: Date = new Date()): boolean {
  const t = Date.parse(iso)
  return Number.isFinite(t) && t <= now.getTime()
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${s}s`
}

/** Filesystem-safe timestamp for backup/recovery-point file names. */
export function fileStamp(date: Date = new Date()): string {
  const p = (n: number, l = 2): string => String(n).padStart(l, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}
