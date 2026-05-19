import { metaCleanup } from './actions/metaCleanup.js';
import { detectOrphans } from './actions/orphanDetection.js';
import { validateMetaChangesAction } from './actions/validateMetaChanges.js';

// ============================================================================
// META COMMANDS REGISTRATION
// Register all meta file management commands with the CLI program
// ============================================================================

/**
 * Register meta file management commands with the CLI program.
 * @param {import('commander').Command} program - Commander.js program instance
 */
export function registerMetaCommands(program) {

    program
        .command('meta-cleanup')
        .description('Full meta cleanup workflow — create branch, remove preference definitions, stage & commit')
        .option('--debug [count]', 'Process preferences in batches (default: 10) — pause between batches for verification')
        .action(metaCleanup);

    program
        .command('validate-meta-changes')
        .description('Verify meta-cleanup results — check removals against deletion files, blacklist, and file structure')
        .option('--fix', 'Auto-fix indentation issues in changed XML files')
        .action(validateMetaChangesAction);

    program
        .command('detect-orphans')
        .description('Compare BM metadata backup against repo meta XMLs to find orphan preferences')
        .action(detectOrphans);
}
