# AMRIT — operator and methods manual

**A**ntimicrobial **R**esistance **M**onitoring, **I**ntelligence and **T**racking

This manual covers both halves of the system and the reasoning behind them:

- **Part I — the desktop application**, which a laboratory runs on its own computer, offline.
- **Part II — the central web portal**, which a programme runs for a country or a network.
- **Part III — methods and rationale**, which states what each analytical choice is, what the
  alternatives were, and why this one was taken. Part III is written to be quotable in a
  paper: every method names the module that implements it.

Every screenshot is captured from a running build — the desktop screens by the application's
own `AMRIT_CAPTURE_DIR` mode against a freshly seeded demonstration database, the portal
screens by `tools/capture_portal.mjs` signed in as each role — and every figure is generated
by `tools/build_manual_figures.py`. Neither is drawn by hand, because a picture
that is edited separately from the system drifts away from it and nobody notices until a
reader follows it and is wrong.

---

## Contents

**Part I — Desktop application**
1. What it is for, and what it refuses to do
2. Install and first run
3. Configure the deployment (country, branding, levels)
4. Register the laboratory and place it on the map
5. Catalogues and breakpoints
6. Enter data
7. Quality control and decision support
8. Analyse
9. One Health capture
10. Export
11. Join a central server (federation)
12. Privacy, retention, audit

**Part II — Central web portal**
13. Deploy the server
14. The site registry and enrolment
15. Asking questions
16. Dashboards, by stakeholder
17. The outbreak console
18. From a signal to an action plan
19. The public view
20. Audit and governance
21. Portal administration: users, roles, capabilities

**Part III — Methods and rationale**
22. Data model and standards
23. Breakpoint interpretation
24. Deduplication
25. Indicators
26. Outbreak detection
27. Privacy engineering
28. Federation protocol design
29. Dashboard computation
30. Limitations and threats to validity

**Appendices** — A commands · B environment · C role capabilities · D metric catalogue · E demo credentials

---

## Part I — Desktop application

### 1. What it is for, and what it refuses to do

A microbiology laboratory produces isolate records: a patient, a specimen, an organism, and a
panel of antimicrobial susceptibility results. AMRIT's desktop application is where those
records live. It is a local-first application — Electron over SQLite — and it is fully
functional with no network at all. A laboratory can install it, type records for a year,
analyse them, print an antibiogram and export a WHONET file without ever connecting to
anything.

It refuses three things by construction:

- It never uploads a patient row. What leaves this application over the network is a count or
  a rate (§27, §28).
- It never interprets a susceptibility result against a breakpoint set nobody activated
  (§23).
- It never invents data. A value it cannot read, map or interpret is reported and left blank,
  not guessed.

![Figure 1](images/fig-architecture.png)

*Figure 1 — where patient data stops.*

![Desktop dashboard](images/app-dashboard.png)

### 2. Install and first run

Install the build for your platform (`.dmg`, `.exe`, `.AppImage`). On first run the
application creates its database under the operating system's application-data directory and
seeds the packaged catalogue: WHONET organisms, antimicrobials, specimen types, expert rules
and panels, hash-pinned so a tampered catalogue is refused rather than loaded.

Nothing else is created. There is no default account, no default laboratory and no sample
data — a deployment holding real results must never inherit invented ones.

### 3. Configure the deployment

**Deployment → country profile.** The profile decides the country, its administrative tiers
(what they are called and how many there are), the default guideline (CLSI or EUCAST),
identifier namespaces, branding and the retention period. A profile is data, not code: the
same binary serves any country, and `python3 tools/generate_country_reference.mjs` scaffolds a
new one.

![Deployment settings](images/app-deployment.png)

Two changes are irreversible and say so before they are saved: changing the identifier
namespace (existing identifiers keep the old one) and changing the country (geography and
overrides from the previous country are discarded).

### 4. Register the laboratory and place it on the map

