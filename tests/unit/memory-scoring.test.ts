/**
 * Memory retrieval scoring and schema memory content (pure functions).
 *
 * The retrieval contract that matters for safety: unrelated schema memories
 * must not be injected "for free", stale memories must rank lower than fresh
 * ones, and user-confirmed facts must outrank AI inference.
 */
import { describe, expect, it } from 'vitest'
import type { MemoryRecord, SchemaSnapshot, SchemaSnapshotTable } from '@shared/types'
import {
  buildSchemaMemoryContent,
  normalizeQuery,
  scoreMemory,
  tokenize
} from '@main/memory/memory-service'

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date().toISOString()
  return {
    id: 'mem_1',
    projectId: 'proj_1',
    type: 'business',
    title: 'User email uniqueness',
    content: '用户邮箱必须唯一，不能重复注册。',
    source: 'user',
    trust: 'user_confirmed',
    confidence: 1,
    tags: ['user', 'email'],
    refs: [{ kind: 'table', database: 'shop', table: 'users' }],
    schemaSnapshotId: null,
    schemaHash: null,
    status: 'active',
    verifiedBy: 'user',
    verifiedAt: now,
    invalidatedReason: null,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
    useCount: 0,
    supersedesId: null,
    ...overrides
  }
}

function snapshotTable(overrides: Partial<SchemaSnapshotTable> = {}): SchemaSnapshotTable {
  return {
    name: 'users',
    type: 'table',
    engine: 'InnoDB',
    comment: '用户表',
    columns: [
      {
        name: 'id',
        dataType: 'int',
        columnType: 'int(11)',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: true,
        isUnique: false,
        isAutoIncrement: true,
        isGenerated: false,
        comment: '主键',
        ordinal: 1
      },
      {
        name: 'email',
        dataType: 'varchar',
        columnType: 'varchar(120)',
        nullable: false,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: true,
        isAutoIncrement: false,
        isGenerated: false,
        comment: '',
        ordinal: 2
      }
    ],
    indexes: [{ name: 'uk_email', unique: true, type: 'BTREE', columns: ['email'] }],
    foreignKeys: [
      {
        name: 'fk_user_role',
        columns: ['role_id'],
        referencedTable: 'roles',
        referencedColumns: ['id'],
        onUpdate: 'RESTRICT',
        onDelete: 'CASCADE'
      }
    ],
    checkConstraints: [],
    primaryKey: ['id'],
    schemaHash: 'sha-users',
    ...overrides
  }
}

function snapshot(tables: SchemaSnapshotTable[]): SchemaSnapshot {
  return {
    id: 'snap_1',
    projectId: 'proj_1',
    connectionId: 'conn_1',
    database: 'shop',
    serverVersion: '11.4.13-MariaDB',
    serverFlavor: 'mariadb',
    charset: 'utf8mb4',
    takenAt: new Date().toISOString(),
    schemaHash: 'sha-snap',
    objectCount: tables.length,
    tables,
    version: 1
  }
}

describe('tokenize / normalizeQuery', () => {
  it('splits snake_case and keeps whole tokens', () => {
    const tokens = tokenize('user_orders ORDER_ID')
    expect(tokens).toContain('user_orders')
    expect(tokens).toContain('user')
    expect(tokens).toContain('orders')
    expect(tokens).toContain('order')
    expect(tokens).toContain('id')
  })

  it('splits CJK runs into bigrams', () => {
    const tokens = tokenize('用户订单')
    expect(tokens).toContain('用户')
    expect(tokens).toContain('户订')
    expect(tokens).toContain('订单')
  })

  it('bounds the token list and normalises query casing', () => {
    const tokens = tokenize(Array.from({ length: 300 }, (_, i) => `word${i}`).join(' '))
    expect(tokens.length).toBeLessThanOrEqual(64)
    const normalized = normalizeQuery('  User EMAIL  ')
    expect(normalized.raw).toBe('User EMAIL')
    expect(normalized.lower).toBe('user email')
    expect(normalized.tokens).toContain('email')
    expect(normalizeQuery('').tokens).toEqual([])
    expect(tokenize(undefined as never)).toEqual([])
  })
})

