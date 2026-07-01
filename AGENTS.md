# AGENTS.md - Cleanup Script Project Agents & Capabilities

This document defines the AI agents and their capabilities for the Cleanup-Script project.

## Project Overview
- **Project Name:** Cleanup-Script
- **Project Code:** CLEANUPSCRIPT
- **Domain:** Site Preferences & Configuration Management
- **Type:** Utility / Maintenance Tool
- **Purpose:** Analyze and clean up unused Salesforce Commerce Cloud (SFCC) site preferences

---

## Primary Agent Capabilities

### 1. API Integration Agent
**Capability:** Interact with SFCC OCAPI (Open Commerce API) endpoints

- **Scope:** 
  - OAuth authentication & session management
  - Site preference retrieval via OCAPI
  - Backup job triggering & WebDAV downloads
  - Batch processing with rate limiting

- **Files:** 
  - [src/api/api.js](src/api/api.js)
  - [src/helpers/backupJob.js](src/helpers/backupJob.js)
  - [src/helpers/batch.js](src/helpers/batch.js)
  - [src/io/backupUtils.js](src/io/backupUtils.js) - Backup download & archive utilities
  - [src/config/ocapi_config.json](src/config/ocapi_config.json)

- **Key Functions:**
  - `getAllSites()`, `getSiteById()` - Site retrieval
  - `getAttributeGroups()`, `getSitePreferences()` - Preference data
  - `getAttributeDefinitionById()` - Detailed definitions with defaults
  - `deleteAttributeDefinitionById()` - Delete preference definitions via OCAPI
  - `getSitePreferencesGroup()` - Fetch actual preference values per site/group
  - `getOAuthToken()` - OAuth 2.0 authentication
  - `processBatch()` - Parallel batch processing with delays
  - `withLoadShedding()` - Rate limit handling
  - `refreshMetadataBackupForRealm()` - Backup job trigger + download

---

### 2. Data Processing Agent
**Capability:** Process and analyze preference data

- **Scope:**
  - CSV matrix generation (preference × site usage)
  - Preference usage analysis across cartridges
  - Priority-tiered deprecation logic (P1–P5)
  - Per-realm deletion file generation
  - Backup file generation and validation

- **Files:**
  - [src/helpers/summarize.js](src/helpers/summarize.js) - Matrix building & preference normalization
  - [src/helpers/analyzer.js](src/helpers/analyzer.js) - Matrix processing orchestration
  - [src/io/csv.js](src/io/csv.js) - CSV read/write and unused preference detection
  - [src/io/codeScanner.js](src/io/codeScanner.js) - Code scanning & deletion candidate generation
  - [src/commands/preferences/helpers/preferenceRemoval.js](src/commands/preferences/helpers/preferenceRemoval.js) - Per-realm deletion file loading
  - [src/commands/preferences/helpers/backupHelpers.js](src/commands/preferences/helpers/backupHelpers.js) - Backup creation & validation
  - [src/commands/preferences/helpers/generateSitePreferences.js](src/commands/preferences/helpers/generateSitePreferences.js) - Site preference JSON generation

- **Key Functions:**
  - `buildMeta()` - Normalize OCAPI definitions
  - `processSitesAndGroups()` - Aggregate site preference values
  - `buildAttributeMatrix()` - Generate usage matrix
  - `findUnusedPreferences()` - Identify preferences with no values
  - `findAllActivePreferencesUsage()` - Scan cartridge code for references
  - `generatePreferenceDeletionCandidates()` - Build per-realm deletion files with priority tiers
  - `loadRealmPreferencesForDeletion()` - Load per-realm deletion files
  - `buildRealmPreferenceMapFromFiles()` - Build realm → preferences map from per-realm files
  - `createBackupsForRealms()` - Create backup JSON files per realm

---

### 3. Utility & Configuration Agent
**Capability:** Configuration, logging, and workflow orchestration

- **Scope:**
  - Multi-realm configuration management
  - Interactive CLI prompts (Inquirer.js)
  - Progress tracking and status logging
  - Real-time progress display (RealmProgressDisplay)
  - File system utilities