**Laboratories → New laboratory.** A laboratory needs a code, a name and an address in the
country's own address shape — the form is generated from the profile, so an Indian deployment
asks for state and district and a Testland deployment asks for governorate and district.

![Laboratory editor](images/app-laboratory-editor.png)

The address resolves to an administrative unit from the bundled geo pack. That unit — not a
typed place name — is what every scope filter, dashboard roll-up and map placement uses
afterwards.

![Resolved placement](images/app-laboratory-editor-resolved.png)

Site coordinates are optional and consent-gated (Sync → Optional location sharing). With
consent given, **Use this computer's location** reads the operating system's location service;
the coordinates can always be typed instead, and the source (device or hand-entered) travels
with the heartbeat, because how a coordinate was obtained is part of what it means.

### 5. Catalogues and breakpoints

**Master Studio** holds the reference data: organisms, antimicrobials, specimens, panels,
expected-resistance rules, expert rules, and local additions. Packaged rows are read-only;
local rows are marked custom and can be deactivated but never silently overwrite the
catalogue.

![Master Studio](images/app-masters.png)

**Breakpoint Centre** is where guidelines arrive. EUCAST publishes its tables free of charge
and permits redistribution, so the application fetches and stages the current edition with one
button. CLSI's M100 is a paid standard: the application links to it and imports a workbook you
supply. Either way the set is *staged inactive* and must be activated deliberately (§23).

![Breakpoint Centre](images/app-breakpoints.png)

The screenshot above is a live fetch: EUCAST v15.0, 950 rows staged, `0 unmatched codes`,
`READY`, and an **Activate** button that has not been pressed. Until it is, nothing in this
set interprets anything.

![Staged rows](images/app-breakpoints-staged.png)

The preview lists what was staged — organism scope, agent, method, site and route, and the
R/I/S thresholds — so a reviewer checks rows rather than trusting a row count.

### 6. Enter data

Three routes, all landing in the same validated shape:

**Type a record.** Identity first (patient identifier, specimen number and date, specimen
type, organism), then residence, then AST. The antimicrobial panel offered is the one matching
the organism and specimen, from the panel catalogue.

![Isolate records](images/app-records.png)

The editor is where identity, specimen, organism and the antimicrobial panel are entered, and
where decision support answers as you type:

![Record editor](images/app-records-editor.png)

**Import a batch.** Map columns once, save the mapping as a profile, and reuse it. The preview
shows what will be imported, what will land as a draft and what is refused, per row and with a
reason, before anything is written.

![Import](images/app-imports.png)

**WHONET legacy.** Existing WHONET data files import directly, including their code sets.

### 7. Quality control and decision support

![Figure 6](images/fig-record-lifecycle.png)

*Figure 6 — one validation path, whichever door the data comes in by.*

Every write passes the same decision-support layer, whether typed, imported or seeded:

- **Interpretation.** A measurement with no explicit S/I/R is interpreted from the active
  breakpoint set — and left blank with a stated reason when the set has no matching row, when
  two equally specific rows disagree, or when the record does not state something the
  breakpoint depends on (§23).
- **Expected resistance.** An organism reported susceptible to an agent it is intrinsically
  resistant to raises an alert rather than being corrected silently.
- **Expert rules.** Configurable phenotype rules (ESBL, carbapenemase, MRSA, inducible
  clindamycin) add comments and alerts.
- **Contaminant and duplicate checks.** Likely skin flora in a sterile-site culture is
  flagged; an identical patient/specimen identity is refused as a duplicate.

### 8. Analyse

**Analytics** runs deterministic, reproducible analyses over the local database: resistance
rates by organism and agent, antibiograms, specimen and organism distributions, priority
indicators, time trends, and a local outbreak scan.

![Analytics](images/app-analytics.png)

With an analysis run, the same screen carries the antibiogram, the priority indicators and
the resistance table computed over the current filter set:

