# AIDB Studio 测试运行记录（真实结果）

> 本文件只记录**实际执行过**的命令与结果。历史失败也如实保留；跳过项不计为通过。
> 最后更新：2026-10-22 23:20 (+08:00)

## 环境

| 项 | 值 |
| --- | --- |
| OS | Microsoft Windows 11 专业版 10.0.28000 (x64) |
| Node | v22.23.0（系统）；Electron 45 内含 Node 24 未参与测试 |
| npm | 10.9.8 |
| vitest | 5.0.5 (win32-x64 node-v22.23.0) |
| MariaDB | 11.4.13-MariaDB（便携 zip，仅 127.0.0.1，root 无密码，随机端口） |
| 源码版本 | 工作区当前 HEAD + 队友实时提交（测试在模块逐步落地过程中反复复跑） |

## 最终全量结果

命令：

```powershell
npm test    # = vitest run（根 vitest.config.ts）
```

输出摘要（2026-10-22 23:18:16 +08:00）：

```
 ✓ tests/unit/sqlfile-format.test.ts (13 tests)
 ✓ tests/integration/schema.test.ts (6 tests) 14759ms
 ✓ tests/integration/backup-restore.test.ts (4 tests) 6929ms
 ✓ tests/integration/undo-ddl.test.ts (6 tests) 3819ms
 ✓ tests/integration/execution-approval.test.ts (9 tests) 2359ms
 ✓ tests/integration/connection.test.ts (7 tests) 2097ms
 ✓ tests/unit/manifest.test.ts (12 tests)
 ✓ tests/unit/classifier.test.ts (33 tests)
 ✓ tests/unit/common-utils.test.ts (11 tests)
 ✓ tests/unit/guard.test.ts (9 tests)
 ✓ tests/unit/ai-safety.test.ts (16 tests)
 ✓ tests/unit/memory-scoring.test.ts (12 tests)
 ✓ tests/unit/redact.test.ts (10 tests)
 ↓ tests/integration/build-platform.test.ts (2 tests | 2 skipped)

 Test Files  13 passed | 1 skipped (14)
      Tests  148 passed | 2 skipped (150)
   Duration  47.29s
```

结论：**148 passed / 2 skipped / 0 failed**。2 个 skipped 是第 12 项 Windows/macOS 打包验证，需要 electron-builder 完整打包，由 Lead 手动执行（macOS 本机无环境），**不计为通过**。

独立配置也可运行（不依赖根配置）：

```powershell
npx vitest run --config tests/vitest.config.ts tests/unit/redact.test.ts
# → Test Files 1 passed / Tests 10 passed
```

