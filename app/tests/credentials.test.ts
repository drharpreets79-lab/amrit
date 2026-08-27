// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const encryption = vi.hoisted(() => ({ available: true, backend: 'keychain' }))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => encryption.available,
    getSelectedStorageBackend: () => encryption.backend,
    encryptString: (value: string) => Buffer.from([...value].reverse().join(''), 'utf8'),
    decryptString: (value: Buffer) => [...value.toString('utf8')].reverse().join('')
  }
}))

import { CredentialVault } from '../src/main/credentials'

describe('CredentialVault', () => {
  const directories: string[] = []

  afterEach(() => {
    encryption.available = true
    encryption.backend = 'keychain'
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  it('persists only OS-encrypted ciphertext and decrypts it on demand', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'amrit-vault-'))
    directories.push(directory)
    const vault = new CredentialVault(directory)
    await vault.set('sync.auth-token', 'highly-sensitive-token')
    expect(await vault.get('sync.auth-token')).toBe('highly-sensitive-token')
    const onDisk = readFileSync(vault.filePath, 'utf8')
    expect(onDisk).not.toContain('highly-sensitive-token')
    expect(JSON.parse(onDisk)).toMatchObject({ version: 1 })
  })

  it('uses memory only when operating-system encryption is unavailable', async () => {
    encryption.available = false
    const directory = mkdtempSync(join(tmpdir(), 'amrit-vault-memory-'))
    directories.push(directory)
    const vault = new CredentialVault(directory)
    await vault.set('llm.api-key', 'memory-secret')
    expect(vault.canPersist()).toBe(false)
    expect(await vault.get('llm.api-key')).toBe('memory-secret')
    expect(() => readFileSync(vault.filePath, 'utf8')).toThrow()
  })

  it('refuses Electron basic_text storage on Linux', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    encryption.backend = 'basic_text'
    const directory = mkdtempSync(join(tmpdir(), 'amrit-vault-basic-text-'))
    directories.push(directory)
    const vault = new CredentialVault(directory)
    await vault.set('sync.pickup-token', 'one-time-secret')
    expect(vault.canPersist()).toBe(false)
    expect(await vault.get('sync.pickup-token')).toBe('one-time-secret')
    expect(() => readFileSync(vault.filePath, 'utf8')).toThrow()
    platform.mockRestore()
  })
})
