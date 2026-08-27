/**
 * Mapping a published breakpoint table onto the local catalogues.
 *
 * A guideline does not name an agent the way a catalogue does. EUCAST publishes
 * "Amoxicillin oral (uncomplicated UTI only)" and "Imipenem, Enterobacterales except
 * Morganellaceae"; the antimicrobial master holds "Amoxicillin", and the organism master
 * holds species. Matching those strings literally fails, and a failed match used to become
 * a provisional code that blocked the whole set from ever being activated — which is the
 * same as having no EUCAST breakpoints at all.
 *
 * So the label is read rather than compared: the agent, the route, the indication and any
 * organism restriction are separated, and the organism scope is resolved to either a
 * catalogue code or a named scope with a membership rule. Nothing here guesses. A scope is
 * a definition ("the order Enterobacterales, except the Morganellaceae"), and an isolate is
 * inside it or it is not.
 */

/**
 * What this file turns a published row into, versioned.
 *
 * Staging refuses a source hash it has already seen, which is right for a repeated import
 * and wrong after a change here: the same EUCAST edition now produces different codes, and
 * a laboratory that staged it under the old reading would be told "already staged" for
 * ever. Bump this whenever parsing or mapping changes what a source yields.
 */
export const BREAKPOINT_MAPPING_VERSION = 2

/** Scope codes are namespaced so they can never collide with a WHONET organism code. */
export const ORGANISM_SCOPE_PREFIX = 'GROUP:'
/** A species scope for an organism the local catalogue does not (yet) carry. */
export const SPECIES_SCOPE_PREFIX = 'GROUP:SPECIES:'

export const isOrganismScopeCode = (value: string): boolean =>
  value.trim().toLocaleUpperCase().startsWith(ORGANISM_SCOPE_PREFIX)

const collapse = (value: string): string => String(value ?? '').replace(/\s+/g, ' ').trim()
const lower = (value: string): string => collapse(value).toLocaleLowerCase()

/** Punctuation- and case-insensitive key, so "Amoxicillin-clavulanic acid" meets "Amoxicillin/Clavulanic acid". */
export const canonicalAgentKey = (value: string): string =>
  String(value ?? '').normalize('NFKD').toLocaleLowerCase().replace(/[^a-z0-9]+/g, '')

/** EUCAST's spelling on the left, the antimicrobial master's name on the right. */
export const AGENT_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  benzylpenicillin: 'Penicillin G',
  penicilling: 'Penicillin G',
  phenoxymethylpenicillin: 'Penicillin V',
  penicillinv: 'Penicillin V',
  rifampicin: 'Rifampin',
  cefalexin: 'Cephalexin',
  cefalotin: 'Cephalothin',
  cefalothin: 'Cephalothin',
  roxithromycin: 'Roxithromicin',
  cotrimoxazole: 'Trimethoprim/Sulfamethoxazole',
  sulfamethoxazoletrimethoprim: 'Trimethoprim/Sulfamethoxazole',
  mecillinam: 'Mecillinam (Amdinocillin)',
  pivmecillinam: 'Pivmecillinam (Amdinocillin pivoxil)',
  latamoxef: 'Moxalactam (Latamoxef)',
  fusidicacid: 'Fusidic acid',
  colistinsulphate: 'Colistin',
  quinupristindalfopristin: 'Quinupristin/Dalfopristin',
  sulbactamdurlobactam: 'Sulbactam-durlobactam',
  bicozamycin: 'Bicyclomycin (Bicozamycin)',
  natamycin: 'Pimaricin (Natamycin)',
  flucytosine: '5-Fluorocytosine'
})

export interface AgentLabel {
  /** The agent alone, with route, indication and organism restriction removed. */
  base: string
  /** EUCAST distinguishes intravenous from oral breakpoints for the same agent. */
  route: 'iv' | 'oral' | ''
  /** The indication, stored as the row's site of infection when it names a site. */
  site: string
  /** `Screening` for EUCAST's screen-only rows, `Clinical` otherwise. */
  breakpointType: string
  /** The organism restriction EUCAST appends after a comma, verbatim and unresolved. */
  restriction: string
  /** Everything else in brackets, kept for the row's comment rather than discarded. */
  notes: string[]
}