describe('scoreMemory', () => {
  it('ranks a title match above an unrelated memory', () => {
    const query = normalizeQuery('user email')
    const relevant = scoreMemory(memory(), query)
    const unrelated = scoreMemory(
      memory({ id: 'mem_2', title: 'Payment settlement cycle', content: '结算周期为 T+1。', tags: [], refs: [] }),
      query
    )
    expect(relevant.score).toBeGreaterThan(unrelated.score)
    expect(relevant.reason).toContain('标题')
  })

  it('gives user-confirmed memories a higher score than AI inference', () => {
    const query = normalizeQuery('user email')
    const confirmed = scoreMemory(memory({ trust: 'user_confirmed' }), query)
    const inferred = scoreMemory(memory({ trust: 'ai_inferred' }), query)
    const unverified = scoreMemory(memory({ trust: 'unverified' }), query)
    expect(confirmed.score).toBeGreaterThan(inferred.score)
    expect(inferred.score).toBeGreaterThan(unverified.score)
    expect(confirmed.reason).toContain('trust:user_confirmed')
  })

  it('penalises stale memories relative to fresh ones', () => {
    const query = normalizeQuery('user email')
    const active = scoreMemory(memory({ status: 'active' }), query)
    const stale = scoreMemory(memory({ status: 'stale' }), query)
    expect(stale.score).toBeLessThan(active.score)
    expect(stale.reason).toContain('status:stale')
  })

  it('boosts table-ref matches and schema memories that name the table', () => {
    const query = normalizeQuery('users')
    const withTableRef = scoreMemory(memory({ title: 'Plain', content: 'x', tags: [], refs: [{ kind: 'table', table: 'users' }] }), query)
    const withoutRef = scoreMemory(memory({ title: 'Plain', content: 'x', tags: [], refs: [] }), query)
    expect(withTableRef.score).toBeGreaterThan(withoutRef.score)

    const schemaMemory = memory({
      type: 'schema',
      title: 'Table users',
      content: 'users 表结构',
      refs: [{ kind: 'table', table: 'users' }]
    })
    expect(scoreMemory(schemaMemory, query).score).toBeGreaterThan(0)
  })

  it('does not inject unrelated AI-inferred schema memories for free', () => {
    const schemaMemory = memory({
      type: 'schema',
      trust: 'ai_inferred',
      title: 'Table orders',
      content: 'orders 表结构',
      tags: ['orders'],
      refs: [{ kind: 'table', table: 'orders' }]
    })
    const hit = scoreMemory(schemaMemory, normalizeQuery('user email'))
    expect(hit.score).toBeLessThanOrEqual(0)
  })

  it('boosts tag hits and recent/used memories slightly', () => {
    const query = normalizeQuery('email')
    const tagged = scoreMemory(memory({ title: 'Rule', content: 'x', tags: ['email'], refs: [] }), query)
    const untagged = scoreMemory(memory({ title: 'Rule', content: 'x', tags: [], refs: [] }), query)
    expect(tagged.score).toBeGreaterThan(untagged.score)

    const fresh = scoreMemory(memory(), query)
    const old = scoreMemory(
      memory({ updatedAt: new Date(Date.now() - 90 * 86_400_000).toISOString(), useCount: 0 }),
      query
    )
    expect(fresh.score).toBeGreaterThan(old.score)
  })
})

describe('buildSchemaMemoryContent', () => {
  it('renders a compact table description with keys, indexes and FKs', () => {
    const table = snapshotTable()
    const content = buildSchemaMemoryContent(snapshot([table]), table)
    expect(content).toContain('shop.users')
    expect(content).toContain('用户表')
    expect(content).toContain('PK')
    expect(content).toContain('NOT NULL')
    expect(content).toContain('主键: id')
    expect(content).toContain('fk_user_role')
    expect(content).toContain('roles')
    expect(content).toContain('结构哈希: sha-users')
    expect(content).toContain('snap_1')
  })

  it('marks views and truncates very wide tables', () => {
    const wide = snapshotTable({
      name: 'wide_table',
      type: 'view',
      columns: Array.from({ length: 70 }, (_, i) => ({
        name: `c${i}`,
        dataType: 'int',
        columnType: 'int',
        nullable: true,
        defaultValue: null,
        isPrimaryKey: false,
        isUnique: false,
        isAutoIncrement: false,
        isGenerated: false,
        comment: '',
        ordinal: i + 1
      }))
    })
    const content = buildSchemaMemoryContent(snapshot([wide]), wide)
    expect(content).toContain('视图 shop.wide_table')
    expect(content).toContain('其余 10 列未展开')
  })

  it('strips control characters from untrusted schema text', () => {
    const table = snapshotTable({ comment: 'bad\u0000comment\u0007' })
    const content = buildSchemaMemoryContent(snapshot([table]), table)
    expect(content).not.toContain('\u0000')
    expect(content).toContain('bad comment')
  })
})