![Analysis results](images/app-analytics-results.png)

Two things are always explicit on screen because they change every number: the
**deduplication mode** (§24) and the **date window**. A saved macro stores a whole filter set
so the same analysis can be re-run next month and compared honestly.

### 9. One Health capture

AMR is not only a human-health problem. The **One Health** workbench captures veterinary,
environmental, food-chain, antimicrobial-consumption and laboratory-quality events against
the same facility registry, with its own operator accounts and its own governance.

![One Health](images/app-oneHealth.png)

### 10. Export

| Format | What it is for |
| --- | --- |
| WHONET | Exchange with the WHONET/GLASS ecosystem |
| FHIR (Observation / MeasureReport) | Interoperable clinical and aggregate reporting |
| HL7 v2 | Feeding a hospital information system |
| Measure bundle | Aggregate indicator reporting to a programme |
| CSV / JSON | Analysis in R, Python, Excel |

![Exports](images/app-exports.png)

An export is a deliberate act by the operator, and it may contain patient-level data — that is
the difference between an export and federation (§28), and the audit log records both.

### 11. Join a central server (federation)

![Sync](images/app-sync.png)

1. **Request access.** The desktop registers its lab code with the server and receives a
   one-time *pickup token*. Nothing is granted yet.
2. **An administrator approves** it in the portal, which creates the site and mints a *site
   token* delivered out of band.
3. **Collect the token.** The desktop redeems its pickup token for a bearer token it mints and
   stores in the operating system's credential vault. The server keeps only a hash.
4. **Allow-list the query types** this laboratory will answer. A query type not on the list is
   refused, logged and answered with an error.
5. **Start sync.** A long-poll worker asks for questions; a WebSocket connection lets the
   server nudge for an immediate answer. A four-hourly heartbeat reports presence.

![Figure 2](images/fig-enrolment.png)

*Figure 2 — enrolment and the two-token credential exchange.*

### 12. Privacy, retention, audit

- **Retention.** The profile sets a retention period; expiry removes row-level data on a
  schedule, with a dry run that reports what would go first.
- **Erasure.** A named subject's rows can be erased on request, with the erasure itself
  audited.
- **Audit.** Every consequential act — saving a record, activating a breakpoint set, exporting
  a file, starting sync, answering a query — is written to an append-only local log.

![Audit](images/app-audit.png)

---

## Part II — Central web portal

### 13. Deploy the server

The portal is Django with Postgres and Redis, shipped as a Docker Compose stack.

```bash
cd server/amrit_central_server
cp .env.example .env
# set at least: DJANGO_SECRET_KEY, DJANGO_ALLOWED_HOSTS, POSTGRES_PASSWORD,
#               AMRIT_COUNTRY_PROFILE (e.g. IN), AMRIT_ENROLMENT_SECRET
docker compose up -d --build
docker compose run --rm web python manage.py bootstrap   # first administrator
```

The entrypoint migrates, collects static assets and — only when `AMRIT_SEED_DEMO=1` — seeds
the demonstration pack for the configured country. A country with no pack is reported and
skipped, never filled with another country's hospitals.

The stack publishes on loopback only. Nothing in it terminates TLS; put a reverse proxy in
front before exposing it, because both operator sign-in and site enrolment carry credentials.

### 14. The site registry and enrolment

**Registry → Sites** lists every laboratory, its administrative unit, when it was last seen
and whether it is online.

![Sites](images/portal-sites.png)

**Registry → Requests** is the enrolment queue: laboratories that have asked to join and are
waiting for a decision. Approving creates the site and shows its site token exactly once.

![Site requests](images/portal-site-requests.png)

Both credentials can be reset independently, and each reset stops that site syncing until the
new value reaches it — which the screen says before the button is pressed.

**Registry → Map** places every consenting site.

![Map](images/portal-map.png)

### 15. Asking questions

**Queries → New query** composes a question and targets it: all sites, an administrative unit,
or named laboratories.