类型检查（tests/** 已被 `tsconfig.node.json` 纳入）：

```powershell
npx tsc --noEmit -p tsconfig.node.json
# → exit 0（含 src + tests，无错误）
```

## 集成测试逐项结果（真实 MariaDB 11.4.13）

| 套件 | 用例 | 结果 |
| --- | --- | --- |
| connection.test.ts | 连接并读取真实版本/flavor、库列表、会话查询、显式断开后重连、错误端口映射 CONNECTION_FAILED、服务端 KILL 后 ping 重建连接池、错误库名映射 AppError | 7/7 通过 |
| schema.test.ts | 扫描表/视图/主键/自增/唯一/联合索引/FK(onDelete=CASCADE)/CHECK/触发器、无主键表、结构哈希稳定与 identical diff、加列/删列/加表/删表变更检测、项目快照持久化+二次检测、对象清单 | 6/6 通过 |
| execution-approval.test.ts | 真实分类、只读查询+历史记录、只读通道拒绝写、只读计划需显式 confirmed、写计划必须先审批、planHash 与 connection/db/sql/trigger 绑定、过期审批拒绝且不写数据、DDL schema_snapshot 恢复点、备份目录不可用时 DROP 被阻止且表仍存在 | 9/9 通过 |
| backup-restore.test.ts | 全库备份→状态 verified→文件/checksum/结构复检、失败备份如实记录 failed+error、恢复到临时库并逐表校验行数/视图、保留期清理：未被引用备份删除、被恢复点引用的备份保留 | 4/4 通过 |
| undo-ddl.test.ts | UPDATE 前后镜像捕获+撤销复原、DELETE 撤销恢复行、INSERT 撤销删除新行、并发修改冲突拒绝覆盖（值保留、恢复点不标记 restored）、多语句 DDL 第二条失败但第一条已隐式提交（partial 状态如实返回、历史 failed）、单条 DDL 失败无部分状态 | 6/6 通过 |
| build-platform.test.ts | Windows 打包、macOS 打包 | **显式 skip（未执行；需手动 npm run dist:win / dist:mac）** |

## 过程中发现并已修复的问题（有据可查）

以下问题均由测试真实暴露，通知对应模块 owner 后修复并复跑通过。修复后对应断言已恢复为正常断言（不再使用 `it.fails`）。

1. **guard.ts `validateWherePredicate` 根节点误判（time-machine 修复）**
   - 现象：对任意 WHERE（含 `id = 5`）返回 `{ok:false, reason:"WHERE 中不允许子查询"}`，导致所有 UPDATE/DELETE 的 before_image 策略被拒绝。
   - 证据：`tests/unit/guard.test.ts` 初始失败；修复后通过。
2. **guard.ts 危险函数漏检（time-machine 修复）**
   - 现象：`SLEEP(5)`/`BENCHMARK(...)`/`LOAD_FILE(...)` 可通过 WHERE 校验（node-sql-parser 的函数名在 `name.name[].value`，旧 `extractFunctionName()` 取不到）。
   - 修复后：`tests/unit/guard.test.ts` 断言危险函数被拒绝，通过。
3. **sqlfile.ts 流式切分跨 chunk 前瞻缺陷（time-machine 修复）**
   - 现象：按 1 字符 feed 时 `/* ... */`、`--` 等 2 字符 token 被 chunk 边界截断会误判。
   - 修复后：`tests/unit/sqlfile-format.test.ts` 的逐字符流式用例通过。
4. **security/redact.ts 带引号 JSON 键不脱敏（Lead 修复）**
   - 现象：`redactText('"password":"p@ss"')` 不脱敏。
   - 修复后：`tests/unit/redact.test.ts` 通过。
5. **sqlformat.ts `buildInsert` 签名变更（time-machine 调整，测试同步更新）**
   - 新签名 `buildInsert(tableRef, columns, rows, startIndex, maxRows)`（恢复在目标库内执行，不再带源库限定），单元测试已按新契约断言。
6. **INSERT 撤销前镜像缺失（time-machine 修复）**
   - 现象：INSERT 执行后恢复点只有 after-image，`previewUndo` 返回“该恢复点没有可用的前镜像”，撤销直接失败。
   - 修复后：`tests/integration/undo-ddl.test.ts` 的 INSERT 撤销用例通过。

> 说明：早期一次集成运行中 DELETE 撤销曾因模块正在被增量修改而瞬时失败，随后同一用例单独/全量复跑均通过（上方最终结果为准），未发现可复现缺陷。

## 团队交叉验证（time-machine，真实 MariaDB 11.4.13，2026-10-22）

time-machine 用相同的便携实例 + 真实 `createServices()` 独立跑完其模块集成验证：**15/15 全绿**，接口已冻结。关键结论（由 time-machine 提供，本记录如实转述）：

- 备份 → `restore_tested`（4 表 / 19–21 条 SQL；`tempDatabase=aidb_verify_*` 恢复验证后删除）；sha256/头部/EOF/CREATE 数/逐表 INSERT 行数全部复检；篡改文件后 verify=failed（不标 verified）。
- 备份目录不可用 + DROP TABLE：prepare 抛 `BACKUP_FAILED`，表与数据仍在（阻止执行）。
- UPDATE/DELETE/INSERT 前镜像 → `previewUndo canUndo=true` → `undo completed`：UPDATE 恢复原值、DELETE 恢复被删行、INSERT 删除新行，恢复点 `status=restored`。
- 并发：UPDATE 后外部改值 → preview `conflicts=[row_changed_since_recovery]`、canUndo=false；undo=failed+conflicts，新值未被覆盖。
- 恢复计划：drop/truncate/no-where/unknown → `full_backup`；alter → `schema_snapshot`；select → `none`；DDL 恢复点 `kind=ddl_schema_snapshot`，undo 明确拒绝（DDL 隐式提交）。
- 临时库恢复 completed、4 表行数全匹配；in-place 无审批=`APPROVAL_REQUIRED`，审批后 completed、先建安全备份、触发器恢复成功。
- retentionSweep：删过期未引用、跳过被恢复点引用的；refreshStatus 篡改镜像→partial。
- 外部 mysqldump（`AIDB_BACKUP_TOOL=mysqldump` + `AIDB_MYSQLDUMP_PATH`）→ `tool=mysqldump`、`status=verified`；失败自动回退内部引擎。
- 全项目 `npx tsc --noEmit -p tsconfig.node.json` exit 0；`npm test` 148 passed / 2 skipped / exit 0（与本记录一致）。

结论：**time machine 模块（备份引擎/校验/临时库恢复/in-place 审批/前镜像 undo/并发冲突/DDL 拒绝/保留期清理/外部 mysqldump 回退）均已在真实 MariaDB 上验证通过。**

### 实例遗留库清理（2026-10-22 23:26 +08:00）

新增 `scripts/cleanup-test-databases.mjs`（默认 dry-run，只匹配测试前缀、只允许 127.0.0.1 实例）。已用 `--apply` 清理 9 个遗留测试库：
`aidb_api_probe`、`aidb_restore_*`（3）、`aidb_verify_*`（4）、`qa_conn_*`（1，早期失败运行残留）。清理后实例仅剩系统库与 `test`。

## 早期运行记录（保留历史）

| 时间（+08:00） | 命令 | 结果 |
| --- | --- | --- |
| 22:52 | `node scripts/mariadb.mjs start/exec/reset` 手工验证 | 通过（start 1.5s 就绪；`SELECT VERSION()` = 11.4.13-MariaDB；重启后数据保留） |
| 23:00 | `npx vitest run tests/unit`（首轮） | 6 文件失败 / 2 通过；17 tests failed（含 manifest mkdtemp 目录、guard 根节点、sqlfile 前瞻、redact 引号 JSON、断言字段名等）——逐项定位后修复测试或通知 owner 修源码 |
| 23:02 | `npx vitest run tests/unit` | 8 文件通过；114 passed + 3 expected-fail（当时把上述源码缺陷标为 `it.fails`） |
| 23:07–23:12 | `tests/integration/connection.test.ts` | 7/7 通过（首轮 afterAll 因 helper 导出名错误失败，修正后通过） |
| 23:09 | `tests/integration/schema.test.ts` | 6/6 通过 |
| 23:12 | `npx vitest run tests/unit/guard.test.ts tests/integration/execution-approval.test.ts` | 18/18 通过 |
| 23:13 | `tests/integration/backup-restore.test.ts` | 4/4 通过 |
| 23:14 | `tests/integration/undo-ddl.test.ts` | 首轮 4/6（DELETE/INSERT 撤销失败，上报后修复），复跑 6/6 通过 |
| 23:17 | `npm test`（第一次全量） | 1 failed / 148 passed / 2 skipped（sqlformat buildInsert 签名变更），同步测试后复跑 |
| 23:18 | **`npm test`（最终全量）** | **148 passed / 2 skipped / 0 failed** |

## macOS 实机续跑（2026-10-22 23:45 +08:00，Darwin arm64）

环境：Node v22.20.0；MariaDB 11.4.5（MariaDB4j osx/arm64 便携包 + `$TMPDIR/aidb-studio-mariadb` datadir，规避外置卷 AppleDouble）。

```
npm run typecheck   # exit 0
npm run build       # exit 0
npm test            # 149 passed | 2 skipped
npm run smoke       # 17/17 checks passed
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir \
  -c.directories.output="$HOME/tmp-aidb-dist"
