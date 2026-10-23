/**
 * Dump SQL reader (streaming splitter) and SQL value formatting.
 * A half-split statement or a mis-escaped literal would corrupt restores.
 */
import { describe, expect, it } from 'vitest'
import { SqlStatementSplitter, splitSqlText } from '@main/timemachine/sqlfile'
import {
  buildInsert,
  buildPkWhere,
  columnList,
  escapeValue,
  ident,
  pkValuesOf,
  previewRow,
  qualified
} from '@main/timemachine/sqlformat'

describe('splitSqlText / SqlStatementSplitter', () => {
  it('splits statements and drops comments', () => {
    const result = splitSqlText('-- header\nSET NAMES utf8mb4;\n/* block */\nSELECT 1;\n')
    expect(result.statements).toEqual(['SET NAMES utf8mb4', 'SELECT 1'])
    expect(result.remainder).toBe('')
  })

  it('reports a truncated trailing statement as remainder (never silently dropped)', () => {
    const result = splitSqlText('SELECT 1;\nINSERT INTO t VALUES (1,')
    expect(result.statements).toEqual(['SELECT 1'])
    expect(result.remainder).toBe('INSERT INTO t VALUES (1,')
  })

  it('handles semicolons in strings, comments and identifiers', () => {
    const result = splitSqlText(
      "INSERT INTO t VALUES ('a;b', 'it''s');\nSELECT `col;name` FROM t; -- tail; comment\n"
    )
    expect(result.statements).toHaveLength(2)
    expect(result.statements[0]).toContain("'a;b'")
    expect(result.statements[1]).toContain('`col;name`')
    expect(result.remainder).toBe('')
  })

  it('honours DELIMITER for stored-program bodies', () => {
    const result = splitSqlText(
      [
        'DELIMITER ;;',
        'CREATE PROCEDURE p() BEGIN',
        '  INSERT INTO t VALUES (1);',
        '  INSERT INTO t VALUES (2);',
        'END;;',
        'DELIMITER ;',
        'SELECT 1;',
        ''
      ].join('\n')
    )
    expect(result.statements).toHaveLength(2)
    expect(result.statements[0]).toContain('CREATE PROCEDURE')
    expect(result.statements[0]).toContain('INSERT INTO t VALUES (2)')
    expect(result.statements[1]).toBe('SELECT 1')
  })

  it('keeps /*! ... */ executable comments in the emitted statement', () => {
    const result = splitSqlText('/*!40101 SET NAMES utf8mb4 */;\nSELECT 1;')
    expect(result.statements).toHaveLength(2)
    expect(result.statements[0]).toContain('/*!40101 SET NAMES utf8mb4 */')
  })

  it('handles chunk boundaries inside strings and comments', () => {
    const script = "INSERT INTO t VALUES ('chunk;value');\n/* comment ; */\nSELECT 'x;y';"
    const splitter = new SqlStatementSplitter()
    const collected: string[] = []
    for (let i = 0; i < script.length; i += 10) {
      collected.push(...splitter.feed(script.slice(i, i + 10)))
    }
    const tail = splitter.end()
    expect(collected).toHaveLength(2)
    expect(collected[0]).toContain("'chunk;value'")
    expect(collected[1]).toContain("'x;y'")
    expect(tail.remainder).toBe('')
  })

  it('handles a one-character-at-a-time stream (lookahead carry-over)', () => {
    const script = 'SELECT 1;\n/* comment ; */\nSELECT 2;'
    const splitter = new SqlStatementSplitter()
    const collected: string[] = []
    for (const char of script) collected.push(...splitter.feed(char))
    splitter.end()
    expect(collected).toHaveLength(2)
    expect(collected.join(' ')).not.toContain('comment')
  })

  it('returns nothing for comment-only scripts', () => {
    const result = splitSqlText('-- a\n# b\n/* c */\n')
    expect(result.statements).toEqual([])
    expect(result.remainder).toBe('')
  })
})

describe('sqlformat escaping', () => {
  it('escapes identifiers and qualified names', () => {
    expect(ident('weird`name')).toBe('`weird``name`')
    expect(qualified('db', 't')).toBe('`db`.`t`')
    expect(columnList(['a', 'b`c'])).toBe('`a`, `b``c`')
  })

  it('escapes literal values safely', () => {
    expect(escapeValue(null)).toBe('NULL')
    expect(escapeValue(undefined)).toBe('NULL')
    expect(escapeValue(42)).toBe('42')
    expect(escapeValue(Number.NaN)).toBe('NULL')
    expect(escapeValue(Number.POSITIVE_INFINITY)).toBe('NULL')
    expect(escapeValue(10n)).toBe('10')
    expect(escapeValue(true)).toBe('1')
    expect(escapeValue(false)).toBe('0')
    expect(escapeValue("O'Reilly")).toBe("'O\\'Reilly'")
    expect(escapeValue('back\\slash')).toBe("'back\\\\slash'")
    expect(escapeValue('数据')).toBe("'数据'")
  })

  it('builds multi-row INSERT statements with a hard row cap', () => {
    const rows = [
      { id: 1, name: "a'b" },
      { id: 2, name: 'c' },
      { id: 3, name: 'd' }
    ]
    // `tableRef` is already escaped (restore runs inside the target database).
    const all = buildInsert(qualified('db', 't'), ['id', 'name'], rows, 0, 10)
    expect(all.rowCount).toBe(3)
    expect(all.sql).toContain('`db`.`t`')
    expect(all.sql).toContain("(1, 'a\\'b')")
    const chunk = buildInsert(qualified('db', 't'), ['id'], rows, 1, 1)
    expect(chunk.rowCount).toBe(1)
    expect(chunk.sql).toContain('(2)')
    expect(buildInsert(qualified('db', 't'), ['id'], rows, 5, 10)).toEqual({ sql: '', rowCount: 0 })
  })

  it('builds parameterised primary-key predicates', () => {
    expect(buildPkWhere(['id'])).toEqual({ where: '`id` = ?', values: [] })
    expect(buildPkWhere(['a', 'b']).where).toBe('`a` = ? AND `b` = ?')
    expect(pkValuesOf({ id: 5, other: 'x' }, ['id'])).toEqual([5])
  })

  it('renders compact row previews with primary keys first', () => {
    const preview = previewRow({ id: 1, name: "O'Reilly", amount: null }, ['id'], 2)
    expect(preview).toBe("{ id=1, name='O\\'Reilly' }")
  })
})