/**
 * Indications that name where the infection is. A row carrying one of these applies only to
 * that site; a row saying "indications other than meningitis" is the ordinary row and gets
 * no site at all, because tying it to a site would stop it matching anything.
 */
const INDICATION_SITES: ReadonlyArray<readonly [RegExp, string]> = Object.freeze([
  [/^uncomplicated uti only$/i, 'Uncomplicated urinary tract infection'],
  [/^infections originating from the urinary tract$/i, 'Urinary tract'],
  [/^uncomplicated urinary tract infection/i, 'Uncomplicated urinary tract infection'],
  [/^endocarditis and meningitis$/i, 'Endocarditis or meningitis'],
  [/^endocarditis(,.*)?$/i, 'Endocarditis'],
  [/^meningitis$/i, 'Meningitis'],
  [/^(community-acquired )?pneumonia$/i, 'Pneumonia'],
  [/^skin and skin structure infections$/i, 'Skin and skin structure'],
  [/^systemic infections$/i, 'Systemic'],
  [/^(for )?prophylaxis only$/i, 'Prophylaxis']
])

/** Indications that qualify the evidence rather than the site. */
const SCREEN_ONLY = /^screen only$/i

/**
 * Split "Amoxicillin oral (uncomplicated UTI only), E. coli" into its parts.
 *
 * The comma split is depth-aware because EUCAST puts commas inside its brackets
 * ("Klebsiella spp. (except K. aerogenes), Raoultella spp."), and the route token is taken
 * only from the end of what remains, so "Fosfomycin iv" gives up its route while
 * "Fusidic acid" keeps its name intact.
 */
export function parseAgentLabel(raw: string): AgentLabel {
  const label = collapse(String(raw ?? '').replace(/\n/g, ' '))
  let depth = 0
  let cut = -1
  for (let index = 0; index < label.length; index += 1) {
    const character = label.charAt(index)
    if (character === '(') depth += 1
    else if (character === ')') depth = Math.max(0, depth - 1)
    else if (character === ',' && depth === 0) { cut = index; break }
  }
  const restriction = cut >= 0 ? collapse(label.slice(cut + 1)) : ''
  const head = cut >= 0 ? collapse(label.slice(0, cut)) : label
  const qualifiers = [...head.matchAll(/\(([^)]*)\)/g)].map((match) => collapse(match[1] ?? '')).filter(Boolean)
  let base = collapse(head.replace(/\([^)]*\)/g, ''))
  let route: AgentLabel['route'] = ''
  const routeMatch = /\b(iv|oral)$/i.exec(base)
  if (routeMatch) {
    route = (routeMatch[1] ?? '').toLocaleLowerCase() as AgentLabel['route']
    base = collapse(base.slice(0, routeMatch.index))
  }
  let site = ''
  let breakpointType = 'Clinical'
  const notes: string[] = []
  for (const qualifier of qualifiers) {
    if (SCREEN_ONLY.test(qualifier)) { breakpointType = 'Screening'; continue }
    const matched = INDICATION_SITES.find(([pattern]) => pattern.test(qualifier))
    if (matched && !site) { site = matched[1]; continue }
    notes.push(qualifier)
  }
  return { base, route, site, breakpointType, restriction, notes }
}

/** A named organism scope: a code, a display name and the rule that decides membership. */
export interface OrganismScope {
  code: string
  name: string
  /** Labels a guideline uses for this scope: sheet names, section headings, restrictions. */
  labels: readonly string[]
  orders?: readonly string[]
  families?: readonly string[]
  genera?: readonly string[]
  species?: readonly string[]
  exceptGenera?: readonly string[]
  exceptSpecies?: readonly string[]
  /** Catalogue codes that belong to the scope regardless of taxonomy (WHONET group rows). */
  codes?: readonly string[]
  /** A scope with no members by construction, such as EUCAST's non-species-related table. */
  nonSpecies?: boolean
}

