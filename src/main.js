// Increase libuv thread pool for parallel file I/O (default is 4, must be set
// before any async I/O occurs).  This allows p-limit batched reads to saturate
// the disk instead of queuing behind 4 threads.
process.env.UV_THREADPOOL_SIZE = '64';

// ---------------------------------------------------------------------------
// Global crash handlers — write directly to process.stderr so errors are NEVER
// swallowed by RealmProgressDisplay's console suppression.
// ---------------------------------------------------------------------------
process.on('uncaughtException', (err) => {
    process.stderr.write(`\n\n[FATAL] Uncaught exception:\n${err.stack || err}\n`);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.stack : String(reason);
    process.stderr.write(`\n\n[FATAL] Unhandled promise rejection:\n${msg}\n`);
    process.exit(1);
});

import { Command } from 'commander';
import { registerDebugCommands } from './commands/debug/debug.js';
import { registerPreferenceCommands } from './commands/preferences/preferences.js';
import { registerCartridgeCommands } from './commands/cartridges/cartridges.js';
import { registerSetupCommands } from './commands/setup/setup.js';
import { registerBlacklistCommands } from './commands/setup/actions/blacklist.js';
import { registerWhitelistCommands } from './commands/setup/actions/whitelist.js';
import { registerMetaCommands } from './commands/meta/meta.js';
import { registerCustomObjectCommands } from './commands/custom-objects/customObjects.js';

// ============================================================================
// CLI ENTRYPOINT
// Central command registry for OCAPI tooling
// ============================================================================

const program = new Command();

// Command to list sites and export cartridge paths
program
    .name('OCAPI Tools')
    .description('Tools for working with SFCC OCAPI')
    .version('1.0.0');

// ============================================================================
// REGISTER SETUP COMMANDS
// ============================================================================
// Location: src/commands/setup/setup.js
// Commands:
//   - add-realm: Add a new realm to config.json
//   - remove-realm: Remove a realm from config.json

registerSetupCommands(program);

// ============================================================================
// REGISTER BLACKLIST COMMANDS
// ============================================================================
// Location: src/commands/setup/blacklist.js
// Commands:
//   - add-to-blacklist: Add a preference pattern to the blacklist
//   - remove-from-blacklist: Remove a preference pattern from the blacklist
//   - list-blacklist: Show all blacklisted preference patterns

registerBlacklistCommands(program);

// ============================================================================
// REGISTER WHITELIST COMMANDS
// ============================================================================
// Location: src/commands/setup/whitelist.js
// Commands:
//   - add-to-whitelist: Add a preference pattern to the whitelist
//   - remove-from-whitelist: Remove a preference pattern from the whitelist
//   - list-whitelist: Show all whitelisted preference patterns

registerWhitelistCommands(program);

// ============================================================================
// REGISTER CARTRIDGE COMMANDS
// ============================================================================
// Location: src/commands/cartridges/cartridges.js
// Commands:
//   - list-sites: List all sites and export cartridge paths to CSV
//   - validate-cartridges-all: [WIP] Validate cartridges across all realms
//   - validate-site-xml: [WIP] Validate site.xml files match live SFCC

registerCartridgeCommands(program);

// ============================================================================
// REGISTER PREFERENCE COMMANDS
// ============================================================================
// Location: src/commands/preferences/preferences.js
// Commands:
//   - analyze-preferences: Full preference analysis workflow
//   - remove-preferences: Remove preferences marked for deletion
//   - restore-preferences: Restore site preferences from backup
//   - backup-site-preferences: Trigger backup job and download metadata
//   - inspect-preference: Show detailed info about a single preference
//   - export-ticket-lists: Export per-realm, per-P-level lists for Jira tickets

registerPreferenceCommands(program);

// ============================================================================
// REGISTER META COMMANDS
// ============================================================================
// Location: src/commands/meta/meta.js
// Commands:
//   - test-meta-cleanup: Preview/execute removal of preference definitions
//     from sibling repo XML files (dry-run supported)
//   - meta-cleanup: Full workflow — create branch, run cleanup, stage & commit
//   - detect-orphans: Compare BM backup XML against repo meta XMLs to find orphans

registerMetaCommands(program);

// ============================================================================
// REGISTER CUSTOM OBJECT COMMANDS
// ============================================================================
// Location: src/commands/custom-objects/customObjects.js
// Commands:
//   - analyze-custom-objects: Analyze CO types across realms (unused, single-realm, shared)
//   - move-custom-objects: Move single-realm CO types from core to realm-specific folders
//   - add-to-co-blacklist: Add a CO type pattern to the blacklist
//   - remove-from-co-blacklist: Remove a CO type pattern from the blacklist
//   - list-co-blacklist: Show all blacklisted CO type patterns
//   - add-to-co-whitelist: Add a CO type pattern to the whitelist
//   - remove-from-co-whitelist: Remove a CO type pattern from the whitelist
//   - list-co-whitelist: Show all whitelisted CO type patterns

registerCustomObjectCommands(program);

// ============================================================================
// REGISTER DEBUG COMMANDS
// ============================================================================
// Location: src/commands/debug/debug.js
// Commands: Various debug/test commands for development and troubleshooting
//   - check-api-endpoints: Probe OCAPI endpoints for all configured realms

registerDebugCommands(program);

program.parse();
