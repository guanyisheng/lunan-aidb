/**
 * Local disk cache for table browse previews.
 * Lets the workspace keep showing rows while an Agent holds the live DB connection.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { TableBrowseResult } from '@shared/types'
import { nowIso } from '../util/time'

const MAX_ENTRIES = 80
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export interface BrowseCacheEntry {
  connectionId: string
  database: string
  table: string
  offset: number
  limit: number
  cachedAt: string
  result: TableBrowseResult
}

function cacheKey(parts: {
  connectionId: string
  database: string
  table: string
  offset: number
  limit: number
}): string {
  const raw = `${parts.connectionId}\0${parts.database}\0${parts.table}\0${parts.offset}\0${parts.limit}`
  return createHash('sha1').update(raw).digest('hex')
}

function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* exists */
  }
}

function filePath(dir: string, key: string): string {
  return join(dir, `${key}.json`)
}

export function readBrowseCache(
  cacheDir: string,
  parts: { connectionId: string; database: string; table: string; offset: number; limit: number }
): BrowseCacheEntry | null {
  try {
    ensureDir(cacheDir)
    const path = filePath(cacheDir, cacheKey(parts))
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as BrowseCacheEntry
    if (!parsed?.cachedAt || !parsed?.result) return null
    const age = Date.now() - Date.parse(parsed.cachedAt)
    if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return null
    return parsed
  } catch {
    return null
  }
}

export function writeBrowseCache(
  cacheDir: string,
  parts: { connectionId: string; database: string; table: string; offset: number; limit: number },
  result: TableBrowseResult
): BrowseCacheEntry {
  ensureDir(cacheDir)
  const entry: BrowseCacheEntry = {
    ...parts,
    cachedAt: nowIso(),
    result: {
      ...result,
      fromCache: false,
      cachedAt: undefined
    }
  }
  const path = filePath(cacheDir, cacheKey(parts))
  writeFileSync(path, JSON.stringify(entry), 'utf8')
  pruneBrowseCache(cacheDir)
  return entry
}

function pruneBrowseCache(cacheDir: string): void {
  try {
    const files = readdirSync(cacheDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const path = join(cacheDir, name)
        try {
          return { path, mtime: statSync(path).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((item): item is { path: string; mtime: number } => Boolean(item))
      .sort((a, b) => b.mtime - a.mtime)

    for (const file of files.slice(MAX_ENTRIES)) {
      try {
        unlinkSync(file.path)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}
