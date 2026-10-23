import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron'
import { totalmem } from 'node:os'
import { join } from 'node:path'
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '@shared/ipc'
import { createServices, type ServicesBundle } from './container'
import { dispatch, registerAllHandlers } from './ipc'
import { NullLogger } from './security/logger'

const isDev = !app.isPackaged
let mainWindow: BrowserWindow | null = null
let bundle: ServicesBundle | null = null
let quitting = false
let bootstrapError: string | null = null
let ipcRegistered = false
let rendererReloadAttempts = 0

const fallbackLogger = new NullLogger()

// Keep Keychain / safeStorage identity stable across electron-vite, packaged,
// and probe launches (otherwise decryptString fails on saved DB/API secrets).
try {
  app.setName('aidb-studio')
  app.setPath('userData', process.env['AIDB_USER_DATA_DIR'] || join(app.getPath('appData'), 'aidb-studio'))
} catch {
  /* path may already be locked after ready in some hosts */
}

/**
 * Chromium SIGTRAP/EXC_BREAKPOINT on 8GB Macs is almost always an OOM CHECK.
 * Cap footprint before `ready` (switches after ready are ignored).
 */
function applyLowMemoryGuards(): void {
  const totalGb = totalmem() / (1024 * 1024 * 1024)
  const forceLow = process.env['AIDB_LOW_MEM'] === '1'
  const lowMem = forceLow || totalGb > 0 && totalGb <= 10
  if (!lowMem) return

  // GPU process + compositor are heavy; software path is fine for a DB tool.
  try {
    app.disableHardwareAcceleration()
  } catch {
    /* ignore */
  }
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
  // One renderer; no spare process waiting around.
  app.commandLine.appendSwitch('renderer-process-limit', '1')
  app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,CalculateNativeWinOcclusion')
  // Keep main-process V8 from ballooning during Agent/schema work.
  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=768')
}

function focusedWindow(): BrowserWindow | null {
  if (mainWindow && !mainWindow.isDestroyed()) return mainWindow
  return BrowserWindow.getAllWindows()[0] ?? null
}

function ensureIpcBridge(): void {
  if (ipcRegistered) return
  ipcRegistered = true
  registerAllHandlers()
  ipcMain.handle(IPC_INVOKE_CHANNEL, async (event, method: unknown, payload: unknown) => {
    const sender = event.senderFrame
    if (sender && sender.parent !== null) {
      return { ok: false, error: { code: 'PERMISSION_DENIED', message: '来自子框架的 IPC 请求已被拒绝' } }
    }
    if (!bundle) {
      return {
        ok: false,
        error: {
          code: 'INTERNAL',
          message: bootstrapError ?? '应用服务尚未初始化',
          hint: '请检查数据目录与系统密钥库后重启应用'
        }
      }
    }
    return dispatch(method, payload, { services: bundle.services, window: focusedWindow })
  })
}

async function bootstrapServices(): Promise<void> {
  ensureIpcBridge()
  bundle = await createServices({
    // Tests and portable runs may redirect the data directory explicitly.
    userDataDir: process.env['AIDB_USER_DATA_DIR'] || app.getPath('userData'),
    // OS keychain integration (DPAPI / Keychain). When unavailable the app
    // refuses to persist secrets instead of writing plaintext.
    safeStorage: {
      isEncryptionAvailable: () => safeStorageAvailable(),
      encryptString: (s) => safeStorageEncrypt(s),
      decryptString: (b) => safeStorageDecrypt(b)
    },
    logLevel: isDev ? 'debug' : 'info'
  })

  // Single typed event channel: agent streams, job progress, connection state.
  bundle.services.events.attach((type, payload) => {
    const win = focusedWindow()
    if (win && !win.webContents.isDestroyed()) {
      win.webContents.send(IPC_EVENT_CHANNEL, { type, payload })
    }
  })
  bundle.services.logger.info('services ready', {
    userData: app.getPath('userData'),
    appDb: bundle.services.paths.appDb,
    platform: process.platform,
    electron: process.versions.electron
  })
}

