<p align="center">
  <img src="docs/logo.png" alt="Lunan AIDB" width="160" />
</p>

<h1 align="center">Lunan AIDB</h1>

<p align="center">
  <strong>AI 原生 MySQL / MariaDB 桌面数据库工作台</strong><br />
  受控 Agent · 本地项目记忆 · 数据库时间机器
</p>

<p align="center">
  <a href="#功能概览">功能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#打包发布">打包</a> ·
  <a href="#许可证">许可证</a>
</p>

---

**Lunan AIDB** 是跨平台（Windows / macOS）桌面客户端。在常规数据库管理能力之上，内置受控 AI Agent、本地持久化项目记忆，以及完整的数据库时间机器（变更前镜像、备份、校验、差异、撤销与恢复）。

作者：[路南](https://github.com/guanyisheng)（`guanyisheng`）

当前版本：`1.0.0-beta`

## 功能概览

| 模块 | 说明 |
| --- | --- |
| 连接管理 | MySQL / MariaDB；密码经系统密钥库加密（Windows DPAPI / macOS Keychain） |
| 工作区 | 对象树、可编辑浏览、表结构、SQL 编辑器（CodeMirror 6）、结果表与执行历史 |
| Schema | `information_schema` 扫描、结构快照、差异检测、项目数据库简介 MD 自动生成 |
| AI Agent | OpenAI 兼容 API + Ollama；受控工具；JEV 决策评审与可选置信度门控 |
| 记忆 | Schema / 业务 / 确认 / 任务 / SQL / 操作类记忆，本地 SQLite，可导入导出配置 |
| 时间机器 | 恢复点、逻辑备份、校验、结构差异、撤销与恢复到临时库 |
| 安全 | 白名单 IPC + zod 校验、密钥不出主进程、审计与脱敏、写入审批 |

## 技术栈

- Electron 45 · React 19 · TypeScript · electron-vite
- `mysql2` · `node-sql-parser` · `zod` · `node:sqlite`（WAL）
- 测试：Vitest · Playwright 冒烟

## 快速开始

```bash
# 需要 Node.js >= 22.12
npm install
npm run dev
```

常用命令：

```bash
npm run typecheck    # 类型检查
npm run build        # 构建到 out/
npm test             # 单元 / 集成测试
npm run dist:mac     # macOS dmg / zip（输出到本机 /tmp/lunan-aidb-dist）
npm run dist:win     # Windows NSIS（同上）
npm run dist:beta    # mac + win 一并打包
```

> 在外置磁盘上打包时，asar 校验可能失败；请使用脚本中的本机 `/tmp` 输出目录，再拷贝产物。

## 配置导入 / 导出

设置页支持导出或导入：应用设置、AI 模型、数据库连接、项目（可单选或全部）。  
**不会**导出数据库密码与模型 API Key，换机导入后需重新填写。

## 目录结构

```
src/
  shared/     # 类型与 IPC 契约
  main/       # 主进程（连接、Schema、Agent、记忆、时间机器、安全）
  preload/    # contextBridge
  renderer/   # React UI
docs/         # 文档与品牌素材（含 logo）
build/        # 安装包图标
templates/    # 数据库简介等模板
tests/        # 测试
```

## 安全摘要

- Renderer 无 Node、无数据库句柄
- 主进程单一 IPC 白名单，参数经 zod 校验
- 写操作可强制人工审批；高风险操作联动恢复点 / 备份
- SQL 风险分类基于 AST，而非正则

## 许可证

MIT © 路南（[guanyisheng](https://github.com/guanyisheng)）

第三方依赖说明见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。
