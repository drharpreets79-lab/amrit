# National AMR Ecosystem for India

## An implementation blueprint using AMRIT edge applications and a national web coordination platform

**Prepared for:** Office of the Principal Scientific Adviser to the Government of India and participating national, State/UT, district, laboratory, clinical, veterinary, food, agriculture, fisheries, environment and research stakeholders  
**Planning horizon:** 48 months from approval, with a first operational release in 9 months  
**Version:** 1.0 | 13 July 2026  
**Status:** Architecture and programme blueprint for consultation, costing, pilot approval and phased execution

> **EXECUTIVE DECISION.** Retain the desktop-plus-web-server combination, but treat it as the nucleus of a wider federated AMR ecosystem—not as the complete ecosystem. The present AMRIT application is a credible offline-first human microbiology and aggregate-surveillance node. The central Django server is a useful coordination, privacy and dashboard layer. National deployment should harden and generalise both while adding antimicrobial consumption and use, stewardship, IPC/HAI, animal/fisheries/food/environment surveillance, residues, genomics, quality assurance, supply-chain, programme monitoring and multi-tier response functions.

## 1. Purpose and intended use

This document answers two questions. First, is the current AMRIT desktop application plus central web server sufficient for a nationwide AMR ecosystem? Second, what programme, operating model and technical roadmap would make that combination sufficient?

It is written as an execution blueprint. Every major recommendation is translated into a work package, accountable owner, dependency, acceptance gate or measurable outcome. It can therefore be used to commission a detailed project report, form technical working groups, prepare requests for proposals, create a product backlog, implement pilots, and govern scale-up.

The design is aligned with the National Action Plan on Antimicrobial Resistance 2.0 (2025–2029), the National One Health Mission governance framework, ICMR and NCDC surveillance functions, ABDM's federated and standards-based principles, and international reporting systems such as WHO GLASS, WOAH ANIMUSE and FAO InFARM. [R2–R13]

### 1.1 Planning assumptions

- India will preserve sectoral ownership of source data while creating a common national coordination and analytics layer.
- Patient-level clinical records normally remain at the facility or authorised programme repository; routine national analytics use de-identified aggregates or privacy-protected event data.
- A narrowly defined, legally authorised line-list exchange may be permitted for outbreak investigation, patient safety or statutory reporting, but it is not the default surveillance path.
- States/UTs can adopt the platform at different maturity levels without losing national interoperability.
- Existing national and sectoral systems—rather than a new monolith—remain systems of record wherever they are functional.
- Public and private laboratories, hospitals, pharmacies, veterinary services, farms, food laboratories, environmental laboratories and research networks must be representable.
- The platform must work in intermittent-connectivity settings and on ordinary hardware.
- The first programme increment will prioritise bacterial AMR and antibacterial use while keeping the information model extensible to fungi, tuberculosis, malaria, HIV and other antimicrobial domains.

## 2. Executive assessment: is the current combination sufficient?

### 2.1 Overall verdict

**No—not as it currently stands. Yes—as the correct architectural starting point.**

The present combination has the right strategic shape: a local application close to where data is generated, plus a central web system that coordinates queries and returns aggregated, role-appropriate intelligence. This matches India's decentralised delivery reality and ABDM's preference for federated architecture. It also reduces the risk of constructing a single national patient-level AMR warehouse.

However, the current implementation is predominantly a clinical microbiology surveillance system. A national AMR ecosystem must connect resistance, antimicrobial consumption/use, diagnostic stewardship, prescribing, IPC/HAI, access and stock, residues, environmental pathways, animal and food production, genomics, quality systems, policy implementation and field action. It must also support a national operating model, not only software deployment.

### 2.2 What the current AMRIT desktop already provides

The code and retained architecture graph show the following useful capabilities:

- Offline-first SQLite persistence for laboratory configuration, isolates, import profiles, macros, reference resources and application preferences.
- Manual isolate entry and BacLink/WHONET-style import, with organism, specimen, location and antibiotic-result handling.
- WHONET-compatible resources, breakpoints, expected resistance phenotypes, quality-control ranges, expert rules and antibiotic panels.
- Analysis, trend and crosstab functions; cumulative resistance measures; first-isolate and infection-origin logic.
- Expert alert evaluation for unusual resistance and low-frequency events.
- WHONET CSV, HL7 and FHIR export functions.
- A thread-safe sync worker that long-polls the central server, executes approved aggregate queries locally and returns aggregate JSON plus an aggregate-safe FHIR bundle.
- A documented principle that patient data stays on the device, with bearer authentication, TLS policy, retry behaviour and audit logging.
- Facility-level settings, consent for approximate geolocation and local LLM assistance that is separable from surveillance logic.

### 2.3 What the current central server already provides

The Django server contains a meaningful national-portal prototype:

- Per-site registry and hashed bearer-token authentication.
- Persistent query, dispatch, result and poll-audit models.
- PII guardrails that reject banned identifiers in site responses.
- Aggregate analytics for isolate counts, organism and specimen distributions and resistance rates, with a configurable k-anonymity floor and Wilson confidence intervals.
- FHIR R4 aggregate outputs for downstream systems.
- Role and geographic scope controls for national, State/UT, district, epidemiology, hospital, research, press and public views.
- KPI snapshots, data freshness, live refresh runs and reporting-site coverage.
- Threshold rules, action plans, action points and Action Taken Reports tied to aggregate evidence.
- Postgres, Redis, ASGI/Channels, scheduled refresh and Docker packaging suitable for pilot deployment.

### 2.4 Critical gaps before national use

| Domain | Present state | National requirement | Disposition |
|---|---|---|---|
| Human AMR laboratory surveillance | Strong prototype | Representative public/private network, reference-lab hierarchy, EQA, GLASS-compatible datasets | Extend and harden |
| Antimicrobial consumption/use | Not a first-class data stream | National, state, district, facility and community AMC/AMU; ATC/DDD and AWaRe | New subsystem |
| Stewardship and prescribing | Limited to susceptibility decision support | Prescribing appropriateness, antibiotic time-outs, audit/feedback, facility AMS workbench | New subsystem |
| IPC and HAI | Partial infection-origin concepts only | HAI case definitions, device denominators, IPC assessments, outbreaks and interventions | New subsystem |
| Animal/fisheries AMR and AMU | Reference vocabularies only | Veterinary lab, farm/flock/herd/aquaculture data, prescriptions, sales/use and biosecurity | New sector applications/connectors |
| Food and residues | Minimal | FSSAI food-chain surveillance, residue testing, commodity and source tracing | New sector applications/connectors |
| Environment | Minimal | Wastewater, effluent, surface water, soil, residues, AMR genes and facility discharge context | New sector applications/connectors |
| Genomics | Export/confirmation references only | Sample-to-sequence linkage, resistance genes, clusters, reference-lab workflow | New genomic service |
| Supply/access/quality | Absent | Stock-outs, availability, shortages, NSQ/spurious alerts and supply-chain consumption | New connector/data product |
| Programme governance | Role dashboards and plans exist | NAP/SAP-CAR milestone registry, budgets, evidence, committee decisions and escalation | Extend server |
| Interoperability | FHIR/HL7/WHONET foundations | National implementation guides, master-data services, legacy adapters, NDLM/FSSAI/CPCB/IHIP/ABDM alignment | Formal standards programme |
| Security and operations | Pilot controls | Government-grade IAM, MFA, device identity, PKI, SOC/SIEM, DR, SRE and accreditation | Major hardening |
| National scalability | Single deployment topology | Multi-region production, queue-based dispatch, observability, capacity tests and tenant isolation | Re-architect selected services |
| Data quality | Local validations and freshness | National quality rules, representativeness, EQA, lineage, correction workflow and certification | New cross-cutting service |

