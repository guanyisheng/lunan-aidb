/**
 * Shared low-level utilities: time, ids, atomic fs helpers and the stable
 * schema hashing helpers used for change detection.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fileStamp, addDays, addMs, formatDuration, isExpired, nowIso } from '@main/util/time'
import { newId, sha256Hex, shortHash } from '@main/util/id'
import {
  ensureDir,
  pathExists,
  readJsonFile,
  removeFile,
  safeFileFragment,
  sha256File,
  writeFileAtomic,
  writeJsonAtomic
} from '@main/util/fsx'
import {
  columnSignature,
  foreignKeySignature,
  hashSnapshotShape,
  hashTableShape,
  indexSignature,
  stableStringify
} from '@main/db/internal'
import { isFilesystemArtifactName } from '@main/db/meta'

const scratch = () => mkdtemp(join(tmpdir(), 'aidb-unit-'))

describe('time helpers', () => {
  it('detects expired / future ISO timestamps', () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(isExpired(past)).toBe(true)
    expect(isExpired(future)).toBe(false)
    expect(isExpired(future, new Date(Date.now() + 120_000))).toBe(true)
    expect(isExpired('not-a-date')).toBe(false)
  })

  it('adds ms/days relative to an explicit base', () => {
    const base = new Date('2026-01-01T00:00:00.000Z')
    expect(addMs(1000, base)).toBe('2026-01-01T00:00:01.000Z')
    expect(addDays(1, base)).toBe('2026-01-02T00:00:00.000Z')
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('formats durations and file stamps', () => {
    expect(formatDuration(12)).toBe('12ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(65_000)).toBe('1m5s')
    const stamp = fileStamp(new Date(2026, 9, 22, 8, 9, 10))
    expect(stamp).toBe('20261022-080910')
  })
})

describe('id helpers', () => {
  it('creates prefixed unique ids', () => {
    const a = newId('plan')
    const b = newId('plan')
    expect(a.startsWith('plan_')).toBe(true)
    expect(a).not.toBe(b)
    expect(newId().startsWith('id_')).toBe(true)
  })

  it('hashes to sha256 (known vector + short hashes)', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(shortHash('abc', 8)).toBe('ba7816bf')
    expect(sha256Hex('')).toHaveLength(64)
  })
})

describe('filesystem helpers', () => {
  it('writes and reads JSON atomically', async () => {
    const dir = await scratch()
    try {
      const file = join(dir, 'nested', 'state.json')
      await ensureDir(join(dir, 'nested'))
      await writeJsonAtomic(file, { ok: true, list: [1, 2] })
      expect(await readJsonFile(file, { fallback: true })).toEqual({ ok: true, list: [1, 2] })
      await writeFileAtomic(file, 'plain')
      expect((await readFile(file, 'utf8')).trim()).toBe('plain')
      expect(await readJsonFile(file, { fallback: true })).toEqual({ fallback: true })
      expect(await pathExists(file)).toBe(true)
      expect(await sha256File(file)).toHaveLength(64)
      await removeFile(file)
      expect(await pathExists(file)).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sanitises file-name fragments', () => {
    expect(safeFileFragment('my_db')).toBe('my_db')
    // No path separators may survive, so the fragment cannot escape its dir.
    const traversal = safeFileFragment('../../etc/passwd')
    expect(traversal).not.toContain('/')
    expect(traversal).not.toContain('\\')
    expect(safeFileFragment('数据库/测试')).not.toContain('/')
    const long = safeFileFragment('x'.repeat(300), 20)
    expect(long.length).toBeLessThanOrEqual(20)
  })

  it('includes unicode paths in safeFileFragment output', async () => {
    const dir = await scratch()
    try {
      const file = join(dir, '数据库.json')
      await writeFile(file, '数据', 'utf8')
      expect(await sha256File(file)).toHaveLength(64)
      expect(await pathExists(file)).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('stable schema signatures', () => {
  it('stableStringify sorts keys deterministically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
    expect(stableStringify({ a: [2, 1] })).toBe('{"a":[2,1]}')
  })

  it('generates column/index/FK signatures that change with shape', () => {
    const column = {
      name: 'id',
      dataType: 'int',
      columnType: 'int(11)',
      nullable: false,
      defaultValue: null,
      isPrimaryKey: true,
      isUnique: false,
      isAutoIncrement: true,
      isGenerated: false,
      comment: '',
      ordinal: 1
    }
    expect(columnSignature(column as never)).toContain('id')
    expect(columnSignature({ ...column, nullable: true } as never)).not.toBe(columnSignature(column as never))

    expect(
      indexSignature({ name: 'idx', unique: false, type: 'BTREE', columns: ['a', 'b'] } as never)
    ).toContain('a')
    expect(
      foreignKeySignature({
        name: 'fk',
        columns: ['user_id'],
        referencedTable: 'users',
        referencedColumns: ['id'],
        onUpdate: 'RESTRICT',
        onDelete: 'CASCADE'
      } as never)
    ).toContain('CASCADE')
  })

  it('hashes table and snapshot shapes consistently', () => {
    const table = {
      name: 't1',
      columns: [],
      indexes: [],
      foreignKeys: [],
      primaryKey: ['id']
    }
    const h1 = hashTableShape(table as never)
    const h2 = hashTableShape(table as never)
    expect(h1).toBe(h2)
    expect(hashTableShape({ ...table, primaryKey: ['other'] } as never)).not.toBe(h1)
    const snapshotTable = {
      name: 't1',
      type: 'table' as const,
      engine: 'InnoDB',
      comment: '',
      columns: [],
      indexes: [],
      foreignKeys: [],
      checkConstraints: [],
      primaryKey: ['id'],
      schemaHash: h1
    }
    expect(hashSnapshotShape([snapshotTable])).toBe(hashSnapshotShape([snapshotTable]))
    expect(hashSnapshotShape([snapshotTable, { ...snapshotTable, name: 't2' }])).not.toBe(
      hashSnapshotShape([snapshotTable])
    )
  })
})

describe('filesystem artifact name filter', () => {
  it('rejects AppleDouble / #mysql50# encoded names', () => {
    expect(isFilesystemArtifactName('._db')).toBe(true)
    expect(isFilesystemArtifactName('.hidden')).toBe(true)
    expect(isFilesystemArtifactName('#mysql50#._db')).toBe(true)
    expect(isFilesystemArtifactName('#mysql50#.foo')).toBe(true)
    expect(isFilesystemArtifactName('qa_users')).toBe(false)
    expect(isFilesystemArtifactName('mysql')).toBe(false)
    expect(isFilesystemArtifactName('')).toBe(true)
  })
})
