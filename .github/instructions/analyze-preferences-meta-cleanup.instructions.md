---
applyTo: "src/commands/analyze-preferences/**,src/commands/meta/**"
---

# Analyze-Preferences & Meta-Cleanup Instructions

## File Location and Naming Convention

- The Meta-cleanup-logic file must be located at:

	results/{instance}/ALL_REALMS/Meta-cleanup-logic.txt

- **Entry format:**
  - Each line should follow this pattern:
    
	  <PreferenceID>: <P-level>(<comma-separated realms>) [<P-level>(<realm(s) to migrate to>)]
  - Example:
	  BePay: P1(PNA, APAC, GB) [P2(EU)]
  - Multiple migrate-to realms with different P-levels:
	  BePay: P1(PNA, GB) [P2(EU), P3(APAC)]
  - A migrate-to realm with no deletion tier (not a candidate at all):
	  BePay: P1(PNA, APAC, GB) [none(EU)]

- **Header/Explanation:**
  - The top of the file must include a comment block explaining the notation, e.g.:
    
	  # Meta-cleanup-logic Notation
	  # Each entry lists a preference, its P-level, and the realms where that P-level applies.
	  # Realms in brackets [ ] indicate where the preference should be migrated/copied to a private meta XML.
	  # The P-level inside brackets is the tier for that specific migrate-to realm.
	  # Example: BePay: P1(PNA, APAC, GB) [P2(EU)] means BePay is P1 in PNA, APAC, GB
	  #   and must be migrated to EU's private meta XML (where it is P2).

This ensures both scripts and human users can interpret the file correctly.

---

## Meta XML File Structure

This project uses two types of meta XML files:

- **Shared meta XMLs** — located in a separate repository at `site_template/meta/{filename}`. These contain preference definitions shared across all realms.
- **Private meta XMLs** — located per realm using the path configured in `config.json`. The path variable in config should always be used; the typical pattern is `site_template_{realmName}/meta/`, but the exact path must be read from config at runtime.

When `meta-cleanup` needs to migrate a preference (i.e., it is P1 for some realms but not others), it must:
1. Read the private meta XML path for the non-P1 realm(s) from `config.json`.
2. Copy the preference definition to that realm's private meta XML before removing it from the shared meta XML.

---

## Excluding Migrated Files from Removal

When copying a metadata definition to a new path (e.g., migrating a preference to a realm-specific meta XML):

- Maintain an array (e.g., `excludedPaths`) in Meta-cleanup-logic.json listing all paths that have received a migrated/copy operation during the process.
- During the removal step, the cleanup command must check this array and ensure that these paths are NOT removed, moved, or overwritten.
- This guarantees that migrated files remain intact and are not affected by subsequent cleanup actions.
---

## Meta-cleanup-logic File

Two companion files are generated at `results/{instance}/ALL_REALMS/`:

- `Meta-cleanup-logic.txt` — human-readable (format described above)
- `Meta-cleanup-logic.json` — machine-readable; used by the `meta-cleanup` command AND contains the merged P-level mismatch data (no separate mismatch file)

**JSON structure (per preference entry):**
```json
{
  "preferenceId": "BePay",
  "pLevel": "P1",
  "p1Realms": ["PNA", "APAC", "GB"],
  "migrateToRealms": ["EU"],
  "hasMismatch": true
}
```

**Usage:**
- The `meta-cleanup` command must read this file before performing any removal actions.
- For each preference with `migrateToRealms` entries:
  1. Copy the preference definition to the private meta XML for each realm listed in `migrateToRealms` (path from `config.json`).
  2. Add the destination path to `excludedPaths` in the file.
  3. Only after migration, proceed with removal from the shared meta XML.
- Preferences with no `migrateToRealms` are removed from the shared meta XML directly.

This ensures that preferences are not lost for realms where they are still required, and that all migration logic is respected before deletion.
---

## Scenario: Preference is P1 for All Realms Except One (P2)

If a preference (e.g., `BePay`) is P1 for all realms except one (e.g., EU, which is P2):

