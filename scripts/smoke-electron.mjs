#!/usr/bin/env node
/**
 * End-to-end smoke test: launches the packaged main process in Electron,
 * verifies the trusted bridge is reachable, exercises a few read-only IPC
 * methods and captures screenshots. Fails loudly on any real problem.
 *
 * Usage: node scripts/smoke-electron.mjs [--keep-open]
 */
import { _electron as electron } from 'playwright-core'
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, '.testdata', 'smoke')
const userDataDir = join(root, '.testdata', 'smoke-userdata')
mkdirSync(outDir, { recursive: true })
mkdirSync(userDataDir, { recursive: true })

const entry = join(root, 'out', 'main', 'index.js')
if (!existsSync(entry)) {
  console.error(`[smoke] missing build output: ${entry}. Run "npm run build" first.`)
  process.exit(2)
}

const keepOpen = process.argv.includes('--keep-open')
const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

const app = await electron.launch({
  args: [entry],
  cwd: root,
  env: { ...process.env, AIDB_USER_DATA_DIR: userDataDir, NODE_ENV: 'test' },
  timeout: 60_000
})

try {
  const win = await app.firstWindow({ timeout: 60_000 })
  await win.waitForSelector('.app-shell', { timeout: 30_000 })

  const title = await win.title()
  check('window loaded', title.includes('AIDB') || title.length > 0, `title="${title}"`)

  const bridge = await win.evaluate(() => ({
    version: window.aidb?.version ?? null,
    methods: typeof window.aidb?.invoke === 'function'
  }))
  check('preload bridge exposed', bridge.version !== null && bridge.methods, JSON.stringify(bridge))

  const info = await win.evaluate(() => window.aidb.invoke('app.info', undefined))
  check('app.info returns ok', info.ok === true && !!info.data?.version, info.ok ? `v${info.data.version} electron ${info.data.electron}` : JSON.stringify(info.error))

  const health = await win.evaluate(() => window.aidb.invoke('app.health', undefined))
  check('app.health (local SQLite)', health.ok === true && health.data?.appDb?.ok === true, health.ok ? `db=${health.data.appDb.path}` : JSON.stringify(health.error))

  const settings = await win.evaluate(() => window.aidb.invoke('app.settings.get', undefined))
  check('app.settings.get', settings.ok === true && typeof settings.data?.autoProtection === 'boolean')

  const projects = await win.evaluate(() => window.aidb.invoke('project.list', undefined))
  check('project.list', projects.ok === true && Array.isArray(projects.data))

  const badMethod = await win.evaluate(() => window.aidb.invoke('shell.exec', undefined))
  check('unknown IPC method rejected', badMethod.ok === false && badMethod.error?.code === 'PERMISSION_DENIED', JSON.stringify(badMethod.error?.code))

  const badPayload = await win.evaluate(() => window.aidb.invoke('project.create', { name: '' }))
  check('invalid payload rejected', badPayload.ok === false && badPayload.error?.code === 'VALIDATION', JSON.stringify(badPayload.error?.code))

  // Persistence across restart is verified by the store/integration tests; here
  // we verify that creating a project really hits the local database.
  const created = await win.evaluate(() =>
    window.aidb.invoke('project.create', { name: '冒烟测试项目', description: 'smoke' })
  )
  check('project.create persists', created.ok === true && !!created.data?.id, created.ok ? created.data.id : JSON.stringify(created.error))
  const reopened = await win.evaluate((id) => window.aidb.invoke('project.open', { id }), created.data?.id)
  check('project.open round-trip', reopened.ok === true && reopened.data?.project?.name === '冒烟测试项目')

  await win.screenshot({ path: join(outDir, 'home.png'), fullPage: false })

  // Navigate every page through the sidebar and screenshot it. Failures surface
  // renderer crashes which the IPC checks alone would miss.
  const navs = ['数据库工作区', 'AI Agent', '操作历史', '时间机器', '记忆中心', '模型设置', '安全设置']
  for (const label of navs) {
    await win.getByRole('button', { name: label, exact: false }).first().click({ timeout: 10_000 })
    await win.waitForTimeout(400)
    const file = join(outDir, `page-${label.replace(/[^\w\u4e00-\u9fa5]+/g, '-')}.png`)
    await win.screenshot({ path: file })
    const crashed = await win.evaluate(() => document.querySelector('.app-shell') === null)
    check(`page renders: ${label}`, !crashed)
  }

  if (keepOpen) {
    console.log('[smoke] leaving app open, press Ctrl+C to exit')
    await new Promise(() => {})
  }
} catch (e) {
  check('smoke run completed without exception', false, e instanceof Error ? e.message : String(e))
} finally {
  try {
    await app.close()
  } catch {
    /* app may already be gone */
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n[smoke] ${results.length - failed.length}/${results.length} checks passed; screenshots: ${outDir}`)
process.exit(failed.length === 0 ? 0 : 1)