const ENTEROBACTERALES_ORDERS = ['enterobacterales', 'enterobacteriales'] as const
const ENTEROBACTERALES_FAMILIES = [
  'enterobacteriaceae', 'morganellaceae', 'yersiniaceae', 'hafniaceae',
  'pectobacteriaceae', 'erwiniaceae', 'budviciaceae', 'thorselliaceae'
] as const
const MORGANELLACEAE_GENERA = ['morganella', 'proteus', 'providencia'] as const
/** Coagulase-positive and variable staphylococci, i.e. everything CoNS excludes. */
const COAGULASE_POSITIVE = [
  'staphylococcus aureus', 'staphylococcus argenteus', 'staphylococcus schweitzeri',
  'staphylococcus intermedius', 'staphylococcus pseudintermedius', 'staphylococcus delphini',
  'staphylococcus coagulans', 'staphylococcus hyicus', 'staphylococcus lutrae'
] as const
const VIRIDANS_SPECIES = [
  'streptococcus mitis', 'streptococcus mitior', 'streptococcus oralis', 'streptococcus sanguinis',
  'streptococcus parasanguinis', 'streptococcus gordonii', 'streptococcus cristatus', 'streptococcus salivarius',
  'streptococcus vestibularis', 'streptococcus mutans', 'streptococcus sobrinus', 'streptococcus anginosus',
  'streptococcus constellatus', 'streptococcus intermedius', 'streptococcus milleri', 'streptococcus gallolyticus',
  'streptococcus infantarius', 'streptococcus bovis', 'streptococcus viridans'
] as const
const ANGINOSUS_GROUP = [
  'streptococcus anginosus', 'streptococcus constellatus', 'streptococcus intermedius', 'streptococcus milleri'
] as const

/**
 * The scopes EUCAST's tables are written against.
 *
 * The taxonomy here is the catalogue's, not today's literature: WHONET still files
 * Enterobacterales under `Enterobacteriaceae` and carries `Citrobacter diversus` for
 * C. koseri, so both spellings are listed. A scope that matches nothing locally is still a
 * valid scope — it simply has no members until the laboratory adds the organism.
 */