![New query](images/portal-query-new.png)

| Query type | Answer |
| --- | --- |
| `isolate_count` | How many isolates match the filters |
| `organism_distribution` | Counts by organism |
| `specimen_distribution` | Counts by specimen type |
| `resistance_rate` | Numerator, denominator and percentage for an organism/agent pair |
| `measure_bundle` | The same as a FHIR MeasureReport |
| `cluster_scan` | Daily case counts by site and phenotype, for outbreak detection |
| `heartbeat` | Presence only |

Queries expire (`AMRIT_QUERY_TTL_SECONDS`), and each site's answer is recorded separately, so
a partial answer is visibly partial.

![Queries](images/portal-queries.png)

### 16. Dashboards, by stakeholder

![Figure 7](images/fig-roles.png)

*Figure 7 — who sees what, and at which scope.*

A role is not a filter on one screen. Each stakeholder gets a different composition at a
different scope, because the question each is asking is different.

**Policy maker — national scope.** Headline resistance, burden, coverage, trend.

![Policy maker dashboard](images/portal-role-policy-maker.png)

The advanced section opens the full resistance matrix and phenotype panels.

![Advanced view](images/portal-role-policy-maker-advanced.png)

**Epidemiologist — national scope with signals.** Priority-pathogen phenotypes (CRE, MDR),
anomaly signals and the outbreak console.

![Epidemiologist dashboard](images/portal-role-epidemiologist.png)

**Researcher.** The epidemiology composition without the operational action queue.

![Researcher dashboard](images/portal-role-researcher.png)

**Public health expert — national scope.**

![Public health dashboard](images/portal-role-public-health.png)

**Administrative health officer — sub-national scope.** The same dashboard at whatever level
the viewer's own administrative unit sits, ranking one level down. A three-tier country needs
three *units*, not three dashboards.

![Administrative officer dashboard](images/portal-role-admin-officer.png)

**Hospital administrator — single-facility scope.** One facility's profile, benchmarked
against the national figure.

![Hospital dashboard](images/portal-role-hospital-admin.png)

**Press and citizen.** The public summary only (§19).

![Press view](images/portal-role-press.png)

**Refresh live** dispatches a fresh batch of queries to the in-scope sites, waits for the
answers, and recomputes the snapshots for that scope (Figure 3). Historical results are never
folded into a new refresh's numbers.

![Figure 3](images/fig-query-lifecycle.png)

*Figure 3 — one dashboard refresh, end to end.*

### 17. The outbreak console

![Outbreaks](images/portal-outbreaks.png)

The console runs the space–time permutation scan (§26) over `cluster_scan` aggregates and
lists clusters with their window, sites, observed and expected counts, p-value and recurrence
interval. Settings — baseline, maximum cluster length, minimum cases, permutations — are on
the screen, because a signal without its parameters is not interpretable.

### 18. From a signal to an action plan

Threshold rules turn a metric crossing into a **draft** action plan — never an automatic
instruction. A person edits, assigns and schedules it; tracking records what was done.

![Action inbox](images/portal-action-inbox.png)
![Action tracking](images/portal-action-tracking.png)

### 19. The public view

A deliberately reduced summary for press and citizens: national headline figures, no
site-level detail, everything already suppressed below the k-anonymity floor.

![Public view](images/portal-public.png)

### 20. Audit and governance

![Audit](images/portal-audit.png)

Every dispatch, answer, approval, token reset, rename and deletion is recorded with actor,
time and detail. **Licences** lists every bundled dataset and its terms.

![Licences](images/portal-licences.png)

### 21. Portal administration

![Portal admin](images/portal-admin-home.png)

Users and roles are managed in the portal itself. A role is a set of capabilities plus a
dashboard kind plus a scope; a deployment can rename roles and change what each may see
without a code change.

![Users](images/portal-admin-users.png)
![Roles](images/portal-admin-roles.png)