### 2.5 Architectural decision

The programme should **preserve the federated edge-and-centre pattern** and introduce three explicit planes:

1. **Sector edge plane:** AMRIT desktop and web/mobile sector applications close to laboratories, facilities, farms and field teams.
2. **Secure exchange plane:** standards-based gateways, identity, consent/legal-basis enforcement, validation, terminology and event/aggregate transport.
3. **National coordination plane:** cross-sector dashboards, alerts, programme monitoring, workflow, public reporting, authorised research access and international reporting.

The central server should not become the universal transactional system of record. It should be the national AMR **control tower, data-product catalogue and response orchestrator**.

## 3. National mission outcomes

### 3.1 Vision

Create a trusted, federated and action-oriented national AMR ecosystem that converts high-quality human, animal, food, plant and environmental data into earlier detection, safer antimicrobial use, stronger infection prevention, equitable access and accountable One Health action.

### 3.2 Outcomes by the end of 48 months

- Every State/UT has a functioning AMR cell or designated One Health unit with a digital workbench aligned to SAP-CAR and NAP-AMR 2.0.
- Participating human and veterinary laboratories exchange standardised, quality-scored AMR data without requiring a single national patient-level repository.
- National and State/UT programmes can measure both resistance and antimicrobial consumption/use, including AWaRe and ATC/DDD indicators in human health and harmonised animal-use indicators.
- Sentinel food and environmental networks report AMR organisms/genes and antimicrobial residues using common sampling and metadata standards.
- Reference laboratories can link phenotypic signals to genomics and notify emerging threats through a governed alert workflow.
- Facilities receive local antibiograms, data-quality feedback and stewardship recommendations; State/UT and national users see representative, uncertainty-aware trends.
- Alerts generate owned actions, deadlines, escalation and evidence-backed closure from facility to national level.
- Programme leaders can monitor NAP-AMR/SAP-CAR outputs, outcomes, funding, coverage and delays in real time.
- Public users receive safe, comprehensible, non-stigmatising aggregates with suppression and uncertainty rules.
- India can produce reproducible national submissions for WHO GLASS, WOAH ANIMUSE, FAO InFARM and other authorised reporting requirements.

### 3.3 Design principles

- **Action before display:** every alert or deteriorating KPI must have an owner, playbook, due date and closure evidence.
- **Sector strength before superficial integration:** each sector needs a credible surveillance process before cross-sector comparisons are treated as evidence.
- **Federated by default:** raw records stay near their lawful custodian; centralisation requires an explicit purpose and authority.
- **Minimum necessary data:** collect only what supports a defined surveillance, care, regulatory or programme objective.
- **Standards at the boundary:** internal systems may vary, but exchanged data must conform to national profiles and code systems.
- **Offline and low-bandwidth first:** synchronisation is resumable, idempotent and tolerant of long gaps.
- **Measure quality and representativeness:** no national rate without denominator, provenance, coverage, quality and uncertainty.
- **Open architecture:** documented APIs, open standards, portable data, modular procurement and no vendor lock-in.
- **Human accountability for algorithms:** models rank or forecast risk; authorised officers own decisions.
- **Privacy, security and audit by design:** controls are product features and procurement requirements, not post-launch additions.

## 4. Target operating model

The digital ecosystem must mirror the National One Health Mission's multi-tier governance rather than invent a parallel chain. The model below aligns national steering, sector ownership, State/UT units, district committees and facility teams. [R2–R4]

### 4.1 National governance

| Body | Proposed AMR ecosystem responsibility | Digital product support |
|---|---|---|
| NAP-AMR high-level review under NITI Aayog | Approve outcomes, resolve cross-ministry barriers, review biannual progress | National programme scorecard and decision docket |
| Office of PSA research coordination | Coordinate cross-ministry research, innovation and non-duplication | Research portfolio, data-access review and evidence registry |
| MoHFW/NCDC AMR coordination unit | Nodal programme management, human surveillance, GLASS, IPC/AMS coordination | National operations console, standards registry and incident oversight |
| ICMR/AMRSN | Scientific methods, reference surveillance, quality and research | Reference analytics, methods, antibiogram and genomic linkage |
| DAHD/DoF/ICAR | Animal/fisheries AMR/AMU, labs, biosecurity and stewardship | Veterinary/fisheries data products and ANIMUSE-ready exports |
| FSSAI | Food AMR and residue surveillance | Commodity sampling, lab and traceability data product |
| MoEFCC/CPCB/SPCBs | Environmental surveillance and effluent risk | Environmental sampling and facility-discharge data product |
| CDSCO/DoP | Quality, distribution, sales and regulatory indicators | Antimicrobial supply/quality data product |
| NHA/ABDM | Human-health interoperability and registries | HFR/HPR alignment, health exchange patterns and sandbox validation |
| National Institute for One Health | Operational integration, capacity building and joint risk assessment | Knowledge hub, training registry and joint assessment workbench |

### 4.2 National AMR Digital Mission Unit

Create a dedicated multidisciplinary mission unit rather than assigning national delivery to a generic IT vendor. Minimum functions:

- Product management and service design.
- AMR epidemiology and biostatistics.
- Clinical microbiology and laboratory quality.
- Antimicrobial stewardship and IPC.
- Veterinary, fisheries, food and environmental subject-matter leadership.
- Enterprise architecture, interoperability and terminology.
- Data governance, legal, ethics and public communication.
- Cybersecurity, privacy, platform engineering and SRE.
- Programme management, procurement, finance, adoption and capacity building.
- Monitoring, evaluation and learning.

The unit maintains a public roadmap, controlled technical standards, release calendar, risk register, architecture decisions, implementation guides and change-control process.

### 4.3 State/UT, district and facility model

| Tier | Operating responsibility | Minimum digital role |
|---|---|---|
| State/UT Executive Committee | Policy, resourcing, cross-department direction | Approves SAP-CAR milestones and high-severity actions |
| State/UT Intersectoral Committee | Quarterly coordination, prioritisation and data-sharing decisions | Reviews cross-sector signals, data quality and action backlog |
| State/UT One Health/AMR Unit | Continuous operations and secretariat | Operates State console, standards support, onboarding and reporting |
| District One Health/AMR Committee | Local investigation, response and resource coordination | Owns district alerts, assignments, SLA and action closure |
| Block/LSG structures | Community implementation and reporting | Mobile/offline tasks, risk communication and local evidence |
| Facility/laboratory AMS/IPC team | Data capture, validation, local action and feedback | Edge app, local antibiogram, stewardship and quality workbench |

### 4.4 Data stewardship and accountability

Every dataset or data product must have:

- A named business owner, data steward and technical custodian.
- A defined purpose and lawful basis.
- A minimum dataset and controlled vocabulary.
- A refresh frequency and service-level objective.
- Quality rules and correction workflow.
- Access classifications and approved consumer roles.
- Retention, archival and deletion rules.
- A versioned data-sharing agreement.
- A published methodology, numerator, denominator and suppression rule.

## 5. Target technical architecture

### 5.1 Logical architecture

The target is a **federated data mesh with a national control plane**. Sector systems publish governed data products; the centre coordinates identities, standards, queries, alerts, workflows and authorised aggregation.

**Layer A — Source and edge systems**

