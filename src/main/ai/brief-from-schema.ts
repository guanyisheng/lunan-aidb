/**
 * Build a project database-brief Markdown draft from live / snapshot schema.
 * No LLM — heuristics on table/column/FK names + comments.
 */
import type { ColumnInfo, ForeignKeyInfo, SchemaSnapshotTable, TableDetails } from '@shared/types'

export type BriefTableInput = Pick<
  TableDetails | SchemaSnapshotTable,
  'name' | 'comment' | 'columns' | 'primaryKey' | 'foreignKeys'
> & { type?: string }

function guessRole(name: string, comment: string): string {
  const hay = `${name} ${comment}`.toLowerCase()
  if (/user|member|customer|account|客户|会员|用户/.test(hay)) return '用户 / 会员'
  if (/order|订单/.test(hay)) return '订单'
  if (/balance|wallet|credit|point|ledger|余额|钱包|积分/.test(hay)) return '余额 / 钱包 / 积分'
  if (/product|goods|sku|item|商品|产品/.test(hay)) return '商品 / SKU'
  if (/pay|payment|支付|交易/.test(hay)) return '支付 / 交易'
  if (/log|audit|history|日志|历史/.test(hay)) return '日志 / 历史'
  if (/config|setting|dict|配置|字典/.test(hay)) return '配置 / 字典'
  return name
}

function keyCols(columns: ColumnInfo[], primaryKey: string[]): string {
  const pk = new Set(primaryKey)
  const picks = columns
    .filter((col) => {
      const n = col.name.toLowerCase()
      if (pk.has(col.name)) return false
      return (
        /status|state|type|name|title|nick|phone|mobile|email|amount|price|balance|money|user_id|order_id|client_id/.test(
          n
        ) || Boolean(col.comment)
      )
    })
    .slice(0, 8)
    .map((col) => `\`${col.name}\``)
  return picks.join(', ') || columns.slice(0, 5).map((c) => `\`${c.name}\``).join(', ')
}

function findByPatterns(tables: BriefTableInput[], patterns: RegExp[]): BriefTableInput | null {
  for (const re of patterns) {
    const hit = tables.find((t) => re.test(t.name) || re.test(t.comment || ''))
    if (hit) return hit
  }
  return null
}

function relationLines(tables: BriefTableInput[]): string[] {
  const lines: string[] = []
  for (const table of tables) {
    for (const fk of table.foreignKeys ?? []) {
      const cols = (fk.columns ?? []).join(', ')
      const refCols = (fk.referencedColumns ?? []).join(', ')
      lines.push(
        `- \`${table.name}\`.${cols ? `\`${cols}\`` : '?'} → \`${fk.referencedTable}\`.${refCols ? `\`${refCols}\`` : 'PK'}（外键${fk.name ? ` ${fk.name}` : ''}）`
      )
      if (lines.length >= 40) return lines
    }
    // Heuristic: user_id / order_id without declared FK
    for (const col of table.columns ?? []) {
      const n = col.name.toLowerCase()
      if (!/_id$/.test(n) || n === 'id') continue
      const already = (table.foreignKeys ?? []).some((fk) => (fk.columns ?? []).includes(col.name))
      if (already) continue
      const guess = n.replace(/_id$/, '')
      const target =
        tables.find((t) => t.name.toLowerCase() === guess || t.name.toLowerCase() === `${guess}s`) ??
        null
      if (target) {
        lines.push(`- \`${table.name}\`.\`${col.name}\` → \`${target.name}\`（推断，无声明外键）`)
      }
      if (lines.length >= 40) return lines
    }
  }
  return lines
}

function statusHints(tables: BriefTableInput[]): string[] {
  const out: string[] = []
  for (const table of tables) {
    for (const col of table.columns ?? []) {
      if (!/status|state|type|flag/i.test(col.name)) continue
      const comment = (col.comment || '').trim()
      out.push(
        `- \`${table.name}\`.\`${col.name}\`${comment ? `：${comment}` : '：（请补全枚举值含义）'}`
      )
      if (out.length >= 24) return out
    }
  }
  return out
}