---

## Part III — Methods and rationale

This part states, for each analytical choice: what the method is, what the alternatives were,
and why this one was taken. It is the material a paper would cite.

### 22. Data model and standards

Records are stored in the WHONET code space (organism, antimicrobial and specimen codes) so
data is exchangeable with the GLASS ecosystem without a mapping step. Interoperable output is
produced on demand: FHIR `Observation` for results, `MeasureReport` for aggregates, HL7 v2 for
hospital systems. Organism concepts carry SNOMED CT codes and antimicrobials carry ATC and
WHO AWaRe classification, so an indicator can be defined in terms a programme already uses.

*Why not a bespoke schema?* Because the value of an AMR record is comparability. A national
system whose codes are its own becomes an island, and the mapping cost is paid later, by
somebody with less context.

### 23. Breakpoint interpretation

![Figure 5](images/fig-breakpoints.png)

*Figure 5 — from a published table to an interpreted result.*

Its properties:

- **Guidelines are versioned data.** A staged set carries its source hash, edition, row
  provenance and import report, so a result interpreted in 2026 can be re-read in 2030 against
  the table that actually produced it.
- **Organism scopes are membership rules**, not expanded species lists. EUCAST writes
  "Enterobacterales", "Coagulase-negative staphylococci", "Enterobacterales except
  Morganellaceae"; those are stored as predicates over the organism catalogue's taxonomy. A
  species-specific row always beats a group row for the same organism.
- **Refusal over guessing.** Conflicting equally specific rows, a route the record does not
  state, or a missing matching row all produce a blank result with a stated reason.
- **Activation is a human act.** A set with unmatched rows cannot be activated at all.

*Alternatives considered.* Compiling breakpoints into the application makes every guideline
revision a software release, which no laboratory can wait for. Accepting a spreadsheet without
provenance makes a result unauditable. The staging-plus-activation design is the middle path:
data-driven, but never live until somebody takes responsibility for it.

### 24. Deduplication

Two modes, chosen per analysis and always shown with the result:

- `firstPatientOrganism` — **first isolate per patient per organism** within the window. This
  is the CLSI M39 / WHO GLASS convention.
- `allIsolates` — every isolate, for laboratory workload and quality questions.

*Why first-isolate is the default.* Repeat isolates from the same patient are not independent
observations: a single long ICU admission with daily cultures can contribute dozens of
resistant isolates and shift a national rate on its own. Reporting resistance without
deduplication systematically overestimates it in exactly the settings where the sickest
patients are — which is where policy attention lands.

*Why the alternative is kept.* A laboratory asking "how much work did we do?" or "how complete
is our AST?" needs every isolate. The mode is therefore a parameter of the question, not a
global setting.

### 25. Indicators

The priority indicators follow WHO GLASS pathogen–antimicrobial combinations: MRSA;
vancomycin-non-susceptible enterococci; third-generation-cephalosporin-non-susceptible *E.
coli* and *K. pneumoniae*; carbapenem-non-susceptible Enterobacterales, *P. aeruginosa* and
*Acinetobacter* spp.; fluoroquinolone-resistant *E. coli*; penicillin-non-susceptible *S.
pneumoniae*.

Each is a numerator and a denominator, both reported. Non-susceptible (R + I) is used where
GLASS uses it, and the tested-with agent set is stated, because "carbapenem resistance"
computed over meropenem alone and over meropenem-or-imipenem-or-ertapenem are different
numbers and only one of them matches the neighbouring country's.

### 26. Outbreak detection

**Method: Kulldorff's space–time permutation scan statistic**, case-only, prospective by
default.

![Figure 4](images/fig-outbreak.png)

*Figure 4 — the scan pipeline and the alternatives it was chosen over.*

