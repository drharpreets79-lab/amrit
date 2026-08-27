/**
 * Generate the pre-specified factorial corpus for the outbreak-detection benchmark.
 *
 *     pnpm outbreak:corpus -- --out /tmp/corpus
 *     pnpm outbreak:corpus -- --out /tmp/corpus --types clonal-multidrug --replicates 2
 *     pnpm outbreak:corpus -- --out /tmp/corpus --manifest-only
 *
 * The design is Study B arm 2 of `paper/AMRIT_paper_phasewise_plan.md`: cluster sizes
 * 5/10/20/40, durations 7/14/30 days, crossed with three background volumes and the five
 * outbreak types, plus null replicates carrying no outbreak at all so the false-alert rate
 * per site-year can be estimated with an interval rather than asserted.
 *
 * ## What is and is not committed
 *
 * The generator and its seeds are the artefact; the corpus is not. A full grid is several
 * gigabytes of JSON, and it is reproducible byte-for-byte from `manifest.json` on any
 * machine, so committing it would be storing something the repository can already derive.
 * `app/tests/fixtures/outbreak-simulation.golden.json` pins a small corpus by digest, and
 * that is what fails if the generator changes.
 *
 * ## Scale warning
 *
 * The full grid is 960 cells. At the medium background rate one cell is roughly 20,000
 * records, and a single prospective scan of one site at 999 Monte Carlo replications took
 * about 30 seconds on the machine this was written on. Running every detector over every
 * cell serially is days of compute, not minutes: Phase 33's harness has to parallelise, and
 * CI runs a reduced grid. `--manifest-only` writes the design without generating anything,
 * which is what a scheduler wants.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { GENERATOR_VERSION, factorialDesign, simulate, type BackgroundRate, type OutbreakType } from '../src/main/outbreak-simulation'

function argument(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

function list(name: string): string[] {
  const raw = argument(name)
  return raw ? raw.split(',').map((item) => item.trim()).filter(Boolean) : []
}

const outDirectory = argument('out')
if (!outDirectory) {
  console.error('Pass --out <directory>. It is created if absent, and written into.')
  process.exit(2)
}

const manifestOnly = process.argv.includes('--manifest-only')
const endDate = argument('end-date', '2026-08-14')
const windowDays = Number(argument('window-days', '730'))
const replicates = Number(argument('replicates', '5'))
const nullReplicates = Number(argument('null-replicates', '20'))
const types = list('types') as OutbreakType[]
const backgroundRates = list('background-rates') as BackgroundRate[]

const cells = factorialDesign({
  replicates,
  nullReplicates,
  ...(types.length ? { types } : {}),
  ...(backgroundRates.length ? { backgroundRates } : {})
})

mkdirSync(outDirectory, { recursive: true })
const manifest = {
  schema_version: 1,
  generator_version: GENERATOR_VERSION,
  created: new Date().toISOString().slice(0, 10),
  end_date: endDate,
  window_days: windowDays,
  cells: cells.length,
  seeded_cells: cells.filter((cell) => cell.outbreaks.length).length,
  null_cells: cells.filter((cell) => !cell.outbreaks.length).length,
  design: cells.map((cell) => ({
    arm_id: cell.arm_id,
    seed: cell.seed,
    type: cell.type,
    excess_cases: cell.excessCases,
    duration_days: cell.durationDays,
    background_rate: cell.backgroundRate,
    replicate: cell.replicate,
    outbreaks: cell.outbreaks
  }))
}
writeFileSync(resolve(outDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Design: ${cells.length} cells (${manifest.seeded_cells} seeded, ${manifest.null_cells} null)`)
console.log(`Manifest: ${resolve(outDirectory, 'manifest.json')}`)

if (manifestOnly) {
  console.log('--manifest-only: no corpus generated. Every cell is reproducible from its seed.')
  process.exit(0)
}

const started = Date.now()
let records = 0
for (const [index, cell] of cells.entries()) {
  const result = simulate({
    seed: cell.seed,
    windowDays,
    endDate,
    backgroundRate: cell.backgroundRate,
    outbreaks: cell.outbreaks
  })
  const stem = resolve(outDirectory, cell.arm_id.replace(/[|/]/g, '_'))
  writeFileSync(`${stem}.records.json`, `${JSON.stringify(result.records)}\n`)
  writeFileSync(`${stem}.truth.json`, `${JSON.stringify(result.truth, null, 2)}\n`)
  records += result.records.length
  if ((index + 1) % 25 === 0 || index === cells.length - 1) {
    const seconds = ((Date.now() - started) / 1000).toFixed(0)
    console.log(`  ${index + 1}/${cells.length} cells, ${records} records, ${seconds}s`)
  }
}
console.log(`Done: ${cells.length} cells, ${records} records, ${((Date.now() - started) / 1000).toFixed(0)}s.`)