- AMRIT Human Lab: clinical microbiology, AST, isolate alerts, exports and local antibiograms.
- AMRIT Stewardship: prescriptions, indication, review/stop dates, days of therapy, AWaRe, audit and feedback.
- AMRIT IPC/HAI: HAI cases, device denominators, IPC assessments, outbreaks and interventions.
- AMRIT Vet/Fisheries: animal/aquatic host, farm/flock/herd/pond, sample, AST, treatment and biosecurity.
- AMRIT Food: commodity, source, sample chain-of-custody, isolate/AST and residue findings.
- AMRIT Environment: matrix/site, discharge context, sampling, culture, genes and residues.
- Reference Lab/Genomics: sample referral, sequencing, quality, lineage, resistance determinants and cluster findings.
- Connectors to LIS/HMIS/pharmacy/ERP, IHIP/IDSP, ABDM registries, NDLM/NADRES, FSSAI systems, CPCB/SPCB systems, procurement and drug-regulatory systems.
- Mobile field capture for district veterinary, food, environment and community teams.

**Layer B — Local integration and privacy gateway**

- Source adapters for CSV, WHONET, HL7 v2, FHIR R4, APIs, secure files and manual entry.
- Schema validation, terminology mapping, deduplication, provenance and data-quality checks.
- Local pseudonymisation/tokenisation where longitudinal analysis is authorised.
- Query policy engine, disclosure control, k-anonymity and minimum-denominator enforcement.
- Store-and-forward queue with signed batches, retry, idempotency and reconciliation.
- Local audit trail and device health.

**Layer C — Secure exchange plane**

- API gateway and web application firewall.
- Organisation, user, service and device identity; MFA; certificate-based device authentication.
- Event broker for alerts and data-product updates; job queue for federated queries.
- Schema, terminology and implementation-guide registry.
- Consent/legal-basis and data-sharing policy enforcement where personal data is processed.
- Immutable security/audit stream and central observability.

**Layer D — National data-product and coordination plane**

- Federated query orchestrator and aggregate result store.
- Cross-sector event store for authorised, minimised alerts and investigations.
- KPI snapshot store and programme milestone/evidence store.
- Metadata catalogue, lineage, quality scores and dataset registry.
- Analytics warehouse/lakehouse for approved de-identified or aggregated products.
- Alert/risk engine, case management, action plans, SLA and escalation.
- National, State/UT, district, facility, researcher and public portals.
- Submission services for GLASS, ANIMUSE, InFARM and authorised national reports.

**Layer E — Knowledge and decision support**

- Versioned guidelines, breakpoints, SOPs, playbooks and standard treatment guidance.
- Reproducible statistical pipelines and validated forecasting services.
- Secure research workspaces with disclosure review.
- Training, competency, EQA and certification registries.

### 5.2 Data zones

| Zone | Permitted content | Typical location | Access model |
|---|---|---|---|
| Z0 Operational identifiable | Patient, animal owner, farm or facility operational record where legally required | Source facility/sector system | Direct care/authorised operations only |
| Z1 Pseudonymised analytic | Linkable records stripped of direct identifiers | State/sector trusted environment or approved secure enclave | Named project, time-limited access |
| Z2 De-identified event | Minimised unusual-event or investigation record | State/national event service | Role- and purpose-scoped |
| Z3 Aggregate confidential | Counts, rates, denominators, quality, uncertainty, small-cell suppressed | National and State analytic stores | Government/authorised analysts |
| Z4 Public aggregate | Delayed, coarsened, disclosure-checked indicators | Public portal/open data | Public |

The current AMRIT flow maps well to Z3. National expansion should retain that default while adding carefully governed Z1/Z2 workflows only where necessary.

### 5.3 Interoperability profile

The programme must publish a **National AMR Interoperability Implementation Guide** with conformance tests. Minimum standards include:

- FHIR R4 profiles for DiagnosticReport, Observation, Specimen, MedicationRequest/Dispense/Administration, Measure/MeasureReport, Organization, Location, Task, ServiceRequest and Provenance.
- WHONET-compatible organism, specimen and antimicrobial representations and export.
- HL7 v2 adapters for common LIS/HMIS interfaces during transition.
- LOINC for laboratory observations; SNOMED CT for clinical concepts; ICD-10/ICD-11 mappings where required; UCUM for units.
- ATC/DDD and WHO AWaRe for human antimicrobial consumption and stewardship.
- WOAH/ANIMUSE-aligned antimicrobial classes and biomass/animal population denominators.
- FAO InFARM-compatible animal/food AMR structures.
- GLASS organism–specimen–antimicrobial combinations and reporting rules.
- HFR/HPR identifiers for human facilities and professionals where applicable; State/district/block codes from authoritative government masters.
- NDLM or authoritative sector identifiers for livestock/farms where available, with non-identifying surrogate identifiers for surveillance exchange.
- Versioned CLSI/EUCAST/ICMR breakpoint metadata and explicit method, standard and year for every interpretation.

### 5.4 Canonical minimum event envelope

Every exchanged batch, aggregate or alert should carry:

- `event_id`, `event_type`, `schema_version`, `source_system`, `source_record_version`.
- `organisation_id`, `facility_id`, `sector`, `jurisdiction`, `reporting_period`.
- `created_at`, `observed_at`, `submitted_at`, `received_at` in ISO 8601.
- `data_classification`, `purpose_code`, `legal_basis`, `retention_class`.
- `terminology_versions`, `methodology_version`, `software_version`.
- `quality_flags`, `completeness_score`, `validation_status`.
- `provenance`, `signing_certificate_id`, `payload_hash`, `correlation_id`.
- The event-specific payload and disclosure-control outcome.

### 5.5 National identifiers and master data

Establish master-data services for:

- Facilities, laboratories, pharmacies, veterinary facilities, food laboratories and environmental laboratories.
- Administrative geography and geospatial boundaries.
- Organisms, resistance genes, antimicrobials, classes, AWaRe groups and veterinary importance.
- Specimens/matrices, host species, production systems, commodities and environmental sample types.
- Test methods, panels, instruments, breakpoints, guidelines and quality materials.
- Programmes, indicators, action plans, playbooks and reporting organisations.

Master data must be versioned, signed and distributable offline. The edge app must preserve the version used for every result.

## 6. Product portfolio

### 6.1 AMRIT Edge 2.0 — common platform

Refactor the present desktop into a signed, auto-updatable, modular edge platform with shared services:

- Local encrypted database and secure backup/restore.
- User accounts, roles, inactivity lock and audit trail.
- Organisation and facility configuration with authoritative identifiers.
- Terminology/breakpoint packages with signed updates and rollback.
- Import/mapping studio, validation work queue and correction history.
- Offline dashboard and export functions.
- Secure sync agent with certificate identity, durable queue and reconciliation.
- Plugin/module framework so human, veterinary, food and environment functions share infrastructure without sharing inappropriate forms or rules.
- Remote health telemetry that reports software/version/sync health without transmitting sensitive records.

The current Tkinter code can support pilots, but national maintenance will be easier after a controlled migration to a testable cross-platform architecture with a stable domain layer, structured migrations, automated updates and accessibility/localisation support. This is a planned migration—not a prerequisite for the first pilot.

### 6.2 Human laboratory module

- Patient/sample/isolate capture or LIS import.
- AST method, measurement, interpretation, guideline/version and QC status.
- First-isolate, repeat-isolate and contaminant rules.
- Local cumulative antibiogram with CLSI M39-style denominator warnings.
- Phenotype and emerging-resistance alerts.
- Reference-lab referral and confirmatory result reconciliation.
- GLASS-compatible export and national federated query support.
- Laboratory quality indicators: contamination, turnaround, rejection, missingness, QC/EQA and instrument downtime.

### 6.3 Antimicrobial stewardship and consumption module

