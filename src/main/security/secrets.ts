import type { SecretStore } from '@main/service-contracts'

/**
 * Minimal shape of Electron's `safeStorage` (DPAPI on Windows, Keychain on
 * macOS). Injected so the store can be unit-tested without Electron.
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

const PREFIX = 'v1:'

/**
 * Credential store backed by the OS keychain via Electron safeStorage.
 * The ciphertext lives in the local SQLite DB; the key never does.
 */
export class SafeStorageSecretStore implements SecretStore {
  constructor(private readonly safeStorage: SafeStorageLike) {}

  available(): boolean {
    try {
      return this.safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  backend(): 'safeStorage' | 'memory' {
    return 'safeStorage'
  }

  encrypt(plaintext: string): string | null {
    if (!plaintext) return null
    if (!this.available()) {
      throw new Error(
        '系统密钥库不可用（safeStorage），无法安全保存凭据。请检查系统密钥环后重试；应用不会以明文落盘。'
      )
    }
    const buf = this.safeStorage.encryptString(plaintext)
    return `${PREFIX}${buf.toString('base64')}`
  }

  decrypt(cipher: string): string | null {
    if (!cipher) return null
    if (!cipher.startsWith(PREFIX)) {
      throw new Error('凭据格式无法识别（版本不匹配）')
    }
    const buf = Buffer.from(cipher.slice(PREFIX.length), 'base64')
    return this.safeStorage.decryptString(buf)
  }
}

/**
 * In-memory store for tests and for platforms without a keychain. It never
 * persists anything, which is the honest fallback: the user re-enters secrets
 * after a restart rather than having them written in plaintext.
 */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()

  available(): boolean {
    return true
  }

  backend(): 'memory' {
    return 'memory'
  }

  encrypt(plaintext: string): string | null {
    if (!plaintext) return null
    const key = `mem_${Math.random().toString(36).slice(2)}`
    this.values.set(key, plaintext)
    return key
  }

  decrypt(cipher: string): string | null {
    return this.values.get(cipher) ?? null
  }
}
