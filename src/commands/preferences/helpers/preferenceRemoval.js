/**
 * Preference Removal Helper
 * Handles loading and removing site preferences marked for deletion
 */

import fs from 'fs';
import path from 'path';
import { ensureResultsDir, openFileInVSCode } from '../../../io/util.js';
import { FILE_PATTERNS, TIER_ORDER, IDENTIFIERS } from '../../../config/constants.js';
import { filterBlacklisted } from '../../setup/helpers/blacklistHelper.js';
import { filterWhitelisted } from '../../setup/helpers/whitelistHelper.js';

/**
 * Parse tiered preferences from a deletion file's content.
 * Reads P1–P5 sections and extracts preference IDs up to an optional max tier.
 *
 * @param {string} content - Raw file content
 * @param {Object} [options] - Parsing options
 * @param {string|null} [options.maxTier] - Maximum tier to include (cascading)
 * @param {boolean} [options.matchLegacyHeader] - Also match legacy '--- Preferences for Deletion ---'
 * @param {boolean} [options.stopAtBlacklistSection] - Break when blacklist section header is found
 * @returns {Array<{id: string, tier: string|null}>} Parsed preference entries
 * @private
 */
function parseTieredPreferences(content, {
    maxTier = null,
    matchLegacyHeader = false,
    stopAtBlacklistSection = false
} = {}) {
    const lines = content.split(/\r?\n/);
    const preferences = [];
    let inPreferenceSection = false;
    let currentTier = null;

    const maxTierOrder = maxTier ? (TIER_ORDER[maxTier] || 5) : null;

    for (const line of lines) {
        const trimmed = line.trim();

        const isTierHeader = trimmed.startsWith('--- [P')
            || (matchLegacyHeader && trimmed === '--- Preferences for Deletion ---');

        if (isTierHeader) {
            inPreferenceSection = true;

            const tierMatch = trimmed.match(/\[P(\d)\]/);
            currentTier = tierMatch ? `P${tierMatch[1]}` : null;

            if (maxTierOrder && currentTier) {
                const tierNum = TIER_ORDER[currentTier] || 0;
                if (tierNum > maxTierOrder) {
                    inPreferenceSection = false;
                }
            }
            continue;
        }

        if (stopAtBlacklistSection
            && trimmed === '--- Blacklisted Preferences (Protected) ---') {
            break;
        }

        if (!trimmed || trimmed.startsWith('=')) {
            if (trimmed.startsWith('=')) {
                inPreferenceSection = false;
            }
            continue;
        }

        if (inPreferenceSection) {
            const parts = trimmed.split('  |  ');
            const prefId = parts[0].trim();

            if (!prefId) {
                continue;
            }

            preferences.push({ id: prefId, tier: currentTier });
        }
    }

    return preferences;
}

/**
 * Load per-realm preferences for deletion.
 * Reads from realm-specific files (e.g. EU05_preferences_for_deletion.txt).
 * Per-realm files have no realm tags — every preference in the file is a candidate for that realm.
 *
 * @param {string} realm - Realm name (e.g. 'EU05')
 * @param {string} instanceType - Instance type (sandbox, development, staging, production)
 * @param {Object} [options] - Optional filtering options
 * @param {string} [options.maxTier] - Maximum tier to include (cascading, e.g. 'P2' = P1+P2)
 * @param {string} [options.objectType] - Object type for non-SitePreferences (e.g. 'Order', 'Product').
 *   When set, loads from `{realm}_{objectType}_custom_attributes_for_deletion.txt`
 * @returns {{
 *   allowed: Array<{id: string, tier: string}> | null,
 *   blocked: string[],
 *   skippedByWhitelist: string[],
 *   fileExists: boolean,
 *   totalInFile: number
 * } | null}
 */
