# shared/ — the contract both products share

`app/` (desktop application) and `server/` (web server) are distributed separately and must never
reference each other's folders. Anything they genuinely share lives here, and only here.

| Path | Contents |
|---|---|
| `contracts/` | Canonical event and data-product JSON Schemas |
| `golden-datasets/` | Reference fixtures for One Health metric formulas |
| `VERSION` | Contract version stamp, exchanged on the app↔server sync handshake |

## How it reaches each product

`shared/` is the source of truth. Each product carries a **vendored copy** so that a checkout or a
distributed artifact containing only that product is complete and self-contained:

- `app/resources/shared/`
- `server/amrit_central_server/shared/`

Sync and verify with:

```bash
python3 tools/sync_shared.py
```

```bash
python3 tools/sync_shared.py --check
```

`--check` is the CI drift gate: it fails if a vendored copy differs from `shared/`. Never edit a
vendored copy — edit `shared/` and re-run the sync.

## Versioning

Bump `VERSION` whenever a contract in `contracts/` changes in a way a peer must know about. Both
products stamp it into their build and compare it during sync, so a version mismatch is reported
rather than silently mis-parsed.
