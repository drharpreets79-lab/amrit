/**
 * Run the detector benchmark and write the report.
 *
 *     pnpm benchmark -- --out /tmp/benchmark --reduced
 *     pnpm benchmark -- --out /tmp/benchmark --types clonal-multidrug,proportion-shift --delay-stride 3
 *     pnpm benchmark -- --out /tmp/benchmark --arms space-time-permutation,bernoulli-space-time
 *     pnpm benchmark -- --out /tmp/ablation --ablation --reduced
 *
 * The corpus is regenerated from the grid's seeds rather than read from disk, so a run needs
 * nothing but this repository and produces the same numbers on any machine.
 *
 * ## Scale
 *
 * The full grid is 960 cells and every arm runs on every one of them. `--reduced` is what CI
 * runs and what a first look should use: a handful of cells, one site, and no delay measurement.
 * Detection delay is off unless `--delay-stride` is given, because it re-runs every arm at
 * successive data cuts and multiplies the cost by the number of cuts.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { armsFor, paceAblationArms, runBenchmark, type BenchmarkReport } from '../src/main/benchmark'
import type { BackgroundRate, OutbreakType } from '../src/main/outbreak-simulation'

function argument(name: string, fallback = ''): string {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`)
const list = (name: string): string[] => {
  const raw = argument(name)
  return raw ? raw.split(',').map((item) => item.trim()).filter(Boolean) : []
}
const number = (name: string, fallback: number): number => {
  const raw = argument(name)
  const parsed = Number(raw)
  return raw && Number.isFinite(parsed) ? parsed : fallback
}

function table(report: BenchmarkReport): string {
  const rows = [
    '| arm | threshold | null alerts/site-yr | own rule alerts/site-yr | sensitivity (95% CI) | PPV | median delay | spatial | temporal | runtime |',
    '|---|---|---|---|---|---|---|---|---|---|'
  ]
  for (const arm of report.arms) {
    const e = arm.endpoints
    const threshold = Number.isFinite(arm.calibration.threshold)
      ? arm.calibration.threshold.toFixed(3)
      : 'all signals'
    // The alert rate the detector's own threshold would have produced, which the matched
    // calibration hides everywhere else in this table. It is the only column in which PACE's
    // third component is visible.
    const native = arm.nativeAlertsPerSiteYear.toFixed(2)
    if (!e.ran) {
      // Never ran is not zero sensitivity, and a table that prints 0% for both says the
      // detector looked and failed. The reason it gave goes in the row instead.
      const reason = arm.unavailable[0]?.reason ?? 'no seeded outbreaks presented'
      rows.push(`| ${arm.arm.label} | — | — | ${native} | **not run** | — | — | — | — | ${(arm.runtimeMs / 1000).toFixed(1)}s |`)
      // Truncated by length, not at the first full stop: the reasons carry decimals
      // ("Only 1.4 years of history") and splitting on the point cuts them mid-number.
      const summary = reason.length > 110 ? `${reason.slice(0, 107)}...` : reason
      rows.push(`| ↳ ${summary} | | | | | | | | | |`)
      continue
    }
    const interval = e.sensitivityInterval as [number, number]
    const ci = `${(interval[0] * 100).toFixed(0)}-${(interval[1] * 100).toFixed(0)}%`
    const delay = e.medianDetectionDelay === null ? '—' : `${e.medianDetectionDelay} d`
    const spatial = e.spatialAccuracy === null ? '—' : `${(e.spatialAccuracy * 100).toFixed(0)}%`
    const temporal = e.temporalAccuracy === null ? '—' : e.temporalAccuracy.toFixed(2)
    const ppv = e.positivePredictiveValue === null ? '—' : `${(e.positivePredictiveValue * 100).toFixed(0)}%`
    const partial = arm.unavailable.length > 0 ? ` (skipped ${arm.unavailable.length} cells)` : ''
    rows.push(`| ${arm.arm.label}${partial} | ${threshold} | ${arm.calibration.achievedRate.toFixed(2)} `
      + `| ${native} | ${((e.sensitivity as number) * 100).toFixed(0)}% (${ci}) | ${ppv} `
      + `| ${delay} | ${spatial} | ${temporal} | ${(arm.runtimeMs / 1000).toFixed(1)}s |`)
  }
  return rows.join('\n')
}

async function main(): Promise<void> {
  const out = argument('out', resolve(process.cwd(), 'benchmark-out'))
  const reduced = flag('reduced')
  const armIds = list('arms')
  // The Phase 31 ablation: PACE, each component switched off in turn, and the control arm.
  // One flag rather than seven `--arms` invocations, because an ablation assembled by hand is
  // one typo away from comparing two arms that differ in two components.
  const ablation = flag('ablation')
  // `--shard 2/8` runs every null cell and one eighth of the seeded cells. The nulls are not
  // sharded because the calibration is computed from them, so pooling shards afterwards
  // reproduces the single-process run exactly.
  const shardArgument = argument('shard')
  const shard = shardArgument
    ? (shardArgument.split('/').map(Number) as [number, number])
    : null
  if (shardArgument && (shard as [number, number]).some((part) => !Number.isInteger(part))) {
    throw new Error(`--shard takes i/n, for example --shard 0/8; got "${shardArgument}".`)
  }

  const report = await runBenchmark({
    ...(ablation ? { arms: paceAblationArms() } : {}),
    ...(!ablation && armIds.length > 0 ? { arms: armsFor(armIds) } : {}),
    ...(reduced
      ? {
        excessCases: [10, 40],
        durationDays: [14],
        backgroundRates: ['medium'] as BackgroundRate[],
        replicates: 1,
        nullReplicates: 3,
        windowDays: 365
      }
      : {}),
    ...(list('types').length > 0 ? { types: list('types') as OutbreakType[] } : {}),
    ...(argument('replicates') ? { replicates: number('replicates', 1) } : {}),
    ...(argument('null-replicates') ? { nullReplicates: number('null-replicates', 3) } : {}),
    ...(argument('window-days') ? { windowDays: number('window-days', 365) } : {}),
    ...(argument('sites') ? { sites: number('sites', 1) } : {}),
    ...(argument('target-rate') ? { targetRate: number('target-rate', 1) } : {}),
    ...(argument('delay-stride') ? { delayStrideDays: number('delay-stride', 0) } : {}),
    ...(argument('max-delay-cuts') ? { maxDelayCuts: number('max-delay-cuts', 12) } : {}),
    ...(shard ? { shard } : {}),
    onProgress: (done, total, label) => {
      if (done % 5 === 0 || done === total) process.stdout.write(`\r  ${done}/${total} cells  ${label}          `)
    }
  })
  process.stdout.write('\n\n')

  mkdirSync(out, { recursive: true })
  writeFileSync(resolve(out, 'benchmark.json'), `${JSON.stringify(report, null, 2)}\n`)
  const markdown = [
    '# Detector benchmark',
    '',
    `Generated ${report.generatedAt}. ${report.seededCells} seeded cells carrying `
    + `${report.seededOutbreaks} outbreaks, ${report.nullCells} null replicates covering `
    + `${report.nullSiteYears.toFixed(1)} site-years, calibrated to ${report.targetRate} alert(s) `
    + 'per site-year.',
    '',
    table(report),
    '',
    '## Notes',
    '',
    ...report.notes.map((note) => `- ${note}`),
    ''
  ].join('\n')
  writeFileSync(resolve(out, 'benchmark.md'), markdown)
  console.log(table(report))
  console.log(`\nwrote ${resolve(out, 'benchmark.json')} and benchmark.md`)
}

void main()