- When running meta-cleanup to delete all P1 preferences, the result should be the same as if EU had no P-level:
	- The preference is removed from the shared meta XML (if present).
	- The preference remains in the private meta XML for EU (since it is not a P1 deletion candidate).
- No additional migration logic is required beyond what is described for the previous scenario.

This ensures that only P1 preferences are deleted, and P2 (or higher) preferences remain for realms where they are not eligible for deletion.
---

# Cross-Realm Preference Deletion Validation Instructions

## Purpose

This file defines additional validation and logic for the `analyze-preferences` and `meta-cleanup` commands to ensure correct handling of preference deletion across multiple realms, especially when P-levels differ.

---

## New Validation Step for `analyze-preferences`

A new step must be added to the `analyze-preferences` command (runs silently — no user prompt):

- After per-realm deletion candidates are generated, compare P-levels for each preference across all scanned realms.
- If a preference has the same P-level on all realms → no special action; include it normally.
- If P-levels differ across realms (a mismatch) → record the preference in `Meta-cleanup-logic.json` with the `hasMismatch: true` flag, listing which realms are P1-eligible and which are not.
- The mismatch data is written silently to `Meta-cleanup-logic.json`. No user prompt or blocking occurs at this stage.

---

## Required Logic for `meta-cleanup`

- The `meta-cleanup` command must only remove a preference from a realm's meta XML if it is a P1 deletion candidate for that specific realm.
- If a preference is not a deletion candidate for all realms, it must **not** be removed from the meta XML for realms where it is not eligible.
- Migration (copying to private meta XML) happens **only when `meta-cleanup` runs**, not during `analyze-preferences`.
- Before any removal, `meta-cleanup` reads `Meta-cleanup-logic.json` and processes all `migrateToRealms` entries first (copy → add to `excludedPaths` → then remove from shared).

---

## Handling Preferences with Differing P-Levels Across Realms

When a preference (or preference group) has different P-levels across realms, the following must be implemented:

1. **P-Level Mismatch Tracking (merged into Meta-cleanup-logic.json)**
	 - There is no separate mismatch file. All mismatch data is stored as entries in `Meta-cleanup-logic.json` with `hasMismatch: true`.
	 - Each mismatch entry lists:
		 - The preference ID
		 - The P-level assigned (e.g., `"P1"` — the level it qualifies for on the eligible realms)
		 - `p1Realms`: realms where this preference is a P1 deletion candidate
		 - `migrateToRealms`: realms where it is NOT a deletion candidate and must be migrated to the private meta XML

2. **Meta File Migration Guidance**
	 - If a preference is P1 for some realms but not others, and the project uses both shared and private meta XML files:
		 - The script (or a future script) must be able to:
			 - Remove the preference from the shared meta XML for realms where it is P1 (deletion candidate)
			 - Move the preference definition to the private meta XML for realms where it is not a deletion candidate (e.g., EU in the BePay example)
	 - The tracking file must provide enough information for a script to:
		 - Identify which meta XML files (shared/private) need to be updated
		 - Know which preferences to migrate rather than simply delete

3. **Example Scenario**
	 - Preference: `BePay`
	 - P-levels:
		 - APAC: P1
		 - PNA: P1
		 - GB: P1
		 - EU: (not a deletion candidate)
	 - Action:
		 - Remove `BePay` from shared meta XML (if present)
		 - Add or retain `BePay` in EU's private meta XML
	 - The tracking file should clearly indicate this migration requirement.

---

## Resolved Implementation Notes

- **Shared meta XML path:** `site_template/meta/` (in the shared/base repository)
- **Private meta XML path:** Read from `config.json` per realm — do not hardcode. Typical pattern: `site_template_{realmName}/meta/`
- **Mismatch tracking:** Merged into `Meta-cleanup-logic.json`; no separate file
- **Migration timing:** Only during `meta-cleanup` execution, not during `analyze-preferences`
- **analyze-preferences mismatch detection:** Silent — writes data, no user prompt or blocking
