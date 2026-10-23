# 测试报告入口

本文件是 README 中链接的稳定入口。

**真实执行记录**（含命令、输出摘要、失败修复过程、未验证项）见：

→ [tests/RESULTS.md](../tests/RESULTS.md)

**测试说明与复现方式**见：

→ [tests/README.md](../tests/README.md)

## macOS 实机验证（2026-10-22，Darwin arm64）

环境：Node v22.20.0、Electron 45、MariaDB 11.4.5（MariaDB4j 便携二进制 + 本地 `$TMPDIR` datadir）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck` | ✅ exit 0 |
| `npm run build` | ✅ `out/` |
| `npm test` | ✅ **149 passed / 2 skipped**（`build-platform` 仍为手动打包项） |
| `npm run smoke` | ✅ **17/17** |
| `electron-builder --mac --dir`（输出到本机磁盘） | ✅ `AIDB Studio.app` (arm64) |
| `electron-builder --mac`（输出到外置 `/Volumes`） | ❌ asar integrity 因 AppleDouble 损坏（已记录；改输出目录后可过） |

本轮相对 Windows 记录的修复：

1. `scripts/mariadb.mjs`：macOS 自动发现 Homebrew/已解压二进制；Unix `mariadb-install-db` 传入 `--basedir`；外置卷上将 runtime datadir 放到 `$TMPDIR/aidb-studio-mariadb`。
2. `src/main/db/meta.ts` / `schema.ts`：过滤 `#mysql50#._*` / `.` 开头的文件系统伪对象，避免 Schema 扫描与库列表失败。
3. Vitest / electron-builder / `.gitignore`：忽略 `._*` AppleDouble sidecar。