For each candidate cluster — a site (or set of sites) and a time window up to
`max_cluster_days` — the expected count is the product of that location's total and that
period's total divided by the grand total. The test statistic is the generalised likelihood
ratio, and significance comes from Monte-Carlo permutation of dates within the observed grid
(999 by default), so the multiple-testing burden of scanning thousands of windows is handled
by the distribution of the *maximum* statistic rather than by a correction applied afterwards.
Output includes the recurrence interval (1/p), which is what an operational programme can act
on: "a cluster this extreme would be seen by chance about once every N days".

*Why case-only.* The Poisson and Bernoulli scan statistics need a population at risk per
location. A national AMR programme does not have one: it has isolates from laboratories with
different catchments, different testing rates and different referral patterns. Conditioning on
both margins removes exactly that — a site that reports twice as much of everything
contributes no signal, which is the property that makes the method usable across
heterogeneous reporting.

*Why not the alternatives.*

| Method | Why not |
| --- | --- |
| Fixed rule ("3 cases in 7 days") | Transparent but scale-blind: floods large sites, silent at small ones |
| EWMA / CUSUM per series | Detects *when* but not *where*; needs a stable per-site baseline |
| Poisson / Bernoulli spatial scan | Needs a denominator population AMRIT does not have |
| Unsupervised clustering | No inferential statement; a cluster is always found |

*Limitations, stated.* The scan detects excess relative to the rest of the observed data, so a
uniform national rise is invisible to it — that is what the trend metrics are for. It is
sensitive to `baseline_days` and `max_cluster_days`, so both travel with every signal. And it
operates on aggregate counts, so it can point a programme at a place and a period, never at a
patient.

### 27. Privacy engineering

Four mechanisms, layered:

1. **Aggregate-only federation.** The wire contract carries counts and rates. A middleware
   guard rejects any response payload carrying patient identifiers, so a bug in a laboratory
   build cannot become a national disclosure.
2. **k-anonymity floor.** Cells below `AMRIT_K_ANONYMITY_FLOOR` (default 5) are suppressed
   before storage, not before display — a suppressed number is never written down.
3. **Coarsening.** Patient residence is stored to a coarsened postal geography; facility
   coordinates are site-level and consent-gated. Patient coordinates do not exist.
4. **Retention and erasure.** Row-level data expires on the profile's schedule; a subject's
   rows can be erased on request, and the erasure is itself auditable.

*Why not de-identified record sharing?* Because de-identified AMR records are re-identifiable
in practice: a rare organism, a date and a district are frequently unique. Keeping rows in the
laboratory and shipping only answers removes the question rather than mitigating it.

### 28. Federation protocol design

The laboratory **pulls** questions (`GET /v1/poll`, long-poll, with a WebSocket nudge for
immediacy) and posts answers (`POST /v1/respond`). Both credentials — bearer token and
out-of-band site token — are required on every request.

*Why pull rather than push.* A pushing laboratory must hold a queue, a retry policy, a
credential for the server and an outbound firewall exception; when it is offline the programme
learns nothing about why. A pulling laboratory needs only outbound HTTPS, answers only
questions it has allow-listed, and its absence is visible as a missing answer rather than as
silence.

*Why not a central warehouse.* A warehouse is the design that makes every other privacy
control a promise. The moment rows are centralised, the protection is policy; while they stay
local, it is architecture.

*Why the two-token scheme.* One token that both authenticates and travels the same channel as
enrolment can be replayed by whoever intercepts enrolment. Splitting the factors across two
channels means a compromise of either one alone is not enough.

### 29. Dashboard computation

Metrics are declared in a catalogue (`metrics/catalog.py`) as key, query type, filters and
presentation. A refresh dispatches the de-duplicated set of wire queries the catalogue implies,
waits for the batch, then computes each metric from *that batch only* and writes a
`KPISnapshot` per metric and scope. Snapshots carry their computation time, source and site
count, so a dashboard tile can always answer "as of when, from how many sites".

Scopes are canonical (`country`, `admin:<level>`, `site`) and derived from the country
profile's tier chain, so a one-tier and a five-tier country use the same code path.

