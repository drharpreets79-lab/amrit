# Data Protection Impact Assessment — template

> **Status: template, not legal advice.** It is written to be filled in by whoever is
> accountable for this deployment and reviewed by their own legal or data-protection
> adviser. The structure is jurisdiction-neutral; the obligations are not. Where a section
> says *"state your legal basis"*, that basis differs by country and no default is supplied.

Everything in the **Facts about the software** sections below is a property of AMRIT itself
and is the same for every deployment. Everything in the **Decisions for this deployment**
sections is yours, and several of them are settings on the *Deployment and country* screen
rather than prose to be written here.

---

## 1. The processing

| Field | Entry |
|---|---|
| Deployment name | |
| Controller (organisation accountable for the data) | |
| Processor(s), if any (hosting, managed database, backup) | |
| Data protection officer / contact | |
| Date of assessment | |
| Date of next review | |

**Purpose of processing.** State it specifically. "Antimicrobial resistance surveillance"
is the domain, not a purpose; the purpose is what the data is used *for* — for example,
national AMR reporting under a named programme, or informing an antibiotic formulary.

**Legal basis.** State your basis and the instrument it comes from. Public-health
surveillance is commonly a public-task or public-interest basis rather than consent, but
this is a decision for your jurisdiction, not a default this template can supply.

---

## 2. Facts about the software

These do not vary by deployment and can be relied on as written.

**Architecture.** Two products. The desktop application holds row-level laboratory data in a
local database on the laboratory's own machine. The central server holds aggregates. Row-level
isolate records are **not** transmitted to the server: the sync channel answers a fixed
allowlist of aggregate query types, and any other command is refused before it executes.

**Categories of data held locally (desktop).** Specimen identity and dates, an optional
patient identifier as the laboratory chooses to record it, sex, age or date of birth,
ward/location, diagnosis, organism, and antimicrobial susceptibility results. Free-text
notes are possible; assume they may contain anything a user types.

**Categories of data held centrally (server).** Site identity and geography, counts and
rates by scope and period, dashboards derived from them, the audit of which query was asked
and answered, and user accounts for the portal.

**Disclosure control.** Aggregates below a minimum cell size are suppressed rather than
published. The floor is `privacy.k_anonymity_floor` in the country profile, cannot be set
below 5, and is stated on the public summary page.

**Identifiers the software refuses to store.** `privacy.banned_identifier_keys` in the
profile is merged into a generic blocklist that always applies; a profile can make the guard
stricter, never weaker.

**Retention.** `privacy.retention_days` expires row-level operational data on both products.
Unset means "keep indefinitely", which is the default. A purge previews before it deletes.

**Audit and erasure.** The One Health audit log is a hash chain. Erasure is by
crypto-shredding: the entry, its time, its actor and a digest remain so the chain still
proves the log was not altered, and the payload is destroyed. The erasure is itself a
chained entry, so removal cannot happen silently.

**Transfers.** The desktop application makes no outbound call except to the central server
you configure and, if enabled, an AI provider you configure. Both are off until set.

---

## 3. Decisions for this deployment

| Question | Your answer | Where it is set |
|---|---|---|
| Retention period for row-level data | | `privacy.retention_days` |
| Minimum cell size for publication | | `privacy.k_anonymity_floor` |
| Identifiers forbidden in this jurisdiction | | `privacy.banned_identifier_keys` |
| Where data is physically held | | `privacy.residency_note` |
| Is an AI assistant enabled, and is it local or hosted? | | AI assistant screen |
| Who may change deployment settings? | | One Health administrator role |
| Who may erase audit details, and on what evidence? | | |
| Backup location, retention and restore drill interval | | |

---

## 4. Necessity and proportionality

- Is every field collected necessary for the stated purpose, or is some of it collected
  because the form offers it? Name any field you have decided not to use.
- Could the purpose be met with less identifiable data — for example, an age band rather
  than a date of birth, or a pseudonymous specimen number rather than a patient identifier?
- How long is each category genuinely needed, and does your retention period match that
  rather than the maximum the law allows?

---

## 5. Risks and mitigations

For each risk: likelihood, severity, mitigation, residual risk, and who accepted it.

| # | Risk | Mitigation in place | Residual | Accepted by |
|---|---|---|---|---|
| 1 | Re-identification from a small aggregate | Cell suppression below the configured floor | | |
| 2 | Loss or theft of a laboratory machine | Full-disk encryption (**deployment responsibility — the application does not encrypt the database file**) | | |
| 3 | Credential compromise | OS-keychain storage, role-based access, audited actions | | |
| 4 | Free-text notes containing identifiers | Redaction before optional AI calls; **no control over what is typed and stored locally** | | |
| 5 | Retention set too long or never set | Retention job and this assessment's review date | | |
| 6 | Erasure request conflicting with the audit chain | Crypto-shredding, chain stays verifiable | | |

Add the risks specific to your setting. Two are called out above as **deployment
responsibilities** because the software genuinely does not address them; do not record them
as mitigated by the product.

---

## 6. Rights of individuals

State, for your jurisdiction, how each request is handled and by whom — including which
requests you will refuse and on what basis. Note that a right to erasure applied to a
surveillance record is frequently limited by public-health law; record the limit you rely on
rather than assuming either extreme.

| Right | How it is handled here | Owner |
|---|---|---|
| Information / transparency | | |
| Access | | |
| Rectification | | |
| Erasure | | |
| Restriction / objection | | |
| Complaint to a supervisory authority | | |

---

## 7. Sign-off

| Role | Name | Date | Outcome |
|---|---|---|---|
| Data protection adviser | | | |
| Controller | | | |

Record the outcome as one of: proceed, proceed with the listed conditions, or do not proceed.
