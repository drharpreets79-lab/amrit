# ADR-001: Federated One Health AMR platform

Status: accepted for reference implementation, 2026-07-13.

## Decision

Keep identifiable operational records at authorised sector edge nodes. Exchange idempotent aggregate data products by default. Use separate module schemas over shared edge services. Central server stores aggregate products, lineage, quality, alerts, actions, programme evidence and governed-access decisions.

## Consequences

- Direct care and regulatory source records remain under source-system control.
- Cross-sector analytics must expose coverage, method, denominator and uncertainty; absence of comparable sampling must not be presented as causal evidence.
- Narrow line-list exchange requires separate legal authority, purpose, endpoint and audit; it is not implemented by aggregate ingest.
- Desktop modules may later migrate from Tkinter without changing domain contracts.

## Code mapping

- Edge schemas/services: `desktop_app/national_amr/`
- Existing human-lab/FHIR/HL7: `desktop_app/`
- Central control plane: `server/amrit_central_server/ecosystem/`
- Contracts: `shared/contracts/`