export const ORGANISM_SCOPES: readonly OrganismScope[] = Object.freeze([
  {
    code: 'GROUP:ENTEROBACTERALES', name: 'Enterobacterales',
    labels: ['enterobacterales', 'enterobacteriaceae'],
    orders: ENTEROBACTERALES_ORDERS, families: ENTEROBACTERALES_FAMILIES
  },
  {
    code: 'GROUP:ENTEROBACTERALES-NOT-MORGANELLACEAE', name: 'Enterobacterales except Morganellaceae',
    labels: ['enterobacterales except morganellaceae'],
    orders: ENTEROBACTERALES_ORDERS, families: ENTEROBACTERALES_FAMILIES, exceptGenera: MORGANELLACEAE_GENERA
  },
  {
    code: 'GROUP:MORGANELLACEAE', name: 'Morganellaceae',
    labels: ['morganellaceae'], genera: MORGANELLACEAE_GENERA
  },
  {
    code: 'GROUP:ENTEROBACTERALES-NOT-PROTEEAE',
    name: 'Enterobacterales except Morganella morganii, Proteus spp. and Serratia spp.',
    labels: ['enterobacterales except morganella morganii, proteus spp. and serratia spp.'],
    orders: ENTEROBACTERALES_ORDERS, families: ENTEROBACTERALES_FAMILIES,
    exceptGenera: ['proteus', 'serratia'], exceptSpecies: ['morganella morganii']
  },
  {
    code: 'GROUP:ECOLI-KLEBSIELLA', name: 'E. coli and Klebsiella spp. except K. aerogenes',
    labels: ['e. coli and klebsiella spp. (except k. aerogenes)'],
    species: ['escherichia coli'], genera: ['klebsiella'], exceptSpecies: ['klebsiella aerogenes']
  },
  {
    code: 'GROUP:ECOLI-KLEBSIELLA-RAOULTELLA-PMIRABILIS',
    name: 'E. coli, Klebsiella spp. except K. aerogenes, Raoultella spp. and P. mirabilis',
    labels: ['e. coli, klebsiella spp. (except k. aerogenes), raoultella spp. and p. mirabilis'],
    species: ['escherichia coli', 'proteus mirabilis'], genera: ['klebsiella', 'raoultella'],
    exceptSpecies: ['klebsiella aerogenes']
  },
  {
    code: 'GROUP:ECOLI-CKOSERI', name: 'E. coli and C. koseri',
    labels: ['e. coli and c. koseri'],
    species: ['escherichia coli', 'citrobacter koseri', 'citrobacter diversus']
  },
  { code: 'GROUP:PSEUDOMONAS', name: 'Pseudomonas spp.', labels: ['pseudomonas', 'pseudomonas spp.'], genera: ['pseudomonas'] },
  {
    code: 'GROUP:PSEUDOMONAS-NOT-AERUGINOSA', name: 'Pseudomonas other than P. aeruginosa',
    labels: ['pseudomonas other than p. aeruginosa'],
    genera: ['pseudomonas'], exceptSpecies: ['pseudomonas aeruginosa']
  },
  { code: 'GROUP:ACINETOBACTER', name: 'Acinetobacter spp.', labels: ['acinetobacter', 'acinetobacter spp.'], genera: ['acinetobacter'] },
  { code: 'GROUP:STAPHYLOCOCCUS', name: 'Staphylococcus spp.', labels: ['staphylococcus', 'staphylococcus spp.'], genera: ['staphylococcus'] },
  {
    code: 'GROUP:CONS', name: 'Coagulase-negative staphylococci',
    labels: ['coagulase-negative staphylococci', 'coagulase negative staphylococci'],
    genera: ['staphylococcus'], exceptSpecies: COAGULASE_POSITIVE, codes: ['SCN']
  },
  {
    code: 'GROUP:SAUREUS-CONS-NOT-SEPI-SLUG',
    name: 'S. aureus and coagulase-negative staphylococci except S. epidermidis and S. lugdunensis',
    labels: ['s. aureus and coagulase-negative staphylococci except s. epidermidis and s. lugdunensis'],
    genera: ['staphylococcus'],
    exceptSpecies: ['staphylococcus epidermidis', 'staphylococcus albus', 'staphylococcus lugdunensis']
  },
  {
    code: 'GROUP:SEPIDERMIDIS-SLUGDUNENSIS', name: 'S. epidermidis and S. lugdunensis',
    labels: ['s. epidermidis and s. lugdunensis'],
    species: ['staphylococcus epidermidis', 'staphylococcus albus', 'staphylococcus lugdunensis']
  },
  {
    code: 'GROUP:SPSEUDINTERMEDIUS-GROUP', name: 'S. pseudintermedius, S. intermedius, S. schleiferi and S. coagulans',
    labels: ['s. pseudintermedius, s. intermedius, s. schleiferi and s. coagulans'],
    species: ['staphylococcus pseudintermedius', 'staphylococcus intermedius', 'staphylococcus schleiferi',
      'staphylococcus coagulans']
  },
  { code: 'GROUP:ENTEROCOCCUS', name: 'Enterococcus spp.', labels: ['enterococcus', 'enterococcus spp.'], genera: ['enterococcus'] },
  {
    code: 'GROUP:EFAECALIS-EFAECIUM', name: 'E. faecalis and E. faecium',
    labels: ['e. faecalis and e. faecium'], species: ['enterococcus faecalis', 'enterococcus faecium']
  },
  {
    code: 'GROUP:ENTEROCOCCUS-OTHER', name: 'Enterococci other than E. faecalis and E. faecium',
    labels: ['other enterococci'], genera: ['enterococcus'],
    exceptSpecies: ['enterococcus faecalis', 'enterococcus faecium']
  },
  {
    code: 'GROUP:STREPTOCOCCUS-ABCG', name: 'Streptococcus groups A, B, C and G',
    labels: ['streptococcus a,b,c,g', 'streptococcus a, b, c, g', 'streptococcus groups a, b, c and g'],
    species: ['streptococcus pyogenes', 'streptococcus agalactiae', 'streptococcus dysgalactiae',
      'streptococcus canis', 'streptococcus equi'],
    codes: ['BSA', 'BSB', 'BSC', 'BSG']
  },
  {
    code: 'GROUP:STREPTOCOCCUS-ACG', name: 'Streptococcus groups A, C and G',
    labels: ['streptococcus groups a, c and g'],
    species: ['streptococcus pyogenes', 'streptococcus dysgalactiae', 'streptococcus canis', 'streptococcus equi'],
    codes: ['BSA', 'BSC', 'BSG']
  },
  {
    code: 'GROUP:VIRIDANS-STREPTOCOCCI', name: 'Viridans group streptococci',
    labels: ['viridans group streptococci', 'viridans streptococci'],
    species: VIRIDANS_SPECIES, codes: ['SVI']
  },
  {
    code: 'GROUP:SANGINOSUS-GROUP', name: 'S. anginosus group',
    labels: ['s. anginosus group', 'streptococcus anginosus group'], species: ANGINOSUS_GROUP
  },
  {
    code: 'GROUP:BACTEROIDES', name: 'Bacteroides spp.',
    labels: ['bacteroides spp.', 'bacteroides'], genera: ['bacteroides', 'parabacteroides']
  },
  { code: 'GROUP:PREVOTELLA', name: 'Prevotella spp.', labels: ['prevotella spp.', 'prevotella'], genera: ['prevotella'] },
  { code: 'GROUP:CORYNEBACTERIUM', name: 'Corynebacterium spp.', labels: ['corynebacterium', 'corynebacterium spp.'], genera: ['corynebacterium'] },
  {
    code: 'GROUP:CDIPHTHERIAE-CULCERANS', name: 'C. diphtheriae and C. ulcerans',
    labels: ['c.diphtheriae_c.ulcerans', 'c. diphtheriae and c. ulcerans'],
    species: ['corynebacterium diphtheriae', 'corynebacterium ulcerans']
  },
  {
    code: 'GROUP:CJEJUNI-CCOLI', name: 'C. jejuni and C. coli',
    labels: ['c.jejuni_c.coli', 'c. jejuni and c. coli'],
    species: ['campylobacter jejuni', 'campylobacter coli']
  },
  {
    code: 'GROUP:ASANGUINICOLA-AURINAE', name: 'A. sanguinicola and A. urinae',
    labels: ['a.sanguinicola_a.urinae', 'a. sanguinicola and a. urinae'],
    species: ['aerococcus sanguinicola', 'aerococcus urinae']
  },
  { code: 'GROUP:VIBRIO', name: 'Vibrio spp.', labels: ['vibrio', 'vibrio spp.'], genera: ['vibrio'] },
  { code: 'GROUP:AEROMONAS', name: 'Aeromonas spp.', labels: ['aeromonas', 'aeromonas spp.'], genera: ['aeromonas'] },
  { code: 'GROUP:PASTEURELLA', name: 'Pasteurella spp.', labels: ['pasteurella', 'pasteurella spp.'], genera: ['pasteurella'] },
  { code: 'GROUP:SALMONELLA', name: 'Salmonella spp.', labels: ['salmonella spp.', 'salmonella'], genera: ['salmonella'] },
  {
    code: 'GROUP:BACILLUS', name: 'Bacillus spp. other than B. anthracis',
    labels: ['bacillus', 'bacillus spp.'], genera: ['bacillus'], exceptSpecies: ['bacillus anthracis']
  },
  {
    code: 'GROUP:PKPD', name: 'PK/PD (non-species related)',
    labels: ['pk pd breakpoints', 'pk/pd breakpoints', 'pk/pd (non-species related)'], nonSpecies: true
  },
  {
    // A phenotype, not an identification. Whether an isolate is MRSA follows from its
    // cefoxitin or oxacillin result, so this scope is stored and displayed but never
    // matched automatically: applying it to every S. aureus would report a telavancin
    // breakpoint against isolates it was never written for.
    code: 'GROUP:MRSA', name: 'MRSA (phenotype; not determined by identification)',
    labels: ['mrsa', 'methicillin-resistant s. aureus', 'methicillin-resistant staphylococcus aureus'],
    nonSpecies: true
  }
])

