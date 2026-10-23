# 架构说明

## 信任边界

```
┌──────────────────────────── Renderer (React, sandbox: true) ────────────────────────────┐
│  页面 / 组件 / 状态（zustand）                    window.aidb（仅 invoke + on 事件订阅）   │
└───────────────────────────────────────┬─────────────────────────────────────────────────┘
                                        │ contextBridge（preload，无 Node API 暴露）
                                        │ 单一通道 aidb:invoke { method, payload }
┌───────────────────────────────────────▼─────────────────────────────────────────────────┐
│ Main process = 可信服务层                                                                 │
│  ipc/registry.ts  方法白名单 + zod 校验 + 错误归一化（AppError → payload）                 │
│  ipc/handlers/*   app / project / conn / schema / sql / approval / memory / model /      │
│                   agent / backup / recovery / audit                                     │
│  services/execution-service.ts  计划 → 授权 → 保护 → 执行 → 审计 → 结构变化联动           │
│  db/*             mysql2 连接池、Schema 扫描、AST 风险分类、执行器（事务 / DDL 语义）      │
│  timemachine/*    恢复点前镜像、逻辑备份、校验、撤销、恢复（含临时库验证）                 │
│  ai/*             模型适配器、提示词、受控工具、Agent 状态机                              │
│  memory/*         项目记忆检索 / 同步 / 失效                                              │
│  store/*          node:sqlite 本地库（迁移 + 仓储 + 事务）                                 │
│  security/*       密钥库、审计、脱敏、日志、事件总线、路径                                 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

渲染层**永远拿不到**数据库句柄、凭据、文件系统或任意 SQL 执行能力；所有执行都由主进程完成并落审计。

## SQL 执行流水线（写操作强制路径）

```
用户 SQL
  │
  ├─ SqlRiskClassifier.classify (AST, 多语句切分) → 逐语句 kind/risk/targetTables/whereSql
  │
  ├─ RecoveryService.buildPlan → strategy: none | before_image | schema_snapshot | full_backup
  │
  ├─ SqlExecutor.estimateRows (EXPLAIN) → 影响面估算（不可靠时为 null，UI 显示"未知"）
  │
  ├─ SqlPlan 入内存（TTL 15min） + ApprovalRecord(status=pending, planHash)
  │
  ├─ 用户预览并批准（approval.approve → status=approved；拒绝 → denied）
  │
  ├─ SqlExecutionService.execute 复核：plan 存在/未过期/未使用 + confirmed + approval(approved,未过期,planHash 一致)
  │      失败 → APPROVAL_REQUIRED / APPROVAL_EXPIRED，绝不执行
  │
  ├─ 写保护 prepare（事务外）：
  │     - 高风险（DROP/TRUNCATE/无 WHERE 批量/未知）→ 先做完整备份 + 校验；失败抛 BACKUP_FAILED → 一条都不执行
  │     - DML → 准备捕获计划
  │
  ├─ SqlExecutor.execute：
  │     - 只读：autocommit
  │     - 纯 DML：单事务内 captureBefore → 执行 → captureAfter → COMMIT / ROLLBACK
  │     - 含 DDL：无事务（隐式提交），逐条执行并如实报告 implicit_ddl / partial
  │
  ├─ protection.finalize → RecoveryPoint（coverage 三态如实记录）
  ├─ history + audit + job.event 进度
  └─ 若为 DDL 且属于项目 → 异步 schema.detectChanges → memory.applySchemaDiff（记忆标记 stale/invalid）
```

## 关键设计决策

### 1. `node:sqlite` 而非 better-sqlite3
Electron 45 内置 Node 24，原生提供 `node:sqlite`（`DatabaseSync`）。因此本地库零原生编译依赖，Windows/macOS 打包不需要 `node-gyp`、不依赖预编译产物（在受限网络下这是决定性的）。WAL + `busy_timeout` 保证单进程内并发读写稳定。

### 2. 计划（plan）与执行分离
执行计划保存在主进程内存中（含 `planHash`），单次使用 + 15 分钟 TTL。渲染层只能提交"计划引用"，无法伪造 SQL 或绕过审批；重复提交被 `plans.delete` 拒绝。

### 3. 备份引擎自研（内置）+ 可选外部工具
不依赖 `mysqldump` 即可完整备份：`SHOW CREATE TABLE/VIEW/TRIGGER/PROCEDURE/FUNCTION/EVENT` + 分批数据 `INSERT`，产物带版本头、表清单 manifest、sha256 与尾部标记。存在 `mysqldump` 时可选择使用，但会校验退出码、文件非空与尾部完整性，**不会仅凭命令有输出就判定成功**。

### 4. 恢复默认走临时库
`previewRestore` → `restoreToTemp`（创建临时库、执行 dump、逐表行数比对、保留临时库供验证）。原地恢复必须：备份校验通过 → schema 兼容检查 → 覆盖风险与新数据丢失估算 → 用户审批 → 二次确认，且失败时明确 `mayBePartial`。

### 5. 撤销基于"前镜像 + 主键 + 并发校验"
DML 在事务内捕获受影响行前镜像（`SELECT ... WHERE <where> FOR UPDATE`）与后镜像；撤销时先用后镜像与当前行比对，发现被其他会话修改则停止自动覆盖并输出冲突，绝不覆盖新数据。

### 6. Agent 有状态、可中止、必须人工授权
Agent 任务机：最大步数、总超时、AbortController 取消、上下文预算、逐步持久化。工具调用分 `read` / `write` / `sensitive` 三类，写工具必须 `propose_sql_change → approval.required → execute_approved_change`，模型自身的安全判断不构成授权。

### 7. 记忆与 Schema 版本联动
Schema 快照带结构哈希；扫描 / DDL 后比对结构差异，将引用受影响表/字段的记忆标记 `stale`，严重冲突标记 `invalid` 并记录原因。未确认的 AI 推断默认 `ai_inferred`，不会被自动升级为确定规则。

## 数据文件位置

默认在 Electron `userData` 下（`%APPDATA%/AIDB Studio` 或 `~/Library/Application Support/AIDB Studio`）：

| 路径 | 内容 |
| --- | --- |
| `aidb.sqlite` | 项目、连接（密文凭据）、快照、历史、审批、记忆、任务、恢复点/备份元数据、模型配置、审计 |
| `backups/` | 完整备份 `.sql` 产物（可在安全设置中改为独立磁盘目录） |
| `recovery-points/` | 变更前/后镜像 JSON、DDL 结构快照 |
| `logs/` | 运行日志与审计导出（已脱敏） |

测试环境可通过 `AIDB_USER_DATA_DIR` 重定向，便携 MariaDB 数据位于仓库 `.testdata/`（已 gitignore）。
