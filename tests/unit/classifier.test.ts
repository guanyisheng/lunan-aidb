/**
 * SQL statement splitting + risk classification (real classifier, no mocks).
 *
 * These tests pin the security-relevant behaviour:
 *  - splitting must never break strings/comments/DELIMITER bodies;
 *  - unparseable SQL must fail strict (approval + backup required);
 *  - destructive DDL/DML must be flagged critical with implicit-commit info.
 */
import { describe, expect, it } from 'vitest'
import type { Services } from '@main/service-contracts'
import { AstSqlRiskClassifier, splitSqlStatements } from '@main/db/classifier'

const classifier = new AstSqlRiskClassifier(() => ({}) as Services)

describe('splitSqlStatements', () => {
  it('returns an empty list for empty / comment-only input', () => {
    expect(splitSqlStatements('')).toEqual([])
    expect(splitSqlStatements('   \n\t  ')).toEqual([])
    expect(splitSqlStatements('-- only a comment')).toEqual([])
    expect(splitSqlStatements('# another comment\n')).toEqual([])
    expect(splitSqlStatements('/* block comment only */')).toEqual([])
  })

  it('splits multiple statements and drops empty chunks', () => {
    expect(splitSqlStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(splitSqlStatements('SELECT 1;\n\n;\nSELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
    expect(splitSqlStatements('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2'])
  })

  it('does not split on semicolons inside quoted strings or identifiers', () => {
    const statements = splitSqlStatements(
      "INSERT INTO t VALUES ('a;b', 'it''s; fine', \"x;y\"); SELECT `weird;column` FROM t;"
    )
    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain("'a;b'")
    expect(statements[0]).toContain("'it''s; fine'")
    expect(statements[1]).toContain('`weird;column`')
  })

  it('handles backslash escapes inside strings', () => {
    const statements = splitSqlStatements("INSERT INTO t VALUES ('it\\'s; ok'); SELECT 1;")
    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain("it\\'s; ok")
  })

  it('keeps semicolons inside comments out of the split', () => {
    expect(splitSqlStatements('SELECT 1; -- ; still comment\nSELECT 2;')).toHaveLength(2)
    expect(splitSqlStatements('SELECT 1 /* ; not a delimiter */; SELECT 2;')).toHaveLength(2)
  })

  it('supports client DELIMITER directives for trigger/procedure bodies', () => {
    const script = [
      'DELIMITER $$',
      'CREATE TRIGGER trg AFTER INSERT ON t FOR EACH ROW BEGIN',
      '  INSERT INTO log VALUES (NEW.id);',
      'END$$',
      'DELIMITER ;',
      'SELECT 1;'
    ].join('\n')
    const statements = splitSqlStatements(script)
    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain('CREATE TRIGGER')
    expect(statements[0]).toContain('INSERT INTO log')
    expect(statements[1]).toBe('SELECT 1')
  })

  it('treats "--" without following whitespace as operator, not a comment', () => {
    expect(splitSqlStatements('SELECT 1--2; SELECT 3;')).toHaveLength(2)
  })

  it('exposes the same splitter through the classifier contract', () => {
    expect(classifier.splitStatements('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2'])
  })
})

describe('classifier - empty and read-only statements', () => {
  it('classifies empty SQL as no-op read-only', () => {
    const analysis = classifier.classify('   ')
    expect(analysis.statements).toEqual([])
    expect(analysis.readOnly).toBe(true)
    expect(analysis.overallRisk).toBe('none')
    expect(analysis.requiresApproval).toBe(false)
    expect(analysis.requiresBackup).toBe(false)
  })

  it('classifies SELECT as read-only / no risk', () => {
    const analysis = classifier.classify('SELECT id, email FROM users WHERE id = 1 LIMIT 10')
    expect(analysis.readOnly).toBe(true)
    expect(analysis.statements).toHaveLength(1)
    const stmt = analysis.statements[0]
    expect(stmt.kind).toBe('select')
    expect(stmt.category).toBe('read')
    expect(stmt.risk).toBe('none')
    expect(stmt.requiresApproval).toBe(false)
    expect(stmt.requiresBackup).toBe(false)
    expect(stmt.recoveryStrategy).toBe('none')
    expect(stmt.targetTables).toContain('users')
    expect(stmt.parser).toBe('ast')
    expect(stmt.whereSql).toBeTruthy()
  })

  it('marks locking reads as low risk but still read-only', () => {
    const analysis = classifier.classify('SELECT * FROM orders WHERE user_id = 1 FOR UPDATE')
    expect(analysis.statements[0].risk).toBe('low')
    expect(analysis.readOnly).toBe(true)
  })

  it('flags SELECT ... INTO OUTFILE as unsafe and requires approval', () => {
    const analysis = classifier.classify("SELECT * FROM users INTO OUTFILE '/tmp/users.csv'")
    const stmt = analysis.statements[0]
    expect(stmt.risk).toBe('high')
    expect(stmt.recoveryStrategy).toBe('refuse_unsafe')
    expect(stmt.requiresApproval).toBe(true)
  })
})

describe('classifier - DML', () => {
  it('classifies UPDATE with WHERE as medium risk with before-image recovery', () => {
    const analysis = classifier.classify("UPDATE users SET name = 'x' WHERE id = 5")
    const stmt = analysis.statements[0]
    expect(stmt.kind).toBe('update')
    expect(stmt.category).toBe('dml')
    expect(stmt.risk).toBe('medium')
    expect(stmt.requiresApproval).toBe(true)
    expect(stmt.requiresBackup).toBe(false)
    expect(stmt.recoveryStrategy).toBe('before_image')
    expect(stmt.targetTable).toBe('users')
    expect(stmt.whereSql).toBeTruthy()
    expect(stmt.hasWhereClause).toBe(true)
    expect(stmt.unbounded).toBe(false)
    expect(stmt.columnList).toContain('name')
    expect(analysis.readOnly).toBe(false)
  })

  it('classifies UPDATE without WHERE as critical and requires a verified full backup', () => {
    const analysis = classifier.classify('UPDATE users SET status = 1')
    const stmt = analysis.statements[0]
    expect(stmt.risk).toBe('critical')
    expect(stmt.requiresBackup).toBe(true)
    expect(stmt.recoveryStrategy).toBe('full_backup')
    expect(stmt.hasWhereClause).toBe(false)
    expect(stmt.unbounded).toBe(true)
    expect(analysis.requiresApproval).toBe(true)
    expect(analysis.requiresBackup).toBe(true)
  })

  it('classifies DELETE without WHERE as critical / destructive scope', () => {
    const analysis = classifier.classify('DELETE FROM orders')
    expect(analysis.statements[0].kind).toBe('delete')
    expect(analysis.statements[0].risk).toBe('critical')
    expect(analysis.statements[0].requiresBackup).toBe(true)
    expect(analysis.statements[0].unbounded).toBe(true)
    expect(analysis.overallRisk).toBe('critical')
  })

  it('classifies DELETE with WHERE as medium with before-image', () => {
    const analysis = classifier.classify('DELETE FROM orders WHERE status = 1')
    const stmt = analysis.statements[0]
    expect(stmt.risk).toBe('medium')
    expect(stmt.recoveryStrategy).toBe('before_image')
    expect(stmt.whereSql).toBeTruthy()
  })

  it('extracts literal primary-key values from a single-row INSERT', () => {
    const analysis = classifier.classify("INSERT INTO users (id, email) VALUES (7, 'a@b.test')")
    const stmt = analysis.statements[0]
    expect(stmt.kind).toBe('insert')
    expect(stmt.category).toBe('dml')
    expect(stmt.risk).toBe('medium')
    expect(stmt.requiresApproval).toBe(true)
    expect(stmt.columnList).toEqual(['id', 'email'])
    expect(stmt.pkValues).toEqual({ id: 7, email: 'a@b.test' })
    expect(stmt.valueTuples).toBe(1)
    expect(stmt.targetTable).toBe('users')
  })

  it('cannot statically resolve INSERT ... SELECT => high risk + full backup', () => {
    const analysis = classifier.classify('INSERT INTO archive (id) SELECT id FROM users')
    const stmt = analysis.statements[0]
    expect(stmt.risk).toBe('high')
    expect(stmt.requiresBackup).toBe(true)
    expect(stmt.recoveryStrategy).toBe('full_backup')
  })

  it('flags REPLACE as potentially destructive', () => {
    const analysis = classifier.classify("REPLACE INTO users (id, email) VALUES (1, 'r@b.test')")
    expect(analysis.statements[0].kind).toBe('replace')
    expect(analysis.statements[0].risk).toBe('medium')
    expect(analysis.statements[0].requiresApproval).toBe(true)
  })

  it('requires approval for ON DUPLICATE KEY UPDATE', () => {
    const analysis = classifier.classify(
      "INSERT INTO users (id, email) VALUES (1, 'd@b.test') ON DUPLICATE KEY UPDATE email = 'd@b.test'"
    )
    expect(analysis.statements[0].risk).toBe('high')
  })
})

describe('classifier - DDL', () => {
  it('classifies DROP TABLE as critical, destructive and implicit-commit', () => {
    const analysis = classifier.classify('DROP TABLE users')
    const stmt = analysis.statements[0]
    expect(stmt.kind).toBe('drop')
    expect(stmt.category).toBe('destructive')
    expect(stmt.risk).toBe('critical')
    expect(stmt.requiresApproval).toBe(true)
    expect(stmt.requiresBackup).toBe(true)
    expect(stmt.recoveryStrategy).toBe('full_backup')
    expect(stmt.implicitCommit).toBe(true)
    expect(stmt.targetTable).toBe('users')
  })

  it('classifies TRUNCATE as critical', () => {
    const analysis = classifier.classify('TRUNCATE TABLE orders')
    const stmt = analysis.statements[0]
    expect(stmt.kind).toBe('truncate')
    expect(stmt.risk).toBe('critical')
    expect(stmt.requiresBackup).toBe(true)
    expect(stmt.implicitCommit).toBe(true)
  })

  it('classifies CREATE TABLE as medium DDL with schema snapshot', () => {
    const analysis = classifier.classify('CREATE TABLE t2 (id INT PRIMARY KEY)')
    const stmt = analysis.statements[0]
    expect(stmt.kind).toBe('create')
    expect(stmt.category).toBe('ddl')
    expect(stmt.risk).toBe('medium')
    expect(stmt.requiresApproval).toBe(true)
    expect(stmt.requiresBackup).toBe(false)
    expect(stmt.recoveryStrategy).toBe('schema_snapshot')
    expect(stmt.implicitCommit).toBe(true)
  })

  it('treats CREATE TRIGGER as high risk requiring a full backup', () => {
    const analysis = classifier.classify(
      'CREATE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW SET @x = 1'
    )
    const stmt = analysis.statements[0]
    expect(stmt.risk).toBe('high')
    expect(stmt.requiresBackup).toBe(true)
    expect(stmt.recoveryStrategy).toBe('full_backup')
  })

  it('classifies ALTER TABLE as high risk', () => {
    const analysis = classifier.classify('ALTER TABLE users ADD COLUMN nick VARCHAR(20)')
    const stmt = analysis.statements[0]
    expect(stmt.kind).toBe('alter')
    expect(stmt.risk).toBe('high')
    expect(stmt.requiresApproval).toBe(true)
    expect(stmt.implicitCommit).toBe(true)
  })

  it('requires a backup for destructive ALTER ... DROP COLUMN', () => {
    const analysis = classifier.classify('ALTER TABLE users DROP COLUMN nick')
    const stmt = analysis.statements[0]
    expect(stmt.requiresBackup).toBe(true)
    expect(stmt.recoveryStrategy).toBe('full_backup')
  })
})

describe('classifier - complex / unknown / fallback', () => {
  it('treats CALL and GRANT as high risk requiring approval + backup', () => {
    for (const sql of ['CALL do_something(1)', "GRANT SELECT ON db.* TO 'u'@'%'"]) {
      const analysis = classifier.classify(sql)
      const stmt = analysis.statements[0]
      expect(stmt.requiresApproval).toBe(true)
      expect(stmt.requiresBackup).toBe(true)
      expect(stmt.risk).toBe('high')
    }
  })

  it('treats SET PASSWORD as unsafe', () => {
    const analysis = classifier.classify("SET PASSWORD = 'secret'")
    expect(analysis.statements[0].recoveryStrategy).toBe('refuse_unsafe')
    expect(analysis.statements[0].requiresApproval).toBe(true)
  })

  it('fails strict when the AST parser cannot parse the SQL', () => {
    const analysis = classifier.classify('NOT REALLY SQL AT ALL')
    const stmt = analysis.statements[0]
    expect(stmt.parser).toBe('fallback')
    expect(stmt.parseError).toBeTruthy()
    expect(stmt.requiresApproval).toBe(true)
    expect(stmt.requiresBackup).toBe(true)
    expect(stmt.recoveryStrategy).toBe('full_backup')
    expect(analysis.analyzer).toBe('fallback')
  })

  it('keeps fallback classification for an invalid UPDATE (never downgrades)', () => {
    const analysis = classifier.classify('UPDATE users SET')
    const stmt = analysis.statements[0]
    expect(stmt.parser).toBe('fallback')
    expect(stmt.requiresBackup).toBe(true)
  })

  it('aggregates risk across statements and marks mixed analyzers', () => {
    const analysis = classifier.classify('SELECT 1; DROP TABLE users;')
    expect(analysis.statements).toHaveLength(2)
    expect(analysis.overallRisk).toBe('critical')
    expect(analysis.readOnly).toBe(false)
    expect(analysis.requiresApproval).toBe(true)
    expect(analysis.requiresBackup).toBe(true)
    expect(analysis.summary.length).toBeGreaterThan(0)
  })

  it('refuses to classify a multi-statement string as one statement', () => {
    const stmt = classifier.classifyStatement('SELECT 1; DROP TABLE users', 0)
    expect(stmt.parser).toBe('fallback')
    expect(stmt.requiresBackup).toBe(true)
  })

  it('throws AppError for an empty statement', () => {
    expect(() => classifier.classifyStatement('   ', 0)).toThrowError(/空 SQL/)
  })
})