/**
 * Single organisms a guideline names in shorthand, resolved to the catalogue's own spelling.
 *
 * The catalogue's names come from WHONET and are older in places than EUCAST's, so the
 * synonym is what gets looked up: `Branhamella catarrhalis` for M. catarrhalis and
 * `Citrobacter diversus` for C. koseri are the same organisms under earlier names.
 */
export const ORGANISM_NAME_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  's.pneumoniae': 'Streptococcus pneumoniae',
  's. pneumoniae': 'Streptococcus pneumoniae',
  'h.influenzae': 'Haemophilus influenzae',
  'h. influenzae': 'Haemophilus influenzae',
  'm.catarrhalis': 'Branhamella catarrhalis',
  'm. catarrhalis': 'Branhamella catarrhalis',
  'moraxella catarrhalis': 'Branhamella catarrhalis',
  'n.gonorrhoeae': 'Neisseria gonorrhoeae',
  'n. gonorrhoeae': 'Neisseria gonorrhoeae',
  'n.meningitidis': 'Neisseria meningitidis',
  'n. meningitidis': 'Neisseria meningitidis',
  's.maltophilia': 'Stenotrophomonas maltophilia',
  's. maltophilia': 'Stenotrophomonas maltophilia',
  'l.monocytogenes': 'Listeria monocytogenes',
  'l. monocytogenes': 'Listeria monocytogenes',
  'h.pylori': 'Helicobacter pylori',
  'h. pylori': 'Helicobacter pylori',
  'k.kingae': 'Kingella kingae',
  'k. kingae': 'Kingella kingae',
  'a.xylosoxidans': 'Achromobacter xylosoxidans',
  'a. xylosoxidans': 'Achromobacter xylosoxidans',
  'b.anthracis': 'Bacillus anthracis',
  'b. anthracis': 'Bacillus anthracis',
  'b.melitensis': 'Brucella melitensis',
  'b. melitensis': 'Brucella melitensis',
  'b.pseudomallei': 'Burkholderia pseudomallei',
  'b. pseudomallei': 'Burkholderia pseudomallei',
  'b.cepacia': 'Burkholderia cepacia',
  'b. cepacia': 'Burkholderia cepacia',
  'l.pneumophila': 'Legionella pneumophila',
  'l. pneumophila': 'Legionella pneumophila',
  'm.tuberculosis': 'Mycobacterium tuberculosis',
  'm. tuberculosis': 'Mycobacterium tuberculosis',
  's. aureus': 'Staphylococcus aureus',
  's. epidermidis': 'Staphylococcus epidermidis',
  's. lugdunensis': 'Staphylococcus lugdunensis',
  's. saprophyticus': 'Staphylococcus saprophyticus',
  's. agalactiae': 'Streptococcus agalactiae',
  's. agalactiae (group b streptococci)': 'Streptococcus agalactiae',
  's. pyogenes': 'Streptococcus pyogenes',
  'p. aeruginosa': 'Pseudomonas aeruginosa',
  'e. coli': 'Escherichia coli',
  'e. faecalis': 'Enterococcus faecalis',
  'e. faecium': 'Enterococcus faecium',
  'c. jejuni': 'Campylobacter jejuni',
  'c. coli': 'Campylobacter coli',
  'c. diphtheriae': 'Corynebacterium diphtheriae',
  'c. ulcerans': 'Corynebacterium ulcerans',
  'c. koseri': 'Citrobacter diversus',
  'clostridioides difficile': 'Clostridioides difficile',
  'clostridium difficile': 'Clostridioides difficile',
  'cutibacterium acnes': 'Cutibacterium acnes',
  'propionibacterium acnes': 'Cutibacterium acnes',
  'fusobacterium necrophorum': 'Fusobacterium necrophorum',
  'clostridium perfringens': 'Clostridium perfringens'
})