- Pharmacy purchase, issue, dispense and administration feeds.
- ATC/DDD metrics: DDD per 100 bed-days, patient-days and 1,000 inhabitants/day as appropriate.
- Days of therapy and length of therapy where administration data exist.
- AWaRe distribution and Access share.
- Indication, empirical/targeted status, culture-before-antibiotic, review/stop date and IV-to-oral switch.
- Antibiotic time-out, prospective audit and prescriber feedback.
- Facility antibiotic policy, formulary and Reserve authorisation.
- Point-prevalence survey workflow for low-digital-maturity facilities.
- Community and supply-chain AMC ingestion from authorised sales/distribution sources.

### 6.4 IPC and HAI module

- Uniform HAI case definitions and investigation forms.
- Patient-day, device-day, surgery and procedure denominators.
- CLABSI, CAUTI, VAP and SSI surveillance.
- Outbreak/cluster detection linked to microbiology and genomics.
- IPC self-assessment, hand-hygiene and environmental-cleaning audits.
- Action plans, responsible teams, due dates and verification.
- De-identified national indicators and facility confidential feedback.

### 6.5 Veterinary and fisheries module

- Host species, age/production class, herd/flock/pond and production system.
- Clinical, healthy-animal, farm and slaughter/market sampling frames.
- Sample, isolate, AST, method, breakpoint and quality metadata.
- Treatment reason, prescriber, product, active ingredient, dose, duration and route.
- Farm/facility biosecurity, vaccination, morbidity, mortality and population denominators.
- Sales/consumption and biomass-adjusted indicators aligned to national/WOAH requirements.
- Withdrawal-period and residue-related workflow where appropriate.
- Separation of regulatory, surveillance and research access.

### 6.6 Food and environmental modules

**Food:** commodity, production stage, establishment/source category, sampling programme, chain of custody, microbiology, AST, residue analyte, method, limit, result, enforcement action and closure.

**Environment:** matrix (influent/effluent/surface water/groundwater/soil/sludge), site type, upstream/downstream relationship, geospatial precision class, sampling protocol, flow/context, antimicrobial residue concentration, culture/AST, resistance genes, method detection limits and regulatory/action status.

Exact coordinates for sensitive sites should be role-restricted and coarsened for public use.

### 6.7 Reference laboratory and genomics module

- Referral order, packaging/cold-chain, receipt and turnaround tracking.
- Phenotypic confirmation and dispute resolution.
- Sequencing run, quality metrics, assembly/analysis pipeline version and accession.
- Organism, sequence type/lineage, resistance determinants and plasmid/mobile-element findings.
- Cluster definitions, distance thresholds and epidemiologist review.
- Alert linkage without exposing unnecessary sample identifiers.
- Submission metadata for authorised national/international repositories.

### 6.8 National web platform

Extend the present server into separate bounded capabilities:

- Identity and organisation administration.
- Site/device provisioning and software compliance.
- Federated query and scheduled surveillance jobs.
- Data-product catalogue, quality, lineage and access requests.
- National/State/district dashboards with Basic and Advanced views.
- Alert and joint risk-assessment workbench.
- Action plans, assignments, SLA, escalation, evidence and closure.
- NAP-AMR/SAP-CAR programme milestone and expenditure/evidence tracking.
- Public transparency portal.
- International reporting and reproducible annual-report generation.
- Secure research enclave with approved extracts and disclosure review.

## 7. Surveillance and analytics framework

### 7.1 Core surveillance streams

| Stream | Core measures | Primary action |
|---|---|---|
| Human phenotypic AMR | Resistance/non-susceptibility by organism, specimen, drug, place and time | Treatment policy, lab response, alerts |
| Animal/fisheries AMR | AMR by host, production system, commodity and sampling frame | Veterinary stewardship, biosecurity, food-chain action |
| Food AMR/residues | Resistant organisms/genes and residue exceedance by commodity/source | Enforcement, source investigation, guidance |
| Environmental AMR/residues | Organisms, genes and residues by matrix/source context | Effluent/waste action and risk assessment |
| Human AMC/AMU | DDD, DOT, AWaRe, indication and appropriateness | Stewardship, access and regulatory action |
| Animal/fisheries AMU | Active ingredient, class, purpose, route and denominator | Stewardship, regulation and ANIMUSE reporting |
| IPC/HAI | HAI incidence, device-associated rates, IPC implementation | Infection prevention and facility safety |
| Genomic/EAR | Resistance determinants, novel mechanisms and clusters | Verification, containment and communication |
| Laboratory quality | EQA, QC, turnaround, contamination, completeness | Quality improvement and accreditation |
| Programme implementation | NAP/SAP outputs, funding, coverage and deadlines | Accountability and resource allocation |

### 7.2 Denominators and representativeness

No rate should be published without a denominator and sampling context. The platform must distinguish:

- Routine diagnostic isolates from structured surveys.
- Clinical disease samples from healthy-animal/food/environment sampling.
- First isolate from repeat isolates.
- Tested isolates from all eligible isolates.
- Facility population, patient-days, bed-days, device-days or surgeries.
- Animal population/biomass, farm count and production units.
- Geographic population and participating-site coverage.

Every dashboard must display coverage, missingness, participating-site mix and confidence/uncertainty. National estimates must use an approved weighting or survey design; a simple pooled rate across convenience sites must not be labelled nationally representative.

### 7.3 Resistance calculation

For standard isolate-based resistance displays:

`Resistance percent = R / (R + I + S) × 100`

The calculation must record how `I` is treated for each published measure, follow the selected standard/version, apply approved deduplication, display the denominator and a confidence interval, and suppress or flag small denominators. The current AMRIT implementation is a sound starting point, but the methodology service must version every rule.

### 7.4 Alert framework

Alerts should combine deterministic public-health rules with statistically validated anomaly detection.

| Level | Example trigger | Required response |
|---|---|---|
| Information | Data-quality drop, delayed feed, low denominator | Data steward review |
| Watch | Sustained increase above baseline or threshold | Facility/district verification |
| Warning | Confirmed unusual phenotype, cross-facility cluster, Reserve-use surge | State investigation and action plan |
| Emergency | Novel/critical mechanism with transmission, major contamination or multi-State signal | National incident coordination |

Each alert carries the rule/model version, trigger data, confidence, affected scope, owner, acknowledgement deadline, verification result, playbook, actions, communications and closure evidence. Automatic escalation occurs when SLA expires.

### 7.5 Cross-sector risk assessment

Do not create a single opaque One Health score. Use a transparent structured assessment with separate dimensions:

- Hazard severity and novelty.
- Evidence strength and laboratory confirmation.
- Human/animal/environment exposure.
- Transmission/spread potential.
- Population and ecosystem vulnerability.
- Geographic convergence and temporal sequence.
- Response capacity and resource gaps.
- Data quality and uncertainty.

The system may calculate a prioritisation band from approved weights, but must show component scores and allow the authorised joint assessment team to document an override.

### 7.6 Forecasting and AI

Forecasts are introduced only after stable data and back-testing. Requirements:

- Pre-specified use case and decision horizon.
- Training-data lineage and population relevance.
- Temporal and geographic validation.
- Calibration, uncertainty and drift monitoring.
- Comparison with a simple baseline.
- Model card, limitations and subgroup/region performance.
- Human approval for operational recommendations.
- Reproducible versioned pipeline and ability to disable the model.

Local LLM features must never be the authoritative calculator for resistance rates, alerts or policy decisions. They may assist with plain-language summaries, coding suggestions or draft reports when source evidence is linked and human-reviewed.

## 8. Data governance, privacy, ethics and cybersecurity

