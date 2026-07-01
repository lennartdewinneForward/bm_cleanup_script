# Cleanup Script - Development TODO

## ✅ Completed Features (Summary)

| Feature | Description |
|---|---|
| **analyze-preferences** | Full analysis workflow: OCAPI fetch → matrix generation → cartridge code scan → per-realm deletion candidates (P1–P5 tiers) with realm tags, backup age checking, multi-realm consolidation |
| **remove-preferences** | Load per-realm or cross-realm deletion files, interactive VS Code review, tier selection (cascading), backup creation, OCAPI DELETE with error handling, dry-run mode |
| **restore-preferences** | Restore deleted preferences from backup JSON (definitions, group assignments, site values) |
| **backup-site-preferences** | Trigger BM backup job + WebDAV download per realm |
| **meta-cleanup** | Full git workflow: create branch → remove attribute definitions + group assignments + preference values from sibling repo XML → optional single-file consolidation → stage & commit with descriptive body |
| **test-meta-cleanup** | Dry-run preview of meta file cleanup (same logic, no git) |
| **Blacklist/Whitelist** | Exact/wildcard/regex pattern filtering for deletion candidates. CLI: add/remove/list commands |
| **Per-realm analysis** | Per-realm value maps, cartridge sets, realm-specific tier classification, P5 (realm-specific code), cross-realm intersection file, combined realm listing |
| **Metadata XML parsing** | `debug-analyze-preferences` command reads attrs+groups from BM metadata XML instead of 500+ OCAPI calls (site-level data still via OCAPI) |
| **Git integration** | Branch creation, staging, committing with `execFileSync` (no `simple-git` dependency), branch naming conventions, customizable commit messages |
| **Realm management** | add-realm / remove-realm CLI commands, multi-realm config |
| **Cartridge tools** | Site listing, cartridge comparison, site.xml validation, cartridge export |

---

## 🔧 Open Work

### Backup & Restore

- [ ] Add verification after restore (compare before/after state)
- [ ] Document rollback procedure

### Metadata XML Optimization

Reads attribute definitions + groups from BM metadata XML instead of individual OCAPI calls. Core implementation done (`siteXmlHelper.js`, `analyzer.js`, `debug-analyze-preferences` command).

- [ ] **TEST:** Run `debug-analyze-preferences` end-to-end on sandbox
- [ ] **TEST:** Compare output between OCAPI and metadata modes
- [ ] Migrate `analyze-preferences` to use metadata mode by default (once validated)
- [ ] Add metadata freshness checking (prompt to refresh if > 7 days old)
- [ ] check if the is a way to label prefercnes per cartridge to be able to assign them to a dedecitaed meta folder for each cartridge. core meta = brand meta

### Deprecation Logic (Decision Pending)

Preferences found ONLY in deprecated cartridges are tagged `[possibly deprecated]` and classified into P3/P4 tiers. Team needs to decide on the final behavior:

1. **Conservative:** Don't delete if ANY code references it
2. **Aggressive:** Ignore deprecated cartridge usage entirely
3. **Hybrid (current):** P3/P4 tiers allow deletion with user review

- [ ] Finalize deprecation policy with team
- [ ] Allow override flags in CLI for aggressive deletion modes

### Enhanced Analysis

Per-realm tracking infrastructure is in place (`buildPerRealmValueMap`, `buildPerRealmCartridgeSet`, realm tags, cross-realm intersection). Remaining work is reporting features on top of existing data.

- [ ] Suggest moving realm-specific preferences into realm-specific cartridges
- [ ] Generate a report comparing preference values across realms (discrepancy detection)
- [ ] Count code reference occurrences per cartridge (usage frequency analysis)
- [ ] Identify rarely-used preferences as potential technical debt

### Meta Cleanup Extensions

- [ ] Auto-create PR from cleanup branch to develop (pre-filled with removed preference list)
- [ ] Hook meta cleanup into `remove-preferences` workflow (after OCAPI deletion step)
- [ ] add option to aply changes without creating a new branch (for small cleanups or when branch creation fails)

### Other

- [ ] Remember failed OCAPI preference IDs to retry later
- [ ] Fix logging issues and improve batch progress visibility
- [ ] Validate per-realm deletion, realm tag parsing, and P5 tier generation with real data

---

## 🧪 Test Coverage — analyze-preferences

Unit tests for the pure functions in the analyze-preferences pipeline.
API calls are mocked — tests verify function output shapes, content, and edge cases.

### summarize.js

- [ ] `normalizeId` — strips `c_` prefix, leaves non-prefixed IDs unchanged
- [ ] `isValueKey` — filters metadata keys (`_v`, `_type`, `link`, `site`)
- [ ] `buildMeta` — produces correct metadata map from OCAPI definitions (id, type, defaultValue, group, description)
- [ ] `buildMeta` — handles missing fields gracefully (partial definitions)
- [ ] `buildMeta` — extracts default values from string, number, boolean, and object formats
- [ ] `buildAttributeMatrix` — marks correct sites as `true` based on usage rows
- [ ] `buildAttributeMatrix` — preferences with no usage rows have all sites `false`
- [ ] `buildAttributeMatrix` — includes defaultValue from preferenceMeta
- [ ] `processSitesAndGroups` — aggregates usage rows across multiple sites and groups (mock API)

### csv.js

- [ ] `compactValue` — truncates long strings/objects at 200 chars
- [ ] `compactValue` — handles null, undefined, empty values
- [ ] `findUnusedPreferences` — returns preferences with no site values and no default
- [ ] `findUnusedPreferences` — keeps preferences that have a default value
- [ ] `findUnusedPreferences` — keeps preferences that have at least one site "X"
- [ ] `findUnusedPreferences` — returns empty array for empty/header-only CSV data
- [ ] `writeMatrixCSV` — generates correct CSV structure (header + X markers)
- [ ] `writeUsageCSV` — generates correct CSV with dynamic site columns
- [ ] `writeUnusedPreferencesFile` — writes correct header and preference list

### codeScanner.js

- [ ] `getActivePreferencesFromMatrices` — extracts unique preference IDs from matrix CSV files
- [ ] `generatePreferenceDeletionCandidates` — classifies into P1 (no code, no values)
- [ ] `generatePreferenceDeletionCandidates` — classifies into P2 (no code, has values)
- [ ] `generatePreferenceDeletionCandidates` — classifies into P3 (deprecated code only, no values)
- [ ] `generatePreferenceDeletionCandidates` — classifies into P4 (deprecated code + values)
- [ ] `generatePreferenceDeletionCandidates` — P5 realm-specific classification
- [ ] `generatePreferenceDeletionCandidates` — respects blacklist filtering

### analyzer.js (integration)

- [ ] `processPreferenceMatrixFiles` — produces correct summary (realm, total, unused, used counts)
- [ ] `executePreferenceSummarization` — end-to-end with mocked API: generates output files

---

## 🚀 Future Enhancements

- [ ] Cache OCAPI responses to reduce API calls
- [ ] Add progress persistence (resume interrupted analysis)
- [ ] Preference migration between realms
- [ ] Integration with CI/CD pipelines

---

*Last Updated: March 9, 2026*