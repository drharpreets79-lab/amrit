/**
 * Mapping an organism-and-agent pair to the resistance mechanism it is evidence of.
 *
 * PACE's first component, and the one that does the most work. Phase 32 measured what the
 * absence of this costs: a seeded 16-case carbapenemase-producing *Klebsiella* cluster was
 * reported as **thirteen separate signals**, because `seriesFromEvents` builds one stream per
 * `R:ORG:AB` and a carbapenemase raises meropenem, imipenem and ertapenem at once. Each stream
 * held roughly a third of the evidence and each was then corrected against the Monte Carlo
 * maximum taken over *all* streams — evidence split, multiplicity inflated, the two failures
 * compounding. The two agents that reached alert status were cephalosporins dragged along by
 * co-resistance, not the carbapenems that defined the outbreak.
 *
 * Pooling agents that share a mechanism fixes both at once: fewer streams, more cases per
 * stream, and streams that correspond to a transmissible biological entity rather than to a
 * laboratory's panel choice.
 *
 * ## The mapping is catalogue data, not a hard-coded list
 *
 * All 399 antibiotics carry `class_name` and `subclass_name` from the WHONET catalogue, and the
 * subclass is what separates the mechanisms that matter here: `Carbapenems` from `Penem`,
 * `Cephalosporin III` from `Cephalosporin I`, `Penicillin (Stable)` — oxacillin and its
 * relatives, the MRSA marker — from the aminopenicillins. Reading the catalogue means a
 * deployment that adds an agent gets it classified without a code change, and means the mapping
 * can be audited against a published source rather than against this file's opinion.
 *
 * ## Where this is wrong, stated in advance
 *
 * Phenotype aggregation mis-pools when the catalogue's class assignment does not match the
 * mechanism for an unusual organism–agent pair. Carbapenem resistance in *Pseudomonas
 * aeruginosa* is frequently porin loss rather than a carbapenemase, and porin loss does not
 * behave like a transmissible clone; pooling the carbapenems for that organism pools two
 * different biological stories. That is a data-quality dependency the case-only per-agent scan
 * does not have, and it is the first place to look if PACE underperforms on an arm.
 *
 * The catalogue itself mis-pools in one place this repository can already name: colistin and
 * daptomycin are both `Lipopeptides` and neither carries a subclass, so an organism tested
 * against both would have a polymyxin result and a gram-positive lipopeptide result pooled into
 * one stream. No panel in this repository tests an organism against both, and the phenotype key
 * carries the organism, so it cannot happen here — but it is the shape of the failure, and a
 * deployment whose panels differ should read `phenotypeForAgent` before trusting the pooling.
 *
 * The plan's ablation exists to measure exactly this: with aggregation off, PACE's streams are
 * the control arm's streams, and any difference is attributable to the pooling and nothing else.
 */

import type { AstResult, IsolateRecord } from '../../../shared/types'

/** One resistance mechanism, as a stream key fragment. */
export interface Phenotype {
  /** Stable key. Stored on signals, so it must not change once published. */
  id: string
  /** What an operator reads. */
  label: string
}

export interface AntibioticClassRow {
  code: string
  class_name?: string | null
  subclass_name?: string | null
}

const upper = (value: unknown): string => String(value ?? '').trim().toLocaleUpperCase()
const text = (value: unknown): string => String(value ?? '').trim()

/**
 * Subclasses that name a mechanism, in the order they are checked.
 *
 * Subclass before class, because the class is too coarse: `Cephems` holds first-generation
 * cephalosporins and fourth-generation ones, which are different mechanisms and different
 * outbreaks. Where a subclass is absent the class is used, and where both are absent the agent
 * stands alone — which is the control arm's behaviour for that agent and the honest fallback.
 */
const SUBCLASS_PHENOTYPES: ReadonlyArray<readonly [RegExp, Phenotype]> = Object.freeze([
  [/^carbapenems?$/i, { id: 'carbapenem-R', label: 'Carbapenem resistance' }],
  [/^cephalosporin\s*III$/i, { id: '3GC-R', label: 'Third-generation cephalosporin resistance (ESBL phenotype)' }],
  [/^cephalosporin\s*IV$/i, { id: '4GC-R', label: 'Fourth-generation cephalosporin resistance' }],
  [/^cephamycin$/i, { id: 'cephamycin-R', label: 'Cephamycin resistance (AmpC phenotype)' }],
  // Oxacillin, cloxacillin, methicillin: the MRSA marker, and the reason this subclass is
  // separated from the rest of the penicillins rather than pooled with them.
  [/^penicillin\s*\(stable\)$/i, { id: 'oxacillin-R', label: 'Oxacillin resistance (MRSA phenotype)' }],
  [/^(lipo)?glycopeptide$/i, { id: 'glycopeptide-R', label: 'Glycopeptide resistance (VRE/VRSA phenotype)' }],
  [/^fluoroquinolone$/i, { id: 'fluoroquinolone-R', label: 'Fluoroquinolone resistance' }]
] as const)

const CLASS_PHENOTYPES: ReadonlyArray<readonly [RegExp, Phenotype]> = Object.freeze([
  [/^aminoglycosides$/i, { id: 'aminoglycoside-R', label: 'Aminoglycoside resistance' }],
  [/^lipopeptides$/i, { id: 'polymyxin-R', label: 'Polymyxin resistance' }],
  [/^macrolides$/i, { id: 'macrolide-R', label: 'Macrolide resistance' }],
  [/^tetracyclines$/i, { id: 'tetracycline-R', label: 'Tetracycline resistance' }],
  [/^folate pathway inhibitors$/i, { id: 'folate-R', label: 'Folate pathway inhibitor resistance' }]
] as const)

