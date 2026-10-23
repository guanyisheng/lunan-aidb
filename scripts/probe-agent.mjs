#!/usr/bin/env node
/**
 * Launch Electron against the real userData, run one Agent task, print the answer.
 * Usage: node scripts/probe-agent.mjs
 */
import { _electron as electron } from 'playwright-core'
import { existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = join(root, 'out', 'main', 'index.js')
const userDataDir =
  process.env.AIDB_USER_DATA_DIR ||
  join(homedir(), 'Library/Application Support/aidb-studio')

if (!existsSync(entry)) {
  console.error(`[probe] missing ${entry}; run npm run build first`)
  process.exit(2)
}

const MESSAGE =
  process.argv.slice(2).join(' ').trim() ||
  '请用工具查看当前库有哪些表，挑 1～2 个业务表用只读 SQL 各查几行样例，用中文总结表名和大致用途。'

console.log(`[probe] userData=${userDataDir}`)
console.log(`[probe] message=${MESSAGE}`)

const electronBin = join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron')
const app = await electron.launch({
  executablePath: electronBin,
  // Same entry style as `electron-vite` / `electron .` so Keychain identity matches.
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    AIDB_USER_DATA_DIR: userDataDir,
    ELECTRON_RENDERER_URL: undefined,
    NODE_ENV: 'production'
  },
  timeout: 90_000
})

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

try {
  const win = await app.firstWindow({ timeout: 90_000 })
  await win.waitForSelector('.app-shell', { timeout: 60_000 })

  const ctx = await win.evaluate(async () => {
    const projects = await window.aidb.invoke('project.list', undefined)
    const conns = await window.aidb.invoke('conn.list', undefined)
    const models = await window.aidb.invoke('model.list', undefined)
    return { projects, conns, models }
  })

  if (!ctx.projects?.ok || !ctx.conns?.ok) {
    console.error('[probe] failed to list projects/connections', JSON.stringify(ctx, null, 2))
    process.exit(1)
  }

  const project = ctx.projects.data?.[0]
  const connection = ctx.conns.data?.[0]
  const model = ctx.models?.data?.find((m) => m.isDefault) ?? ctx.models?.data?.[0]
  console.log('[probe] project=', project?.id, project?.name)
  console.log(
    '[probe] connection=',
    connection?.id,
    connection?.name,
    connection?.host,
    connection?.database ?? connection?.databaseName
  )
  console.log('[probe] model=', model?.id, model?.name, model?.model)

  if (!project?.id || !connection?.id) {
    console.error('[probe] missing project or connection')
    process.exit(1)
  }

  // Ensure connected
  const connect = await win.evaluate(async (id) => window.aidb.invoke('conn.connect', { id }), connection.id)
  console.log('[probe] connect=', connect.ok ? 'ok' : JSON.stringify(connect.error))

  const databases = await win.evaluate(
    async (connectionId) => window.aidb.invoke('schema.listDatabases', { connectionId }),
    connection.id
  )
  const dbName =
    connection.database ||
    databases.data?.find((d) => !d.isSystem)?.name ||
    databases.data?.[0]?.name ||
    ''
  console.log('[probe] database=', dbName)

  const started = await win.evaluate(
    async (payload) => window.aidb.invoke('agent.run', payload),
    {
      projectId: project.id,
      connectionId: connection.id,
      database: dbName,
      message: MESSAGE,
      modelProfileId: model?.id,
      maxSteps: 10
    }
  )

  if (!started.ok) {
    console.error('[probe] agent.run failed', JSON.stringify(started.error, null, 2))
    process.exit(1)
  }

  const taskId = started.data?.task?.id ?? started.data?.id
  console.log('[probe] task started', taskId)

  let lastStatus = ''
  let final = null
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const got = await win.evaluate(async (id) => window.aidb.invoke('agent.task.get', { taskId: id }), taskId)
    const task = got.data
    if (!task) {
      await sleep(1000)
      continue
    }
    if (task.status !== lastStatus) {
      lastStatus = task.status
      console.log(`[probe] status=${task.status} steps=${task.stepCount} tools=${task.toolCallCount}`)
    }
    const terminal = ['completed', 'failed', 'cancelled', 'max_steps_reached', 'timed_out']
    if (terminal.includes(task.status)) {
      final = task
      break
    }
    await sleep(1500)
  }

  if (!final) {
    console.error('[probe] timed out waiting for task')
    process.exit(1)
  }

  console.log('\n========== AGENT RESULT ==========')
  console.log('status:', final.status)
  console.log('steps:', final.stepCount, 'tools:', final.toolCallCount)
  if (final.error) console.log('error:', final.error)
  console.log('answer:\n' + (final.finalAnswer || '(empty)'))
  console.log('==================================\n')

  if (final.steps?.length) {
    console.log('--- last steps ---')
    for (const step of final.steps.slice(-6)) {
      console.log(
        `#${step.index} ${step.phase} ${step.toolName || ''} [${step.status}] ${
          step.toolResultSummary || step.text || ''
        }`.slice(0, 240)
      )
    }
  }

  process.exit(final.status === 'completed' || final.status === 'max_steps_reached' ? 0 : 1)
} catch (error) {
  console.error('[probe] fatal', error)
  process.exit(1)
} finally {
  await app.close().catch(() => undefined)
}
