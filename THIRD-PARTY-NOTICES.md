# 第三方依赖与许可证声明

本项目自身代码以 **MIT** 许可发布（见 [LICENSE](../LICENSE)）。

## 运行时依赖（随应用打包）

| 依赖 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [mysql2](https://github.com/sidorares/node-mysql2) | 3.24.6 | MIT | MySQL / MariaDB 驱动（唯一数据库驱动） |
| [node-sql-parser](https://github.com/taozhi8833998/node-sql-parser) | 5.4.0 | Apache-2.0 | SQL AST 解析与风险分类（MySQL 方言） |
| [zod](https://github.com/colinhacks/zod) | 4.6.7 | MIT | IPC 参数校验 |
| [react](https://react.dev/) / [react-dom](https://react.dev/) | 19.3.1 | MIT | UI 框架 |
| [zustand](https://github.com/pmndrs/zustand) | 5.0.16 | MIT | 渲染层状态管理 |
| [codemirror](https://codemirror.net/) / [@codemirror/state](https://codemirror.net/) / [@codemirror/lang-sql](https://codemirror.net/) | 6.x | MIT | SQL 编辑器 |
| [lucide-react](https://lucide.dev/) | 1.61.0 | ISC | 图标 |
| [Electron](https://www.electronjs.org/) | 45.0.0 | MIT | 桌面运行时（Chromium + Node 24） |
| Electron 内置 SQLite（`node:sqlite`） | Node 24.22 | MIT（SQLite public domain） | 本地持久化 |

## 构建 / 测试依赖（不随应用分发）

| 依赖 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| electron-vite | 6.0.0 | MIT | 构建编排 |
| vite | 8.3.5 | MIT | 打包器 |
| @vitejs/plugin-react | 6.1.2 | MIT | React 转换 |
| typescript | 5.9.3 | Apache-2.0 | 类型系统 |
| electron-builder | 26.15.3 | MIT | Windows / macOS 打包 |
| vitest | 5.0.5 | MIT | 测试框架 |
| playwright-core | 1.64.1 | Apache-2.0 | Electron 端到端冒烟测试 |
| @types/* | — | MIT | 类型声明 |

## 测试用外部组件（不随应用分发，仅本地测试）

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| MariaDB 便携版（Windows x64 zip） | 11.4.x | GPLv2（数据库服务器本身） | 由 `scripts/mariadb.mjs` 下载到 `.testdata/` 中运行集成测试，**不链接、不分发**于应用产物 |

## 说明

- 工作区初始为空仓库，本项目**不是**任何上游数据库客户端的 fork，因此不存在需要保留的上游版权头或上游许可证文件；所有源码为本项目新写。
- 若后续引入 `mysqldump` 等外部工具，仅通过子进程调用（用户本机安装），不随应用分发，使用者需自行遵守对应工具的许可。
- 商标：MySQL 为 Oracle 的商标，MariaDB 为 MariaDB Foundation 的商标；本项目仅用于描述兼容性，无隶属关系。
