import { z } from 'zod'
import { defineHandler } from '../registry'
import {
  idSchema,
  limitSchema,
  memoryInputSchema,
  memoryStatusSchema,
  memoryTrustSchema,
  memoryTypeSchema,
  modelDiscoverSchema,
  modelProfileInputSchema,
  offsetSchema
} from '../schemas'
import { AppError } from '@main/util/errors'

const voidSchema = z.void()

export function registerAiHandlers(): void {
  /* ----------------------------------------------------------- memory */
  defineHandler(
    'memory.list',
    z.object({
      projectId: idSchema,
      types: z.array(memoryTypeSchema).max(6).optional(),
      status: memoryStatusSchema.optional(),
      trust: z.array(memoryTrustSchema).max(4).optional(),
      limit: limitSchema,
      offset: offsetSchema
    }),
    async (ctx, payload) =>
      ctx.services.memory.list({
        projectId: payload.projectId,
        types: payload.types,
        status: payload.status,
        trust: payload.trust,
        limit: payload.limit ?? 100,
        offset: payload.offset ?? 0
      })
  )

  defineHandler(
    'memory.search',
    z.object({
      projectId: idSchema,
      query: z.string().max(5000),
      types: z.array(memoryTypeSchema).max(6).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      includeStale: z.boolean().optional()
    }),
    async (ctx, payload) => ctx.services.memory.search(payload)
  )

  defineHandler('memory.get', z.object({ id: idSchema }), async (ctx, payload) => ctx.services.memory.get(payload.id))

  defineHandler('memory.create', memoryInputSchema, async (ctx, payload) => {
    // Manual creation is an explicit user action: trust is user-confirmed unless
    // the caller explicitly stores an inference (kept as ai_inferred).
    const record = await ctx.services.memory.create({
      ...payload,
      source: payload.source ?? 'user',
      trust: payload.trust ?? 'user_confirmed'
    })
    ctx.services.audit.record({
      actor: 'user',
      action: 'memory.create',
      projectId: record.projectId,
      outcome: 'info',
      detail: `新增记忆「${record.title}」（${record.type}/${record.trust}）`,
      metadata: { memoryId: record.id }
    })
    return record
  })

  defineHandler(
    'memory.update',
    z.object({
      id: idSchema,
      patch: memoryInputSchema.partial().extend({ status: memoryStatusSchema.optional() })
    }),
    async (ctx, payload) => {
      const updated = ctx.services.memory.update(payload.id, payload.patch)
      ctx.services.audit.record({
        actor: 'user',
        action: 'memory.update',
        projectId: updated.projectId,
        outcome: 'info',
        detail: `编辑记忆「${updated.title}」`,
        metadata: { memoryId: updated.id, keys: Object.keys(payload.patch) }
      })
      return updated
    }
  )

  defineHandler('memory.delete', z.object({ id: idSchema }), async (ctx, payload) => {
    const existing = ctx.services.memory.get(payload.id)
    ctx.services.memory.remove(payload.id)
    ctx.services.audit.record({
      actor: 'user',
      action: 'memory.delete',
      projectId: existing?.projectId ?? null,
      outcome: 'info',
      detail: `删除记忆「${existing?.title ?? payload.id}」`
    })
  })

  defineHandler('memory.confirm', z.object({ id: idSchema, content: z.string().max(20_000).optional() }), async (ctx, payload) => {
    const record = ctx.services.memory.confirm(payload.id, payload.content)
    ctx.services.audit.record({
      actor: 'user',
      action: 'memory.confirm',
      projectId: record.projectId,
      outcome: 'info',
      detail: `用户确认记忆「${record.title}」`,
      metadata: { memoryId: record.id }
    })
    return record
  })

  defineHandler('memory.invalidate', z.object({ id: idSchema, reason: z.string().min(1).max(1000) }), async (ctx, payload) => {
    const record = ctx.services.memory.invalidate(payload.id, payload.reason)
    ctx.services.audit.record({
      actor: 'user',
      action: 'memory.invalidate',
      projectId: record.projectId,
      outcome: 'info',
      detail: `标记记忆失效：${payload.reason}`,
      metadata: { memoryId: record.id }
    })
    return record
  })

  defineHandler('memory.stats', z.object({ projectId: idSchema }), async (ctx, payload) =>
    ctx.services.memory.stats(payload.projectId)
  )

  /* ----------------------------------------------------------- models */
  defineHandler('model.list', voidSchema, async (ctx) => ctx.services.models.list())

  defineHandler('model.save', modelProfileInputSchema, async (ctx, payload) => {
    const profile = ctx.services.models.save(payload)
    ctx.services.audit.record({
      actor: 'user',
      action: payload.id ? 'model.update' : 'model.create',
      outcome: 'info',
      detail: `保存模型配置 ${profile.name}（${profile.kind}/${profile.model}）`,
      metadata: { profileId: profile.id, apiKeyUpdated: payload.apiKey !== undefined }
    })
    return profile
  })

  defineHandler('model.delete', z.object({ id: idSchema }), async (ctx, payload) => {
    ctx.services.models.remove(payload.id)
    ctx.services.audit.record({ actor: 'user', action: 'model.delete', outcome: 'info', detail: '删除模型配置' })
  })

  defineHandler('model.test', z.object({ id: idSchema }), async (ctx, payload) => {
    const result = await ctx.services.models.test(payload.id)
    ctx.services.audit.record({
      actor: 'user',
      action: 'model.test',
      outcome: result.ok ? 'success' : 'failure',
      detail: result.ok ? `模型连通，延迟 ${result.latencyMs}ms` : `模型测试失败：${result.error ?? '未知错误'}`
    })
    return result
  })

  defineHandler('model.setDefault', z.object({ id: idSchema }), async (ctx, payload) => ctx.services.models.setDefault(payload.id))

  defineHandler(
    'model.setDefaultDecision',
    z.object({ id: z.string().max(200).nullable() }),
    async (ctx, payload) => ctx.services.models.setDefaultDecision(payload.id)
  )

  defineHandler('model.duplicate', z.object({ id: idSchema }), async (ctx, payload) => {
    const profile = ctx.services.models.duplicate(payload.id)
    ctx.services.audit.record({
      actor: 'user',
      action: 'model.duplicate',
      outcome: 'info',
      detail: `复制模型配置 ${profile.name}`,
      metadata: { profileId: profile.id, apiKeyCopied: profile.apiKeyStored }
    })
    return profile
  })

  defineHandler('model.discover', modelDiscoverSchema, async (ctx, payload) => ctx.services.models.discover(payload))

  defineHandler('model.configPath', voidSchema, async (ctx) => ({ path: ctx.services.models.configPath() }))

  /* ------------------------------------------------------------ agent */
  defineHandler(
    'agent.run',
    z.object({
      projectId: idSchema,
      connectionId: idSchema,
      database: z.string().max(200).optional(),
      message: z.string().min(1).max(20_000),
      modelProfileId: z.string().max(200).optional(),
      /** Empty string = no agent (JEV-only). Omit = use default agent. */
      decisionModelProfileId: z.string().max(200).optional(),
      maxSteps: z.number().int().min(1).max(50).optional(),
      /** Continue an existing finished task (same conversation). */
      taskId: z.string().max(200).optional()
    }),
    async (ctx, payload) => {
      const task = await ctx.services.agent.run(payload)
      return { task }
    }
  )

  defineHandler('agent.cancel', z.object({ taskId: idSchema }), async (ctx, payload) => {
    ctx.services.agent.cancel(payload.taskId)
  })

  defineHandler(
    'agent.busy',
    z.object({ connectionId: z.string().max(200).optional() }).optional(),
    async (ctx, payload) => ctx.services.agent.getBusyState(payload?.connectionId)
  )

  defineHandler('agent.task.get', z.object({ taskId: idSchema }), async (ctx, payload) => {
    const task = ctx.services.agent.get(payload.taskId)
    if (!task) return null
    return task
  })

  defineHandler(
    'agent.task.list',
    z.object({ projectId: z.string().max(200).optional(), limit: limitSchema }),
    async (ctx, payload) => ctx.services.agent.list({ projectId: payload.projectId, limit: payload.limit ?? 20 })
  )

  defineHandler('agent.task.delete', z.object({ taskId: idSchema }), async (ctx, payload) => {
    ctx.services.agent.delete(payload.taskId)
    return { ok: true as const }
  })

  defineHandler(
    'agent.approval.respond',
    z.object({ approvalId: idSchema, approved: z.boolean(), comment: z.string().max(1000).optional() }),
    async (ctx, payload) => {
      ctx.services.agent.respondToApproval(payload.approvalId, payload.approved, payload.comment)
    }
  )

  defineHandler('agent.tools.list', voidSchema, async (ctx) => ctx.services.agent.tools())
}
