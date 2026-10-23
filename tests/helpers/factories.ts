/**
 * Schema / data factories for integration tests.
 *
 * Builds a small but realistic MySQL/MariaDB schema that exercises every object
 * kind the app has to understand: primary keys, auto-increment, unique keys,
 * foreign keys with actions, multi-column indexes, CHECK constraints, a trigger,
 * a view and a table without a primary key (the "cannot reliably capture before
 * image" case).
 *
 * All identifiers are prefixed (default `qa_`) so the fixture cannot collide
 * with application tables; every factory works inside its own throw-away test
 * database created by tests/helpers/mariadb.ts.
 */
import type { Connection } from 'mysql2/promise'

export interface SchemaFixture {
  usersTable: string
  ordersTable: string
  auditTable: string
  noPkTable: string
  viewName: string
  triggerName: string
  prefix: string
}

export interface SeedFixtureResult {
  userIds: number[]
  orderIds: number[]
  users: number
  orders: number
}

export interface FactoryOptions {
  prefix?: string
}

function ident(name: string): string {
  if (!/^[A-Za-z0-9_$]+$/.test(name)) throw new Error(`Unsafe fixture identifier: ${name}`)
  return `\`${name}\``
}

function objectNames(options: FactoryOptions = {}): SchemaFixture {
  const prefix = options.prefix ?? 'qa'
  if (!/^[A-Za-z0-9_$]+$/.test(prefix)) throw new Error(`Unsafe fixture prefix: ${prefix}`)
  return {
    prefix,
    usersTable: `${prefix}_users`,
    ordersTable: `${prefix}_orders`,
    auditTable: `${prefix}_audit`,
    noPkTable: `${prefix}_nopk`,
    viewName: `${prefix}_user_totals`,
    triggerName: `${prefix}_users_after_update`
  }
}

