/**
 * Chapter 8 test #12: Windows and macOS build verification.
 *
 * These checks are NOT executed by the automated suite because they need a full
 * Electron packaging run (downloads NSIS/Electron artifacts, several minutes,
 * writes outside the workspace). They are recorded explicitly as SKIPPED rather
 * than silently omitted or reported as passing.
 *
 * Verified manually by the Lead / release owner:
 *   npm run typecheck
 *   npm run build
 *   npm run dist:win        (Windows, this machine)
 *   npm run dist:mac        (requires macOS host - not verified here)
 *
 * This file exists so the suite surfaces the unverified item in its output.
 */
import { describe, it } from 'vitest'

describe.skip('integration: cross-platform build (requires electron-builder, run manually)', () => {
  it('Windows production build + packaging', () => {
    // Run: npm run build && npm run dist:win:dir
    // Expected: out/main/index.js, out/preload/index.js, out/renderer/index.html and
    // a runnable win-unpacked/AIDB Studio.exe.
  })

  it('macOS build (requires a macOS host)', () => {
    // Run: npm run dist:mac on macOS.
    // Not verified in this Windows environment - must stay documented as unverified.
  })
})
