# Packaged catalogue provenance

`catalog-seed.v1.json` is a deterministic, PII-free fresh-install seed. Version
`2026.1` is generated exclusively from terminology and configuration files
checked into `desktop_app/resources`, plus the checked-in India LGD
state/district catalogue and the curated `Simple_AST_List_2026.csv` parser.

The asset contains no laboratory, hospital, isolate, patient, credential, or
server data. It contains antimicrobial and organism masters, specimen groups and
aliases, India geography, WHONET coded values/field definitions/MIC panels,
expected-resistance and expert-rule masters, and 43 curated AST panel templates.
CLSI breakpoint/QC files are intentionally not embedded in this seed; those are
managed by the app's explicit, hash-tracked download/upload and activation flow.

Each source path, byte size, row count, and SHA-256 digest is embedded in the
asset. The payload has a second SHA-256 digest verified before any insert. Run:

```sh
pnpm catalog:verify
```

The runtime seeds only a genuinely empty database and records the installed
dataset/version/hash in `app_catalog_seed_state`. Inserts are transactional. It
never overwrites an existing row. A newly created laboratory receives the AST
panel catalogue once; later user edits, deactivations, and deletions are retained.
