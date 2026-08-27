# Records of processing activities — template

> **Status: template, not legal advice.** Most data-protection regimes require a controller
> to keep a written record of what it processes and why. The columns below are the ones such
> regimes have in common; check which are mandatory in yours before relying on this.

Two activities are listed because AMRIT is two products with genuinely different footprints.
Keep them separate: they have different data, different locations and different retention.

---

## Activity 1 — Laboratory surveillance records (desktop application)

| Field | Entry |
|---|---|
| Controller | |
| Joint controllers, if any | |
| Processor(s) | *None by default. The desktop application stores data on the laboratory's own machine.* |
| Purpose | |
| Legal basis | |
| Categories of data subject | Patients whose specimens are tested; laboratory staff as system users |
| Categories of personal data | Specimen identity and dates; optional patient identifier; sex; age or date of birth; ward or location; diagnosis; organism; susceptibility results; free-text notes |
| Special-category data | Health data. State any others your configuration adds. |
| Recipients | The central server, aggregates only. Any AI provider you enable. |
| Transfers outside the jurisdiction | |
| Retention period | Set by `privacy.retention_days`; record the value and who decided it |
| Security measures | Local database on the laboratory machine; role-based access; tamper-evident audit chain; OS-keychain credential storage. **Disk encryption and physical security are the deployment's responsibility.** |
| Location(s) of storage | |

---

## Activity 2 — Aggregate surveillance and portal accounts (central server)

| Field | Entry |
|---|---|
| Controller | |
| Processor(s) | Hosting provider, managed database, backup service — name each |
| Purpose | |
| Legal basis | |
| Categories of data subject | Portal users. *Aggregates are not attributable to an individual patient once the disclosure floor is applied.* |
| Categories of personal data | Account identity and role; site identity and geography; audit of queries asked and answered; counts and rates by scope and period |
| Special-category data | None at row level. Aggregated health data. |
| Recipients | Reporting frameworks you export to (GLASS, ANIMUSE, InFARM, national) — list those enabled |
| Transfers outside the jurisdiction | |
| Retention period | Set by `privacy.retention_days`; aggregates (`KPISnapshot`) are deliberately **not** purged — record why that is acceptable here |
| Security measures | TLS; authenticated enrolment; role-based access; audited settings changes; suppression below the configured cell size |
| Location(s) of storage | |

---

## Change log

Every material change to either activity should appear here, with the date and who approved it.

| Date | Change | Approved by |
|---|---|---|
| | | |