/**
 * The phenotype an agent is evidence of, or `null` when the catalogue does not classify it.
 *
 * `null` is not a failure: the caller falls back to the agent as its own stream, which is what
 * the control arm does for every agent. An agent with no mechanism-level class is better left
 * alone than pooled into a class it does not belong to.
 */
export function phenotypeForAgent(row: AntibioticClassRow | undefined): Phenotype | null {
  if (!row) return null
  const subclass = text(row.subclass_name)
  for (const [pattern, phenotype] of SUBCLASS_PHENOTYPES) {
    if (pattern.test(subclass)) return phenotype
  }
  const className = text(row.class_name)
  for (const [pattern, phenotype] of CLASS_PHENOTYPES) {
    if (pattern.test(className)) return phenotype
  }
  return null
}

/** Agent code to phenotype, built once from the catalogue. */
export function buildPhenotypeIndex(rows: readonly AntibioticClassRow[]): Map<string, Phenotype> {
  const index = new Map<string, Phenotype>()
  for (const row of rows) {
    const phenotype = phenotypeForAgent(row)
    if (phenotype) index.set(upper(row.code), phenotype)
  }
  return index
}

/**
 * An isolate whose susceptibility results have been collapsed to one entry per mechanism.
 *
 * The pooling happens **here**, on the record, and nowhere else. Every downstream count — the
 * case events the permutation scan reads, the tested-and-resistant denominators the Bernoulli
 * scan reads — is then produced by the existing functions from these records, which is what
 * stops the two models from disagreeing about how many carbapenem-resistant *Klebsiella* there
 * were on a Tuesday. Two implementations of one counting rule would drift, and the drift would
 * read as a difference between the models.
 *
 * The counting rule is easy to get wrong. An isolate resistant to meropenem, imipenem *and*
 * ertapenem is **one** carbapenem-resistant case, not three; summing per-agent counts would
 * inflate the numerator by the size of the panel and turn a well-tested laboratory into an
 * outbreak. So each isolate carries at most one result per phenotype: `R` if any agent in the
 * phenotype is `R`, otherwise `I` if any is `I`, otherwise `S`. Precedence rather than a vote,
 * because a carbapenemase is not outvoted by the two carbapenems that still test susceptible.
 *
 * Measurements are dropped from the pooled result. A merged MIC across three agents means
 * nothing, and carrying one would invite a reader to interpret it.
 */
export function mapRecordToPhenotypes(
  record: IsolateRecord, index: ReadonlyMap<string, Phenotype>
): IsolateRecord {
  const results = (record.antibiotic_results ?? {}) as Record<string, AstResult>
  const pooled: Record<string, AstResult> = {}
  for (const [rawCode, ast] of Object.entries(results)) {
    const interpretation = upper(ast?.result)
    if (interpretation !== 'R' && interpretation !== 'I' && interpretation !== 'S') continue
    const code = upper(rawCode)
    const id = index.get(code)?.id ?? code
    const current = upper(pooled[id]?.result)
    if (current === 'R') continue
    if (current === 'I' && interpretation !== 'R') continue
    pooled[id] = { result: interpretation }
  }
  return { ...record, antibiotic_results: pooled as IsolateRecord['antibiotic_results'] }
}

/**
 * Records with their agents pooled to mechanisms, or the records unchanged.
 *
 * `aggregate: false` returns the input untouched rather than mapping every agent to itself, so
 * the ablation arm with pooling switched off is provably running on the control arm's input
 * rather than on a re-derivation that happens to agree with it.
 */
export function mapRecordsToPhenotypes(
  records: readonly IsolateRecord[], index: ReadonlyMap<string, Phenotype>, aggregate = true
): readonly IsolateRecord[] {
  if (!aggregate) return records
  return records.map((record) => mapRecordToPhenotypes(record, index))
}

/**
 * What an operator reads for a phenotype id, falling back to the id for an unpooled agent.
 *
 * Matched case-insensitively, because both counting paths upper-case the code on the way
 * through — `buildOutbreakCaseEvents` and `deriveDenominators` both normalise agent codes — so
 * the id that comes back from a scan is `CARBAPENEM-R` where the mapping wrote `carbapenem-R`.
 * An exact match here silently labelled every pooled stream with its own id.
 */
export function labelForPhenotype(id: string, index: ReadonlyMap<string, Phenotype>): string {
  const wanted = upper(id)
  for (const phenotype of index.values()) {
    if (upper(phenotype.id) === wanted) return phenotype.label
  }
  return id
}

/**
 * Distinct organism-and-stream pairs across a record set.
 *
 * The diagnostic that shows the pooling did something: count over the input and over the mapped
 * records, and the difference is the multiplicity PACE removed. It is reported on every run,
 * because a pooling that quietly stopped working — a catalogue without subclasses, an import
 * that lost the class column — would otherwise look like the control arm with a different name.
 */
export function countStreams(records: readonly IsolateRecord[]): number {
  const streams = new Set<string>()
  for (const record of records) {
    const organismCode = upper(record.organism_code) || upper(record.organism)
    if (!organismCode) continue
    const results = (record.antibiotic_results ?? {}) as Record<string, AstResult>
    for (const [code, ast] of Object.entries(results)) {
      const interpretation = upper(ast?.result)
      if (interpretation !== 'R' && interpretation !== 'I' && interpretation !== 'S') continue
      streams.add(`${organismCode}|${upper(code)}`)
    }
  }
  return streams.size
}
