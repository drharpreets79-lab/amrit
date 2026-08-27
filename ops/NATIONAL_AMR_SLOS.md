# National AMR platform service objectives

Reference targets for production design; local reference implementation does not claim national-scale certification.

| Capability | Target | Verification |
|---|---:|---|
| Edge offline operation | 30 days | Replay test; zero duplicate products |
| Aggregate ingest availability | 99.9% monthly | Synthetic probe by region |
| Central recovery point | 15 minutes | Quarterly restore drill |
| Central recovery time | 4 hours | Annual region-failure exercise |
| Critical security patch | 72 hours | Release attestation |
| Critical alert acknowledgement | 4 hours | Workflow SLA report |
| Product lineage | 100% KPIs | Catalogue trace audit |
| Identifier rejection | 100% forbidden fixtures | CI privacy tests |

Required production controls: managed PKI/HSM, MFA/SSO, WAF, secrets manager, encrypted volumes/backups, SBOM/signing, dependency/container scanning, immutable audit export, SOC integration, tested DR, accessibility and localisation testing.