- **Files:**
  - [src/config/helpers/helpers.js](src/config/helpers/helpers.js) - Config read/write, realm management
  - [src/config/constants.js](src/config/constants.js) - Constants, deletion levels, tier order
  - [src/scripts/loggingScript/log.js](src/scripts/loggingScript/log.js) - Logging utilities
  - [src/scripts/loggingScript/progressDisplay.js](src/scripts/loggingScript/progressDisplay.js) - RealmProgressDisplay class
  - [src/helpers/timer.js](src/helpers/timer.js) - Runtime tracking
  - [src/io/util.js](src/io/util.js) - File system utilities
  - [src/commands/prompts/index.js](src/commands/prompts/index.js) - Prompt aggregation
  - [src/commands/prompts/preferencePrompts.js](src/commands/prompts/preferencePrompts.js) - Preference prompts
  - [src/commands/prompts/realmPrompts.js](src/commands/prompts/realmPrompts.js) - Realm selection prompts
  - [src/commands/prompts/commonPrompts.js](src/commands/prompts/commonPrompts.js) - Shared prompts
  - [src/main.js](src/main.js) - Command registration & orchestration

- **Key Functions:**
  - `getSandboxConfig()`, `getRealmsByInstanceType()` - Config retrieval
  - `addRealmToConfig()`, `removeRealmFromConfig()` - Realm management
  - `deriveRealm()` - Extract realm name from hostname
  - `resolveRealmScopeSelection()` - Multi-realm prompts
  - `deletionLevelPrompt()` - P1–P5 cascading deletion level selection
  - `logStatusUpdate()`, `logProgress()` - User feedback
  - `RealmProgressDisplay` - Dynamic multi-realm CLI progress display
  - `ensureResultsDir()`, `getSiblingRepositories()` - File utilities
  - `findAllMatrixFiles()`, `findAllUsageFiles()` - Result file discovery
  - `openFileInVSCode()` - Open files in VS Code editor
  - Command orchestration in [src/main.js](src/main.js)

---

### 4. Code Analysis Agent
**Capability:** Scan cartridge code for preference references

- **Scope:**
  - Multi-file batch scanning (optimized)
  - Deprecated cartridge filtering
  - Preference usage mapping
  - Per-realm deletion file generation with priority tiers (P1–P5)
  - File type filtering (.js, .isml, .ds, .json, .xml, .properties)

- **Files:**
  - [src/io/codeScanner.js](src/io/codeScanner.js) - Core scanning & deletion candidate logic
  - [src/commands/cartridges/helpers/cartridgeComparison.js](src/commands/cartridges/helpers/cartridgeComparison.js) - Cartridge comparison
  - [src/commands/cartridges/helpers/siteHelper.js](src/commands/cartridges/helpers/siteHelper.js) - Site data fetching

- **Key Functions:**
  - `findAllActivePreferencesUsage()` - Batch scan all preferences across cartridges
  - `getActivePreferencesFromMatrices()` - Extract preference list from CSV matrices
  - `generatePreferenceDeletionCandidates()` - Generate per-realm deletion files with P1–P5 tiers
  - `findPreferenceUsage()` - Scan for a single preference
  - `compareCartridges()` - Compare cartridge lists across realms
  - `fetchAndTransformSites()` - Fetch site data from OCAPI

---

### 5. Deletion & Restore Agent
**Capability:** Delete preferences via OCAPI and restore from backups

- **Scope:**
  - Per-realm preference deletion with priority-based filtering
  - Backup creation before deletion
  - Preference restoration from backup files
  - Blacklist/whitelist filtering

