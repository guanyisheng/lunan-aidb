/**
 * Chapter 8 test #2: schema scanning and change detection on real MariaDB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Connection } from 'mysql2/promise'
import type { TestApp } from '../helpers/app'
import { createTestApp } from '../helpers/app'
import {
  isServerAvailable,
  openTestConnection
} from '../helpers/mariadb'
import {
  addColumn,
  createSchemaFixture,
  dropColumn,
  dropSchemaFixture,
  seedFixture,
  type SchemaFixture
} from '../helpers/factories'

const available = await isServerAvailable()

describe.skipIf(!available)('integration: schema scan + change detection', () => {
  let app: TestApp
  let conn: Connection
  let fixture: SchemaFixture

  beforeAll(async () => {
    app = await createTestApp('schema')
    conn = await openTestConnection(app.database)
    fixture = await createSchemaFixture(conn)
    await seedFixture(conn, fixture)
  }, 240_000)

  afterAll(async () => {
    if (conn) {
      await dropSchemaFixture(conn, fixture).catch(() => {})
      await conn.end().catch(() => {})
    }
    await app?.dispose()
  }, 240_000)

  it('scans tables, views, keys, indexes, FKs, checks and triggers', async () => {
    const session = await app.services.connections.openSession(app.connectionId, app.database)
    const snapshot = await app.services.schema.scan(session, {
      connectionId: app.connectionId,
      database: app.database
    })

    expect(snapshot.database).toBe(app.database)
    expect(snapshot.serverFlavor).toBe('mariadb')
    expect(snapshot.serverVersion).toMatch(/11\.4\./)
    expect(snapshot.objectCount).toBe(5)
    expect(snapshot.tables.map((t) => t.name).sort()).toEqual(
      [fixture.usersTable, fixture.ordersTable, fixture.auditTable, fixture.noPkTable, fixture.viewName].sort()
    )
    expect(snapshot.schemaHash).toMatch(/^[0-9a-f]{64}$/)

    const users = snapshot.tables.find((t) => t.name === fixture.usersTable)!
    expect(users.primaryKey).toEqual(['id'])
    const idColumn = users.columns.find((c) => c.name === 'id')!
    expect(idColumn.isPrimaryKey).toBe(true)
    expect(idColumn.isAutoIncrement).toBe(true)
    const emailColumn = users.columns.find((c) => c.name === 'email')!
    expect(emailColumn.isUnique).toBe(true)
    expect(emailColumn.nullable).toBe(false)
    expect(users.indexes.some((i) => i.columns.includes('email'))).toBe(true)
    expect(users.indexes.some((i) => i.name.toLowerCase().includes('email'))).toBe(true)

    const orders = snapshot.tables.find((t) => t.name === fixture.ordersTable)!
    const fk = orders.foreignKeys.find((f) => f.referencedTable === fixture.usersTable)!
    expect(fk).toBeTruthy()
    expect(fk.columns).toEqual(['user_id'])
    expect(fk.referencedColumns).toEqual(['id'])
    expect(fk.onDelete).toBe('CASCADE')
    expect(orders.checkConstraints.length).toBeGreaterThan(0)
    expect(orders.indexes.some((i) => i.columns.join(',') === 'user_id,status')).toBe(true)

    const view = snapshot.tables.find((t) => t.name === fixture.viewName)!
    expect(view.type).toBe('view')

    const audit = snapshot.tables.find((t) => t.name === fixture.auditTable)!
    expect(audit.primaryKey).toEqual(['id'])
    // MariaDB exposes triggers via information_schema; the scanner also probes
    // them per table via SHOW TRIGGERS (see getTable details).
    const usersDetails = await app.services.schema.getTable(
      session,
      app.database,
      fixture.usersTable
    )
    expect(usersDetails.triggers.map((t) => t.name)).toContain(fixture.triggerName)
    expect(usersDetails.createSql?.toUpperCase()).toContain('CREATE TABLE')
  })

  it('scans the no-primary-key table truthfully', async () => {
    const session = await app.services.connections.openSession(app.connectionId, app.database)
    const details = await app.services.schema.getTable(session, app.database, fixture.noPkTable)
    expect(details.primaryKey).toEqual([])
    expect(details.columns.length).toBe(2)
  })

  it('produces a stable schema hash and an identical diff for an unchanged schema', async () => {
    const session = await app.services.connections.openSession(app.connectionId, app.database)
    const first = await app.services.schema.scan(session, {
      connectionId: app.connectionId,
      database: app.database
    })
    const second = await app.services.schema.scan(session, {
      connectionId: app.connectionId,
      database: app.database
    })
    expect(second.schemaHash).toBe(first.schemaHash)

    const diff = app.services.schema.diff(first, second)
    expect(diff.identical).toBe(true)
    expect(diff.addedTables).toEqual([])
    expect(diff.removedTables).toEqual([])
    expect(diff.changedTables).toEqual([])
  })

  it('detects added / changed / removed columns and tables', async () => {
    const session = await app.services.connections.openSession(app.connectionId, app.database)
    const before = await app.services.schema.scan(session, {
      connectionId: app.connectionId,
      database: app.database
    })

    await addColumn(conn, fixture.usersTable, 'nickname VARCHAR(30) NULL')
    await addColumn(conn, fixture.ordersTable, 'discount DECIMAL(8,2) NOT NULL DEFAULT 0')
    await conn.query(`CREATE TABLE \`${fixture.prefix}_extra\` (id INT PRIMARY KEY) ENGINE=InnoDB`)
    await conn.query(`DROP TABLE \`${fixture.noPkTable}\``)

    const after = await app.services.schema.scan(session, {
      connectionId: app.connectionId,
      database: app.database
    })
    const diff = app.services.schema.diff(before, after)

    expect(diff.identical).toBe(false)
    expect(diff.addedTables).toContain(`${fixture.prefix}_extra`)
    expect(diff.removedTables).toContain(fixture.noPkTable)
    const usersChange = diff.changedTables.find((t) => t.name === fixture.usersTable)!
    expect(usersChange.addedColumns.map((c) => c.name)).toContain('nickname')
    const ordersChange = diff.changedTables.find((t) => t.name === fixture.ordersTable)!
    expect(ordersChange.addedColumns.map((c) => c.name)).toContain('discount')

    // And removal direction.
    await dropColumn(conn, fixture.usersTable, 'nickname')
    const afterRemoval = await app.services.schema.scan(session, {
      connectionId: app.connectionId,
      database: app.database
    })
    const removalDiff = app.services.schema.diff(after, afterRemoval)
    const removedUsers = removalDiff.changedTables.find((t) => t.name === fixture.usersTable)!
    expect(removedUsers.removedColumns.map((c) => c.name)).toContain('nickname')

    await conn.query(`DROP TABLE \`${fixture.prefix}_extra\``)
  })

  it('persists snapshots and detects changes for a project', async () => {
    const project = app.store.createProject({
      name: 'QA schema project',
      description: 'integration test',
      connectionId: app.connectionId
    })

    const initial = await app.services.schema.detectChanges(app.services, project.id)
    expect(initial.changed).toBe(false)
    expect(initial.newSnapshot).toBeTruthy()
    expect(app.store.getProject(project.id)?.schemaSnapshotId).toBe(initial.newSnapshot!.id)

    await addColumn(conn, fixture.auditTable, 'source VARCHAR(40) NULL')
    try {
      const changed = await app.services.schema.detectChanges(app.services, project.id)
      expect(changed.changed).toBe(true)
      expect(changed.diff?.identical).toBe(false)
      expect(changed.newSnapshot?.version).toBe(2)
      const auditChange = changed.diff?.changedTables.find((t) => t.name === fixture.auditTable)
      expect(auditChange?.addedColumns.map((c) => c.name)).toContain('source')

      // A second detection with no further DDL reports no change.
      const again = await app.services.schema.detectChanges(app.services, project.id)
      expect(again.changed).toBe(false)
    } finally {
      await dropColumn(conn, fixture.auditTable, 'source')
    }
  })

  it('returns the real view definition and dependency-safe object list', async () => {
    const session = await app.services.connections.openSession(app.connectionId, app.database)
    const objects = await app.services.schema.listTables(session, app.database)
    const names = objects.map((o) => o.name)
    expect(names).toContain(fixture.viewName)
    expect(names).toContain(fixture.usersTable)
    const view = objects.find((o) => o.name === fixture.viewName)!
    expect(view.type).toBe('view')
  })
})