const SCOPES_BY_LABEL: ReadonlyMap<string, OrganismScope> = new Map(
  ORGANISM_SCOPES.flatMap((scope) => scope.labels.map((label) => [lower(label), scope] as const))
)

/** The scope a guideline label names, if it names one. */
export const organismScopeForLabel = (label: string): OrganismScope | undefined =>
  SCOPES_BY_LABEL.get(lower(label)) ?? SCOPES_BY_LABEL.get(lower(label).replace(/\s+spp\.?$/, ''))

/** The catalogue's own spelling for a shorthand organism label. */
export const organismNameForLabel = (label: string): string =>
  ORGANISM_NAME_ALIASES[lower(label)] ?? ''

const slug = (value: string): string =>
  lower(value).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLocaleUpperCase()

/** The binomial, so `Achromobacter xylosoxidans ss. xylosoxidans` scopes as its species. */
export const binomialOf = (organismName: string): string =>
  lower(organismName).split(' ').slice(0, 2).join(' ')

/** The scope code standing for one species, used when the catalogue has no row for it. */
export const speciesScopeCode = (organismName: string): string =>
  `${SPECIES_SCOPE_PREFIX}${slug(binomialOf(organismName))}`

/** The catalogue fields a scope rule reads. Anything else about the organism is irrelevant. */
export interface OrganismTaxon {
  code?: string
  organism_name?: string
  genus_name?: string
  family_name?: string
  order_name?: string
}

