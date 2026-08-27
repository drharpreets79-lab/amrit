/**
 * The credential seam: where a secret lives when the process is not running.
 *
 * Phase 17. `credentials.ts` uses Electron's `safeStorage`, which is Chromium's OS-keychain
 * wrapper and exists only in Electron. iOS has the Keychain, Android the Keystore, and a
 * headless test run has neither.
 *
 * **`isHardwareBacked` is on the interface because the answer changes what a deployment may
 * do.** A site token protected by the iOS Secure Enclave and one sitting in an encrypted file
 * on a laptop are not the same control, and a deployment policy that cannot tell them apart
 * cannot be enforced. The value is reported, never assumed.
 */

export interface SecretStore {
  /** Whether this platform can store a secret at all. False means refuse to enrol, not degrade. */
  isAvailable(): Promise<boolean>
  /** Whether the key material is held by hardware (Secure Enclave, StrongBox, TPM). */
  isHardwareBacked(): Promise<boolean>
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}
