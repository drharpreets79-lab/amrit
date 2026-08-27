import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The bundled reference data and its licence terms, for the in-application licences view.
 *
 * Surfaced in the application rather than left in a file, because two of these datasets
 * place an obligation on the deployment: SNOMED CT requires a licence outside a Member
 * country, and several require attribution when this software is redistributed. A term
 * nobody can find has not been communicated.
 *
 * shared/DATA_LICENCES.md is the narrative version; shared/data-licences.json is this one.
 */

export interface DatasetLicence {
  id: string
  name: string
  detail?: string
  source: string
  licence: string
  url?: string
  bundled: boolean
  attribution_required?: boolean
  /** Places an obligation on the deployment, so the view calls it out. */
  warn?: boolean
  asset?: string
}

function candidatePaths(relative: string): string[] {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  return [
    resourcesPath ? resolve(resourcesPath, 'resources', relative) : '',
    resolve(process.cwd(), 'resources', relative),
    resolve(moduleDirectory, '../../resources', relative)
  ].filter(Boolean)
}

let cached: DatasetLicence[] | null = null

export function dataLicences(): DatasetLicence[] {
  if (cached) return cached
  for (const candidate of candidatePaths('shared/data-licences.json')) {
    if (!existsSync(candidate)) continue
    const payload = JSON.parse(readFileSync(candidate, 'utf8')) as { datasets?: DatasetLicence[] }
    cached = payload.datasets ?? []
    return cached
  }
  // Never fabricate terms: an empty list is honest, an invented one is not.
  cached = []
  return cached
}

/** Datasets whose terms require the deployment to do something. */
export function licenceNotices(): DatasetLicence[] {
  return dataLicences().filter((entry) => entry.warn)
}

export function clearDataLicenceCache(): void {
  cached = null
}
