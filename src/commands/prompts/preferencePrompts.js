import inquirer from 'inquirer';
import { IDENTIFIERS, LOG_PREFIX, BACKUP_CONFIG } from '../../config/constants.js';
import { logSectionTitle } from '../../scripts/loggingScript/log.js';
import { checkBackupStatusForRealms } from '../../io/backupUtils.js';

export const cleanupSourceTypePrompt = () => ([
    {
        type: 'rawlist',
        name: 'cleanupSourceType',
        message: 'What type of cleanup metadata do you want to work with?',
        choices: [
            {
                name: 'Site Preferences (from analyze-preferences)',
                value: 'preferences'
            },
            {
                name: 'Custom Attributes (from analyze-custom-attributes)',
                value: 'custom-attributes'
            }
        ]
    }
]);

export const deletionSourcePrompt = () => ([
    {
        type: 'rawlist',
        name: 'deletionSource',
        message: 'Which deletion file should be used?',
        choices: [
            {
                name: 'Per-realm files — Each realm has its own deletion candidates',
                value: 'per-realm'
            },
            {
                name: 'Cross-realm intersection — Only preferences at the same tier on ALL realms',
                value: 'cross-realm'
            }
        ]
    }
]);

export const deletionLevelPrompt = () => ([
    {
        type: 'rawlist',
        name: 'deletionLevel',
        message: 'Select deletion level (cascading — includes all lower tiers):',
        choices: [
            {
                name: 'P1 — Safe to Delete: No code references, no values',
                value: 'P1'
            },
            {
                name: 'P2 — Likely Safe: No code references, has values [includes P1]',
                value: 'P2'
            },
            {
                name: 'P3 — Deprecated Code Only: No values [includes P1-P2]',
                value: 'P3'
            },
            {
                name: 'P4 — Deprecated Code + Values [includes P1-P3]',
                value: 'P4'
            },
            {
                name: 'P5 — Realm-Specific: Active code not on all realms [includes P1-P4]',
                value: 'P5'
            }
        ]
    }
]);

export const confirmPreferenceDeletionPrompt = (count, dryRun = false) => ([
    {
        name: 'confirm',
        message: dryRun
            ? `Proceed with dry-run simulation for ${count} preferences? (no changes will be made)`
            : `Are you sure you want to delete these ${count} preferences? This action cannot be undone.`,
        type: 'confirm',
        default: dryRun
    }
]);

export const runAnalyzePreferencesPrompt = (instanceType) => ([
    {
        name: 'runAnalyze',
        message: `Preferences for deletion file hasn't been generated yet for '${instanceType}'.`
            + ' Would you like to run analyze-preferences to generate this file?',
        type: 'confirm',
        default: true
    }
]);

export const confirmRestoreAfterDeletionPrompt = () => ([
    {
        type: 'confirm',
        name: 'restore',
        message: 'Would you like to restore the deleted preferences from backups?',
        default: false
    }
]);

export const confirmProceedRestorePrompt = () => ([
    {
        type: 'confirm',
        name: 'proceed',
        message: 'Proceed with restoration?',
        default: false
    }
]);

export const overwriteBackupsPrompt = (count) => ([
    {
        type: 'confirm',
        name: 'createNew',
        message: `${count} realm(s) already have today's backup. Create new ones anyway?`,
        default: false
    }
]);

export const refreshMetadataPrompt = () => ([
    {
        type: 'confirm',
        name: 'refreshMetadata',
        message: 'Download latest metadata from SFCC before creating backups?',
        default: false
    }
]);

export const applyBackupCorrectionsPrompt = () => ([
    {
        type: 'confirm',
        name: 'applyCorrections',
        message: 'Apply these corrections before restore?',
        default: true
    }
]);

export const preferenceIdPrompt = () => ([
    {
        name: 'preferenceId',
        message: 'Preference ID to search for?',
        validate: (input) => input && input.trim().length > 0 ? true : 'Preference ID is required'
    }
]);

// Used by debug commands only — main analyze-preferences hardcodes these values
export const objectTypePrompt = (defaultValue = IDENTIFIERS.SITE_PREFERENCES) => ([
    {
        name: 'objectType',
        message: 'Choose an object type?',
        type: 'rawlist',
        choices: [IDENTIFIERS.SITE_PREFERENCES],
        default: defaultValue
    }
]);

export const scopePrompts = () => ([
    {
        name: 'scope',
        message: 'Run for all sites or single site?',
        type: 'rawlist',
        choices: ['all', 'single'],
        default: 'all'
    },
    {
        name: 'siteId',
        message: 'Enter site ID to process',
        when: (a) => a.scope === 'single',
        validate: (input) => input && input.trim().length > 0 ? true : 'Site ID is required'
    }
]);

export const includeDefaultsPrompt = () => ([
    {
        type: 'confirm',
        name: 'includeDefaults',
        message: 'Include default values? (slower)',
        default: true
    }
]);

export const useExistingBackupPrompt = (ageInDays) => ([
    {
        name: 'useExisting',
        message: `Backup file found (${ageInDays} day${ageInDays === 1 ? '' : 's'} old). Use existing backup data?`,
        type: 'confirm',
        default: true
    }
]);

export const useExistingBackupsForAllRealmsPrompt = (backupSummary) => ([
    {
        name: 'useExisting',
        message: `Found backup files for ${backupSummary.availableCount} realm(s).`
            + ' Use cached data for all realms?',
        type: 'confirm',
        default: true
    }
]);

/**
 * Prompt user about using cached backup files when includeDefaults is true.
 * Checks backup age, displays status, and asks whether to reuse or fetch fresh.
 * @param {string[]} realmsToProcess - Realms being processed
 * @param {string} objectType - Object type
 * @returns {Promise<boolean>} Whether to use cached backups
 */
export async function promptBackupCachePreference(realmsToProcess, objectType) {
    const backupStatus = await checkBackupStatusForRealms(realmsToProcess, objectType);
    const validBackups = backupStatus.filter(b => b.exists && !b.tooOld);
    const tooOldBackups = backupStatus.filter(b => b.exists && b.tooOld);

    if (validBackups.length === 0) {
        return false;
    }

    logSectionTitle('BACKUP FILES FOUND');

    validBackups.forEach(backup => {
        const plural = backup.ageInDays === 1 ? '' : 's';
        console.log(
            `  ${LOG_PREFIX.INFO} ${backup.realm}: ${backup.ageInDays} day${plural} old`
        );
    });

    if (tooOldBackups.length > 0) {
        console.log(
            `\nBackups older than ${BACKUP_CONFIG.MAX_AGE_DAYS} days (will fetch fresh):`
        );
        tooOldBackups.forEach(backup => {
            console.log(
                `  ${LOG_PREFIX.WARNING} ${backup.realm}: ${backup.ageInDays} days old`
            );
        });
    }

    console.log('');

    const backupAnswer = await inquirer.prompt(useExistingBackupsForAllRealmsPrompt({
        availableCount: validBackups.length,
        totalCount: realmsToProcess.length
    }));

    if (backupAnswer.useExisting) {
        console.log(`${LOG_PREFIX.INFO} Will use cached backups where available.\n`);
    } else {
        console.log(`${LOG_PREFIX.INFO} Will fetch fresh data for all realms.\n`);
    }

    return backupAnswer.useExisting;
}
