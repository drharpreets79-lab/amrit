# Verification plan

## Automated gates

1. TypeScript strict typecheck.
2. ESLint with zero warnings.
3. Unit tests for migrations, legacy compatibility, master CRUD, duplicates, atomic imports, parsers, token gates, aggregate sync, exports, PHI redaction, breakpoint staging, One Health PBKDF2/roles/actor binding/actions/audit/export completeness, and renderer flows.
4. Electron production build.
5. Electron Builder unpacked application.

## Legacy parity evidence

The unchanged Python baseline is run first with its own virtual environment. Electron tests use a disposable copy of the same SQLite schema. Important cross-layer paths are exercised end to end:

- first-run legacy copy and migration;
- laboratory create/select;
- master change reflected in entry/import selectors;
- organism/specimen panel match and AST save;
- duplicate warning and draft/final lifecycle;
- invalid batch rollback and valid atomic commit;
- breakpoint workbook stage/provenance/activation;
- analysis and all export formats;
- auto-token configuration, WebSocket aggregate response, and long-poll response;
- One Health capture and audit;
- cold production launch with renderer console/error capture.

## Manual UI smoke

Run the built application with a temporary user-data directory. Inspect dashboard, every navigation route, compact and wide layouts, keyboard focus, empty/error/loading states, logo rendering, file dialogs, master edit forms, isolate form, breakpoint centre, sync status, One Health capture, and audit details.
