import { z } from 'zod'

export const idSchema = z.string().min(1).max(200)
export const isoDateSchema = z.string().min(10).max(40)
export const sqlTextSchema = z.string().min(1).max(500_000)
export const optionalId = z.string().max(200).optional()
export const limitSchema = z.number().int().min(1).max(500).optional()
export const offsetSchema = z.number().int().min(0).max(1_000_000).optional()

export const riskLevelSchema = z.enum(['none', 'low', 'medium', 'high', 'critical'])
export const memoryTypeSchema = z.enum(['schema', 'business', 'user_confirmed', 'task', 'sql', 'operation'])
export const memoryTrustSchema = z.enum(['user_confirmed', 'verified', 'ai_inferred', 'unverified'])
export const memoryStatusSchema = z.enum(['active', 'stale', 'invalid'])
export const memorySourceSchema = z.enum(['user', 'agent', 'schema_scan', 'execution', 'import'])

export const memoryRefSchema = z.object({
  kind: z.enum([
    'table',
    'column',
    'connection',
    'execution',
    'backup',
    'recovery_point',
    'task',
    'snapshot'
  ]),
  id: z.string().max(200).optional(),
  database: z.string().max(200).optional(),
  table: z.string().max(200).optional(),
  column: z.string().max(200).optional()
})

export const connectionInputSchema = z.object({
  name: z.string().min(1).max(120),
  host: z.string().min(1).max(255).regex(/^[A-Za-z0-9._:\-[\]]+$/, '主机名包含非法字符'),
  port: z.number().int().min(1).max(65535),
  user: z.string().min(1).max(120),
  password: z.string().max(4096).optional(),
  database: z.string().max(200).optional(),
  ssl: z.enum(['disabled', 'preferred', 'required']).optional(),
  charset: z.string().max(40).optional(),
  connectTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
  color: z.string().max(40).optional()
})

export const settingsPatchSchema = z
  .object({
    autoProtection: z.boolean().optional(),
    requireApprovalForWrites: z.boolean().optional(),
    allowSampling: z.boolean().optional(),
    maxSampleRows: z.number().int().min(0).max(100).optional(),
    sqlTimeoutMs: z.number().int().min(1000).max(600_000).optional(),
    maxResultRows: z.number().int().min(1).max(100_000).optional(),
    maxAgentSteps: z.number().int().min(1).max(50).optional(),
    agentTimeoutMs: z.number().int().min(5000).max(1_800_000).optional(),
    backupDir: z.string().max(1000).optional(),
    retentionDays: z.number().int().min(0).max(3650).optional(),
    maxBackupBytes: z.number().int().min(0).max(10 * 1024 * 1024 * 1024 * 1024).optional(),
    diskWarnBytes: z.number().int().min(0).max(10 * 1024 * 1024 * 1024 * 1024).optional(),
    defaultModelProfileId: z.string().max(200).nullable().optional(),
    defaultDecisionModelProfileId: z.string().max(200).nullable().optional(),
    theme: z.enum(['dark', 'light', 'system']).optional(),
    jevQualityGateEnabled: z.boolean().optional(),
    jevMinConfidence: z.number().int().min(0).max(100).optional()
  })
  .strict()

export const modelProfileInputSchema = z.object({
  id: z.string().max(200).optional(),
  name: z.string().min(1).max(120),
  kind: z.enum(['openai', 'ollama']),
  baseUrl: z.string().min(1).max(1000),
  model: z.string().min(1).max(200),
  apiKey: z.string().max(8192).optional(),
  copyApiKeyFromProfileId: z.string().max(200).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(1_000_000).optional(),
  timeoutMs: z.number().int().min(1000).max(600_000).optional(),
  toolsEnabled: z.boolean().optional(),
  isDefault: z.boolean().optional(),
  roles: z.array(z.enum(['agent', 'decision'])).min(1).max(2).optional(),
  notes: z.string().max(2000).optional()
})

export const modelDiscoverSchema = z.object({
  baseUrl: z.string().min(1).max(1000),
  kind: z.enum(['openai', 'ollama']).optional(),
  apiKey: z.string().max(8192).optional(),
  profileId: z.string().max(200).optional(),
  timeoutMs: z.number().int().min(2000).max(60_000).optional()
})

export const memoryInputSchema = z.object({
  projectId: idSchema,
  type: memoryTypeSchema,
  title: z.string().min(1).max(300),
  content: z.string().min(1).max(20_000),
  trust: memoryTrustSchema.optional(),
  source: memorySourceSchema.optional(),
  tags: z.array(z.string().max(80)).max(30).optional(),
  refs: z.array(memoryRefSchema).max(50).optional(),
  confidence: z.number().min(0).max(1).optional(),
  schemaSnapshotId: z.string().max(200).nullable().optional(),
  schemaHash: z.string().max(200).nullable().optional()
})

export const backupCreateSchema = z.object({
  connectionId: idSchema,
  projectId: z.string().max(200).nullable().optional(),
  database: z.string().min(1).max(200),
  scope: z.enum(['database', 'tables']),
  tables: z.array(z.string().max(200)).max(500).optional(),
  type: z.enum(['full', 'schema_only', 'data_only']).optional(),
  verify: z.boolean().optional(),
  restoreTest: z.boolean().optional(),
  label: z.string().max(200).optional()
})

export const restorePreviewSchema = z.object({
  backupId: optionalId,
  recoveryPointId: optionalId,
  connectionId: idSchema,
  mode: z.enum(['to_temp_database', 'in_place']),
  targetDatabase: z.string().max(200).optional(),
  tempDatabase: z.string().max(200).optional()
})
