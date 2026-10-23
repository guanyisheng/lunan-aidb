/**
 * Backup file format, manifest parsing and independent integrity inspection.
 *
 * The invariant under test: verification derives structure/row counts from the
 * file contents itself, so a forged manifest or a truncated dump is detected.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildBackupHeader,
  countValueTuples,
  hasValidFooter,
  hashCreateStatements,
  inspectBackupFile,
  readBackupManifest,
  readChecksumSidecar,
  scanDumpFile,
  writeBackupFile
} from '@main/timemachine/manifest'
import {
  BACKUP_END,
  BACKUP_FORMAT_VERSION,
  BACKUP_HEADER,
  BACKUP_META_PREFIX,
  type BackupManifestV1
} from '@main/timemachine/internal-types'
import { sha256File } from '@main/util/fsx'

const scratchRoot = join(process.cwd(), '.testdata', 'unit-manifest')

function manifestFixture(overrides: Partial<BackupManifestV1> = {}): BackupManifestV1 {
  return {
    version: BACKUP_FORMAT_VERSION,
    format: 'aidb-backup',
    database: 'qa_db',
    scope: 'database',
    type: 'full',
    tool: 'internal',
    tables: ['t1', 't2'],
    views: ['v1'],
    objects: [
      { name: 't1', type: 'table' },
      { name: 't2', type: 'table' },
      { name: 'v1', type: 'view' }
    ],
    rowCounts: { t1: 3, t2: 1 },
    countedRows: { t1: 3, t2: 1 },
    totalRows: 4,
    schemaHash: 'deadbeef',
    serverVersion: '11.4.13-MariaDB',
    serverFlavor: 'mariadb',
    charset: 'utf8mb4',
    startedAt: '2026-10-22T00:00:00.000Z',
    finishedAt: '2026-10-22T00:00:05.000Z',
    dumper: 'aidb-internal',
    warnings: [],
    ...overrides
  }
}

const BODY = [
  'SET NAMES utf8mb4;',
  'SET FOREIGN_KEY_CHECKS=0;',
  'CREATE TABLE `t1` (`id` int NOT NULL, `name` varchar(20), PRIMARY KEY (`id`));',
  'CREATE TABLE `t2` (`id` int NOT NULL, PRIMARY KEY (`id`));',
  "INSERT INTO `t1` VALUES (1,'a'),(2,'b'),(3,'c');",
  "INSERT INTO `t2` VALUES (1);",
  'CREATE VIEW `v1` AS SELECT id FROM t1;',
  'SET FOREIGN_KEY_CHECKS=1;',
  ''
].join('\n')

async function makeBackup(): Promise<{
  dir: string
  file: string
  bodyPath: string
  manifest: BackupManifestV1
  checksum: string
}> {
  await mkdir(scratchRoot, { recursive: true })
  const dir = await mkdtemp(join(scratchRoot, 'case-'))
  const bodyPath = join(dir, 'body.sql')
  const file = join(dir, 'backup.sql')
  await writeFile(bodyPath, BODY, 'utf8')
  const manifest = manifestFixture()
  const written = await writeBackupFile(file, manifest, bodyPath)
  return { dir, file, bodyPath, manifest, checksum: written.checksumSha256 }
}

async function clean(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

describe('backup manifest + file assembly', () => {
  it('writes header, body and EOF marker and records the checksum sidecar', async () => {
    const { dir, file, checksum } = await makeBackup()
    try {
      const text = await readFile(file, 'utf8')
      expect(text.startsWith(BACKUP_HEADER)).toBe(true)
      expect(text).toContain(BACKUP_META_PREFIX)
      expect(text.trimEnd().endsWith(BACKUP_END)).toBe(true)
      expect(checksum).toBe(await sha256File(file))
      expect(await readChecksumSidecar(file)).toBe(checksum)
      expect(await hasValidFooter(file)).toBe(true)
      expect(buildBackupHeader(manifestFixture())).toContain('"format":"aidb-backup"')
    } finally {
      await clean(dir)
    }
  })

  it('round-trips the manifest and detects missing/corrupt metadata', async () => {
    const { dir, file } = await makeBackup()
    try {
      const { manifest, issues } = await readBackupManifest(file)
      expect(issues).toEqual([])
      expect(manifest?.database).toBe('qa_db')
      expect(manifest?.tables).toEqual(['t1', 't2'])
      expect(manifest?.totalRows).toBe(4)

      const badFile = join(dir, 'bad.sql')
      await writeFile(badFile, 'SELECT 1;\n', 'utf8')
      const bad = await readBackupManifest(badFile)
      expect(bad.manifest).toBeNull()
      expect(bad.issues.length).toBeGreaterThan(0)

      const badMeta = join(dir, 'bad-meta.sql')
      await writeFile(
        badMeta,
        `${BACKUP_HEADER}\n${BACKUP_META_PREFIX}{not json}\n${BACKUP_END}\n`,
        'utf8'
      )
      const badMetaResult = await readBackupManifest(badMeta)
      expect(badMetaResult.manifest).toBeNull()
      expect(badMetaResult.issues.join(' ')).toContain('JSON')

      expect((await readBackupManifest(join(dir, 'missing.sql'))).issues).toContain('备份文件不存在')
    } finally {
      await clean(dir)
    }
  })

  it('rejects manifests with an unsupported version/format', async () => {
    const { dir } = await makeBackup()
    try {
      const file = join(dir, 'wrong-version.sql')
      await writeFile(
        file,
        `${BACKUP_HEADER}\n${BACKUP_META_PREFIX}${JSON.stringify({ version: 99, format: 'nope' })}\n${BACKUP_END}\n`,
        'utf8'
      )
      const result = await readBackupManifest(file)
      expect(result.manifest).toBeNull()
      expect(result.issues.length).toBeGreaterThan(0)
    } finally {
      await clean(dir)
    }
  })
})

describe('dump content scanning', () => {
  it('derives table/view/row counts from the SQL itself', async () => {
    const { dir, file } = await makeBackup()
    try {
      const scan = await scanDumpFile(file)
      expect(scan.createTableCount).toBe(2)
      expect(scan.createViewCount).toBe(1)
      expect(scan.tableNames.sort()).toEqual(['t1', 't2'])
      expect(scan.viewNames).toEqual(['v1'])
      expect(scan.rowCountsByTable).toEqual({ t1: 3, t2: 1 })
      expect(scan.insertStatements).toBe(2)
      expect(scan.bytesScanned).toBeGreaterThan(0)
      expect(Object.keys(scan.createStatements).sort()).toEqual(['t1', 't2', 'v1'])
    } finally {
      await clean(dir)
    }
  })

  it('recognises executable-comment wrapped views (mysqldump style)', async () => {
    await mkdir(scratchRoot, { recursive: true })
    const dir = await mkdtemp(join(scratchRoot, 'wrapped-'))
    try {
      const file = join(dir, 'wrapped.sql')
      await writeFile(
        file,
        [
          'CREATE TABLE `t1` (`id` int);',
          '/*!50001 CREATE ALGORITHM=UNDEFINED VIEW `v1` AS select 1 AS `x` */;',
          ''
        ].join('\n'),
        'utf8'
      )
      const scan = await scanDumpFile(file)
      expect(scan.createTableCount).toBe(1)
      expect(scan.createViewCount).toBe(1)
      expect(scan.viewNames).toEqual(['v1'])
    } finally {
      await clean(dir)
    }
  })

  it('counts INSERT value tuples, including ON DUPLICATE KEY UPDATE', () => {
    expect(countValueTuples('INSERT INTO t VALUES (1),(2),(3)')).toBe(3)
    expect(countValueTuples('INSERT INTO `db`.`t` (a, b) VALUES (1, 2), (3, 4)')).toBe(2)
    expect(countValueTuples("INSERT INTO t VALUES (1,'a)b'),(2,'c');")).toBe(2)
    expect(countValueTuples('INSERT INTO t VALUES (1),(2) ON DUPLICATE KEY UPDATE a = 1')).toBe(2)
    expect(countValueTuples('INSERT INTO t SELECT * FROM x')).toBe(0)
  })

  it('hashes CREATE statements order-independently', () => {
    const a = hashCreateStatements({ b: 'CREATE TABLE b (id int)', a: 'CREATE TABLE a (id int)' })
    const b = hashCreateStatements({ a: 'CREATE TABLE a (id int)', b: 'CREATE TABLE b (id int)' })
    expect(a).toBe(b)
    expect(hashCreateStatements({ a: 'CREATE TABLE a (id bigint)' })).not.toBe(
      hashCreateStatements({ a: 'CREATE TABLE a (id int)' })
    )
  })
})

