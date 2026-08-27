/**
 * The antibiotic class columns the benchmark hands to PACE.
 *
 * PACE pools agents by mechanism, and the mechanism is catalogue data (`class_name`,
 * `subclass_name`) rather than a list in the source. The desktop reads those columns from its
 * database; a headless benchmark has no database, so it reads them from the packaged catalogue
 * asset that seeds one — the same 399 rows, from the same file, with the same content hash.
 *
 * Loaded once per process. The asset is 4 MB of JSON and every cell of a 960-cell grid would
 * otherwise re-parse it.
 *
 * A failure here is **not** swallowed. If the catalogue cannot be read, PACE would fall back to
 * per-agent streams and quietly become the control arm under a different name, and the benchmark
 * would report that as a finding about the method.
 */

import { loadPackagedCatalogue } from '../catalog-seed'
import type { AntibioticClassRow } from '../detection/registry'

let cached: AntibioticClassRow[] | null = null

export function antibioticClasses(): AntibioticClassRow[] {
  if (cached) return cached
  const { asset, path } = loadPackagedCatalogue()
  const rows = asset.catalogue.antibiotics.map((row) => ({
    code: String(row.code ?? ''),
    class_name: row.class_name === undefined || row.class_name === null ? '' : String(row.class_name),
    subclass_name: row.subclass_name === undefined || row.subclass_name === null ? '' : String(row.subclass_name)
  })).filter((row) => row.code !== '')
  if (rows.length === 0) {
    throw new Error(`The packaged catalogue at ${path} carries no antibiotic codes, so PACE cannot `
      + 'pool agents into mechanisms and would silently run as the per-agent case-only scan.')
  }
  cached = rows
  return rows
}