export function loadRealmPreferencesForDeletion(realm, instanceType, { maxTier, objectType } = {}) {
    const resultsDir = ensureResultsDir(realm, instanceType, objectType);
    const filename = objectType
        ? `${realm}_${objectType}${FILE_PATTERNS.CUSTOM_ATTR_FOR_DELETION}`
        : `${realm}${FILE_PATTERNS.PREFERENCES_FOR_DELETION}`;
    const filePath = path.join(resultsDir, filename);

    if (!fs.existsSync(filePath)) {
        return null;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const preferences = parseTieredPreferences(content, {
        maxTier,
        matchLegacyHeader: true,
        stopAtBlacklistSection: true
    });

    if (preferences.length === 0) {
        return { allowed: null, blocked: [], skippedByWhitelist: [], fileExists: true, totalInFile: 0 };
    }

    const allIds = preferences.map(p => p.id);
    const { allowed: whitelistedIds, blocked: skippedByWhitelist } = filterWhitelisted(allIds, null, realm);
    const { allowed: allowedIds, blocked } = filterBlacklisted(whitelistedIds, null, realm);

    if (allowedIds.length === 0) {
        return { allowed: null, blocked, skippedByWhitelist, fileExists: true, totalInFile: allIds.length };
    }

    const allowedSet = new Set(allowedIds);
    const allowed = preferences.filter(p => allowedSet.has(p.id));

    return { allowed, blocked, skippedByWhitelist, fileExists: true, totalInFile: allIds.length };
}

/**
 * Build a per-realm preference map from per-realm deletion files.
 * Loads each realm's file individually and applies tier filtering.
 *
 * @param {string[]} selectedRealms - Realms selected by the user for deletion
 * @param {string} instanceType - Instance type
 * @param {Object} [options] - Optional filtering options
 * @param {string} [options.maxTier] - Maximum tier to include (cascading)
 * @param {string} [options.objectType] - Object type for non-SitePreferences (e.g. 'Order')
 * @returns {{
 *   realmPreferenceMap: Map<string, string[]>,
 *   blockedByBlacklist: string[],
 *   skippedByWhitelist: string[],
 *   missingRealms: string[],
 *   filteredOutRealms: string[]
 * }}
 */
export function buildRealmPreferenceMapFromFiles(selectedRealms, instanceType, { maxTier, objectType } = {}) {
    const realmPreferenceMap = new Map();
    const allBlocked = new Set();
    const allSkipped = new Set();
    const missingRealms = [];
    const filteredOutRealms = [];

    for (const realm of selectedRealms) {
        const result = loadRealmPreferencesForDeletion(realm, instanceType, { maxTier, objectType });

        if (!result) {
            realmPreferenceMap.set(realm, []);
            missingRealms.push(realm);
            continue;
        }

        if (!result.allowed) {
            realmPreferenceMap.set(realm, []);
            filteredOutRealms.push(realm);
            continue;
        }

        realmPreferenceMap.set(realm, result.allowed.map(p => p.id));

        for (const id of result.blocked) {
            allBlocked.add(id);
        }
        for (const id of result.skippedByWhitelist) {
            allSkipped.add(id);
        }
    }

    return {
        realmPreferenceMap,
        blockedByBlacklist: [...allBlocked],
        skippedByWhitelist: [...allSkipped],
        missingRealms,
        filteredOutRealms
    };
}

/**
 * Load the cross-realm intersection file and build a preference map
 * where the same preference list applies to every selected realm.
 *
 * The cross-realm file has the same tier-section format as per-realm files,
 * so we reuse the same parsing logic. Every preference that passes filtering
 * is mapped to ALL selected realms.
 *
 * @param {string[]} selectedRealms - Realms selected by the user for deletion
 * @param {string} instanceType - Instance type
 * @param {Object} [options] - Filtering options
 * @param {string} [options.maxTier] - Maximum tier to include (cascading)
 * @returns {{
 *   realmPreferenceMap: Map<string, string[]>,
 *   blockedByBlacklist: string[],
 *   skippedByWhitelist: string[],
 *   missingRealms: string[],
 *   filePath: string|null
 * }}
 */
export function buildCrossRealmPreferenceMap(selectedRealms, instanceType, { maxTier } = {}) {
    const resultsDir = ensureResultsDir(IDENTIFIERS.ALL_REALMS, instanceType);
    const filename = `${instanceType}${FILE_PATTERNS.PREFERENCES_CROSS_REALM}`;
    const filePath = path.join(resultsDir, filename);

    if (!fs.existsSync(filePath)) {
        return {
            realmPreferenceMap: new Map(selectedRealms.map(r => [r, []])),
            blockedByBlacklist: [],
            skippedByWhitelist: [],
            missingRealms: selectedRealms.slice(),
            filePath: null
        };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const preferences = parseTieredPreferences(content, { maxTier });

    if (preferences.length === 0) {
        return {
            realmPreferenceMap: new Map(selectedRealms.map(r => [r, []])),
            blockedByBlacklist: [],
            skippedByWhitelist: [],
            missingRealms: [],
            filePath
        };
    }

    // Apply whitelist/blacklist globally (cross-realm file is not realm-specific)
    const allIds = preferences.map(p => p.id);
    const { allowed: whitelistedIds, blocked: skippedByWhitelist } = filterWhitelisted(allIds);
    const { allowed: allowedIds, blocked: blockedByBlacklist } = filterBlacklisted(whitelistedIds);

    // Map the same filtered list to every selected realm
    const realmPreferenceMap = new Map();
    for (const realm of selectedRealms) {
        realmPreferenceMap.set(realm, allowedIds.slice());
    }

    return {
        realmPreferenceMap,
        blockedByBlacklist,
        skippedByWhitelist,
        missingRealms: [],
        filePath
    };
}

/**
 * Open per-realm preferences for deletion files in VS Code editor.
 * Opens each realm's deletion file in a separate editor tab.
 *
 * @param {string[]} realms - Realm names to open files for
 * @param {string} instanceType - Instance type
 * @returns {Promise<string[]>} Paths to the opened files
 */
export async function openRealmDeletionFilesInEditor(realms, instanceType) {
    const openedFiles = [];

    for (const realm of realms) {
        const resultsDir = ensureResultsDir(realm, instanceType);
        const targetPath = path.join(
            resultsDir, `${realm}${FILE_PATTERNS.PREFERENCES_FOR_DELETION}`
        );

        if (!fs.existsSync(targetPath)) {
            continue;
        }

        await openFileInVSCode(targetPath);
        openedFiles.push(targetPath);
    }

    return openedFiles;
}

/**
 * Open the cross-realm intersection deletion file in VS Code editor.
 *
 * @param {string} instanceType - Instance type
 * @returns {Promise<string|null>} Path to the opened file, or null if not found
 */
export async function openCrossRealmFileInEditor(instanceType) {
    const resultsDir = ensureResultsDir(IDENTIFIERS.ALL_REALMS, instanceType);
    const targetPath = path.join(
        resultsDir, `${instanceType}${FILE_PATTERNS.PREFERENCES_CROSS_REALM}`
    );

    if (!fs.existsSync(targetPath)) {
        return null;
    }

    await openFileInVSCode(targetPath);
    return targetPath;
}

/**
 * Generate summary statistics for preferences to be deleted
 * @param {Array<string>} preferences - Array of preference IDs
 * @returns {Object} Summary statistics
 */
export function generateDeletionSummary(preferences) {
    // Group by prefix to show what types of preferences are being removed
    const prefixMap = new Map();

    for (const pref of preferences) {
        // Extract prefix (text before first uppercase letter after first char)
        let prefix = pref[0];
        for (let i = 1; i < pref.length; i++) {
            if (pref[i] === pref[i].toUpperCase() && pref[i] !== '_') {
                break;
            }
            prefix += pref[i];
        }

        if (!prefixMap.has(prefix)) {
            prefixMap.set(prefix, 0);
        }
        prefixMap.set(prefix, prefixMap.get(prefix) + 1);
    }

    // Sort by count descending
    const sortedPrefixes = Array.from(prefixMap.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10); // Top 10 prefixes

    return {
        total: preferences.length,
        topPrefixes: sortedPrefixes
    };
}
