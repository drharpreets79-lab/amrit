# AMRIT

**Antimicrobial Resistance Monitoring, Intelligence and Tracking**

AMRIT is a local-first antimicrobial-resistance (AMR) surveillance platform spanning laboratory desktop workflows, aggregate-safe national coordination, One Health programme operations, and standards-based interoperability. This repository is a reference implementation for development and controlled pilots; it is not a claim of production deployment or autonomous clinical decision support.

## What is included

- An offline-capable React and Electron desktop application for laboratory configuration, isolate and AST workflows, imports, analysis, governed One Health capture, and standards exports.
- A Django central server for site enrolment, aggregate query dispatch, dashboards, outbreak-signal review, action plans, audit, and public-health programme coordination.
- Shared, versioned contracts for country profiles, geography, terminology, FHIR resources, and aggregate data products.
- Reproducible validation, benchmark, and operator documentation assets.

## Architecture and privacy boundary

```text
Laboratory edge (Electron + SQLite)
  identifiable operational records stay local
                 |
                 | authenticated aggregate queries/results
                 v
National control plane (Django + PostgreSQL + Redis)
  aggregate products, quality, lineage, alerts, actions, and governance
                 |
                 v
Restricted dashboards and disclosure-limited public views
```

Federation is aggregate-first: patient rows are not uploaded by the normal synchronization path. The server rejects direct identifiers at its ingest boundary and applies a configurable minimum-cell-size rule. Any separately authorized line-list exchange would require its own legal basis, endpoint, controls, and audit; it is not implemented by the aggregate ingest contract.

See [ADR-001](architecture/adr-001-federated-one-health-platform.md) and the [privacy and safety documentation](app/docs/PRIVACY_AND_SAFETY.md).

## Repository map

| Path | Purpose |
| --- | --- |
| `app/` | React, Electron, and SQLite desktop application |
| `server/amrit_central_server/` | Django central aggregation and control-plane server |
| `shared/` | Canonical cross-product contracts, country profiles, terminology, and test fixtures |
| `fhir-ig/` | FHIR implementation-guide source |
| `docs/` | Operator, deployment, outbreak-detection, and globalization documentation |
| `architecture/` | Architecture decision records |
| `tools/` | Data-generation, validation, documentation, and consistency tooling |
| `.github/workflows/ci.yml` | Cross-platform desktop, server, packaging, and repository gates |

## Core capabilities

- Multi-laboratory, local-first isolate and AST workflows.
- CSV, XLSX, XLSB, WHONET, and BacLink-style import with preview and validation.
- Explicitly activated, provenance-aware breakpoint sets; EUCAST support and licensed CLSI import boundaries.
- Resistance summaries, antibiograms, data-quality analysis, and outbreak-signal workflows.
- WHONET, FHIR R4, HL7 v2.5.1, JSON, and CSV interoperability.
- Country-neutral geography, configurable administrative hierarchies, and deployment branding.
- Governed One Health workflows across human, animal, food, environment, antimicrobial-use, and infection-prevention domains.
- Aggregate-only long-poll and WebSocket federation with enrolment, token rotation, audit, and privacy guards.
- Role-aware dashboards, reviewable alerts, action plans, and disclosure-limited public reporting.

## Desktop development

Requirements: Node.js 22 or newer and pnpm 11.

```bash
cd app
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run build
pnpm dev
```

Build an unpacked desktop application with `pnpm run dist:dir`, or platform installers with `pnpm run dist`.

The desktop creates its working database in the operating system's application-data directory. Set `AMRIT_DATABASE_PATH` only when an explicit writable database path is required for development or testing.

## Central server development

Requirements: Docker with the Compose plugin.

```bash
cd server/amrit_central_server
cp .env.example .env
# Set the required values in .env, including a strong POSTGRES_PASSWORD.
docker compose up --build
```

The server listens on `127.0.0.1:8000` by default. It creates no default administrator credential. Follow the [central-server setup guide](server/amrit_central_server/README.md) to bootstrap an administrator and register a site. Put a TLS-terminating reverse proxy in front before exposing a deployment beyond localhost.

## Repository verification

```bash
python3 tools/sync_shared.py --check
python3 tools/check_data_licences.py
python3 tools/check_country_neutral.py

cd app
pnpm install --frozen-lockfile
pnpm run check
pnpm test
pnpm run build

cd ../server/amrit_central_server
python3 -m pip install -r requirements.txt
python3 manage.py check
python3 manage.py makemigrations --check --dry-run
python3 manage.py test
```

Continuous integration also exercises supported desktop platforms, country profiles, reduced outbreak benchmarks, Electron packaging, the server smoke flow, dependency audit, OpenAPI generation, and the Docker build.

## Clinical and operational boundaries

- AMRIT supports surveillance and laboratory workflows; it does not make autonomous treatment decisions.
- Breakpoint interpretation depends on the selected standard, edition, method, organism, specimen context, and local authorization.
- A qualified laboratory authority must review provenance and explicitly activate a staged breakpoint set.
- Production operation still requires institutional controls such as PKI and key management, SSO/MFA, signed releases, backups, monitoring, vulnerability assessment, accessibility/localization review, and approved data-sharing agreements.
- Do not commit runtime databases, environment files, credentials, patient data, or site tokens. Demonstration data must be clearly labelled and non-identifiable.

## Reference data and licensing

Bundled datasets have different redistribution and use conditions. Review [the data licence register](shared/DATA_LICENCES.md) before redistribution or deployment. In particular, CLSI content is not bundled, SNOMED CT use depends on the deployment's licence position, and some geographic datasets require attribution or a separate licence.

The application package is currently marked `UNLICENSED`. No open-source licence is granted by this repository; all rights are reserved unless the repository owner provides separate terms.

## Documentation

- [Operator and methods manual](docs/manual/README.md)
- [Desktop application guide](app/README.md)
- [Central server guide](server/amrit_central_server/README.md)
- [Outbreak detection](docs/OUTBREAK_DETECTION.md)
- [International deployment plan](docs/globalization/PLAN.md)
- [National reference implementation overview](NATIONAL_AMR_SOFTWARE_README.md)

## Status

Research and reference implementation for controlled evaluation. Production readiness, clinical effectiveness, national-scale performance, and regulatory suitability must be established independently in the intended deployment environment.
