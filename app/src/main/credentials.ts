import { safeStorage } from 'electron'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

type VaultDocument = { version: 1; values: Record<string, string> }

/** Stores secrets only as OS-encrypted ciphertext. If encryption is unavailable,
 * values remain in memory for this process and are never written in plaintext. */
export class CredentialVault {
  readonly filePath: string
  private readonly volatileValues = new Map<string, string>()

  constructor(userDataPath: string) {
    this.filePath = path.join(userDataPath, 'credentials.vault.json')
  }

  canPersist(): boolean {
    if (!safeStorage.isEncryptionAvailable()) return false
    // Electron can report encryption as "available" on Linux while using the
    // `basic_text` backend. That is obfuscation, not an OS credential store, so
    // never write authentication or pickup tokens to disk in that state.
    if (
      process.platform === 'linux' &&
      typeof safeStorage.getSelectedStorageBackend === 'function' &&
      safeStorage.getSelectedStorageBackend() === 'basic_text'
    ) return false
    return true
  }

  async get(key: string): Promise<string> {
    if (!this.canPersist()) return this.volatileValues.get(key) ?? ''
    const document = await this.readDocument()
    const encoded = document.values[key]
    if (!encoded) return ''
    try {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    } catch {
      return ''
    }
  }

  async set(key: string, value: string): Promise<void> {
    if (!this.canPersist()) {
      if (value) this.volatileValues.set(key, value)
      else this.volatileValues.delete(key)
      return
    }
    const document = await this.readDocument()
    if (value) document.values[key] = safeStorage.encryptString(value).toString('base64')
    else delete document.values[key]
    await this.writeDocument(document)
  }

  async remove(key: string): Promise<void> {
    await this.set(key, '')
  }

  private async readDocument(): Promise<VaultDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<VaultDocument>
      if (parsed.version === 1 && parsed.values && typeof parsed.values === 'object') {
        return { version: 1, values: parsed.values }
      }
    } catch {
      // First run, inaccessible file, or invalid vault: begin with an empty vault.
    }
    return { version: 1, values: {} }
  }

  private async writeDocument(document: VaultDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    const temporary = `${this.filePath}.tmp`
    await writeFile(temporary, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.filePath)
    await chmod(this.filePath, 0o600)
  }
}
