# AIDB Studio 测试基础设施（tests/ + scripts/）

本目录负责项目真实可运行的测试：**单元测试不 mock 被测模块，集成测试跑在真实 MariaDB 11.4 上**。
唯一的数据源是 `scripts/mariadb.mjs` 从 TUNA 镜像下载的便携实例，绝不连接真实生产库。

---

## 1. 快速开始

```powershell
# 1) 启动（幂等）便携 MariaDB 测试实例；首次会自动下载/解压/初始化（约 1-3 分钟）
node scripts/mariadb.mjs start

# 2) 查看实例信息（端口随机，动态变化，勿硬编码）
node scripts/mariadb.mjs status          # 退出码 3 = 未运行
Get-Content .testdata/mariadb.json       # { pid, port, host, user, password, version, ... }

# 3) 跑全部测试（单元 + 集成）
npm test                                 # = vitest run，使用根 vitest.config.ts
npm run test:unit                        # 只跑单元测试
npm run test:integration                 # 只跑集成测试（真实 MariaDB）

# 4) 停止 / 重置（reset 会删除 datadir！）
node scripts/mariadb.mjs stop
node scripts/mariadb.mjs reset
```

其他 CLI：

```powershell
node scripts/mariadb.mjs exec -- "SELECT VERSION(), @@port"
node scripts/mariadb.mjs exec -- "CREATE DATABASE demo; SHOW DATABASES"

# 清理遗留测试库（默认 dry-run；只匹配 tm_it_/aidb_verify_/aidb_restore_/qa_ 前缀与 aidb_api_probe）
node scripts/cleanup-test-databases.mjs
node scripts/cleanup-test-databases.mjs --apply
```

可 import 的 API（`scripts/mariadb.mjs`，类型声明见 `scripts/mariadb.d.mts`）：

```ts
import { startServer, stopServer, getInfo, exec, createDatabase, dropDatabase, resetDatabase, getPaths } from './scripts/mariadb.mjs'
```

## 2. 便携实例说明（真实实现细节）

- 二进制来源：`https://mirrors.tuna.tsinghua.edu.cn/mariadb/mariadb-11.4.13/winx64-packages/mariadb-11.4.13-winx64.zip`
  （95,024,126 字节，缓存在 `.testdata/downloads/`，解压到 `.testdata/mariadb`，重复启动直接复用）。
- 初始化：Windows 版 `mariadb-install-db.exe` 只接受 `--datadir=...`（不接受 `--no-defaults/--basedir/--auth-root-authentication-method`），
  在 `.testdata/mariadb-data` 建立独立 datadir，`root` 无密码。
- 启动：`mysqld.exe --no-defaults --basedir=... --datadir=... --tmpdir=.testdata/tmp --log-error=.testdata/mariadb.log --port=<随机空闲端口> --bind-address=127.0.0.1 ...`。
  - `--tmpdir` 固定到项目内：本机 InnoDB 使用默认 `%TEMP%` 时创建临时文件失败（`Unable to create temporary file; errno: 0`）。
  - `detached: true` 启动：实例必须比启动它的 CLI 进程活得久（否则会被调用方进程树清理）。
  - 就绪检测：TCP 连接 + `mysqladmin ping` 轮询，最长 120s（实测 1.5–2.6s 就绪）。
- 不安装 Windows 服务、不写系统目录、不修改系统环境、不干扰系统 MySQL、只监听 `127.0.0.1`。
- 元数据文件 `.testdata/mariadb.json`：`{ pid, port, host, user:'root', password:'', datadir, socket:null, version, startedAt, logPath }`。
- 日志：`.testdata/mariadb.log`（mysqld error log）与 `.testdata/mariadb-console.log`（stdout/stderr）。
- 停止：`mysqladmin shutdown` 优雅关闭，超时 30s 后 `taskkill /F /T`。
- 端口每次启动是**随机空闲端口**，所以测试/脚本一律通过 `getInfo()` / `startServer()` 读取，不能硬编码。

### 环境变量