/** Lazily required so a broken keychain cannot crash app startup. */
function safeStorageSafe(): typeof import('electron').safeStorage | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { safeStorage } = require('electron') as typeof import('electron')
    return safeStorage
  } catch {
    return null
  }
}

function safeStorageAvailable(): boolean {
  try {
    return safeStorageSafe()?.isEncryptionAvailable() ?? false
  } catch {
    return false
  }
}

function safeStorageEncrypt(value: string): Buffer {
  const storage = safeStorageSafe()
  if (!storage) throw new Error('safeStorage unavailable')
  return storage.encryptString(value)
}

function safeStorageDecrypt(value: Buffer): string {
  const storage = safeStorageSafe()
  if (!storage) throw new Error('safeStorage unavailable')
  return storage.decryptString(value)
}

function applySecurityPolicy(): void {
  const ses = session.defaultSession
  const devCsp =
    "default-src 'self'; script-src 'self' 'unsafe-inline' http://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  const prodCsp =
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  const csp = isDev ? devCsp : prodCsp
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff']
      }
    })
  })
  // The renderer needs no device permissions at all.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
}

function createWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus()
    return
  }
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#0e1116',
    title: 'Lunan AIDB',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      // Keep DevTools available, but don't open them by default (huge memory cost).
      devTools: true,
      backgroundThrottling: true,
      v8CacheOptions: 'code'
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
    rendererReloadAttempts = 0
  })

  // Renderer can never navigate away or spawn windows; links go through the
  // validated app.openExternal IPC method instead.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (isDev && devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault())
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    bundle?.services.logger.error('renderer process gone', { reason: details.reason, exitCode: details.exitCode })
    // OOM / crash: try one soft reload instead of leaving a blank window.
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      rendererReloadAttempts < 1 &&
      (details.reason === 'oom' || details.reason === 'crashed' || details.reason === 'killed')
    ) {
      rendererReloadAttempts += 1
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache()
      }, 400)
    }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Must run before ready / single-instance side effects that may create GPU process.
applyLowMemoryGuards()

// Single instance: a second launch focuses the existing window.
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.aidbstudio.desktop')
    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          { role: 'appMenu' },
          { role: 'editMenu' },
          { role: 'windowMenu' },
          {
            role: 'help',
            submenu: [{ role: 'toggleDevTools' }]
          }
        ])
      )
    } else {
      Menu.setApplicationMenu(null)
    }
    applySecurityPolicy()
    ensureIpcBridge()
    try {
      await bootstrapServices()
      bootstrapError = null
      bundle?.services.logger.info('memory profile', {
        totalMemGb: Math.round((totalmem() / (1024 * 1024 * 1024)) * 10) / 10,
        lowMemGuards: totalmem() / (1024 * 1024 * 1024) <= 10 || process.env['AIDB_LOW_MEM'] === '1'
      })
    } catch (e) {
      bootstrapError = e instanceof Error ? e.message : String(e)
      fallbackLogger.error('failed to initialise services', { error: bootstrapError })
      dialog.showErrorBox(
        'Lunan AIDB 初始化失败',
        `${bootstrapError}\n\n窗口仍会打开以便查看错误；数据库连接、备份与 Agent 在服务恢复前不可用。`
      )
    }
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })

    // GPU / utility child deaths should not take down the whole app silently.
    app.on('child-process-gone', (_event, details) => {
      bundle?.services.logger.error('child process gone', {
        type: details.type,
        reason: details.reason,
        exitCode: details.exitCode,
        name: details.name
      })
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', (event) => {
    if (quitting || !bundle) return
    event.preventDefault()
    quitting = true
    void bundle
      .dispose()
      .catch((e: unknown) =>
        fallbackLogger.error('dispose failed', { error: e instanceof Error ? e.message : String(e) })
      )
      .finally(() => app.exit(0))
  })

  process.on('uncaughtException', (error) => {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error ? error.stack : undefined
    bundle?.services.logger.error('uncaught exception', { error: message, stack })
    fallbackLogger.error('uncaught exception', { error: message, stack })
  })
  process.on('unhandledRejection', (reason) => {
    bundle?.services.logger.error('unhandled rejection', { reason: String(reason) })
    fallbackLogger.error('unhandled rejection', { reason: String(reason) })
  })
}
