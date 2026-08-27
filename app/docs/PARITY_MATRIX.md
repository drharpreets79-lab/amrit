# Python-to-Electron parity matrix

This matrix is the acceptance contract for the separate implementation.

| Python source/capability | Electron surface | Required verification |
|---|---|---|
| `main.py`, `branding.py`, `scrollable_screen.py` shell/navigation/ICMR identity | App shell, sidebar, responsive page frame, help panel | production launch and visual smoke |
| `database.py` schema, migrations, preferences, laboratory and isolate persistence | `AMRITDatabase`; private copied SQLite | fresh and legacy migration tests |
| `lab_config.py` laboratories, masters, panels, custom fields/alerts | Laboratories + Master Studio | CRUD, activation and reload tests |
| `data_entry.py` guided isolate/AST entry, historical AST retention, draft/final | Records workspace | save/reopen/duplicate/panel tests |
| `panel_matching.py`, `simple_ast_catalog.py` code-first organism/specimen panels | panel matcher and AST table | exact-code priority tests |
| `expert_system.py` custom alerts, expert comments, expected resistance | configurable master rules and saved support output | deterministic rule tests |
| `baclink_import.py`, `excel_batch.py`, `batch_validation.py`, `import_screen.py` | Import workspace | CSV/XLSX/XLSB preview, mapping, rollback tests |
| `analysis.py`, `whonet_csv_export.py` | Analysis + WHONET export | golden CSV checks for interpretation, measurement, method, guideline, potency and source |
| `interoperability.py`, `aggregate_measures.py` | FHIR R4, HL7 v2.5.1, Measure exports | UUID-URN/reference-resolution checks plus segment-level HL7/OBX tests |
| `whonet_*_loader.py`, `whonet_support.py`, `whonet_data.py` | Master Studio + Breakpoint Centre | legacy catalogue visibility and workbook tests |
| `settings_screen.py` endpoint/test/token UX | Sync Centre | missing-token auto-config and explicit rotation tests |
| `sync_module.py`, `local_query.py`, `SYNC_PROTOCOL.md` | long-poll + WebSocket aggregate sync | protocol mock-server and privacy tests |
| `llm_assist.py`, `chatbot_widget.py` | AI settings + assistant | consent, redaction, local model and hidden-thinking tests |
| `national_amr/schemas.py`, `workbench.py` | One Health workspace | module form and coded-field tests |
| `national_amr/security.py`, `repository.py`, `service.py`, `rules.py` | PBKDF2 identities, main-process actor binding, roles, local capture, alert review, corrective actions, chained audit, aggregate-only outbox | password-vector, authorization, actor-spoof, closure-evidence, audit-tamper and outbox tests |
| `national_amr/metrics.py`, `exporters.py` | complete-corpus One Health indicators plus WHO GLASS-compatible, WOAH ANIMUSE-aligned and FAO InFARM-compatible JSON | deterministic fixture, profile-shape and >1,000-event completeness tests |
| Existing Python `test_*.py` and smoke scripts | unchanged baseline | 106-test baseline plus Electron gates |

No parity item is accepted solely because a menu exists. Its storage, validation, reload behavior, export/network boundary, and failure path must be verified.