### 8.1 Governance controls

- National AMR Data Governance Board with sector and State/UT representation.
- Data-product approval and change-control process.
- Data-sharing agreements and standard schedules per sector/use case.
- Role/purpose-based access with least privilege and periodic recertification.
- Data Protection Impact Assessment for each personal-data workflow.
- Ethics and scientific review for research access.
- Public release committee with small-cell and re-identification review.
- Incident notification, grievance and correction processes.

### 8.2 Privacy design

- Default to aggregate queries and local computation.
- Separate direct care, statutory surveillance, programme monitoring, research and public purposes.
- Do not use ABHA or Aadhaar as the national surveillance key.
- Use facility-local patient identifiers for care; use salted, rotating or purpose-specific tokens only when authorised longitudinal analysis is essential.
- Suppress small cells, coarsen geography/time and combine complementary suppression for public data.
- Prevent differencing attacks across overlapping queries through a privacy budget/query-history policy.
- Record every access, export, query and policy decision.
- Implement retention schedules by data zone, not one indefinite default.
- Align implementation with the DPDP Act/Rules transition, ABDM Health Data Management Policy and applicable public-health/legal authorities. [R7–R9]

### 8.3 Cybersecurity baseline

- Government-controlled domains, certificates and key management.
- MFA for users; mutual TLS and per-device certificates for edge nodes.
- No production default passwords or wildcard hosts.
- Encrypted databases/backups and TLS 1.2+ in transit.
- Central secrets manager; automated certificate/token rotation.
- Secure software supply chain: signed releases, SBOM, dependency and container scanning, reproducible builds and vulnerability SLAs.
- WAF, rate limiting, API schema validation and anti-automation controls.
- Endpoint hardening, application allow-listing and tamper-evident audit.
- SOC/SIEM integration, use-case playbooks and 24×7 incident escalation for national services.
- Independent VAPT before each major release and at least annually.
- Disaster recovery with tested restore, multi-zone database, offline runbooks and immutable backups.
- Compliance mapping to CERT-In directions/guidelines and applicable government security requirements. [R14]

### 8.4 Non-functional targets

| Attribute | Pilot target | National target |
|---|---|---|
| Central availability | 99.5% monthly | 99.9% monthly for core exchange/alert services |
| Edge offline operation | 30 days without loss | 90 days with controlled backlog |
| Sync delivery | 95% of valid batches within 24 h | 99% within defined sector SLO |
| Alert latency | Critical verified signal within 4 h of central receipt | Sector-specific SLO with escalation |
| Recovery point | 24 h pilot | ≤15 min for core central stores |
| Recovery time | 24 h pilot | ≤4 h for core services |
| Audit retention | Defined by DPIA/policy | Tamper-evident, policy-controlled |
| Scale test | 100 concurrent sites | ≥10,000 sites/devices simulated with headroom |
| Accessibility | Keyboard and readable contrast | WCAG 2.1 AA-equivalent for web interfaces |

## 9. Implementation roadmap

### Phase 0 — Mandate, baseline and standards (months 0–3)

**Objective:** create authority, ownership, scope, standards and evidence before large development.

Deliverables:

- Programme charter, funding route, decision rights and escalation matrix.
- National AMR Digital Mission Unit and technical working groups.
- Inventory of existing systems, datasets, networks, laboratories and contracts by sector and State/UT.
- Data availability/maturity matrix and current workflow maps.
- Prioritised national use cases and pilot State/UT selection criteria.
- National AMR information model v0.1, indicator catalogue and data classification.
- Security/privacy architecture, DPIA template and standard data-sharing schedules.
- Product roadmap, release governance, procurement packaging and bottom-up cost model.
- Baseline measurement for every pilot KPI.

**Exit gate:** named owners; approved pilot scope; signed data-sharing authority; minimum datasets and indicators approved; pilot sites committed; architecture/security review passed.

### Phase 1 — Harden the nucleus and prove human-health flow (months 4–9)

**Objective:** produce a secure, supportable first operational release based on the existing desktop/server combination.

Deliverables:

- AMRIT Edge 1.5 hardening: migrations, encrypted backup, user roles, signed terminology packages, durable sync, device identity and remote health.
- Central server production baseline: hardened settings, MFA/SSO integration, PKI, queue-based dispatch, observability, DR, API versioning and audit export.
- Human lab minimum dataset and conformance test kit.
- LIS/WHONET/CSV adapters and mapping workbench.
- Data-quality console and correction loop.
- National/State/district/facility dashboards with denominator, confidence, freshness and coverage.
- Alert verification and action-plan workflow.
- Initial GLASS-compatible export.
- Pilot operations manual, help desk, onboarding and training.

Suggested controlled footprint: 25–50 diverse laboratories across 3–6 willing States/UTs, including tertiary, medical college, district and selected private facilities. Final numbers must follow the baseline/costing exercise.

**Exit gate:** ≥90% valid exchange; no unresolved critical security findings; reproducible metrics match reference datasets; users close test alerts end-to-end; restore and offline reconciliation drills pass.

### Phase 2 — Multi-sector and stewardship pilots (months 10–18)

**Objective:** demonstrate a real One Health AMR loop rather than parallel dashboards.

Deliverables:

- Stewardship/AMC module in a representative subset of facilities.
- IPC/HAI module and denominator integration.
- Veterinary/fisheries module and selected NDLM/NADRES or sector connectors.
- Food and environmental sentinel modules with FSSAI/CPCB/SPCB partners.
- Reference laboratory and genomics linkage.
- Joint risk-assessment workbench and cross-sector alert playbooks.
- State/UT NAP/SAP programme scorecards.
- Public portal release with disclosure controls.
- Independent pilot evaluation: usability, quality, actionability, cost and unintended consequences.

Select use cases where sectors can plausibly act together, for example: carbapenem resistance across hospitals and wastewater; colistin/polymyxin resistance across human, poultry/aquaculture, food and environment; ESBL Enterobacterales across clinical and food-chain sampling; or a verified novel resistance mechanism requiring reference-lab response.

**Exit gate:** at least one cross-sector signal is investigated and closed through the platform; sector owners approve data quality; AMC/AMU measures are reproducible; external evaluation recommends scale with documented changes.

### Phase 3 — State/UT scale and ecosystem integration (months 19–30)

**Objective:** transition from pilots to a repeatable national adoption programme.

Deliverables:

- State/UT onboarding factory, readiness assessment and certification.
- Managed terminology/master-data distribution.
- National help desk, knowledge base, regional implementation partners and training-of-trainers.
- Integrations prioritised by reuse: major LIS/HMIS vendors, public programme systems, pharmacy/procurement feeds, veterinary and food/environment systems.
- Scalable infrastructure, multi-region DR, performance certification and cost monitoring.
- Research enclave and approved data-access workflow.
- Automated annual/state reports and international reporting packages.
- Procurement and support models for low-resource facilities.

**Exit gate:** every participating State/UT has an accountable unit, approved plan, trained team, support route and certified data product; national capacity and DR tests pass.

### Phase 4 — National operations and continuous improvement (months 31–48)

**Objective:** make the ecosystem routine, measured and independently accountable.

Deliverables:

- Coverage expansion according to approved national sampling and service priorities.
- Mature stewardship, IPC, supply/access and multi-sector surveillance products.
- Model governance and carefully introduced forecasting.
- Annual independent security, privacy, epidemiological and programme audits.
- Public methods, quality and progress reports.
- Benefits realisation review and transition plan beyond NAP-AMR 2.0.

**Exit gate:** national operations funding is recurrent; services meet SLOs; indicators are trusted; action closure and programme outcomes show sustained use rather than dashboard-only adoption.