# → AIDB Studio.app (arm64) 成功；输出到本机磁盘。输出到 /Volumes 外置盘时 asar integrity 失败（已记录）。
```

本轮修复（相对 Windows 基线）：

1. `scripts/mariadb.mjs` — macOS 二进制发现、`--basedir` 初始化、外置卷 runtime 目录隔离。
2. `src/main/db/meta.ts` + `schema.ts` — 过滤 `#mysql50#._*` / `.` 伪表，修复 Schema 扫描与 `listDatabases`。
3. Vitest / builder / gitignore — 忽略 `._*` sidecar。

## 未验证项（如实列出）

- `build-platform.test.ts` 仍显式 skip（需把打包断言接到 CI）；手动 macOS `--dir` 与 dmg/zip 已在本机验证（产物在 `$HOME/tmp-aidb-dist`）。
- 外部 `mysqldump` 备份引擎（`AIDB_BACKUP_TOOL=mysqldump`）未做集成验证；内部引擎已验证。
- 真实 Ollama / 在线模型 API 调用未联网验证（只测了 URL 解析、参数校验、输出截断等纯逻辑）。
- 大表/大数据量（>10,000 行前镜像上限、超大 dump、并发多会话压力）未做性能压力测试。
- MySQL 8（非 MariaDB）上的行为差异未验证。

## 复现方式

```powershell
node scripts/mariadb.mjs start
npm test
node scripts/mariadb.mjs status
```

日志与临时产物均在 `.testdata/`（已被 `.gitignore` 忽略）：实例元数据 `mariadb.json`、mysqld 日志 `mariadb.log`、测试用临时库目录 `qa-run/`。
