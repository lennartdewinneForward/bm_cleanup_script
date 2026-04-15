import { analyzeCustomObjects } from './actions/analyzeCustomObjects.js';
import { moveCustomObjects } from './actions/moveCustomObjects.js';
import { deleteCustomObjects } from './actions/deleteCustomObjects.js';
import { registerCOBlacklistCommands } from './actions/coBlacklist.js';
import { registerCOWhitelistCommands } from './actions/coWhitelist.js';

// ============================================================================
// CUSTOM OBJECT COMMANDS REGISTRATION
// Register all custom-object-related commands with the CLI program
// ============================================================================

export function registerCustomObjectCommands(program) {
    program
        .command('analyze-custom-objects')
        .description('Analyze custom object types: detect unused, single-realm, and multi-realm types')
        .action(analyzeCustomObjects);

    program
        .command('move-custom-objects')
        .description('Move single-realm custom object types from core to realm-specific meta folders')
        .option('--dry-run', 'Preview changes without modifying any files')
        .action(moveCustomObjects);

    program
        .command('delete-custom-objects')
        .description('Delete unused custom object type definitions and instance records from the repo')
        .option('--dry-run', 'Preview changes without modifying any files')
        .action(deleteCustomObjects);

    // CO blacklist/whitelist commands
    registerCOBlacklistCommands(program);
    registerCOWhitelistCommands(program);
}