describe('inspectBackupFile', () => {
  it('verifies a valid backup against its checksum and manifest', async () => {
    const { dir, file, checksum } = await makeBackup()
    try {
      const inspection = await inspectBackupFile(file, checksum)
      expect(inspection.fileExists).toBe(true)
      expect(inspection.nonEmpty).toBe(true)
      expect(inspection.checksumOk).toBe(true)
      expect(inspection.structureOk).toBe(true)
      expect(inspection.tableCount).toBe(2)
      expect(inspection.viewCount).toBe(1)
      expect(inspection.totalInsertRows).toBe(4)
      expect(inspection.rowDataPresent).toBe(true)
      expect(inspection.manifest?.database).toBe('qa_db')
      expect(inspection.notes.join(' ')).toContain('校验和一致')
    } finally {
      await clean(dir)
    }
  })

  it('detects a tampered file via its expected checksum', async () => {
    const { dir, file, checksum } = await makeBackup()
    try {
      await writeFile(file, `${await readFile(file, 'utf8')}-- tampered\n`, 'utf8')
      const inspection = await inspectBackupFile(file, checksum)
      expect(inspection.checksumOk).toBe(false)
      expect(inspection.notes.join(' ')).toContain('不一致')
    } finally {
      await clean(dir)
    }
  })

  it('detects a truncated dump (missing EOF marker)', async () => {
    const { dir, file } = await makeBackup()
    try {
      const text = await readFile(file, 'utf8')
      const truncated = join(dir, 'truncated.sql')
      await writeFile(truncated, text.replace(BACKUP_END, ''), 'utf8')
      expect(await hasValidFooter(truncated)).toBe(false)
      const inspection = await inspectBackupFile(truncated)
      expect(inspection.structureOk).toBe(false)
      expect(inspection.notes.join(' ')).toContain(BACKUP_END)
    } finally {
      await clean(dir)
    }
  })

  it('reports a missing file truthfully', async () => {
    const inspection = await inspectBackupFile(join(scratchRoot, 'does-not-exist.sql'))
    expect(inspection.fileExists).toBe(false)
    expect(inspection.structureOk).toBe(false)
    expect(inspection.notes).toContain('备份文件不存在')
  })

  it('detects a manifest/files table-count mismatch', async () => {
    await mkdir(scratchRoot, { recursive: true })
    const dir = await mkdtemp(join(scratchRoot, 'mismatch-'))
    try {
      const bodyPath = join(dir, 'body.sql')
      const file = join(dir, 'mismatch.sql')
      await writeFile(bodyPath, 'CREATE TABLE `t1` (`id` int);\n', 'utf8')
      const written = await writeBackupFile(
        file,
        manifestFixture({ tables: ['t1', 't2'], views: [], objects: [{ name: 't1', type: 'table' }], rowCounts: { t1: 0, t2: 0 } }),
        bodyPath
      )
      const inspection = await inspectBackupFile(file, written.checksumSha256)
      expect(inspection.tableCount).toBe(1)
      expect(inspection.structureOk).toBe(false)
      expect(inspection.notes.join(' ')).toContain('不一致')
    } finally {
      await clean(dir)
    }
  })
})