- **Files:**
  - [src/commands/preferences/preferences.js](src/commands/preferences/preferences.js) - Command registration (extracted layout)
  - [src/commands/preferences/actions/removePreferences.js](src/commands/preferences/actions/removePreferences.js) - Remove command flow
  - [src/commands/preferences/actions/restorePreferences.js](src/commands/preferences/actions/restorePreferences.js) - Restore command flow
  - [src/commands/preferences/actions/shared.js](src/commands/preferences/actions/shared.js) - Shared action utilities
  - [src/commands/preferences/helpers/deleteHelpers.js](src/commands/preferences/helpers/deleteHelpers.js) - OCAPI DELETE operations
  - [src/commands/preferences/helpers/restoreHelper.js](src/commands/preferences/helpers/restoreHelper.js) - Preference restoration
  - [src/commands/preferences/helpers/preferenceRemoval.js](src/commands/preferences/helpers/preferenceRemoval.js) - Deletion file loading & summary
  - [src/commands/preferences/helpers/backupHelpers.js](src/commands/preferences/helpers/backupHelpers.js) - Backup creation
  - [src/commands/setup/helpers/blacklistHelper.js](src/commands/setup/helpers/blacklistHelper.js) - Blacklist management (thin wrapper)
  - [src/commands/setup/helpers/whitelistHelper.js](src/commands/setup/helpers/whitelistHelper.js) - Whitelist management (thin wrapper)
  - [src/commands/setup/helpers/blackAndWhiteListHelper.js](src/commands/setup/helpers/blackAndWhiteListHelper.js) - Shared list helper factory
  - [src/commands/setup/helpers/listCommands.js](src/commands/setup/helpers/listCommands.js) - Shared CLI command factory

- **Key Functions:**
  - `deletePreferencesForRealms()` - Execute OCAPI DELETE across realms
  - `restorePreferencesFromBackups()` - Restore preferences from backup JSON
  - `restorePreferencesForRealm()` - Per-realm restore logic
  - `openRealmDeletionFilesInEditor()` - Open per-realm files for review in VS Code
  - `generateDeletionSummary()` - Summary of deletion candidates
  - `createListHelper()` - Factory for blacklist/whitelist CRUD (shared by both)
  - `createListCommands()` - Factory for CLI add/remove/list commands (shared by both)
  - `loadBlacklist()`, `isBlacklisted()` - Blacklist filtering
  - `loadWhitelist()`, `isWhitelisted()` - Whitelist filtering

---

## Supported Data Formats

### Input
- JSON responses from SFCC OCAPI
- CSV files with preference data
- Configuration files (JSON)

### Output
- CSV matrices (usage, summary)
- TXT reports (unused preferences, per-realm deletion files)
- JSON summaries and backups

### Sample Files
Located in [test-runs/](test-runs/):
- `bcwr-080_sandbox_preferences_response.json`
- `bcwr-080_sandbox_preferences_matrix.csv`
- `bcwr-080_unused_preferences.txt`

---

## Configuration & Environment

### Configuration Files
- [config.json](config.json) - Active project configuration
- [config.example.json](config.example.json) - Configuration template
- [src/config/ocapi_config.json](src/config/ocapi_config.json) - OCAPI endpoint settings
- [src/config/preference_blacklist.json](src/config/preference_blacklist.json) - Preferences excluded from deletion
- [src/config/preference_whitelist.json](src/config/preference_whitelist.json) - Preferences approved for deletion

### Environment Requirements
- **Node Engine:** >=16.0.0 (from package.json)
- **Required Packages:** See [package.json](package.json)

---

## Deprecation Logic & Workflow

### Priority Tiers (P1–P5)

Each preference is classified into a priority tier based on code usage and value presence:

| Tier | Code Usage | Has Values | Description |
|------|-----------|------------|-------------|
| P1 | No code refs | No values | Safest to delete — completely unused |
| P2 | No code refs | Has values | No code uses it, but values exist on some sites |
| P3 | Deprecated code only | No values | Only referenced in deprecated cartridges, no values |
| P4 | Deprecated code only | Has values | Deprecated code refs + values exist |
| P5 | Active code (some realms) | Varies | Active in some realms but not the target realm |

Tier selection is **cascading**: selecting P3 includes P1 + P2 + P3.