| 变量 | 用途 |
| --- | --- |
| `AIDB_MARIADB_BIN` | 已有 MariaDB/MySQL 的 `bin` 目录（macOS/Linux 必需；Windows 也可覆盖） |
| `AIDB_MARIADB_PORT` | 固定端口（默认随机空闲端口） |
| `AIDB_MARIADB_VERSION` | 下载版本，默认 `11.4.13` |
| `AIDB_MARIADB_URL` / `AIDB_MARIADB_ARCHIVE` | 覆盖下载 URL / 使用本地 zip |
| `AIDB_TESTDATA_DIR` | 覆盖 `.testdata` 目录 |

### 平台支持

| 平台 | 状态 |
| --- | --- |
| Windows 11 x64 + Node 22.23 | **已真实验证**（下载、初始化、启动、连接、CLI、API、单元+集成测试全绿） |
| macOS / Linux | **未验证**。代码允许用 `AIDB_MARIADB_BIN=/usr/local/mysql/bin` 指向现有二进制；自动下载只实现 Windows x64。 |

## 3. 测试目录结构

```
tests/
  vitest.config.ts           # 独立可用的 vitest 配置（根 vitest.config.ts 由 Lead 提供）
  README.md                  # 本文件
  RESULTS.md                 # 每次真实运行的命令、输出摘要、通过/跳过/失败
  helpers/
    mariadb.ts               # 启动/连接/临时库/清理辅助（真实 mysql2 连接）
    app.ts                   # createServices() 全量真实服务容器 + 独立 userDataDir + 独立测试库
    factories.ts             # 造表/造数据：PK、自增、唯一键、FK + ON DELETE CASCADE、联合索引、CHECK、触发器、视图、无主键表
  unit/                      # 纯单元测试（真实模块，不 mock 被测逻辑）
    classifier.test.ts       # SQL 语句切分（引号/注释/DELIMITER）+ 风险分类/审批/备份策略
    guard.test.ts            # 前镜像 WHERE 校验、危险函数、捕获上限、主键匹配
    sqlfile-format.test.ts   # dump 流式切分 + SQL 转义/INSERT/预览
    manifest.test.ts         # 备份头部/元数据/manifest、校验和、EOF、篡改/截断检测、dump 内容扫描
    memory-scoring.test.ts   # 记忆分词/打分/可信度/过期惩罚/schema 记忆内容
    ai-safety.test.ts        # Agent 工具参数校验、不可信输入、上下文裁剪、模型 URL、输出截断
    redact.test.ts           # 日志/审计脱敏
    common-utils.test.ts     # time/id/fsx 原子写/稳定哈希与 schema 签名
  integration/               # 真实 MariaDB 集成测试（使用 describe.skipIf 标记）
    connection.test.ts       # 第八章 #1 连接/断线重连
    schema.test.ts           # #2 Schema 扫描与变更检测
    execution-approval.test.ts # #3/#4/#10 审批、planHash、只读通道、备份失败阻止危险 SQL
    backup-restore.test.ts   # #6/#7/#11 备份完整性、临时库恢复、保留期清理
    undo-ddl.test.ts         # #5/#8/#9 前镜像撤销、并发冲突、DDL 失败部分状态
    build-platform.test.ts   # #12 构建验证（需 electron-builder，显式 skip 并注明手动命令）
```

集成测试对应用户任务书第八章 12 项要求：

| # | 要求 | 覆盖位置 | 状态 |
| --- | --- | --- | --- |
| 1 | 连接和断线恢复 | `integration/connection.test.ts` | 已跑通 |
| 2 | Schema 扫描及结构变化检测 | `integration/schema.test.ts` | 已跑通 |
| 3 | AI 工具参数校验 | `unit/ai-safety.test.ts` | 已跑通 |
| 4 | SQL 风险分类 | `unit/classifier.test.ts` + `execution-approval.test.ts` | 已跑通 |
| 5 | UPDATE/DELETE 前镜像与恢复 | `integration/undo-ddl.test.ts` | 已跑通 |
| 6 | 备份文件完整性 | `unit/manifest.test.ts` + `integration/backup-restore.test.ts` | 已跑通 |
| 7 | 完整备份恢复到临时数据库 | `integration/backup-restore.test.ts` | 已跑通 |
| 8 | 恢复冲突和并发修改 | `integration/undo-ddl.test.ts` | 已跑通 |
| 9 | DDL 失败及部分执行状态 | `integration/undo-ddl.test.ts` | 已跑通 |
| 10 | 备份失败时禁止危险 SQL | `integration/execution-approval.test.ts` | 已跑通 |
| 11 | 备份清理与保留期限 | `integration/backup-restore.test.ts` | 已跑通 |
| 12 | Windows/macOS 构建测试 | `integration/build-platform.test.ts` | **显式 skip**：需 electron-builder 完整打包，由 Lead 手动执行；macOS 无环境 |

