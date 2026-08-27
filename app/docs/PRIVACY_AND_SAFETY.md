# Privacy and safety boundaries

## Local records

Patient and specimen rows remain in the local database. WebSocket and long-poll handlers accept only a finite allowlist of aggregate query types. Responses contain counts and resistance summaries, not patient identifiers or raw isolate rows.

## Where a patient lives

A patient record holds the town and the postal code, in the shape that country writes them. It holds no street address, and there is no field for one: AMR surveillance maps cases to places, which the town, the postal code and the administrative unit already do, and a street address is the strongest re-identifier a health record can carry.

The postal code is truncated before it leaves this computer — in FHIR bundles and in spreadsheet exports alike — to the number of leading characters set by `privacy.patient_postal_code_digits` (default three; zero drops it). What counts as identifying depends on population density and on local law, so the number is the deployment's to choose. The central server never receives any of it: its guard refuses `postal_code`, `postalCode` and `address` outright, and it stores aggregates only.

## Network gates

- Remote sync requires HTTPS. Plain HTTP is accepted only for loopback services such as local Ollama.
- Approximate or explicit GPS is transmitted only after separate consent.
- Remote LLM providers are disabled until the user opts in.
- LLM prompts redact patient identifiers, specimen numbers, dates of birth, phone numbers and email addresses before a network call. The patterns are generic — they match the *shape* of an identifier, not one country's schemes — so a deployment that must block a national identifier by name adds it to `banned_identifier_keys` in its country profile.
- Official breakpoint downloads are restricted to HTTPS and to the standards bodies' own hosts (CLSI and EUCAST). The allowlist exists so the application cannot be talked into downloading from an arbitrary address, and a profile-supplied host would defeat it, so it is in code.

## Credentials

Bearer and site tokens are not stored in ordinary preferences. Electron `safeStorage` encrypts them using the operating-system credential facility. Where OS encryption is unavailable, the application keeps them in memory only. Renderer responses show token presence, never encrypted payloads.

One Health user passwords are salted PBKDF2-SHA256 hashes with 310,000 iterations; plaintext passwords are never persisted. There is no default administrator. The first administrator is created explicitly when the user table is empty. The active identity is held only in main-process memory and expires after inactivity.

## Breakpoint governance

An imported workbook records file name, SHA-256, standard, edition, import time, and row-level validation outcomes. Import creates a staged set. Activation is explicit and audited. Users must verify licensing and scientific applicability. The application links to official access but does not bypass access controls or redistribute paid standards.

## Human authorization

Expert rules, expected resistance, and assistance outputs are decision support. They show provenance and comments, remain editable masters, and do not autonomously change a final laboratory result.

The renderer cannot select or override the One Health actor. The main process binds each capture, alert review, corrective-action update, and aggregate enqueue to the authenticated identity. Direct-care and regulatory capture requires an administrator or steward; data-entry identities create drafts in non-sensitive modules. Action closure requires evidence. Only aggregate products enter the federation outbox. Named standards projections are explicit, user-selected local exports and are never synchronized automatically.