### 30. Limitations and threats to validity

Stated plainly, because a paper needs them:

- **Denominator heterogeneity.** Resistance rates depend on which isolates a laboratory tests
  and refers. Coverage metrics (sites reporting, AST completeness) are published alongside the
  rates for that reason.
- **Breakpoint version effects.** A guideline revision can move a national rate without any
  change in biology. Every result carries the set that produced it.
- **Deduplication sensitivity.** First-isolate versus all-isolate changes rates materially;
  comparisons across systems must match modes.
- **Suppression bias.** k-anonymity suppression removes small cells, which are not missing at
  random — sparse regions lose more.
- **Signal ≠ outbreak.** A scan statistic identifies statistical excess; confirmation is an
  epidemiological act.

---

## Appendix A — Commands

```bash
# Desktop
pnpm --dir app install && pnpm --dir app dev      # development
pnpm --dir app run check && pnpm --dir app test   # types, lint, tests

# Portal
python3 manage.py migrate
python3 manage.py bootstrap                       # first administrator
python3 manage.py seed_demo [--country IND] [--strict]
python3 manage.py refresh_snapshots --live
python3 manage.py purge_sites --apply             # clears the registry
python3 manage.py purge_dashboard_data --apply    # clears snapshots and results

# Documentation
python3 tools/build_manual_figures.py
AMRIT_PORTAL_URL=… AMRIT_PORTAL_USER=… AMRIT_PORTAL_PASSWORD=… \
  app/node_modules/.bin/electron tools/capture_portal.mjs
python3 tools/build_manual.py
```

## Appendix B — Environment

| Variable | Meaning |
| --- | --- |
| `AMRIT_COUNTRY_PROFILE` | Country profile id (`IN`, `TESTLAND`, …). Must be passed to the container |
| `AMRIT_SEED_DEMO` | `1` seeds the demonstration pack — published passwords, demo only |
| `AMRIT_K_ANONYMITY_FLOOR` | Minimum cell size before suppression (default 5) |
| `AMRIT_QUERY_TTL_SECONDS` | How long a dispatched query stays answerable |
| `AMRIT_LONGPOLL_MAX_WAIT`, `AMRIT_LONGPOLL_TICK` | Long-poll hold time and poll granularity |
| `AMRIT_REFRESH_WAIT_SECONDS` | How long a live refresh waits for answers |
| `AMRIT_ENROLMENT_PICKUP_TTL_SECONDS` | Lifetime of a one-time pickup token (default 24 h) |

## Appendix C — Roles and dashboards

| Role | Dashboard | Scope |
| --- | --- | --- |
| Super administrator, programme administrator | Country | National |
| Policy maker, public health expert | Country | National |
| Epidemiologist, researcher | Epidemiology | National, with signals |
| Administrative health officer | Administrative | The viewer's own unit |
| Hospital administrator | Hospital | One facility |
| Press, citizen | Public summary | National, suppressed |

## Appendix D — Metric catalogue (extract)

`res_*` resistance rates per pathogen–agent pair · `phen_cre`, `phen_mdr` phenotypes ·
`burden_isolates`, `burden_organism_mix`, `burden_specimen_mix` · `antibiogram` ·
`cov_sites_reporting`, `cov_sites_online`, `cov_geo`, `cov_ast_completeness`.

## Appendix E — Demonstration credentials

Seeded only by `seed_demo`, with passwords published in this repository. Never enable on a
deployment holding real data.

| User | Role |
| --- | --- |
| `superadmin` | Super administrator |
| `policy_maker` | Policy maker |
| `epidemiologist` | Epidemiologist |
| `researcher` | Researcher |
| `public_health` | Public health expert |
| `state_officer`, `district_officer` | Administrative health officer |
| `hospital_admin` | Hospital administrator |
| `press`, `citizen` | Public views |
