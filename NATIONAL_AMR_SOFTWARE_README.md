# National AMR software reference implementation

This workspace now contains an executable reference slice spanning edge capture and national control plane. It is a foundation for pilots, not a claim of finished national deployment.

> **Start here: [the operator manual](docs/manual/README.md)** — what each part is, how data flows,
> and step-by-step setup, collection, analysis, sharing and deployment, with screenshots of the
> running software.

The Markdown is the source. A branded PDF and DOCX are built from it, taking the emblem, the
authority's name and the three brand colours from the deployment's own country profile — so an
Indian build carries ICMR's identity and a Testland build carries Testland's:

```bash
python3 tools/build_manual.py
```

## Applications

1. `app/`: the offline-capable desktop application one laboratory runs — isolate register, AST,
   analysis, standards export, and the **One Health workbench** for the eight non-human modules.
2. `server/amrit_central_server/`: the central server one country runs — site registry, aggregate
   query dispatch, dashboards, action plans and the national control plane under `ecosystem/`.
3. `shared/`: the contract both read — canonical event schema, postal-address pack, golden datasets.
   Edit here, then run `python3 tools/sync_shared.py`.
4. `/api/v1/ecosystem/workbench/`: authenticated national operations view.
5. `/api/v1/ecosystem/public/`: disclosure-limited transparency view.

Both products are country-neutral: a deployment picks its country and edits every country-varying
value from the screen. See [docs/globalization/PLAN.md](docs/globalization/PLAN.md).

## Implemented reference capabilities

- Versioned minimum datasets and validation for eight modules.
- Transparent AMC/DDD/AWaRe, stewardship, HAI, animal AMU, food, environment and genomics indicators.
- Explainable alert rules and action/audit persistence.
- PBKDF2 local identities/RBAC primitives and tamper-evident audit chain.
- Reversible SQLite migrations, verified backup, idempotent durable outbox and device-health records.
- Checksum-controlled terminology package slots.
- Aggregate data-product and FHIR `Basic` projections; GLASS-, ANIMUSE- and InFARM-aligned projections.
- Central organisation/device registry, product catalogue, quality/lineage, terminology releases, joint alerts/risk assessments, NAP milestones/budget/evidence, research access and reproducible reporting runs.
- Bearer-authenticated aggregate ingest with duplicate suppression and direct-identifier rejection.
- Authenticated One Health workbench and public, published-only portal.

## Production work still requiring institutional infrastructure

PKI/HSM issuance, SSO/MFA integration, SQLCipher/OS key-store deployment, signed auto-update service, authoritative terminology agreements, vendor LIS/HMIS/pharmacy connectors, national 10,000-site load testing, secure research enclave, SOC/SIEM operation, VAPT, accessibility/localisation certification and jurisdiction-approved data-sharing workflows. These cannot be honestly completed by source code alone.

## Verification

```bash
cd desktop_app
python3 -m unittest national_amr.test_platform test_local_query.py

cd ../server
docker run --rm -v "$PWD:/app" -w /app/amrit_central_server \
  -e DATABASE_URL=sqlite:////tmp/amrit-test.db server-web python manage.py test
```