function lookupPaths(tables: BriefTableInput[]): string[] {
  const users = findByPatterns(tables, [/^users?$/i, /user|member|customer|客户|会员/i])
  const orders = findByPatterns(tables, [/order/i, /订单/])
  const balance = findByPatterns(tables, [/balance|wallet|credit|point|ledger|余额|钱包|积分/i])
  const lines: string[] = []
  if (users && balance) {
    const nameCol =
      users.columns.find((c) => /name|nick|user_?name|account/i.test(c.name))?.name ?? 'name'
    const balCol =
      balance.columns.find((c) => /balance|amount|money|point|credit/i.test(c.name))?.name ?? '…'
    const fk =
      balance.columns.find((c) => /user_id|uid|member_id|client_id/i.test(c.name))?.name ?? 'user_id'
    lines.push(
      `- 「查某昵称的余额」→ ① \`${users.name}\` 按 \`${nameCol}\` 找 \`${(users.primaryKey ?? ['id'])[0]}\` → ② \`${balance.name}\` 按 \`${fk}\` 查 \`${balCol}\``
    )
  }
  if (orders) {
    const pk = (orders.primaryKey ?? ['id'])[0]
    lines.push(`- 「查 id={N} 的订单」→ \`${orders.name}\` where \`${pk}\`={N}，必要时 join 用户/明细表`)
  }
  if (users && orders) {
    const fk =
      orders.columns.find((c) => /user_id|client_id|member_id/i.test(c.name))?.name ?? 'user_id'
    lines.push(
      `- 「查某用户的订单」→ ① \`${users.name}\` 定位 id → ② \`${orders.name}\` where \`${fk}\`=id`
    )
  }
  lines.push('- 「修改某某状态」→ 先 SELECT 确认，再 UPDATE（写操作需人工审批）')
  return lines
}

export function buildDatabaseBriefMarkdown(options: {
  database: string
  projectName?: string | null
  serverFlavor?: string | null
  tables: BriefTableInput[]
}): string {
  const tables = [...options.tables]
    .filter((t) => !t.type || /table/i.test(t.type))
    .sort((a, b) => a.name.localeCompare(b.name))

  const entityRows = tables.slice(0, 60).map((table) => {
    const role = guessRole(table.name, table.comment || '')
    const pk = (table.primaryKey ?? []).map((c) => `\`${c}\``).join(', ') || '—'
    const cols = keyCols(table.columns ?? [], table.primaryKey ?? [])
    const note = (table.comment || '').trim() || '由库结构自动生成'
    return `| ${role} | \`${table.name}\` | ${pk} | ${cols} | ${note.replace(/\|/g, '/')} |`
  })

  const relations = relationLines(tables)
  const statuses = statusHints(tables)
  const paths = lookupPaths(tables)
  const softDelete = tables
    .filter((t) => (t.columns ?? []).some((c) => /deleted_at|is_deleted|del_flag/i.test(c.name)))
    .map((t) => `\`${t.name}\``)
    .slice(0, 20)

  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

  return [
    `# 数据库业务说明（由库结构自动生成）`,
    '',
    `> 生成时间：${now}`,
    `> 库：\`${options.database}\`${options.projectName ? ` · 项目：${options.projectName}` : ''}${options.serverFlavor ? ` · ${options.serverFlavor}` : ''}`,
    `> 说明：本文件**未调用 AI**，仅根据表名/字段/外键/注释启发式填写，请人工校对业务说法与枚举值。`,
    '',
    '---',
    '',
    '## 1. 产品一句话',
    '',
    `（自动草稿）当前库 \`${options.database}\` 共 ${tables.length} 张表。请用一句话补全产品定位。`,
    '',
    '## 2. 核心业务实体',
    '',
    '| 业务说法 | 对应表 | 主键 | 关键字段 | 备注 |',
    '|---------|--------|------|----------|------|',
    ...entityRows,
    '',
    '## 3. 状态与枚举（非常重要）',
    '',
    statuses.length ? statuses.join('\n') : '- （未从列名中识别到 status/state/type，请手工补充）',
    '',
    '## 4. 常用查询意图 → SQL 思路（多跳路径很重要）',
    '',
    ...paths,
    '',
    '## 5. 表关系（口头版）',
    '',
    relations.length ? relations.join('\n') : '- （未发现外键或 *_id 推断关系，请手工补充）',
    '',
    '## 6. 网站/后台功能对照（可选）',
    '',
    '| 页面/功能 | 主要读写的表 | 关键操作 |',
    '|-----------|--------------|----------|',
    ...tables.slice(0, 15).map((t) => `| （待填）${guessRole(t.name, t.comment || '')} | \`${t.name}\` | 查询 |`),
    '',
    '## 7. 安全与禁区',
    '',
    '- 禁止未确认就批量 DELETE / TRUNCATE / DROP',
    '- 金额、余额类变更必须先读后写，并说明影响行数',
    '- 敏感字段（手机号、密码哈希）默认不要 SELECT *',
    '',
    '## 8. 补充备注',
    '',
    softDelete.length
      ? `- 可能含软删除字段的表：${softDelete.join(', ')}`
      : '- （特殊业务规则、分库分表、软删除字段等请补充）',
    ''
  ].join('\n')
}

/** Narrow FK type usage without depending on exact ForeignKeyInfo field names at compile sites. */
export type { ForeignKeyInfo }
