/**
 * The asset seam: bundled reference data, read the same way on every platform.
 *
 * Phase 17. `core/` needs the catalogue seed, the terminology seed, country profiles, geo packs,
 * the geographic directory's 247 gzip shards, breakpoint tables and the licence manifest. Today
 * every one of those is `readFileSync(resolveResourcePath(...))`, which is `node:fs` and a
 * filesystem path — neither of which a phone has in the same shape.
 *
 * Two things this interface takes seriously:
 *
 * **Bytes, not paths.** A caller that receives a path will eventually open it itself, and the
 * seam leaks. Everything here returns content.
 *
 * **Decompression is the platform's problem, not the domain's.** `node:zlib` does not exist in a
 * WebView, so `readGzip` is on this interface rather than being something the geo-directory
 * loader does to a `Uint8Array` it was handed. A platform without a native gunzip implements it
 * in JavaScript and pays for it once, where it can be measured.
 */

export interface AssetSource {
  /** UTF-8 text of a bundled asset, by repository-relative name. */
  readText(name: string): Promise<string>
  /** Raw bytes of a bundled asset. */
  readBytes(name: string): Promise<Uint8Array>
  /** UTF-8 text of a gzip-compressed bundled asset. */
  readGzipText(name: string): Promise<string>
  /** Whether the asset is present at all, so a caller can degrade rather than throw. */
  exists(name: string): Promise<boolean>
  /** Names under a bundled directory, for the shard loaders that enumerate what they have. */
  list(prefix: string): Promise<string[]>
}
