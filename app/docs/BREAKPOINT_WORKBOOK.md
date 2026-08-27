# Structured breakpoint workbook contract

AMRIT reads `.xlsx`, `.xlsb`, and `.xls` workbooks. A normalized workbook should contain a sheet named `Breakpoints`; optional sheets are `QC_Ranges`, `Expected_Resistance`, `Expert_Rules`, and `Metadata`. Header matching is case-insensitive and accepts spaces or underscores.

## Breakpoints

| Column | Required | Meaning |
|---|---:|---|
| `guidelines` | yes | Standard owner, for example `CLSI` |
| `year` | yes | Edition year or edition label |
| `test_method` | yes | Disk diffusion, MIC, or another configured method |
| `potency` | no | Disk content or test concentration |
| `organism_code` | yes | Configured organism code or rule-group code |
| `organism_code_type` | no | WHONET, SNOMED CT, local, or another configured system |
| `breakpoint_type` | no | Clinical, screening, ECV/ECOFF, or configured type |
| `host` | no | Human, animal, environment, or configured host |
| `site_of_infection` | no | Site-specific qualifier |
| `whonet_abx_code` | yes | Configured antimicrobial code |
| `whonet_test` | no | WHONET test code |
| `r_value` | no | Resistant threshold/expression |
| `i_value` | no | Intermediate threshold/expression |
| `sdd_value` | no | Susceptible-dose-dependent threshold/expression |
| `s_value` | no | Susceptible threshold/expression |
| `ecv_ecoff` | no | Epidemiological cutoff |
| `ecv_ecoff_tentative` | no | Tentative ECV/ECOFF indicator/value |
| `comments` | no | Source table, exception, or interpretation note |

At least one interpretation or ECV/ECOFF field must be populated. Codes are checked against active organism and antibiotic masters. Unknown codes remain visible as validation errors; they are never silently invented.

## Metadata

Use two columns, `key` and `value`. Recognized keys include `standard`, `edition`, `published_date`, `source_url`, `license_note`, and `notes`. File name, SHA-256, and import timestamp are added by AMRIT.

## Import sequence

1. Select an official or local workbook.
2. Preview mapped sheets and validation issues.
3. Import to a staged source set.
4. Review row counts, errors, edition, source URL, and SHA-256.
5. Activate the set explicitly. The previous set stays queryable for provenance and rollback.

CLSI’s comparison workbook may use a presentation-oriented layout. The importer detects known headings and retains unmapped source rows/issues for review. A normalized workbook remains the safest reproducible route.
