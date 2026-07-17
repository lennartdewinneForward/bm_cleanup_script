import inquirer from 'inquirer';
import path from 'path';
import { getSiblingRepositories } from '../../../io/util.js';
import {
    buildRealmPreferenceMapFromFiles,
    buildCrossRealmPreferenceMap
} from '../../preferences/helpers/preferenceRemoval.js';
import { repositoryPrompt } from '../../prompts/index.js';
import {
    scanSitesForRemainingPreferences,
    formatSitesScanResults
} from '../helpers/metaFileCleanup.js';

// ============================================================================
// SHARED ACTION UTILITIES
// Functions shared across multiple meta command actions
// ============================================================================

/**
 * Prompt user to select a sibling repository and return the resolved path.
 * @returns {Promise<string|null>} Resolved repository path, or null if none found
 */
export async function promptForRepositoryPath() {
    const siblings = await getSiblingRepositories();
    if (siblings.length === 0) {
        console.log('No sibling repositories found.');
        return null;
    }

    const siblingAnswers = await inquirer.prompt(await repositoryPrompt(siblings));
    return path.join(path.dirname(process.cwd()), siblingAnswers.repository);
}

/**
 * Load deletion candidates from per-realm or cross-realm files, log summary, and return
 * the preference map along with a flat list of selected IDs.
 * @param {Object} params
 * @param {string[]} params.realmList - Realms to load
 * @param {string} params.instanceType - Instance type
 * @param {string} params.maxTier - Maximum deletion tier
 * @param {boolean} params.useCrossRealm - Whether to use cross-realm intersection
 * @param {string} [params.objectType] - Object type for non-SitePreferences (e.g. 'Order')
 * @returns {{ realmPreferenceMap: Map, selectedPreferenceIds: string[], totalPrefs: number }}
 */
export function loadDeletionCandidates({ realmList, instanceType, maxTier, useCrossRealm, objectType }) {
    console.log(`  Loading deletion candidates up to tier ${maxTier}...`);
    const {
        realmPreferenceMap,
        blockedByBlacklist,
        skippedByWhitelist,
        missingRealms,
        filteredOutRealms
    } = useCrossRealm
        ? buildCrossRealmPreferenceMap(realmList, instanceType, { maxTier, objectType })
        : buildRealmPreferenceMapFromFiles(realmList, instanceType, { maxTier, objectType });

    let totalPrefs = 0;
    for (const [realm, prefs] of realmPreferenceMap) {
        console.log(`    ${realm}: ${prefs.length} preference(s)`);
        totalPrefs += prefs.length;
    }

    if (blockedByBlacklist.length > 0) {
        console.log(`    Blocked by blacklist: ${blockedByBlacklist.length}`);
    }
    if (skippedByWhitelist.length > 0) {
        console.log(`    Skipped (not whitelisted): ${skippedByWhitelist.length}`);
    }
    if (filteredOutRealms?.length > 0) {
        console.log(`    No candidates after filtering for: ${filteredOutRealms.join(', ')}`);
    }
    if (missingRealms.length > 0) {
        console.log(`    Missing deletion files for: ${missingRealms.join(', ')}`);
    }

    const selectedPreferenceIds = [];
    for (const preferenceIds of realmPreferenceMap.values()) {
        selectedPreferenceIds.push(...preferenceIds);
    }

    return { realmPreferenceMap, selectedPreferenceIds, totalPrefs };
}

/**
 * Run cross-realm residual scan if cross-realm mode is active.
 * @param {Object} params
 * @param {boolean} params.useCrossRealm - Whether cross-realm mode is active
 * @param {string} params.repoPath - Repository path
 * @param {string[]} params.selectedPreferenceIds - Preference IDs to scan for
 */
export function runCrossRealmScanIfNeeded({ useCrossRealm, repoPath, selectedPreferenceIds }) {
    if (useCrossRealm) {
        console.log('\n  Running cross-realm residual scan in sites/ ...');
        const scanResults = scanSitesForRemainingPreferences({
            repoPath,
            preferenceIds: selectedPreferenceIds
        });
        console.log(formatSitesScanResults(scanResults));
    }
}