const taxonGenus = (taxon: OrganismTaxon): string =>
  lower(taxon.genus_name ?? '') || lower(taxon.organism_name ?? '').split(' ')[0] || ''

const matchesSpecies = (taxon: OrganismTaxon, species: readonly string[]): boolean => {
  const name = lower(taxon.organism_name ?? '')
  const binomial = binomialOf(name)
  return species.some((item) => {
    const target = lower(item)
    return name === target || binomial === target || name.startsWith(`${target} `)
  })
}

/** Whether one organism falls inside one scope. */
export function organismScopeMatches(scope: OrganismScope, taxon: OrganismTaxon): boolean {
  if (scope.nonSpecies) return false
  const code = String(taxon.code ?? '').trim().toLocaleUpperCase()
  if (scope.codes?.some((item) => item.toLocaleUpperCase() === code)) return true
  if (scope.exceptSpecies && matchesSpecies(taxon, scope.exceptSpecies)) return false
  const genus = taxonGenus(taxon)
  if (scope.exceptGenera?.some((item) => lower(item) === genus)) return false
  if (scope.species && matchesSpecies(taxon, scope.species)) return true
  if (scope.genera?.some((item) => lower(item) === genus)) return true
  const family = lower(taxon.family_name ?? '')
  if (family && scope.families?.some((item) => lower(item) === family)) return true
  const order = lower(taxon.order_name ?? '')
  if (order && scope.orders?.some((item) => lower(item) === order)) return true
  return false
}

/**
 * Every scope code an organism belongs to, for matching against staged breakpoint rows.
 *
 * The species scope is included unconditionally: a guideline row written against a species
 * the catalogue does not carry is stored under `GROUP:SPECIES:…`, and the only way it can
 * ever match is if the same name, from the other side, produces the same code.
 */
export function organismScopeCodesFor(taxon: OrganismTaxon): string[] {
  const codes = ORGANISM_SCOPES.filter((scope) => organismScopeMatches(scope, taxon)).map((scope) => scope.code)
  const name = String(taxon.organism_name ?? '').trim()
  if (name) codes.push(speciesScopeCode(name))
  return [...new Set(codes)]
}

/** The display name for a scope code, for the comment written onto a staged row. */
export const organismScopeName = (code: string): string =>
  ORGANISM_SCOPES.find((scope) => scope.code === code)?.name
    ?? (code.startsWith(SPECIES_SCOPE_PREFIX) ? code.slice(SPECIES_SCOPE_PREFIX.length).replace(/-/g, ' ') : code)