### Three-Level Analysis

**Level 1: Matrix Analysis (per realm)**

A preference is "unused" IF:
- No site has a value (no "X" marks in matrix)
- AND no default value exists

→ Output: `{realm}_unused_preferences.txt`

**Level 2: Cartridge Code Scan**

Scans repository cartridges for ALL active preferences:
- **Includes:** .js, .isml, .ds, .json, .xml, .properties files
- **Excludes:** sites folder, .git, node_modules, deprecated cartridges
- Records which cartridges reference each preference
- Tags deprecated cartridge usage as `[possibly deprecated]`

→ Output:
- `{instance}_unused_preferences.txt` - No cartridge usage found
- `{instance}_cartridge_preferences.txt` - Cartridge → preference mapping

**Level 3: Per-Realm Deletion Candidates**

Generates a separate deletion file per realm. Each preference is re-evaluated
per realm (a global P2 may become P1 on a realm with no values, or P2 on a
realm where values exist). P5 candidates only appear in realm files where active
code does NOT run.

→ Output: `{realm}_preferences_for_deletion.txt` (one per realm)

### Workflow: analyze-preferences → remove-preferences

```
1. analyze-preferences (7 steps)
   ↓
   Select instance type & realms → Fetch prefs from SFCC
   ↓
   Generate matrices → Scan cartridge code → Generate per-realm deletion files
   ↓
   Export site cartridge lists
   ↓
   Output: {realm}_preferences_for_deletion.txt (per realm)

2. remove-preferences (9 steps)
   ↓
   Step 1: Select instance type
   Step 2: Select realms
   Step 3: Select deletion level (P1–P5 cascading + realm-targeted)
   Step 4: Load per-realm deletion files (filtered by selected tier)
   Step 5: Open per-realm files in VS Code for review
   Step 6: Create backups (per realm)
   Step 7: Confirm deletion
   Step 8: Delete preferences via OCAPI
   Step 9: Optional restore from backups
```

---

## Results & Artifacts

Output directory structure:
```
backup/
├── development/
│   └── {realm}_SitePreferences_backup_{date}.json
├── sandbox/
│   └── {realm}_SitePreferences_backup_{date}.json
└── staging/
    └── ...

backup_downloads/
└── {instance}_{realm}_meta_data_backup.xml

results/
├── development/
│   ├── ALL_REALMS/
│   │   ├── ALL_REALMS_cartridge_comparison.txt
│   │   ├── ALL_REALMS_unused_preferences.txt
│   │   ├── development_cartridge_preferences.txt
│   │   ├── development_preference_usage.txt
│   │   └── development_unused_preferences.txt
│   ├── {realm}/
│   │   ├── {realm}_active_site_cartridges_list.csv
│   │   ├── {realm}_development_preferences_matrix.csv
│   │   ├── {realm}_development_preferences_usage.csv
│   │   ├── {realm}_unused_preferences.txt
│   │   └── {realm}_preferences_for_deletion.txt  ← PER-REALM DELETION LIST
│   └── ...
├── sandbox/
│   └── ...
└── staging/
    └── ...
```

---

## Development Notes

### Code Quality Standards

**Variable Declaration Pattern:**
- Move ALL variable declarations to the **top of the function**
- Declare variables with their actual assigned values immediately, not empty
- Only use `let` for conditionally-assigned variables (no value at declaration time)
- Example:
  ```javascript
  // ✓ CORRECT - declare with immediate value
  const cartridges = findCartridgeFolders(repositoryPath);
  const sandbox = getSandboxConfig(realm);
  
  // ✓ CORRECT - declare empty only if conditionally assigned later
  let filePath;
  if (condition) {
    filePath = await someAsyncFunction();
  }
  ```
- **Linting:** ESLint enforces 120 character line limit; split declarations across multiple lines if needed

**Related Files:**
- ESLint configuration: [eslint.config.js](eslint.config.js)
- Main entry point: [src/main.js](src/main.js)
- All helper files follow this pattern

