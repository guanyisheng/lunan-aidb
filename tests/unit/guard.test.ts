/**
 * Guards around before-image capture: WHERE predicate re-validation and
 * primary-key matching. These are the last line of defence before an
 * AST-reserialised predicate is concatenated into a capture SELECT.
 */
import { describe, expect, it } from 'vitest'
import { AppError } from '@main/util/errors'
import {
  MAX_CAPTURE_ROWS,
  assertCaptureCap,
  buildPkMatch,
  validateWherePredicate
} from '@main/timemachine/guard'

describe('validateWherePredicate', () => {
  it('accepts simple predicates on the target table', () => {
    expect(validateWherePredicate('id = 5', 'users')).toEqual({ ok: true, normalized: 'id = 5' })
    expect(validateWherePredicate("status = 'active' AND balance > 10", 'users').ok).toBe(true)
    expect(validateWherePredicate('`users`.`id` IN (1, 2, 3)', 'users').ok).toBe(true)
  })

  it('rejects empty, oversized and dangerous predicates', () => {
    expect(validateWherePredicate('', 'users').ok).toBe(false)
    expect(validateWherePredicate('   ', 'users').ok).toBe(false)
    expect(validateWherePredicate('id = 1; DROP TABLE users', 'users').ok).toBe(false)
    expect(validateWherePredicate('id = 1 -- comment', 'users').ok).toBe(false)
    expect(validateWherePredicate('id = 1 UNION SELECT * FROM mysql.user', 'users').ok).toBe(false)
    expect(validateWherePredicate('id = 1 INTO OUTFILE "/tmp/x"', 'users').ok).toBe(false)
    expect(validateWherePredicate(`id = ${'1'.repeat(9000)}`, 'users').ok).toBe(false)
  })

  it('rejects sub-queries and references to other tables', () => {
    expect(validateWherePredicate('id IN (SELECT user_id FROM orders)', 'users').ok).toBe(false)
    expect(validateWherePredicate('orders.user_id = 1', 'users').ok).toBe(false)
  })

  it('rejects dangerous functions inside the predicate', () => {
    for (const fn of ['SLEEP(5)', 'BENCHMARK(1000, MD5(1))', 'LOAD_FILE("/etc/passwd")']) {
      const result = validateWherePredicate(`id = 1 AND ${fn}`, 'users')
      expect(result.ok).toBe(false)
      expect(result.ok ? '' : result.reason).toMatch(/函数|不允许|无法/)
    }
  })

  it('rejects predicates that cannot be re-parsed', () => {
    expect(validateWherePredicate('id ==== 5', 'users').ok).toBe(false)
  })
})

describe('assertCaptureCap', () => {
  it('allows capture up to the cap and refuses beyond it', () => {
    expect(() => assertCaptureCap(new Array(MAX_CAPTURE_ROWS).fill({ id: 1 }))).not.toThrow()
    expect(() => assertCaptureCap(new Array(MAX_CAPTURE_ROWS + 1).fill({ id: 1 }))).toThrow(AppError)
    try {
      assertCaptureCap(new Array(5).fill({}), 4)
    } catch (error) {
      expect((error as AppError).code).toBe('PROTECTION_FAILED')
    }
  })
})

describe('buildPkMatch', () => {
  it('builds OR-combined primary-key matches with bound parameters', () => {
    const { sql, params } = buildPkMatch(
      ['id'],
      [{ id: 1 }, { id: 2 }]
    )
    expect(sql).toBe('(`id` = ?) OR (`id` = ?)')
    expect(params).toEqual([1, 2])
  })

  it('supports composite primary keys and null values', () => {
    const { sql, params } = buildPkMatch(
      ['a', 'b'],
      [
        { a: 1, b: 2 },
        { a: 3, b: null }
      ]
    )
    expect(sql).toBe('(`a` = ? AND `b` = ?) OR (`a` = ? AND `b` = ?)')
    expect(params).toEqual([1, 2, 3, null])
  })

  it('returns an empty fragment when there are no rows', () => {
    expect(buildPkMatch(['id'], [])).toEqual({ sql: '', params: [] })
  })
})