## 4. 数据安全约定

- 只连接 `127.0.0.1` 的便携实例（端口来自 `mariadb.json`）；**禁止**把测试指向任何真实/生产数据库。
- 每个集成测试套件通过 `createTestApp()` 创建**独立随机数据库**（`qa_<label>_<时间戳>_<随机>`）和独立临时 userDataDir（SQLite store/日志/备份），测试结束即删除。
- 工厂表统一使用 `qa_` 前缀；测试不会访问 `mysql`/`sys`/`performance_schema`。
- 破坏性用例（DROP/TRUNCATE、备份失败阻止执行）都在一次性测试库的一次性表上执行。
- 集成测试 **不会** 调用 `mariadb.mjs reset/stop`：共享实例的生命周期由 CLI 管理，避免打断其他测试/队友；每个套件只清理自己的库。
- 测试目录 `.testdata/` 已在 `.gitignore` 中，不进入版本库。

## 5. MariaDB 11.4 与 MySQL 8 的差异（测试断言按 MariaDB 实际行为写）

- MariaDB 11.4 的 `CHECK` 约束真正生效，但 `information_schema.TABLE_CONSTRAINTS` 对 CHECK 的暴露方式与 MySQL 8 略有不同；扫描器按实际结果解析。
- DDL 隐式提交：测试断言“第一条 DDL 成功、第二条失败时第一条仍然存在（partial/implicit commit）”，而不是假称可回滚。
- `SHOW CREATE TABLE` 输出格式、默认字符集/collation 名称与 MySQL 8 有差异；测试只断言结构语义（主键/索引/外键），不比较整段 DDL 文本。
- `COUNT(*)` 经 mysql2 返回字符串（BIGINT），测试里统一 `Number(...)` 比较。
- 触发器通过 `SHOW TRIGGERS` / `information_schema.TRIGGERS` 探测（MariaDB 语法差异已在扫描器中处理）。

## 6. 本次验证范围与未验证项

已验证：
- `node scripts/mariadb.mjs start|stop|status|reset|exec` 全部真实执行成功；重启后数据保留、`start` 幂等复用。
- 可 import API：`startServer/stopServer/getInfo/exec/createDatabase/dropDatabase/resetDatabase/getPaths`。
- `npm test`：13 个测试文件通过、1 个 skip；148 tests passed、2 tests skipped（详见 `tests/RESULTS.md`）。

未验证 / 已知限制：
- macOS / Linux 下的便携实例与测试运行（本机无该环境；仅 `AIDB_MARIADB_BIN` 代码路径已实现，未实测）。
- `npm run dist:win` / `npm run dist:mac` 打包验证（需 electron-builder 完整产物，未在本次自动化测试内执行）。
- 备份/恢复在 MySQL 8（非 MariaDB）上的行为差异。
- 外部 `mysqldump` 备份引擎（`AIDB_BACKUP_TOOL=mysqldump`）：内部引擎已测；外部工具路径需要额外环境验证。
- 超大数据量（>10k 行前镜像上限、超大 dump）性能与内存上限未做压力测试。
- Ollama / 在线模型请求未做联网集成测试（单元测试只覆盖 URL 解析与输出截断）。

## 7. 排障

- `status` 退出码 3：实例未运行，执行 `start`。
- 端口连接失败但 `mysql.json` 存在：进程可能已死，`start` 会检测 stale 元数据并重新拉起。
- 启动失败看 `.testdata/mariadb.log` 与 `.testdata/mariadb-console.log`（错误信息会同时打印日志尾部）。
- 单元测试不需要数据库；集成测试会在第一个用例前自动 `startServer()`。
- 若在 CI/受限环境无法启动 MariaDB，集成测试会通过 `describe.skipIf(!isServerAvailable())` 整体跳过，而不是伪造通过。