/** Create the full fixture schema. Idempotent only when called on an empty db. */
export async function createSchemaFixture(conn: Connection, options: FactoryOptions = {}): Promise<SchemaFixture> {
  const f = objectNames(options)
  const users = ident(f.usersTable)
  const orders = ident(f.ordersTable)
  const audit = ident(f.auditTable)
  const noPk = ident(f.noPkTable)
  const view = ident(f.viewName)
  const trigger = ident(f.triggerName)

  await conn.query(`
    CREATE TABLE ${users} (
      id INT NOT NULL AUTO_INCREMENT,
      email VARCHAR(120) NOT NULL,
      name VARCHAR(80) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'active',
      balance DECIMAL(12,2) NOT NULL DEFAULT 0.00,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_${f.usersTable}_email (email),
      KEY idx_${f.usersTable}_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await conn.query(`
    CREATE TABLE ${orders} (
      id BIGINT NOT NULL AUTO_INCREMENT,
      user_id INT NOT NULL,
      amount DECIMAL(12,2) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'new',
      note VARCHAR(200) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_${f.ordersTable}_user_status (user_id, status),
      CONSTRAINT fk_${f.ordersTable}_user FOREIGN KEY (user_id)
        REFERENCES ${users} (id) ON DELETE CASCADE ON UPDATE RESTRICT,
      CONSTRAINT chk_${f.ordersTable}_amount CHECK (amount >= 0)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await conn.query(`
    CREATE TABLE ${audit} (
      id INT NOT NULL AUTO_INCREMENT,
      table_name VARCHAR(64) NOT NULL,
      row_pk VARCHAR(64) NOT NULL,
      action VARCHAR(16) NOT NULL,
      at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  // Table without a primary key: before-image restore cannot reliably target
  // individual rows here, which the app must detect and refuse/handle strictly.
  await conn.query(`
    CREATE TABLE ${noPk} (
      payload VARCHAR(100) NOT NULL,
      amount INT NULL,
      KEY idx_${f.noPkTable}_payload (payload)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  await conn.query(`
    CREATE TRIGGER ${trigger} AFTER UPDATE ON ${users}
    FOR EACH ROW INSERT INTO ${audit} (table_name, row_pk, action)
    VALUES ('${f.usersTable}', CONCAT(NEW.id), 'update')
  `)

  await conn.query(`
    CREATE VIEW ${view} AS
    SELECT u.id AS user_id, u.email AS email, COUNT(o.id) AS order_count, COALESCE(SUM(o.amount), 0) AS total_amount
    FROM ${users} u
    LEFT JOIN ${orders} o ON o.user_id = u.id
    GROUP BY u.id, u.email
  `)

  return f
}

/** Insert deterministic users + orders (trigger fires only on updates). */
export async function seedFixture(conn: Connection, fixture: SchemaFixture): Promise<SeedFixtureResult> {
  const users = ident(fixture.usersTable)
  const orders = ident(fixture.ordersTable)
  const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve']
  const userIds: number[] = []
  for (let i = 0; i < names.length; i += 1) {
    const [result] = await conn.query(
      `INSERT INTO ${users} (email, name, status, balance) VALUES (?, ?, ?, ?)`,
      [`user${i + 1}@example.test`, names[i], i === 4 ? 'suspended' : 'active', (i + 1) * 10]
    )
    userIds.push((result as { insertId: number }).insertId)
  }

  const orderIds: number[] = []
  const statuses = ['new', 'paid', 'shipped', 'cancelled']
  for (let i = 0; i < 12; i += 1) {
    const userId = userIds[i % userIds.length]
    const [result] = await conn.query(
      `INSERT INTO ${orders} (user_id, amount, status, note) VALUES (?, ?, ?, ?)`,
      [userId, 5 + i * 2.5, statuses[i % statuses.length], i % 3 === 0 ? null : `note-${i}`]
    )
    orderIds.push((result as { insertId: number }).insertId)
  }

  return { userIds, orderIds, users: userIds.length, orders: orderIds.length }
}

/** Insert a single row and return insertId. */
export async function insertRow(
  conn: Connection,
  table: string,
  values: Record<string, unknown>
): Promise<number> {
  const columns = Object.keys(values)
  const placeholders = columns.map(() => '?').join(', ')
  const sql = `INSERT INTO ${ident(table)} (${columns.map(ident).join(', ')}) VALUES (${placeholders})`
  const [result] = await conn.query(
    sql,
    columns.map((column) => values[column])
  )
  return (result as { insertId: number }).insertId
}

/** Count rows in a table (optionally filtered). */
export async function countRows(conn: Connection, table: string, where?: string): Promise<number> {
  const sql = `SELECT COUNT(*) AS n FROM ${ident(table)}${where ? ` WHERE ${where}` : ''}`
  const [rows] = await conn.query(sql)
  return Number((rows as Array<{ n: number }>)[0]?.n ?? 0)
}

/** Fetch rows as plain objects. */
export async function fetchRows<T = Record<string, unknown>>(
  conn: Connection,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const [rows] = await conn.query(sql, params)
  return rows as T[]
}

/** Table existence check within the connection's current database. */
export async function tableExists(conn: Connection, table: string): Promise<boolean> {
  const [rows] = await conn.query(
    'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
    [table]
  )
  return Number((rows as Array<{ n: number }>)[0]?.n ?? 0) > 0
}

/** Add a column to a fixture table (schema change detection tests). */
export async function addColumn(
  conn: Connection,
  table: string,
  columnDefinition: string
): Promise<void> {
  await conn.query(`ALTER TABLE ${ident(table)} ADD COLUMN ${columnDefinition}`)
}

/** Drop a column from a fixture table. */
export async function dropColumn(conn: Connection, table: string, column: string): Promise<void> {
  await conn.query(`ALTER TABLE ${ident(table)} DROP COLUMN ${ident(column)}`)
}

/** Drop every object created by createSchemaFixture. */
export async function dropSchemaFixture(conn: Connection, fixture: SchemaFixture): Promise<void> {
  await conn.query(`DROP VIEW IF EXISTS ${ident(fixture.viewName)}`)
  // Dropping the parent table drops orders (FK cascade) but be explicit anyway.
  await conn.query(`DROP TABLE IF EXISTS ${ident(fixture.ordersTable)}`)
  await conn.query(`DROP TABLE IF EXISTS ${ident(fixture.usersTable)}`)
  await conn.query(`DROP TABLE IF EXISTS ${ident(fixture.auditTable)}`)
  await conn.query(`DROP TABLE IF EXISTS ${ident(fixture.noPkTable)}`)
  // Trigger disappears with the table; the DROP TRIGGER below is defensive for
  // databases where the table was recreated.
  await conn.query(`DROP TRIGGER IF EXISTS ${ident(fixture.triggerName)}`).catch(() => {})
}
