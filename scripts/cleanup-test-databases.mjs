#!/usr/bin/env node
/**
 * AIDB Studio - clean up *test databases* left on the portable MariaDB instance.
 *
 * Only databases whose name starts with one of the known test prefixes below are
 * ever removed; the system schemas (mysql/sys/information_schema/...) and any
 * database without a test prefix are always left untouched. The script refuses
 * to run against anything other than the local 127.0.0.1 test instance.
 *
 * Usage:
 *   node scripts/cleanup-test-databases.mjs            # dry-run (prints only)
 *   node scripts/cleanup-test-databases.mjs --apply    # actually drop them
 */

import { exec, getInfo } from './mariadb.mjs'

const TEST_PREFIXES = ['tm_it_', 'aidb_verify_', 'aidb_restore_', 'qa_']
const EXACT_TEST_NAMES = ['aidb_api_probe']

const apply = process.argv.includes('--apply')

function isTestDatabase(name) {
  if (EXACT_TEST_NAMES.includes(name)) return true
  return TEST_PREFIXES.some((prefix) => name.startsWith(prefix) && /^[A-Za-z0-9_]+$/.test(name))
}

function quoteId(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Refusing to quote unsafe identifier: ${name}`)
  return `\`${name}\``
}

async function main() {
  const info = await getInfo()
  if (!info.running || info.host !== '127.0.0.1') {
    throw new Error('The portable test instance is not running on 127.0.0.1; refusing to touch anything.')
  }

  const result = await exec(
    "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME"
  )
  // `exec` returns the rows for a single statement and an array of result sets
  // for multi-statement SQL; accept both shapes.
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result
  const names = (Array.isArray(rows) ? rows : []).map((row) => row.name)
  const targets = names.filter(isTestDatabase)

  if (targets.length === 0) {
    console.log('No leftover test databases found.')
    return 0
  }
  console.log(`${apply ? 'Dropping' : 'Would drop'} ${targets.length} test database(s):`)
  for (const name of targets) console.log(`  - ${name}`)

  if (!apply) {
    console.log('\nDry-run only. Re-run with --apply to drop them.')
    return 0
  }
  for (const name of targets) {
    await exec(`DROP DATABASE IF EXISTS ${quoteId(name)}`)
    console.log(`dropped ${name}`)
  }
  console.log('done.')
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    console.error(`[cleanup] ERROR: ${error?.message || error}`)
    process.exitCode = 1
  })