## 10. Work breakdown structure and executable backlog

The following work packages are suitable as programme epics. Each should be decomposed into user stories, technical designs, tests, deployment steps, training and acceptance evidence.

| ID | Work package | Lead | Key deliverable | Acceptance evidence |
|---|---|---|---|---|
| GOV-01 | Programme charter and decision rights | NITI/MoHFW/PSA | Approved charter and RACI | Signed order, funded unit, meeting calendar |
| GOV-02 | Sector and State/UT governance onboarding | NCDC + sector units | Standard MoU/DSA and onboarding kit | Pilot agreements executed |
| GOV-03 | Indicator and methods board | NCDC/ICMR/sector experts | Versioned national indicator catalogue | Published definitions and change log |
| ARC-01 | Enterprise architecture | Mission Unit | Target architecture and ADR register | Independent architecture review |
| ARC-02 | National implementation guide | Standards TWG | FHIR/WHONET/AMU/sector profiles | Conformance suite passes |
| ARC-03 | Master-data service | Mission Unit + owners | Signed offline packages and APIs | Version/rollback test |
| EDGE-01 | Desktop security hardening | Product team | Encrypted, signed, role-aware client | Threat-model and VAPT closure |
| EDGE-02 | Data migration and backup | Product team | Reversible schema migrations | Upgrade/restore test on reference DBs |
| EDGE-03 | Import and mapping studio | Product team | Reusable LIS/CSV/WHONET mappings | ≥95% reference import accuracy |
| EDGE-04 | Durable sync and reconciliation | Product team | Idempotent queued exchange | Offline 30-day replay with no duplication |
| EDGE-05 | Remote device health | Platform/SRE | Version/sync telemetry | Fleet compliance dashboard |
| HLAB-01 | Human lab minimum dataset | Lab TWG | Forms, adapters and validation | Golden dataset concordance |
| HLAB-02 | Local antibiogram and alerts | Lab TWG | Versioned metrics and rules | Reference calculation match |
| HLAB-03 | EQA/quality module | NCDC/ICMR/NABL partners | QC/EQA and corrective action | Pilot lab sign-off |
| AMS-01 | AMC ingestion | AMS TWG/CDSCO/DoP | Product/sales/facility consumption model | ATC/DDD reproducibility |
| AMS-02 | Facility AMU and stewardship | AMS TWG | DOT/AWaRe/audit workflow | Point-prevalence and electronic validation |
| IPC-01 | IPC/HAI module | NCDC/IPC TWG | HAI forms, denominators and actions | Case/denominator audit concordance |
| VET-01 | Veterinary/fisheries minimum dataset | DAHD/DoF/ICAR | Host/farm/sample/AMR/AMU model | Sector pilot approval |
| FOOD-01 | Food AMR/residue module | FSSAI | Sampling, lab, traceability and action | Chain-of-custody test |
| ENV-01 | Environmental module | CPCB/SPCB/MoEFCC | Matrix/site/method/gene/residue model | Sentinel protocol conformance |
| GEN-01 | Reference/genomics workflow | ICMR/NCDC/CSIR | Referral-to-cluster data product | Round-trip sample reconciliation |
| SRV-01 | Identity and PKI | Platform security | MFA/SSO, service/device certificates | Rotation and revocation drill |
| SRV-02 | Federated query orchestration | Platform team | Queue, policy, retries, budgets | 10,000-site simulation |
| SRV-03 | Data-product catalogue | Data platform | Metadata, lineage, quality and access | Every KPI traceable to source/version |
| SRV-04 | Alert/case/action workflow | Programme product team | SLA, escalation, evidence and closure | Tabletop exercise completion |
| SRV-05 | Programme monitoring | NAP Secretariat | Milestones, budgets, outputs/outcomes | Ministry/State evidence review |
| ANA-01 | Reproducible metrics service | Epidemiology team | Versioned statistical pipelines | Independent code/data validation |
| ANA-02 | Representativeness framework | Epidemiology team | Sampling/weighting and labelling rules | Methods board approval |
| ANA-03 | Joint risk assessment | One Health TWG | Transparent component scoring | Cross-sector exercise sign-off |
| PUB-01 | Public portal | Communications + data governance | Safe public indicators/methods | Disclosure and usability review |
| INT-01 | GLASS reporting | NCDC/ICMR | Validated export and audit package | Parallel submission concordance |
| INT-02 | ANIMUSE/InFARM reporting | DAHD/DoF/ICAR/FSSAI | Validated sector exports | Authority sign-off |
| SEC-01 | Secure SDLC and supply chain | CISO/Product | SBOM, signing, scanning and patch SLA | Release attestation |
| SEC-02 | SOC and incident response | National SOC | Detection rules and runbooks | Red-team/tabletop closure |
| PRIV-01 | DPIA and disclosure control | Data Governance Board | Zone/purpose controls and query policy | Privacy test and audit |
| OPS-01 | Production platform and DR | SRE | HA deployment, backups and DR | RPO/RTO drill |
| OPS-02 | Help desk and field support | Programme operations | Tiered support and SLAs | Ticket resolution and satisfaction targets |
| ADP-01 | Training and certification | NIOH/NIHFW/sector institutes | Role-based curricula and LMS | Competency assessment |
| ADP-02 | State onboarding factory | Mission Unit | Readiness, install, verify, certify | Repeatable onboarding lead time |
| MEL-01 | Baseline and benefits evaluation | Independent M&E partner | Baseline, midline and endline | Published evaluation reports |

## 11. Testing and assurance strategy

### 11.1 Test pyramid

- Unit tests for every calculation, validation, mapping and permission rule.
- Contract tests for every API/schema/terminology version.
- Golden datasets covering common and rare organisms, MIC/zone edge cases, revised breakpoints and missing data.
- Property-based tests for deduplication, suppression and filter combinations.
- Cross-implementation concordance tests between edge, central and official reporting outputs.
- Migration, backup/restore, offline replay and duplicate-delivery tests.
- Security tests: SAST, DAST, dependency/container scanning, secrets detection, fuzzing, VAPT and red team.
- Performance tests using realistic site latency, connectivity gaps and burst schedules.
- Accessibility, multilingual, usability and low-literacy field tests.
- Epidemiological validation and independent methods review.
- Operational exercises for outbreak, compromised device, central outage and bad terminology update.

### 11.2 Release gates

No production release without:

- Approved requirements and architecture decision.
- Threat model and privacy impact review.
- Complete automated regression and conformance tests.
- Migration/rollback and support runbook.
- Training and release notes.
- Product owner, epidemiology owner, security and operations sign-off.
- Measured pilot acceptance and no open critical defect.

## 12. Adoption, capacity building and support

Technology adoption is a service transformation programme. The platform must reduce duplicate reporting, return local value and make quality gaps visible without punitive use.

### 12.1 Role-based learning pathways

- Laboratory technician: standards, data capture/import, QC, correction and sync.
- Microbiologist: breakpoint governance, antibiogram, alerts, EQA and interpretation.
- Clinician/pharmacist: AWaRe, stewardship metrics, audit and feedback.
- IPC nurse/officer: definitions, denominators, investigation and actions.
- Veterinary/field/food/environment officer: sector sampling, metadata, chain of custody and response.
- Data steward: quality, lineage, master data and correction.
- District/State programme officer: dashboards, alerts, risk assessment and action closure.
- National analyst: representative analysis, uncertainty, disclosure and reporting.
- Administrator/SRE/security: provisioning, observability, incident and recovery.

### 12.2 Support model

