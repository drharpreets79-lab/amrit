import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'

/**
 * Sequencing output is far too large for SQLite, so an omics artefact is always stored as a row
 * of metadata plus either a managed copy on disk or a link to where the operator keeps it.
 * Files at or below this size are copied into the workspace so the record survives the source
 * file being moved; anything larger is linked and the original location is recorded.
 */
export const OMICS_COPY_LIMIT_BYTES = Number(process.env.AMRIT_OMICS_COPY_LIMIT_MB ?? 512) * 1024 * 1024

export interface OmicsFileFacts {
  file_name: string
  file_format: string
  file_size: number
  sha256: string
  source_path: string
  stored_path: string
  storage_mode: 'copied' | 'linked'
}

/** Recognises the double extensions common to sequencing output. */
export function omicsFormat(fileName: string): string {
  const lower = fileName.toLowerCase()
  for (const suffix of ['.fastq.gz', '.fq.gz', '.fasta.gz', '.fa.gz', '.vcf.gz', '.gff.gz']) {
    if (lower.endsWith(suffix)) return suffix.slice(1)
  }
  return extname(lower).replace('.', '') || 'unknown'
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Reads the chosen file, records its size and digest, and copies it into
 * `<workspace>/omics/<lab>/<isolate>/` when it is small enough to manage.
 */
export async function attachOmicsFile(
  sourcePath: string,
  options: { workspace: string; labCode: string; isolateId: number; copy?: boolean }
): Promise<OmicsFileFacts> {
  const source = resolve(sourcePath)
  const info = await stat(source)
  if (!info.isFile()) throw new Error('Select a file, not a folder.')
  const fileName = basename(source)
  const shouldCopy = options.copy ?? info.size <= OMICS_COPY_LIMIT_BYTES
  const facts: OmicsFileFacts = {
    file_name: fileName,
    file_format: omicsFormat(fileName),
    file_size: info.size,
    sha256: await digest(source),
    source_path: source,
    stored_path: '',
    storage_mode: 'linked'
  }
  if (!shouldCopy) return facts
  const safeLab = (options.labCode || 'unassigned').replace(/[^A-Za-z0-9._-]+/g, '_')
  const directory = join(options.workspace, 'omics', safeLab, String(options.isolateId))
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const safeName = `${Date.now()}-${fileName.replace(/[^A-Za-z0-9._-]+/g, '_')}`
  const destination = join(directory, safeName)
  await copyFile(source, destination)
  return { ...facts, stored_path: destination, storage_mode: 'copied' }
}

/** Removes a managed copy. A linked original is never touched. */
export async function removeStoredOmicsFile(storedPath: string, workspace: string): Promise<void> {
  if (!storedPath) return
  const target = resolve(storedPath)
  const managed = resolve(join(workspace, 'omics'))
  if (!target.startsWith(`${managed}/`)) return
  await rm(target, { force: true })
}