### Process Documentation
- User guide: [site preference cleanup script.txt](site%20preference%20cleanup%20script.txt)
- Project README: [README.md](README.md)

### Test Data
Test responses are stored in [test-runs/](test-runs/) directory for reference and debugging.

---

## Commands Reference

### Production Commands
- `analyze-preferences` - Full analysis workflow (fetch → scan → generate per-realm deletion lists)
- `remove-preferences` - Remove preferences from per-realm deletion files via OCAPI DELETE
- `restore-preferences` - Restore deleted preferences from backup files
- `backup-site-preferences` - Trigger backup job and download metadata
- `inspect-preference` - Show detailed info about a single preference (values, code refs, P-level)
- `export-ticket-lists` - Export per-realm, per-P-level preference lists as Jira ticket attachment files
- `test-meta-cleanup` - Preview/execute removal of preference definitions from repo XML
- `meta-cleanup` - Full git workflow: create branch → remove XML definitions → stage & commit
- `detect-orphans` - Compare BM metadata backup XML against repo meta XMLs to find orphan preferences
- `list-sites` - Export site cartridge paths to CSV
- `add-realm` / `remove-realm` - Realm configuration management
- `add-to-blacklist` / `remove-from-blacklist` / `list-blacklist` - Blacklist management
- `add-to-whitelist` / `remove-from-whitelist` / `list-whitelist` - Whitelist management

### Validation Commands
- `validate-cartridges-all` - Multi-realm cartridge validation
- `validate-site-xml` - Site.xml vs. live cartridge comparison

---

### 6. Meta File & Orphan Detection Agent
**Capability:** Manage meta XML files and detect orphan preferences

- **Scope:**
  - Cleanup of preference definitions from repo XML files
  - Git workflow integration (branch, stage, commit)
  - Orphan detection: BM backup XML vs repo meta XML comparison
  - Meta file consolidation across realms

- **Files:**
  - [src/commands/meta/meta.js](src/commands/meta/meta.js) - Command registration
  - [src/commands/meta/actions/testMetaCleanup.js](src/commands/meta/actions/testMetaCleanup.js) - Preview/execute meta cleanup
  - [src/commands/meta/actions/metaCleanup.js](src/commands/meta/actions/metaCleanup.js) - Full git workflow cleanup
  - [src/commands/meta/actions/orphanDetection.js](src/commands/meta/actions/orphanDetection.js) - Orphan detection action
  - [src/commands/meta/helpers/metaFileCleanup.js](src/commands/meta/helpers/metaFileCleanup.js) - XML manipulation & cleanup planning
  - [src/commands/meta/helpers/orphanHelper.js](src/commands/meta/helpers/orphanHelper.js) - Orphan detection logic
  - [src/commands/meta/helpers/metaConsolidation.js](src/commands/meta/helpers/metaConsolidation.js) - Meta file merging
  - [src/commands/meta/helpers/gitHelper.js](src/commands/meta/helpers/gitHelper.js) - Git operations

- **Key Functions:**
  - `collectRepoAttributeIds()` - Scan all repo meta XMLs for attribute definitions
  - `detectOrphansForRealm()` - Compare BM backup vs repo for a single realm
  - `formatOrphanReport()` / `writeOrphanReport()` - Generate orphan report
  - `buildMetaCleanupPlan()` - Plan XML attribute removal operations
  - `executeMetaCleanupPlan()` - Execute planned XML modifications

---

## Next Steps for Agents

When working on this project:

1. **Preference Analysis:** Use Data Processing + Code Analysis Agents
2. **SFCC Integration:** Use API Integration Agent
3. **Preference Deletion:** Use Deletion & Restore Agent (OCAPI DELETE implemented)
4. **Backup/Restore:** Use Deletion & Restore Agent + backupHelpers
5. **Configuration:** Use Utility & Configuration Agent
6. **Meta XML & Orphans:** Use Meta File & Orphan Detection Agent

---

*Last Updated: March 19, 2026*
*Project Structure: Maintained by AI agents*