- Tier 0 in-product guidance, validation messages and searchable knowledge base.
- Tier 1 State/UT help desk and trained super-users.
- Tier 2 national product/data support.
- Tier 3 engineering, security, interoperability and methods specialists.
- Published severity/SLA matrix, escalation and problem-management process.
- Remote diagnostics limited to non-sensitive telemetry unless explicit supervised access is authorised.

## 13. Procurement and delivery model

Avoid a single end-to-end black-box procurement. Package work into interoperable lots with a government-owned architecture and shared acceptance suite:

- Core product and edge platform.
- National cloud/platform operations.
- Security and independent assurance.
- Interoperability/connectors and terminology.
- Sector modules.
- State/UT implementation and training.
- Independent M&E and scientific validation.

Contracts should require source-code escrow or government ownership as appropriate, open APIs, data portability, documentation, SBOM, vulnerability obligations, performance SLOs, exit assistance and prohibition of secondary data use. Payment milestones should be tied to verified outcomes and acceptance evidence, not screenshots or installation counts.

### 13.1 Costing method

Produce a bottom-up, five-year total-cost-of-ownership model during Phase 0. Cost drivers:

- Number and maturity of facilities/sites by sector.
- Hardware, connectivity and local support needs.
- Integration complexity and vendor diversity.
- Central environments, storage, observability, DR and security operations.
- Terminology/licensing and quality-assurance programmes.
- Training, change management, help desk and travel.
- Product engineering, maintenance, independent assurance and evaluation.
- State/UT implementation units and recurrent staffing.

Compare at least three adoption scenarios—sentinel, accelerated and universal-service—using the same unit-cost assumptions. Do not commit a national figure until the inventory and reference implementations establish actual unit costs.

## 14. Monitoring, evaluation and learning

### 14.1 Programme scorecard

| Outcome | Indicator examples | Cadence |
|---|---|---|
| Governance | Active sector/State units; meetings held; decisions closed; SAP-CAR funded | Quarterly/biannual |
| Laboratory capacity | Quality-assured labs; EQA performance; turnaround; valid AST completeness | Monthly/quarterly |
| Surveillance representation | Sites, districts, sectors and population/animal production covered | Quarterly |
| Data exchange | Valid batch rate, sync latency, backlog, duplicate/correction rate | Daily/monthly |
| AMR intelligence | Core organism–drug coverage, denominators, confidence, emerging alerts verified | Monthly/quarterly |
| AMC/AMU | Facilities and sectors reporting; DDD/DOT; AWaRe Access share; animal-use coverage | Monthly/annual |
| Stewardship | Functional AMS teams; antibiotic time-outs; audit/feedback; appropriate-use measures | Quarterly |
| IPC/HAI | Facilities implementing IPC; HAI coverage; action completion | Monthly/quarterly |
| One Health action | Cross-sector investigations; acknowledgement/closure SLA; overdue actions | Monthly |
| Programme delivery | Releases accepted, onboarding lead time, support SLA, adoption and user satisfaction | Monthly/quarterly |
| Security/privacy | Critical vulnerabilities, incidents, access reviews, DPIAs and audit findings closed | Monthly/quarterly |
| International reporting | GLASS/ANIMUSE/InFARM packages accepted with reproducible audit trail | Annual |

### 14.2 Guardrail metrics

- No incentive to increase sample rejection or suppress difficult cases to improve quality scores.
- No ranking of facilities without case-mix, sampling and coverage context.
- No public small-area reporting below disclosure thresholds.
- No automated punitive action from an unverified algorithmic alert.
- Monitor workload, duplicate entry, alert fatigue, inequitable coverage and unintended antimicrobial restriction.

### 14.3 Learning loop

Every quarter, the Mission Unit should publish a change log describing: evidence reviewed, user feedback, incidents, indicator changes, terminology/breakpoint updates, retired features, open risks and next-quarter decisions. Annual evaluation should include independent scientific, security, privacy, economic and implementation reviews.

## 15. Risk register

| Risk | Likelihood/impact | Mitigation | Early warning |
|---|---|---|---|
| Dashboard built without reliable sector data | High/High | Phase gates, data-quality certification, sampling framework | High missingness, unstable denominators |
| State/sector ownership unclear | High/High | Formal charter, named data owners, funded units | Meetings without decisions; unowned actions |
| Duplicate reporting burden | High/High | Integrate existing systems, local value, retire redundant forms | Manual re-entry hours, low active use |
| Convenience samples mislabelled national | High/High | Representativeness framework and mandatory coverage display | Large site mix shifts, unsupported national rates |
| Small-cell or location re-identification | Medium/High | Query history, suppression, coarsening, release review | Repeated overlapping queries |
| Weak device/server security | Medium/Very High | PKI, MFA, signed updates, SOC, VAPT, DR | Outdated clients, default credentials |
| Terminology/breakpoint drift | High/High | Signed versioned packages and rule lineage | Same isolate classified differently |
| Vendor lock-in | Medium/High | Open standards/APIs, modular lots, exit clauses | Undocumented proprietary formats |
| Alert fatigue | High/Medium | Tiered rules, verification, performance review | Low acknowledgement/positive predictive value |
| Algorithm overreach | Medium/High | Model governance and human decision ownership | Recommendations without uncertainty |
| Insufficient recurring budget/staff | High/High | TCO, recurrent funding, staged scale | Vacant roles, delayed patching/support |
| Sector data cannot be legally shared as designed | Medium/High | DPIA/DSA before build, minimum necessary data | Unresolved authority or purpose |
| Connectivity/hardware inequity | High/Medium | Offline-first, store-and-forward, support/hardware package | Persistent sync backlog in remote sites |
| Poor laboratory quality undermines analytics | High/High | EQA/QMS linked to data products | QC failures, inconsistent methods |

## 16. First 100 days

### Days 0–30: authorise and focus

1. Issue programme order and appoint executive sponsor, mission director and sector leads.
2. Establish the Digital Mission Unit, methods board, architecture/standards TWG, data governance board and security authority.
3. Freeze ungoverned feature expansion in the current prototype; create a controlled code/release repository and defect backlog.
4. Select 3–6 pilot States/UTs using readiness, ecological/sector diversity, laboratory mix and leadership criteria.
5. Start system/data/network inventory and map the current reporting burden.
6. Approve the first three outcome-oriented use cases: human AMR surveillance, facility stewardship/AMC and one multi-sector sentinel pathway.

### Days 31–60: specify and baseline

1. Publish minimum datasets, indicator definitions and data-classification matrix v0.1.
2. Complete threat model, privacy assessment, data-sharing schedules and pilot security plan.
3. Build golden datasets and calculation/conformance tests before major refactoring.
4. Assess the current desktop/server against production controls; prioritise critical remediation.
5. Establish baseline laboratory, data-quality, AMC/AMU, IPC and programme indicators.
6. Confirm pilot sites, local teams, infrastructure and training calendar.

### Days 61–100: build the reference implementation

1. Implement secure provisioning, durable sync, API versioning, data-quality feedback and denominator-aware dashboards.
2. Demonstrate a reference LIS/WHONET import-to-national-aggregate round trip.
3. Demonstrate a verified alert-to-action-to-closure workflow.
4. Run offline replay, backup/restore, security and metric-concordance tests.
5. Finalise the 9-month pilot backlog, budget and procurement packages.
6. Hold a go/no-go review with documented unresolved risks and owners.

## 17. Decision gates for leadership

Leadership should approve the following in sequence:

