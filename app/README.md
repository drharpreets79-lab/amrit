# ICMR AMRIT Electron

A separate, local-first React + Electron implementation of the AMRIT antimicrobial-resistance desktop application. It keeps the Python application and its database untouched, while preserving its laboratory, isolate, AST, import, analysis, interoperability, One Health, sync, and assistance workflows.

## Run locally

Requirements: Node.js 24 or newer and pnpm 11 or newer.

```bash
pnpm install
pnpm run check
pnpm test
pnpm run build
pnpm dev
```

Build an unpacked desktop application with `pnpm run dist:dir`. Build platform installers with `pnpm run dist`.

## First run and data safety

- Electron creates a private SQLite database under its platform user-data directory.
- If `../desktop_app/whonet_replica.db` exists, it is copied once and migrated in the private location. The Python database is never opened for mutation.
- Set `AMRIT_DATABASE_PATH` to use an explicit writable test/database path.
- Set `AMRIT_LEGACY_DB` to nominate a legacy database for one-time copying.
- Sync and site tokens are encrypted with Electron `safeStorage`. If OS encryption is unavailable, tokens remain memory-only and are not written as plaintext.

## Core capabilities

- Multi-laboratory configuration with one active laboratory.
- Guided isolate entry, draft/final lifecycle, duplicate detection, and retained AST results.
- CSV, XLSX, XLSB, and WHONET/BacLink-style import preview, mapping, validation, and atomic commit.
- Configurable master studio for antibiotics, organisms, samples, aliases, locations, domains, data fields, hospitals, states, districts, panels, breakpoints, QC ranges, expert rules, expected resistance, and coded values.
- Versioned breakpoint sets with workbook staging, provenance hash, explicit activation, and official CLSI access/download links.
- Analysis, resistance summaries, data-quality views, and WHONET CSV, FHIR R4, HL7 v2.5.1, Measure, JSON, and CSV exports.
- Governed One Health capture for human, animal, environment, food, antimicrobial-use, and infection-prevention workflows, with PBKDF2 local identities, role-gated actor binding, alert review, corrective-action closure evidence, tamper-evident audit verification, and named WHO GLASS-compatible, WOAH ANIMUSE-aligned, and FAO InFARM-compatible JSON projections.
- Aggregate-only long-poll and WebSocket synchronization with automatic token configuration.
- Local Ollama assistance by default; remote providers require explicit network consent and PHI redaction.
- Searchable audit trail.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Python-to-Electron parity matrix](docs/PARITY_MATRIX.md)
- [Breakpoint workbook contract](docs/BREAKPOINT_WORKBOOK.md)
- [Privacy and safety boundaries](docs/PRIVACY_AND_SAFETY.md)
- [ICMR brand implementation](docs/ICMR_BRAND_IMPLEMENTATION.md)
- [Verification plan](docs/TEST_PLAN.md)

## Clinical and standards notice

AMRIT is a surveillance and laboratory workflow tool, not autonomous clinical decision software. Breakpoint content is edition-, method-, organism-, and site-specific. A qualified laboratory authority must review provenance and activate a staged breakpoint set before it is used. Paid CLSI content is not bundled or redistributed.