1. **Architecture decision:** federated edge plus national control plane; no indiscriminate central patient warehouse.
2. **Programme decision:** AMR is a One Health mission workstream with dedicated national and State/UT operating units.
3. **Scope decision:** first release focuses on trustworthy human lab surveillance and action workflow; multi-sector and AMU/AMC follow through planned modules.
4. **Data decision:** approve minimum datasets, classifications, sharing schedules and public-release rules.
5. **Standards decision:** mandate the national implementation guide and conformance suite for all vendors and sector connectors.
6. **Security decision:** require PKI/MFA, signed software, SOC integration, independent assurance and tested DR before national scale.
7. **Scale decision:** expand only after pilot evidence demonstrates quality, actionability, user adoption and sustainable unit cost.

## 18. Definition of a successful national ecosystem

The ecosystem is successful when a district, State/UT and national authority can answer—using the same governed evidence—what resistance or antimicrobial-use signal changed, whether the change is real, which populations/sectors are affected, what uncertainty exists, who owns the response, which action is overdue and whether the intervention worked.

It is not successful merely because desktop software is installed, sites appear on a map, data are uploaded, dashboards refresh, or an AI model generates a narrative.

## Appendix A. Current codebase evidence used in this assessment

- `desktop_app/database.py`: local SQLite persistence and reference/configuration management.
- `desktop_app/data_entry.py`, `import_screen.py`, `lab_config.py`: facility configuration, isolate entry and data import.
- `desktop_app/analysis.py`, `whonet_support.py`, `expert_system.py`: analysis, deduplication/infection-origin support and alert evaluation.
- `desktop_app/interoperability.py`, `whonet_csv_export.py`, `aggregate_measures.py`: HL7/FHIR/WHONET and aggregate measures.
- `desktop_app/sync_module.py`, `SYNC_PROTOCOL.md`: aggregate-only long-poll, bearer/TLS and FHIR response workflow.
- `Server/amrit_central_server/sites`, `queries`, `analytics`, `metrics`, `dashboards`, `actionplans`: site identity, federated queries, aggregates, indicators, scoped dashboards and response workflow.
- `Server/amrit_central_server/central/settings.py`, `docker-compose.yml`: current security/runtime configuration and deployment topology.

## Appendix B. Reference data-product contracts

### B.1 Human AMR aggregate product

Required dimensions: period, facility/site, State/district, specimen category, organism, antimicrobial, method, guideline/year, interpretation, first-isolate rule and patient/location class where lawful. Required measures: R/I/S counts, tested denominator, total eligible isolates, missing/invalid counts, participating sites, confidence interval and suppression status.

### B.2 Human AMC product

Required dimensions: period, geography, setting, product/substance, ATC, route, formulation, sector and AWaRe. Measures: packs/units, grams active ingredient, DDD, DDD per 1,000 inhabitants/day or 100 bed-days, population/bed-day denominator, source coverage and exclusions.

### B.3 Animal AMU product

Required dimensions: period, animal species/production class, antimicrobial/class, route, purpose, source and geography. Measures: quantity active ingredient, animal population/biomass denominator, coverage, validation status and national reporting mapping.

### B.4 Event/alert product

Required: event identifier/type, affected scope, detection time, trigger/rule version, evidence summary, severity, confidence/uncertainty, verification status, owning organisation/user, SLA, linked playbook, actions, communications and closure outcome.

## Appendix C. Minimum national dashboard views

**Executive:** priority risks, new verified alerts, overdue critical actions, data freshness, geographic/sector coverage and NAP/SAP delivery exceptions.

**Epidemiology:** organism–drug trends, denominators, confidence intervals, site mix, sampling frame, first-isolate logic, quality flags and cross-sector evidence.

**Laboratory:** QC/EQA, turnaround, rejection, missingness, breakpoint/version drift, referral and unresolved validation.

**Stewardship/IPC:** AWaRe, DDD/DOT, Reserve use, antibiotic time-outs, antibiogram, HAI/device rates and action completion.

**Veterinary/food/environment:** AMR/AMU/residue trends, host/commodity/matrix, sampling coverage, methods, biosecurity/effluent actions and regulatory closure.

**Programme:** NAP/SAP milestones, budgets/evidence, training, facility coverage, implementation delays and meeting decisions.

**Public:** delayed/coarsened trends, plain-language interpretation, methods, uncertainty, prevention/stewardship messages and no facility league table.

## Appendix D. Official references

- **R1.** Office of the Principal Scientific Adviser, *State Consultations – One Health Dashboard Framework Wireframe*, 6 July 2026 (user-provided document).
- **R2.** Office of the Principal Scientific Adviser, National One Health Mission: https://psa.gov.in/oneHealthMission
- **R3.** Office of the Principal Scientific Adviser, *One Health Governance Structure for State/Union Territory: A Model Framework*, December 2025: https://psa.gov.in/CMS/web/sites/default/files/publication/OH%20Model%20Governance%20Framework_17Dec2025_1.pdf
- **R4.** National Centre for Disease Control, *National Action Plan on Antimicrobial Resistance 2.0 (2025–2029)*, November 2025: https://www.ncdc.mohfw.gov.in/uploads/pdf/amr10.pdf
- **R5.** Indian Council of Medical Research, *AMR Surveillance Network Annual Report 2024*: https://www.icmr.gov.in/icmrobject/uploads/Report/1763981012_icmramrsnannualreport2024.pdf
- **R6.** National Centre for Disease Control, AMR programme and national documents: https://ncdc.mohfw.gov.in/includes/About/CentresAndDivision/amr.php
- **R7.** Ayushman Bharat Digital Mission, guiding principles and federated architecture: https://abdm.gov.in/abdm
- **R8.** ABDM Health Data Management Policy: https://abdm.gov.in/static/media/health_management_policy_bac9429a79.80f74bc3e039c00acd4f.pdf
- **R9.** Ministry of Electronics and Information Technology, Digital Personal Data Protection Rules 2025: https://www.meity.gov.in/documents/act-and-policies/digital-personal-data-protection-rules-2025-gDOxUjMtQWa
- **R10.** World Health Organization, GLASS: https://www.who.int/activities/facilitating-global-surveillance-of-antimicrobial-resistance
- **R11.** World Health Organization, AWaRe system: https://www.who.int/teams/surveillance-prevention-control-AMR/control-and-response-strategies/AWaRe
- **R12.** World Organisation for Animal Health, ANIMUSE: https://amu.woah.org/amu-system-portal/home
- **R13.** Food and Agriculture Organization, InFARM: https://www.fao.org/antimicrobial-resistance/resources/infarm-system/en/
- **R14.** CERT-In, Guidelines on Information Security Practices for Government Entities: https://www.cert-in.org.in/guidelinesgovtentities.jsp

## Appendix E. Handover package for execution by Codex or another delivery team

Before implementation begins, convert this blueprint into the following controlled artefacts:

- `programme_charter.md` — scope, authority, outcomes, governance and funding.
- `architecture/adr-*.md` — one decision record per major architecture choice.
- `standards/national-amr-ig/` — schemas, profiles, terminology and examples.
- `backlog/epics.csv` and `backlog/stories/` — traceable requirements and acceptance criteria.
- `threat-model/` and `privacy/` — data flows, risks, DPIAs and controls.
- `test/golden-datasets/` — expected calculations and conformance fixtures.
- `ops/` — environments, SLOs, deployment, observability, backup, DR and incident runbooks.
- `pilot/` — site readiness, onboarding, training, support and evaluation protocols.
- `governance/decision-log.md` — unresolved choices, owners and due dates.

The first engineering sprint should not add new dashboard tiles. It should establish source control, automated tests, golden calculation fixtures, secure configuration, migrations, release signing and a reproducible local-to-central reference flow.
