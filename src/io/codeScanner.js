
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import pLimit from 'p-limit';
import { findAllMatrixFiles, findAllUsageFiles, getResultsPath } from './util.js';
import { ensureResultsDir } from './util.js';
import { parseCSVToNestedArray } from './csv.js';
import { getRealmsByInstanceType } from '../config/helpers/helpers.js';
import { getMetadataBackupPathForRealm } from '../helpers/backupJob.js';
import { logStatusUpdate, logStatusClear, logProgress } from '../scripts/loggingScript/log.js';
import {
    DIRECTORIES,
    IDENTIFIERS,
    FILE_PATTERNS,
    ALLOWED_EXTENSIONS,
    SKIP_DIRECTORIES,
    REALM_TAGS
} from '../config/constants.js';
import { filterBlacklisted, loadBlacklist } from '../commands/setup/helpers/blacklistHelper.js';

const DEFAULT_COMPARISON_FILE_PATH = path.join(
    process.cwd(),
    DIRECTORIES.RESULTS,
    IDENTIFIERS.ALL_REALMS,
    `${IDENTIFIERS.ALL_REALMS}${FILE_PATTERNS.CARTRIDGE_COMPARISON}`
);

function getDeprecatedCartridges(comparisonFilePath) {
    const deprecatedCartridges = new Set();
    let content = '';
    let inDeprecatedSection = false;

    if (!comparisonFilePath || !fs.existsSync(comparisonFilePath)) {
        return deprecatedCartridges;
    }

    content = fs.readFileSync(comparisonFilePath, 'utf-8');

    const lines = content.split(/\r?\n/);

    for (const line of lines) {
        if (line.includes('--- Potentially Deprecated Cartridges ---')) {
            inDeprecatedSection = true;
            continue;
        }

        if (line.includes('--- Active Cartridges ---')) {
            inDeprecatedSection = false;
            break;
        }

        if (inDeprecatedSection) {
            const match = line.match(/\[X\]\s+([^\s]+)/);
            if (match && match[1]) {
                deprecatedCartridges.add(match[1]);
            }
        }
    }

    return deprecatedCartridges;
}

function getCartridgeNameFromPath(filePath) {
    const normalizedPath = filePath.replace(/\\/g, '/');
    const cartridgesIndex = normalizedPath.indexOf('/cartridges/');
    const cartridgeIndex = normalizedPath.indexOf('/cartridge/');

    if (cartridgesIndex !== -1) {
        const afterCartridges = normalizedPath.slice(cartridgesIndex + '/cartridges/'.length);
        const name = afterCartridges.split('/')[0];
        return name || null;
    }

    if (cartridgeIndex !== -1) {
        const beforeCartridge = normalizedPath.slice(0, cartridgeIndex);
        const parts = beforeCartridge.split('/');
        const name = parts[parts.length - 1];
        return name || null;
    }

    return null;
}

function shouldSkipDirectory(name) {
    return name.startsWith('.') || SKIP_DIRECTORIES.has(name);
}

function shouldScanFile(filePath) {
    const extension = path.extname(filePath).toLowerCase();
    return ALLOWED_EXTENSIONS.has(extension);
}

function countScannableFiles(dirPath) {
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            if (shouldSkipDirectory(entry.name)) {
                continue;
            }
            total += countScannableFiles(entryPath);
            continue;
        }

        if (shouldScanFile(entryPath)) {
            total += 1;
        }
    }

    return total;
}

/**
 * Check whether a line contains a genuine preference access pattern for the given ID.
 * Matches: string literals ('PrefId' / "PrefId"), dot access (.custom.PrefId),
 * variable dot access (xyzCustom.PrefId — handles destructured custom objects like orderCustom),
 * getCustom() method access (.getCustom().PrefId — e.g. order.getCustom().attrId),
 * bracket access (.custom['PrefId'] / .custom["PrefId"]),
 * OCAPI c_ prefixed variants ('c_PrefId', .c_PrefId, ['c_PrefId']),
 * and SFCC query syntax (custom.PrefId at word boundary).
 * @param {string} line - Source line to test
 * @param {string} preferenceId - Preference ID to look for
 * @returns {boolean} True if the line contains a real preference access
 */
export function isPreferenceAccessMatch(line, preferenceId) {
    // Escape special regex characters in the preference ID
    const escaped = preferenceId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Match: 'PrefId' | "PrefId"
    //   | .custom.PrefId (word boundary) | custom.PrefId (word boundary before custom)
    //   | xyzCustom.PrefId (variable holding custom object, e.g. orderCustom.attrId)
    //   | .getCustom().PrefId (method call, e.g. order.getCustom().radialWalletType)
    //   | .custom['PrefId'] | .custom["PrefId"]
    //   | 'c_PrefId' | "c_PrefId" | .c_PrefId | ['c_PrefId']
    const pattern = new RegExp(
        `['"]${escaped}['"]`
        + `|\\bcustom\\.${escaped}\\b`
        + `|\\w*[Cc]ustom\\.${escaped}\\b`
        + `|\\.getCustom\\(\\)\\.${escaped}\\b`
        + `|\\.custom\\[\\s*['"]${escaped}['"]\\s*\\]`
        + `|\\*custom\\[\\s*['"]${escaped}['"]\\s*\\]`
        + `|['"]c_${escaped}['"]`
        + `|\\.c_${escaped}\\b`
        + `|\\[\\s*['"]c_${escaped}['"]\\s*\\]`
    );

    return pattern.test(line);
}

export function collectMatchesInFile(filePath, preferenceId) {
    const matches = [];
    const content = fs.readFileSync(filePath, 'utf-8');

    // Fast pre-filter: skip file entirely if the preference ID string isn't present
    if (!content.includes(preferenceId)) {
        return matches;
    }

    const lines = content.split(/\r?\n/);

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (isPreferenceAccessMatch(line, preferenceId)) {
            matches.push({
                filePath,
                lineNumber: i + 1,
                lineText: line.trim()
            });
        }
    }

    return matches;
}

export function collectAllFilePaths(dirPath, fileList = []) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            if (shouldSkipDirectory(entry.name)) {
                continue;
            }
            collectAllFilePaths(entryPath, fileList);
            continue;
        }

        if (!shouldScanFile(entryPath)) {
            continue;
        }

        const cartridgeName = getCartridgeNameFromPath(entryPath);

        fileList.push({ path: entryPath, cartridge: cartridgeName });
    }

    return fileList;
}

async function searchMultiplePreferencesInFileAsync(filePath, preferenceIds) {
    const foundPreferences = new Set();
    const referenceDetails = new Map();

    try {
        const content = await fsPromises.readFile(filePath, 'utf-8');

        // Fast pre-filter: narrow down to preferences whose ID string appears in the file
        const candidates = new Set();
        for (const prefId of preferenceIds) {
            if (content.includes(prefId)) {
                candidates.add(prefId);
            }
        }

        // Strict line-level check: only keep genuine preference access patterns
        if (candidates.size > 0) {
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i += 1) {
                for (const prefId of candidates) {
                    if (isPreferenceAccessMatch(lines[i], prefId)) {
                        foundPreferences.add(prefId);
                        if (!referenceDetails.has(prefId)) {
                            referenceDetails.set(prefId, []);
                        }
                        referenceDetails.get(prefId).push({
                            lineNumber: i + 1,
                            lineText: lines[i].trim()
                        });
                    }
                }
            }
        }
    } catch {
        // Ignore unreadable/binary files
    }

    return { foundPreferences, referenceDetails };
}

function searchDirectoryForPreference(dirPath, preferenceId, deprecatedCartridges, matches, state, isFirstSearch) {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
            if (shouldSkipDirectory(entry.name)) {
                continue;
            }
            searchDirectoryForPreference(entryPath, preferenceId, deprecatedCartridges, matches, state, isFirstSearch);
            continue;
        }

        if (!shouldScanFile(entryPath)) {
            continue;
        }

        state.scannedFiles += 1;

        const cartridgeName = getCartridgeNameFromPath(entryPath);
        const isDeprecated = cartridgeName && deprecatedCartridges.has(cartridgeName);

        if (isDeprecated) {
            continue;
        }

        try {
            const fileMatches = collectMatchesInFile(entryPath, preferenceId);
            matches.push(...fileMatches);
            state.matchesFound += fileMatches.length;
            logProgress(state, isFirstSearch);
        } catch {
            // Ignore unreadable/binary files
        }
    }
}

/**
 * Get all active preferences from matrix CSV files
 * @param {Array<string>} matrixFilePaths - Array of matrix file paths
 * @returns {Set<string>} Set of unique active preference IDs
 */
export function getActivePreferencesFromMatrices(matrixFilePaths) {
    const activePreferences = new Set();

    for (const filePath of matrixFilePaths) {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const lines = content.split(/\r?\n/);

            if (lines.length < 2) {
                continue;
            }

            const headers = lines[0].split(',');
            const preferenceIdIndex = headers.indexOf('preferenceId');

            if (preferenceIdIndex === -1) {
                continue;
            }

            // Iterate through data rows starting from line 1
            for (let i = 1; i < lines.length; i += 1) {
                const line = lines[i].trim();
                if (!line) {
                    continue;
                }

                const parts = line.split(',');
                if (parts.length > preferenceIdIndex) {
                    let prefId = parts[preferenceIdIndex].trim();
                    // Remove surrounding quotes from CSV fields
                    if (prefId.startsWith('"') && prefId.endsWith('"')) {
                        prefId = prefId.slice(1, -1);
                    }
                    if (prefId) {
                        activePreferences.add(prefId);
                    }
                }
            }
        } catch {
            // Ignore unreadable files
        }
    }

    return activePreferences;
}

/**
 * Export unused preferences (with no cartridge usage) to a separate file
 * @param {Array} results - Array of preference usage results
 * @param {string} [instanceTypeOverride] - Optional instance type for output path scoping
 * @returns {string} Path to the exported file
 */
function exportUnusedPreferencesToFile(results, instanceTypeOverride = null) {
    const unusedPreferences = results.filter(r => r.cartridges.length === 0);

    if (unusedPreferences.length === 0) {
        return null;
    }

    const dirName = instanceTypeOverride || IDENTIFIERS.ALL_REALMS;
    const resultsDir = ensureResultsDir(IDENTIFIERS.ALL_REALMS, instanceTypeOverride);
    const filename = `${dirName}${FILE_PATTERNS.UNUSED_PREFERENCES}`;
    const filePath = path.join(resultsDir, filename);

    const lines = [
        'Unused Preferences (Not Referenced in Any Cartridge)',
        `Generated: ${new Date().toISOString()}`,
        `Total Unused: ${unusedPreferences.length}`,
        '',
        '--- Preference IDs ---',
        ...unusedPreferences.map(p => p.preferenceId)
    ];

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

    return filePath;
}

/**
 * Export cartridge-to-preferences mapping to a text file
 * @param {Array} results - Array of preference usage results
 * @param {string} [instanceTypeOverride] - Optional instance type for output path scoping
 * @returns {string} Path to the exported file
 */
function exportCartridgePreferenceMapping(results, instanceTypeOverride = null) {
    // Build a map of cartridge -> preferences
    const cartridgeToPreferences = new Map();

    for (const result of results) {
        for (const cartridge of result.cartridges) {
            // Extract cartridge name (remove [possibly deprecated] tag if present)
            const cartridgeName = cartridge.replace(' [possibly deprecated]', '');
            const isDeprecated = cartridge.includes('[possibly deprecated]');

            if (!cartridgeToPreferences.has(cartridgeName)) {
                cartridgeToPreferences.set(cartridgeName, {
                    preferences: new Set(),
                    isDeprecated
                });
            }

            cartridgeToPreferences.get(cartridgeName).preferences.add(result.preferenceId);
        }
    }

    // Sort cartridges alphabetically
    const sortedCartridges = Array.from(cartridgeToPreferences.keys()).sort();

    const dirName = instanceTypeOverride || IDENTIFIERS.ALL_REALMS;
    const resultsDir = ensureResultsDir(IDENTIFIERS.ALL_REALMS, instanceTypeOverride);
    const filename = `${dirName}${FILE_PATTERNS.CARTRIDGE_PREFERENCES}`;
    const filePath = path.join(resultsDir, filename);

    const lines = [
        'Cartridge Preference Usage',
        `Generated: ${new Date().toISOString()}`,
        `Total Cartridges: ${sortedCartridges.length}`,
        '',
        '================================================================================',
        ''
    ];

    for (const cartridgeName of sortedCartridges) {
        const data = cartridgeToPreferences.get(cartridgeName);
        const deprecatedTag = data.isDeprecated ? ' [possibly deprecated]' : '';
        const preferences = Array.from(data.preferences).sort();

        lines.push(`Cartridge: ${cartridgeName}${deprecatedTag}`);
        lines.push(`  Preferences Used: ${preferences.length}`);

        if (preferences.length === 0) {
            lines.push('  (no preferences found)');
        } else {
            preferences.forEach(pref => {
                lines.push(`    • ${pref}`);
            });
        }

        lines.push('');
    }

    lines.push('================================================================================');
    lines.push(`Total cartridges: ${sortedCartridges.length}`);
    lines.push(`Total unique preferences used: ${results.filter(r => r.cartridges.length > 0).length}`);

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');

    return filePath;
}

/**
 * Export per-preference code references to a JSON file.
 * Each preference maps to its list of file+line references and cartridge tags.
 * Consumed by inspect-preference to avoid re-scanning the codebase.
 *
 * @param {Map<string, Array<{file: string, line: number, text: string, cartridge: string|null}>>} preferenceReferences - Collected references
 * @param {string} [instanceTypeOverride] - Optional instance type for output path scoping
 * @returns {string|null} Path to the exported file, or null if no data
 */
function exportPreferenceReferences(preferenceReferences, instanceTypeOverride = null) {
    if (preferenceReferences.size === 0) {
        return null;
    }

    const dirName = instanceTypeOverride || IDENTIFIERS.ALL_REALMS;
    const resultsDir = ensureResultsDir(IDENTIFIERS.ALL_REALMS, instanceTypeOverride);
    const filename = `${dirName}${FILE_PATTERNS.PREFERENCE_REFERENCES}`;
    const filePath = path.join(resultsDir, filename);

    const output = {
        generated: new Date().toISOString(),
        totalPreferences: preferenceReferences.size,
        preferences: {}
    };

    for (const [prefId, refs] of preferenceReferences) {
        output.preferences[prefId] = refs.map(r => ({
            file: r.file.replace(/\\/g, '/'),
            line: r.line,
            text: r.text,
            cartridge: r.cartridge
        }));
    }

    fs.writeFileSync(filePath, JSON.stringify(output, null, 2), 'utf-8');

    return filePath;
}

/**
 * Parse unused preferences file and extract preference IDs
 * @param {string} filePath - Path to unused preferences file
 * @returns {Set<string>} Set of unused preference IDs
 */
function parseUnusedPreferencesFile(filePath) {
    const unusedPrefs = new Set();

    if (!fs.existsSync(filePath)) {
        return unusedPrefs;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    let inPreferenceSection = false;

    for (const line of lines) {
        if (line.trim() === '--- Preference IDs ---') {
            inPreferenceSection = true;
            continue;
        }

        if (inPreferenceSection && line.trim()) {
            unusedPrefs.add(line.trim());
        }
    }

    return unusedPrefs;
}

/**
 * Parse cartridge preferences file and extract all used preference IDs
 * @param {string} filePath - Path to cartridge preferences file
 * @returns {Set<string>} Set of used preference IDs
 */
function parseCartridgePreferencesFile(filePath) {
    const usedPrefs = new Set();

    if (!fs.existsSync(filePath)) {
        return usedPrefs;
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split(/\r?\n/);

    for (const line of lines) {
        // Look for lines that start with bullet points (preferences)
        const match = line.match(/^\s+•\s+(.+)$/);
        if (match && match[1]) {
            usedPrefs.add(match[1].trim());
        }
    }

    return usedPrefs;
}

/**
 * Build a map of preference value data from matrix CSV files
 * @param {string|null} instanceTypeOverride - Instance type for matrix file scoping
 * @returns {Map<string, {hasValues: boolean, hasDefault: boolean, siteCount: number}>}
 */
function buildPreferenceValueMap(instanceTypeOverride = null) {
    const valueMap = new Map();
    const matrixFiles = findAllMatrixFiles();

    for (const { matrixFile } of matrixFiles) {
        // Filter by instance type if specified
        if (instanceTypeOverride) {
            const normalizedPath = matrixFile.replace(/\\/g, '/');
            if (!normalizedPath.includes(`/${instanceTypeOverride}/`)) {
                continue;
            }
        }

        const csvData = parseCSVToNestedArray(matrixFile);

        if (csvData.length <= 1) {
            continue;
        }

        const headers = csvData[0];
        const preferenceIdIndex = headers.indexOf('preferenceId');
        const defaultValueIndex = headers.indexOf('defaultValue');

        if (preferenceIdIndex === -1) {
            continue;
        }

        const siteDataStart = defaultValueIndex > -1 ? defaultValueIndex + 1 : 1;

        for (let i = 1; i < csvData.length; i++) {
            const row = csvData[i];
            const preferenceId = row[preferenceIdIndex];

            if (!preferenceId) {
                continue;
            }

            const defaultValue = defaultValueIndex > -1 ? (row[defaultValueIndex] || '') : '';
            const hasDefault = defaultValue.trim() !== '';
            const sitesWithValues = row.slice(siteDataStart)
                .filter(v => v === 'X' || v === 'x').length;
            const hasValues = sitesWithValues > 0;

            // Merge across realms: if ANY realm has values/defaults, record it
            const existing = valueMap.get(preferenceId);
            if (existing) {
                existing.hasValues = existing.hasValues || hasValues;
                existing.hasDefault = existing.hasDefault || hasDefault;
                existing.siteCount = existing.siteCount + sitesWithValues;
            } else {
                valueMap.set(preferenceId, { hasValues, hasDefault, siteCount: sitesWithValues });
            }
        }
    }

    return valueMap;
}

/**
 * Build a per-realm value map from matrix CSV files.
 * Unlike buildPreferenceValueMap() which merges across realms, this preserves
 * per-realm value/default data for realm-specific deletion targeting.
 * @param {string|null} instanceTypeOverride - Instance type for matrix file scoping
 * @returns {Map<string, Map<string, {hasValues: boolean, hasDefault: boolean, siteCount: number}>>}
 *   Map of preferenceId → Map of realm → value data
 */
function buildPerRealmValueMap(instanceTypeOverride = null) {
    const perRealmMap = new Map();
    const matrixFiles = findAllMatrixFiles();

    for (const { realm, matrixFile } of matrixFiles) {
        if (instanceTypeOverride) {
            const normalizedPath = matrixFile.replace(/\\/g, '/');
            if (!normalizedPath.includes(`/${instanceTypeOverride}/`)) {
                continue;
            }
        }

        const csvData = parseCSVToNestedArray(matrixFile);
        if (csvData.length <= 1) {
            continue;
        }

        const headers = csvData[0];
        const preferenceIdIndex = headers.indexOf('preferenceId');
        const defaultValueIndex = headers.indexOf('defaultValue');
        if (preferenceIdIndex === -1) {
            continue;
        }

        const siteDataStart = defaultValueIndex > -1 ? defaultValueIndex + 1 : 1;

        for (let i = 1; i < csvData.length; i++) {
            const row = csvData[i];
            const preferenceId = row[preferenceIdIndex];
            if (!preferenceId) {
                continue;
            }

            const defaultValue = defaultValueIndex > -1 ? (row[defaultValueIndex] || '') : '';
            const hasDefault = defaultValue.trim() !== '';
            const sitesWithValues = row.slice(siteDataStart)
                .filter(v => v === 'X' || v === 'x').length;
            const hasValues = sitesWithValues > 0;

            if (!perRealmMap.has(preferenceId)) {
                perRealmMap.set(preferenceId, new Map());
            }
            perRealmMap.get(preferenceId).set(realm, { hasValues, hasDefault, siteCount: sitesWithValues });
        }
    }

    return perRealmMap;
}

/**
 * Build a set of active cartridges for each realm by reading the per-realm
 * active_site_cartridges_list.csv files. This enables realm-specific code
 * reference analysis: a preference referenced in a cartridge only active on
 * one realm can be safely deleted from other realms.
 * @param {string|null} instanceTypeOverride - Instance type for path resolution
 * @returns {Map<string, Set<string>>} Map of realm → Set of active cartridge names
 */
function buildPerRealmCartridgeSet(instanceTypeOverride = null) {
    const realmCartridges = new Map();
    const realms = instanceTypeOverride
        ? getRealmsByInstanceType(instanceTypeOverride)
        : [];

    for (const realm of realms) {
        const realmDir = getResultsPath(realm);
        const csvPath = path.join(realmDir, `${realm}${FILE_PATTERNS.SITE_CARTRIDGES_LIST}`);

        if (!fs.existsSync(csvPath)) {
            continue;
        }

        const content = fs.readFileSync(csvPath, 'utf-8');
        const lines = content.split(/\r?\n/);
        const cartridges = new Set();

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) {
                continue;
            }

            // Format: siteId,cartridge1:cartridge2:cartridge3
            const commaIndex = line.indexOf(',');
            if (commaIndex === -1) {
                continue;
            }

            const cartridgeList = line.slice(commaIndex + 1).split(':');
            for (const c of cartridgeList) {
                const trimmed = c.trim();
                if (trimmed) {
                    cartridges.add(trimmed);
                }
            }
        }

        realmCartridges.set(realm, cartridges);
    }

    return realmCartridges;
}

/**
 * Determine which realms a preference should be deleted from based on:
 * 1. Code references: if a cartridge referencing the pref is active in a realm, that realm is blocked
 * 2. Value presence: optionally filter out realms where the preference has values
 *
 * @param {string[]} activeCartridges - Cartridges with active code refs for this preference
 * @param {Map<string, Set<string>>} perRealmCartridges - Per-realm active cartridge sets
 * @param {string[]} allRealms - All available realms for this instance type
 * @returns {string[]} Array of realm names where the preference can be deleted,
 *   or ['ALL'] if all realms are applicable
 */
function determineRealmsByCode(activeCartridges, perRealmCartridges, allRealms) {
    if (activeCartridges.length === 0) {
        return [REALM_TAGS.ALL];
    }

    const applicableRealms = [];

    for (const realm of allRealms) {
        const realmCarts = perRealmCartridges.get(realm) || new Set();
        const hasActiveCodeInRealm = activeCartridges.some(c => realmCarts.has(c));

        if (!hasActiveCodeInRealm) {
            applicableRealms.push(realm);
        }
    }

    if (applicableRealms.length === allRealms.length) {
        return [REALM_TAGS.ALL];
    }

    return applicableRealms;
}

/**
 * Filter realm list by value presence: keep only realms where the preference
 * has no values (safest to delete from).
 * @param {string[]} candidateRealms - Realms already passing code check (or ['ALL'])
 * @param {string} prefId - Preference ID
 * @param {Map<string, Map<string, {hasValues: boolean, hasDefault: boolean}>>} perRealmValues
 * @param {string[]} allRealms - All available realms
 * @returns {{ realms: string[], realmValueDetail: string }}
 *   realms: filtered realm list; realmValueDetail: human-readable per-realm value info
 */
function filterRealmsByValues(candidateRealms, prefId, perRealmValues, allRealms) {
    const prefRealmData = perRealmValues.get(prefId);
    const realmsToCheck = candidateRealms[0] === REALM_TAGS.ALL ? allRealms : candidateRealms;
    const filteredRealms = [];
    const valueParts = [];

    for (const realm of realmsToCheck) {
        const realmData = prefRealmData?.get(realm);
        const hasValuesInRealm = realmData?.hasValues || realmData?.hasDefault || false;

        if (hasValuesInRealm) {
            const count = realmData?.siteCount || 0;
            valueParts.push(`${realm}(${count})`);
        } else {
            filteredRealms.push(realm);
        }
    }

    const realmValueDetail = valueParts.length > 0 ? `values on: ${valueParts.join(', ')}` : '';

    // If ALL checked realms have values, fall back to the original candidate list.
    // P2/P4 preferences are still deletion candidates — the user can review per-realm
    // value detail and decide. An empty realm list would make them un-deletable.
    if (filteredRealms.length === 0) {
        return { realms: candidateRealms, realmValueDetail };
    }

    if (filteredRealms.length === allRealms.length) {
        return { realms: [REALM_TAGS.ALL], realmValueDetail };
    }

    return { realms: filteredRealms, realmValueDetail };
}

/**
 * Find deletion candidates whose IDs appear as exact values of other site preferences.
 *
 * Scenario: A preference stores another preference's ID as its value, e.g.
 *   var attr = Site.current.getPreferenceValue('dynamicAttr'); // value = "myPref"
 *   product.custom[attr] = ...;  // uses myPref without it appearing in code
 *
 * This check reads all usage CSVs and compares each value cell (defaultValue +
 * per-site value columns) against the set of candidate IDs. Exact match only.
 *
 * Also identifies "untracked parents" — preferences that reference candidate IDs
 * but are not themselves candidates (e.g. missing from OCAPI attribute definitions).
 * Value metadata is collected for these parents so the caller can classify them.
 *
 * @param {Set<string>} candidateIds - Set of preference IDs that are deletion candidates
 * @param {string|null} instanceTypeOverride - Instance type for file scoping
 * @returns {{ dynamicRefs: Map<string, Array<{parentId: string, column: string}>>,
 *            untrackedParents: Map<string, {hasValues: boolean, hasDefault: boolean, siteCount: number}> }}
 *   dynamicRefs: Map of candidateId → array of { parentId, column } where the value was found
 *   untrackedParents: Map of parentId → value metadata for parents NOT in candidateIds
 */
function findDynamicPreferenceReferences(candidateIds, instanceTypeOverride = null) {
    const dynamicRefs = new Map();
    const untrackedParents = new Map();
    const usageFiles = findAllUsageFiles();

    for (const { usageFile } of usageFiles) {
        // Filter by instance type if specified
        if (instanceTypeOverride) {
            const normalizedPath = usageFile.replace(/\\/g, '/');
            if (!normalizedPath.includes(`/${instanceTypeOverride}/`)) {
                continue;
            }
        }

        const csvData = parseCSVToNestedArray(usageFile);

        if (csvData.length <= 1) {
            continue;
        }

        const headers = csvData[0];
        const preferenceIdIndex = headers.indexOf('preferenceId');
        const defaultValueIndex = headers.indexOf('defaultValue');

        if (preferenceIdIndex === -1) {
            continue;
        }

        // Identify value columns (defaultValue + value_* columns)
        const valueColumnIndices = [];
        const valueColumnNames = [];

        if (defaultValueIndex !== -1) {
            valueColumnIndices.push(defaultValueIndex);
            valueColumnNames.push('defaultValue');
        }

        for (let col = 0; col < headers.length; col++) {
            if (headers[col].startsWith('value_')) {
                valueColumnIndices.push(col);
                valueColumnNames.push(headers[col]);
            }
        }

        // Check each row's values against candidate IDs
        for (let i = 1; i < csvData.length; i++) {
            const row = csvData[i];
            const parentId = row[preferenceIdIndex];

            if (!parentId) {
                continue;
            }

            for (let v = 0; v < valueColumnIndices.length; v++) {
                const cellValue = (row[valueColumnIndices[v]] || '').trim();

                // Skip self-references (a preference whose value equals its own ID)
                if (cellValue && cellValue !== parentId && candidateIds.has(cellValue)) {
                    if (!dynamicRefs.has(cellValue)) {
                        dynamicRefs.set(cellValue, []);
                    }

                    // Avoid duplicate parent entries for the same parent+column
                    const existing = dynamicRefs.get(cellValue);
                    const alreadyRecorded = existing.some(
                        e => e.parentId === parentId
                            && e.column === valueColumnNames[v]
                    );

                    if (!alreadyRecorded) {
                        existing.push({
                            parentId,
                            column: valueColumnNames[v]
                        });
                    }

                    // Track value metadata for parents not already candidates
                    if (!candidateIds.has(parentId) && !untrackedParents.has(parentId)) {
                        const defaultVal = defaultValueIndex > -1
                            ? (row[defaultValueIndex] || '').trim() : '';
                        const sitesWithValues = valueColumnIndices
                            .filter((_, idx) => valueColumnNames[idx] !== 'defaultValue')
                            .filter(ci => (row[ci] || '').trim() !== '').length;
                        untrackedParents.set(parentId, {
                            hasValues: sitesWithValues > 0,
                            hasDefault: defaultVal !== '',
                            siteCount: sitesWithValues
                        });
                    }
                }
            }
        }
    }

    return { dynamicRefs, untrackedParents };
}

/**
 * Find the latest metadata backup XML file for a given realm.
 * Checks the expected path first (today's date), then scans backup_downloads
 * for the most recent file matching the realm pattern.
 *
 * @param {string} realm - Realm name (e.g. 'EU05', 'GB')
 * @returns {string|null} Absolute path to the latest metadata file, or null if none found
 */
export function findLatestMetadataFile(realm) {
    // Try the expected path first (today's file via backupJob helper)
    try {
        const expectedPath = getMetadataBackupPathForRealm(realm);
        if (fs.existsSync(expectedPath)) {
            return expectedPath;
        }
    } catch {
        // Config error — fall through to directory scan
    }

    // Scan backup_downloads for the latest file matching this realm
    const backupDir = path.join(process.cwd(), DIRECTORIES.BACKUP_DOWNLOADS);
    if (!fs.existsSync(backupDir)) {
        return null;
    }

    const pattern = new RegExp(`^${realm}_meta_data_backup_(\\d{4}-\\d{2}-\\d{2})\\.xml$`, 'i');
    const files = fs.readdirSync(backupDir);
    let latestFile = null;
    let latestDate = '';

    for (const file of files) {
        const match = file.match(pattern);
        if (match && match[1] > latestDate) {
            latestDate = match[1];
            latestFile = path.join(backupDir, file);
        }
    }

    return latestFile;
}

/**
 * Parse a metadata backup XML file to extract SitePreferences attribute definition IDs.
 * Uses simple regex matching (no XML parser dependency) to extract attribute-id values
 * from the SitePreferences type-extension section.
 *
 * @param {string} xmlFilePath - Absolute path to the metadata backup XML file
 * @returns {Set<string>} Set of attribute definition IDs found under SitePreferences
 */
export function parseSitePreferencesFromMetadata(xmlFilePath) {
    const attributeIds = new Set();
    const content = fs.readFileSync(xmlFilePath, 'utf-8');
    const lines = content.split(/\r?\n/);

    let inSitePreferences = false;

    for (const line of lines) {
        if (line.includes('type-id="SitePreferences"')) {
            inSitePreferences = true;
            continue;
        }

        if (inSitePreferences && line.includes('</type-extension>')) {
            break;
        }

        if (inSitePreferences) {
            const match = line.match(/attribute-definition\s+attribute-id="([^"]+)"/);
            if (match) {
                attributeIds.add(match[1]);
            }
        }
    }

    return attributeIds;
}

/**
 * Build a map of realm → Set of attribute IDs that exist in each realm's metadata.
 * Used to cross-check deletion candidates against actual realm content.
 *
 * @param {string[]} allRealms - List of realm names
 * @returns {Map<string, Set<string>>} Map of realm → attribute IDs present in metadata
 */
function buildPerRealmMetadataAttributeMap(allRealms) {
    const metadataMap = new Map();

    for (const realm of allRealms) {
        const metadataFile = findLatestMetadataFile(realm);

        if (!metadataFile) {
            console.log(
                `  ⚠ No metadata backup found for ${realm}`
                + ' — skipping metadata cross-check for this realm'
            );
            continue;
        }

        const attributeIds = parseSitePreferencesFromMetadata(metadataFile);
        metadataMap.set(realm, attributeIds);

        console.log(
            `  ${realm}: ${attributeIds.size} attribute definition(s)`
            + ` in metadata (${path.basename(metadataFile)})`
        );
    }

    return metadataMap;
}

/**
 * Compare unused and cartridge preferences files, classify using code scan results,
 * and generate priority-ranked deletion candidates with per-realm targeting.
 *
 * Priority tiers:
 *   [P1] No code references, no values / defaults         — safest to remove
 *   [P2] No code references, but has values / defaults     — likely safe, verify values
 *   [P3] Only in deprecated cartridges, no values          — probably safe
 *   [P4] Only in deprecated cartridges, has values         — needs careful review
 *   [P5] Active code only in some realms                   — realm-specific deletion
 *
 * Each preference is tagged with applicable realms (ALL or specific realm names).
 *
 * @param {string|null} instanceTypeOverride - Optional instance type for output path scoping
 * @param {Array} [codeResults] - Results from findAllActivePreferencesUsage (enriched)
 * @returns {string|null} Path to the generated file, or null if no candidates found
 */
export function generatePreferenceDeletionCandidates(instanceTypeOverride = null, codeResults = []) {
    const dirName = instanceTypeOverride || IDENTIFIERS.ALL_REALMS;
    const resultsDir = ensureResultsDir(IDENTIFIERS.ALL_REALMS, instanceTypeOverride);

    const unusedFilePath = path.join(resultsDir, `${dirName}${FILE_PATTERNS.UNUSED_PREFERENCES}`);
    const cartridgeFilePath = path.join(
        resultsDir, `${dirName}${FILE_PATTERNS.CARTRIDGE_PREFERENCES}`
    );

    // Check if both files exist
    if (!fs.existsSync(unusedFilePath)) {
        console.log(`\u26a0 Unused preferences file not found: ${unusedFilePath}`);
        return null;
    }

    if (!fs.existsSync(cartridgeFilePath)) {
        console.log(`\u26a0 Cartridge preferences file not found: ${cartridgeFilePath}`);
        return null;
    }

    // Parse both files
    const unusedPreferences = parseUnusedPreferencesFile(unusedFilePath);
    const usedPreferences = parseCartridgePreferencesFile(cartridgeFilePath);

    // Build code usage lookup from enriched results
    const codeUsageMap = new Map();
    for (const result of codeResults) {
        codeUsageMap.set(result.preferenceId, {
            activeCartridges: result.activeCartridges || [],
            deprecatedCartridges: result.deprecatedCartridges || []
        });
    }

    // Build merged value/default lookup (for backward-compatible tier classification)
    const valueMap = buildPreferenceValueMap(instanceTypeOverride);

    // Build per-realm data for realm-specific targeting
    const allRealms = instanceTypeOverride
        ? getRealmsByInstanceType(instanceTypeOverride)
        : [];
    const perRealmValues = buildPerRealmValueMap(instanceTypeOverride);
    const perRealmCartridges = buildPerRealmCartridgeSet(instanceTypeOverride);
    const hasRealmData = allRealms.length > 0 && perRealmCartridges.size > 0;

    // Classify ALL preferences into tiers
    const p1 = []; // No code, no values
    const p2 = []; // No code, has values
    const p3 = []; // Deprecated code only, no values
    const p4 = []; // Deprecated code only, has values
    const p5 = []; // Active code in some realms, deletable from others

    // Set of all candidate preference IDs (for blacklist filtering later)
    const allCandidateIds = new Set();

    // --- Tier 1 & 2: Preferences with NO code references ---
    // These are in "unused" (no cartridge code refs) and not in "used"
    for (const prefId of unusedPreferences) {
        if (usedPreferences.has(prefId)) {
            continue;
        }

        allCandidateIds.add(prefId);
        const valData = valueMap.get(prefId) || { hasValues: false, hasDefault: false, siteCount: 0 };

        if (valData.hasValues || valData.hasDefault) {
            // P2: no code, has values; realm tags filtered by which realms have no values
            const { realms, realmValueDetail } = hasRealmData
                ? filterRealmsByValues([REALM_TAGS.ALL], prefId, perRealmValues, allRealms)
                : { realms: [REALM_TAGS.ALL], realmValueDetail: '' };

            p2.push({ id: prefId, realms, realmValueDetail, ...valData });
        } else {
            p1.push({ id: prefId, realms: [REALM_TAGS.ALL] });
        }
    }

    // --- Tier 3 & 4: Preferences ONLY in deprecated cartridges ---
    // These have code refs, but ALL refs are in deprecated cartridges
    for (const [prefId, usage] of codeUsageMap) {
        // Skip if already classified (no code refs)
        if (allCandidateIds.has(prefId)) {
            continue;
        }

        // Skip if there are active (non-deprecated) cartridge references
        if (usage.activeCartridges.length > 0) {
            continue;
        }

        // Only deprecated cartridge references exist
        if (usage.deprecatedCartridges.length > 0) {
            allCandidateIds.add(prefId);
            const valData = valueMap.get(prefId)
                || { hasValues: false, hasDefault: false, siteCount: 0 };

            if (valData.hasValues || valData.hasDefault) {
                const { realms, realmValueDetail } = hasRealmData
                    ? filterRealmsByValues([REALM_TAGS.ALL], prefId, perRealmValues, allRealms)
                    : { realms: [REALM_TAGS.ALL], realmValueDetail: '' };

                p4.push({
                    id: prefId,
                    deprecatedCartridges: usage.deprecatedCartridges,
                    realms,
                    realmValueDetail,
                    ...valData
                });
            } else {
                p3.push({
                    id: prefId,
                    deprecatedCartridges: usage.deprecatedCartridges,
                    realms: [REALM_TAGS.ALL]
                });
            }
        }
    }

    // --- Tier 5: Active code only in some realms ---
    // Preferences with active code refs, but only in cartridges used by specific realms.
    // They can be safely deleted from realms not using those cartridges.
    if (hasRealmData) {
        for (const [prefId, usage] of codeUsageMap) {
            if (allCandidateIds.has(prefId)) {
                continue;
            }

            if (usage.activeCartridges.length === 0) {
                continue;
            }

            const applicableRealms = determineRealmsByCode(
                usage.activeCartridges, perRealmCartridges, allRealms
            );

            // Skip if code is active in ALL realms (not a candidate)
            if (applicableRealms[0] === REALM_TAGS.ALL || applicableRealms.length === 0) {
                continue;
            }

            allCandidateIds.add(prefId);
            const valData = valueMap.get(prefId)
                || { hasValues: false, hasDefault: false, siteCount: 0 };

            // Further filter by value presence within applicable realms
            const { realms, realmValueDetail } = filterRealmsByValues(
                applicableRealms, prefId, perRealmValues, allRealms
            );

            if (realms.length === 0) {
                // All applicable realms have values — skip or include with warning
                allCandidateIds.delete(prefId);
                continue;
            }

            // Identify which realms have the active code (for display)
            const codeRealms = allRealms.filter(r => !applicableRealms.includes(r));

            p5.push({
                id: prefId,
                activeCartridges: usage.activeCartridges,
                codeRealms,
                realms,
                realmValueDetail,
                ...valData
            });
        }
    }

    // Sort each tier alphabetically
    p1.sort((a, b) => a.id.localeCompare(b.id));
    p2.sort((a, b) => a.id.localeCompare(b.id));
    p3.sort((a, b) => a.id.localeCompare(b.id));
    p4.sort((a, b) => a.id.localeCompare(b.id));
    p5.sort((a, b) => a.id.localeCompare(b.id));

    // Apply blacklist filter to all candidates
    const allCandidateArray = [...p1, ...p2, ...p3, ...p4, ...p5].map(c => c.id);
    const blacklistEntries = loadBlacklist().blacklist;
    const { blocked: blacklistedPreferences } = filterBlacklisted(allCandidateArray, blacklistEntries);
    const blacklistedSet = new Set(blacklistedPreferences);

    // Remove blacklisted from each tier
    const filterBlacklisted_ = (arr) => arr.filter(c => !blacklistedSet.has(c.id));
    const fp1 = filterBlacklisted_(p1);
    const fp2 = filterBlacklisted_(p2);
    const fp3 = filterBlacklisted_(p3);
    const fp4 = filterBlacklisted_(p4);
    const fp5 = filterBlacklisted_(p5);

    // --- Dynamic value check ---
    // Detect candidates whose IDs appear as stored values of other preferences.
    // These may be dynamically referenced at runtime (e.g. product.custom[prefValue]).
    const remainingCandidateIds = new Set(
        [...fp1, ...fp2, ...fp3, ...fp4, ...fp5].map(c => c.id)
    );
    const { dynamicRefs, untrackedParents } = findDynamicPreferenceReferences(
        remainingCandidateIds, instanceTypeOverride
    );

    // --- Add untracked parents as candidates ---
    // Parents that reference candidate IDs but were not in the matrix (e.g. missing
    // from OCAPI attribute definitions). If they are also not in active code, they
    // should be classified as P1/P2 candidates themselves.
    let untrackedParentCount = 0;
    for (const [parentId, valData] of untrackedParents) {
        // Skip if parent is in active code — it's legitimately used
        if (usedPreferences.has(parentId)) {
            continue;
        }

        // Skip if blacklisted
        if (blacklistedSet.has(parentId)) {
            continue;
        }

        untrackedParentCount++;
        remainingCandidateIds.add(parentId);

        if (valData.hasValues || valData.hasDefault) {
            const { realms, realmValueDetail } = hasRealmData
                ? filterRealmsByValues(
                    [REALM_TAGS.ALL], parentId, perRealmValues, allRealms
                )
                : { realms: [REALM_TAGS.ALL], realmValueDetail: '' };

            fp2.push({
                id: parentId, realms, realmValueDetail, ...valData,
                untrackedParent: true
            });
        } else {
            fp1.push({ id: parentId, realms: [REALM_TAGS.ALL], untrackedParent: true });
        }
    }

    if (untrackedParentCount > 0) {
        // Re-sort P1 and P2 after adding untracked parents
        fp1.sort((a, b) => a.id.localeCompare(b.id));
        fp2.sort((a, b) => a.id.localeCompare(b.id));
        console.log(
            `\u2713 ${untrackedParentCount} untracked parent preference(s) added as`
            + ' candidates (not in attribute definitions but reference other candidates)'
        );
    }

    // Build tier lookup so we can match a child to its parent's tier
    const tierLookup = new Map();
    for (const c of fp1) { tierLookup.set(c.id, 1); }
    for (const c of fp2) { tierLookup.set(c.id, 2); }
    for (const c of fp3) { tierLookup.set(c.id, 3); }
    for (const c of fp4) { tierLookup.set(c.id, 4); }
    for (const c of fp5) { tierLookup.set(c.id, 5); }

    // Process dynamic references:
    // A parent can be in one of three states:
    //   1. Actively used in code (in usedPreferences) → child is indirectly
    //      used at runtime → remove from deletion list.
    //   2. Also a deletion candidate (in tierLookup) → child inherits the
    //      parent's tier (higher P = less safe).
    //   3. Unknown / never analyzed (not in either set, e.g. missing from
    //      attribute definitions) → annotate for review but keep in list.
    let dynamicRefCount = 0;
    const dynamicProtected = [];
    for (const [candidateId, refs] of dynamicRefs) {
        const parentIds = refs.map(r => r.parentId);
        const uniqueParents = [...new Set(parentIds)];

        // Check if any parent is confirmed active in cartridge code
        const activeParents = uniqueParents.filter(
            pid => usedPreferences.has(pid)
        );

        const currentTier = tierLookup.get(candidateId);
        const currentArray = [fp1, fp2, fp3, fp4, fp5][currentTier - 1];
        const candidate = currentArray.find(c => c.id === candidateId);

        if (activeParents.length > 0 && candidate) {
            // Parent is confirmed in active code → child is indirectly used → remove
            const idx = currentArray.indexOf(candidate);
            if (idx !== -1) {
                currentArray.splice(idx, 1);
            }
            tierLookup.delete(candidateId);
            dynamicProtected.push({
                id: candidateId,
                parents: activeParents
            });
            continue;
        }

        // Check parents that are also deletion candidates (for tier inheritance)
        const candidateParents = uniqueParents.filter(
            pid => tierLookup.has(pid)
        );

        dynamicRefCount++;

        if (candidate) {
            candidate.dynamicValueOf = uniqueParents;
        }

        // Inherit the highest parent tier when parents are also candidates
        if (candidateParents.length > 0 && candidate) {
            const parentTiers = candidateParents.map(
                pid => tierLookup.get(pid)
            );
            const targetTier = Math.max(currentTier, ...parentTiers);

            if (targetTier > currentTier) {
                const idx = currentArray.indexOf(candidate);
                if (idx !== -1) {
                    currentArray.splice(idx, 1);
                }

                const targetArray = [fp1, fp2, fp3, fp4, fp5][targetTier - 1];
                targetArray.push(candidate);
                targetArray.sort((a, b) => a.id.localeCompare(b.id));
                tierLookup.set(candidateId, targetTier);
            }
        }
    }

    if (dynamicProtected.length > 0) {
        console.log(
            `\u2713 Dynamic value check protected ${dynamicProtected.length}`
            + ' preference(s) referenced by active code'
        );
        for (const { id, parents } of dynamicProtected) {
            console.log(`    ${id}  \u2190 value of: ${parents.join(', ')}`);
        }
    }

    if (dynamicRefCount > 0) {
        console.log(
            `\u26a0 ${dynamicRefCount} candidate(s) detected as dynamic `
            + 'preference values of other candidates (annotated in output)'
        );
    }

    const totalCandidates = fp1.length + fp2.length + fp3.length + fp4.length + fp5.length;

    if (blacklistedPreferences.length > 0) {
        console.log(
            `\u2713 Blacklist protected ${blacklistedPreferences.length} preference(s) from deletion`
        );
    }

    if (totalCandidates === 0) {
        console.log(
            '\u2713 No preferences marked for deletion (all unused preferences have some usage)'
        );
        return null;
    }

    // Generate output file
    const outputFilename = `${dirName}${FILE_PATTERNS.PREFERENCES_FOR_DELETION}`;
    const outputFilePath = path.join(resultsDir, outputFilename);

    const lines = [
        'Site Preferences \u2014 Deletion Candidates (Priority Ranked)',
        `Generated: ${new Date().toISOString()}`,
        `Instance Type: ${instanceTypeOverride || 'ALL'}`,
        `Realms: ${allRealms.length > 0 ? allRealms.join(', ') : 'N/A'}`,
        '',
        'Analysis Summary:',
        `  \u2022 Total preferences analyzed: ${codeResults.length || unusedPreferences.size + usedPreferences.size}`,
        `  \u2022 [P1] Safe to delete (no code, no values): ${fp1.length}`,
        `  \u2022 [P2] Likely safe (no code, has values): ${fp2.length}`,
        `  \u2022 [P3] Review: deprecated code only, no values: ${fp3.length}`,
        `  \u2022 [P4] Review: deprecated code only, has values: ${fp4.length}`,
        `  \u2022 [P5] Realm-specific: active code not on all realms: ${fp5.length}`,
        `  \u2022 Total deletion candidates: ${totalCandidates}`
    ];

    if (dynamicRefCount > 0) {
        lines.push(
            `  \u2022 Dynamic value references: ${dynamicRefCount} (annotated with \u26a0)`
        );
    }

    if (dynamicProtected.length > 0) {
        lines.push(
            `  \u2022 Dynamic value protected: ${dynamicProtected.length}`
            + ' (referenced by active code)'
        );
    }

    if (untrackedParentCount > 0) {
        lines.push(
            `  \u2022 Untracked parents added: ${untrackedParentCount}`
            + ' (not in attribute definitions, reference candidates)'
        );
    }

    if (blacklistedPreferences.length > 0) {
        lines.push(`  \u2022 Blacklisted (protected): ${blacklistedPreferences.length}`);
    }

    lines.push(
        '',
        'Priority Legend:',
        '  [P1] No code references, no values \u2014 safest to remove',
        '  [P2] No code references, but has values/defaults \u2014 likely unused but verify',
        '  [P3] Only in deprecated cartridges, no values \u2014 probably safe',
        '  [P4] Only in deprecated cartridges, has values \u2014 needs careful review',
        '  [P5] Active code only in some realms \u2014 delete from non-covered realms',
        '',
        'Realm Tags:',
        '  Each preference has a "realms:" tag indicating which realms it should',
        '  be deleted from. "ALL" means all realms; specific names (e.g., EU05, APAC)',
        '  mean only those realms. The remove-preferences command uses these tags to',
        '  determine per-realm deletion targeting.',
        '',
        'Dynamic Value References:',
        '  When a preference ID appears as the stored value of another preference,',
        '  it may be dynamically referenced at runtime, e.g.:',
        '    var attr = Site.current.getPreferenceValue("parentPref");',
        '    product.custom[attr] = ...;  // uses this pref without code reference',
        '  If the parent preference is in active code, the child is treated as',
        '  actively used and removed from this deletion list.',
        '  If the parent is also a deletion candidate, the child inherits the',
        '  parent\'s tier and is marked with \u26a0 for review.',
        '',
        'NOTE: Preferences matching patterns in src/config/preference_blacklist.json are excluded',
        'from this list and will never be deleted. To manage the blacklist, run:',
        '  \u2022 node src/main.js list-blacklist        \u2014 View all protected patterns',
        '  \u2022 node src/main.js add-to-blacklist       \u2014 Add a new pattern',
        '  \u2022 node src/main.js remove-from-blacklist  \u2014 Remove a pattern'
    );

    // --- P1 Section ---
    if (fp1.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P1] Safe to Delete (No Code, No Values) --- [${fp1.length} preferences]`
        );

        for (const c of fp1) {
            const parts = [`realms: ${c.realms.join(', ')}`];
            if (c.dynamicValueOf) {
                parts.push(`\u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`);
            }
            lines.push(`${c.id}  |  ${parts.join('  |  ')}`);
        }
    }

    // --- P2 Section ---
    if (fp2.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P2] Likely Safe (No Code, Has Values) --- [${fp2.length} preferences]`
        );

        for (const c of fp2) {
            const details = [];
            if (c.hasDefault) {
                details.push('has default value');
            }
            if (c.hasValues) {
                details.push(`sites with values: ${c.siteCount}`);
            }
            if (c.realmValueDetail) {
                details.push(c.realmValueDetail);
            }
            details.push(`realms: ${c.realms.join(', ')}`);
            if (c.dynamicValueOf) {
                details.push(
                    `\u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`
                );
            }
            lines.push(`${c.id}  |  ${details.join('  |  ')}`);
        }
    }

    // --- P3 Section ---
    if (fp3.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P3] Review: Deprecated Code Only (No Values) --- [${fp3.length} preferences]`
        );

        for (const c of fp3) {
            const suffix = c.dynamicValueOf
                ? `  |  \u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`
                : '';
            lines.push(
                `${c.id}  |  deprecated: ${c.deprecatedCartridges.join(', ')}`
                + `  |  realms: ${c.realms.join(', ')}${suffix}`
            );
        }
    }

    // --- P4 Section ---
    if (fp4.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P4] Review: Deprecated Code + Values --- [${fp4.length} preferences]`
        );

        for (const c of fp4) {
            const details = [`deprecated: ${c.deprecatedCartridges.join(', ')}`];
            if (c.hasDefault) {
                details.push('has default value');
            }
            if (c.hasValues) {
                details.push(`sites with values: ${c.siteCount}`);
            }
            if (c.realmValueDetail) {
                details.push(c.realmValueDetail);
            }
            details.push(`realms: ${c.realms.join(', ')}`);
            if (c.dynamicValueOf) {
                details.push(
                    `\u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`
                );
            }
            lines.push(`${c.id}  |  ${details.join('  |  ')}`);
        }
    }

    // --- P5 Section ---
    if (fp5.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P5] Realm-Specific: Active Code Not on All Realms --- [${fp5.length} preferences]`
        );

        for (const c of fp5) {
            const details = [
                `active in: ${c.codeRealms.join(', ')}`,
                `code: ${c.activeCartridges.join(', ')}`
            ];
            if (c.realmValueDetail) {
                details.push(c.realmValueDetail);
            }
            details.push(`realms: ${c.realms.join(', ')}`);
            if (c.dynamicValueOf) {
                details.push(
                    `\u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`
                );
            }
            lines.push(`${c.id}  |  ${details.join('  |  ')}`);
        }
    }

    // --- Blacklisted Section ---
    if (blacklistedPreferences.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            '--- Blacklisted Preferences (Protected) ---',
            ...blacklistedPreferences.sort()
        );
    }

    fs.writeFileSync(outputFilePath, lines.join('\n'), 'utf-8');

    // --- Generate per-realm deletion files ---
    // Each realm gets its own file with tiers re-classified using realm-specific
    // value data. This avoids the 404 problem (only prefs that exist on a realm
    // are included) and allows per-realm tier selection during removal.
    // Cross-check against metadata backup XMLs to ensure only attributes
    // that actually exist on each realm are included in its deletion file.
    if (hasRealmData) {
        console.log('\nBuilding metadata cross-check map...');
        const perRealmMetadata = buildPerRealmMetadataAttributeMap(allRealms);

        const allCandidates = [...fp1, ...fp2, ...fp3, ...fp4, ...fp5];
        const { generatedFiles: perRealmFiles, perRealmTiers } = generatePerRealmDeletionFiles({
            allCandidates,
            tierLookup,
            perRealmValues,
            perRealmCartridges,
            perRealmMetadata,
            allRealms,
            instanceTypeOverride,
            codeUsageMap,
            blacklistEntries,
            blacklistedPreferences,
            totalAnalyzed: codeResults.length || unusedPreferences.size + usedPreferences.size,
            dynamicRefCount,
            dynamicProtected,
            untrackedParentCount
        });

        console.log(
            `✓ Generated ${perRealmFiles.length} per-realm deletion file(s)`
        );

        // Generate combined per-realm listing (all realms in one file)
        const combinedFilePath = writeCombinedRealmDeletionFile({
            perRealmTiers,
            allRealms,
            instanceTypeOverride,
            resultsDir
        });
        console.log(`✓ Generated combined per-realm listing: ${path.basename(combinedFilePath)}`);

        // Generate cross-realm intersection file (same tier on ALL realms)
        const crossRealmFilePath = writeCrossRealmIntersectionFile({
            perRealmTiers,
            allRealms,
            instanceTypeOverride,
            resultsDir
        });
        if (crossRealmFilePath) {
            console.log(
                `✓ Generated cross-realm intersection file: ${path.basename(crossRealmFilePath)}`
            );
        } else {
            console.log('✓ No cross-realm intersection candidates found');
        }

        // Generate Meta-cleanup-logic files (.txt + .json)
        // Compares P-levels across realms and records mismatches for the
        // meta-cleanup command to handle migration before removal.
        const metaCleanupResult = generateMetaCleanupLogicFiles({
            perRealmTiers,
            allRealms,
            instanceTypeOverride,
            resultsDir
        });
        if (metaCleanupResult) {
            console.log(
                '\u2713 Generated Meta-cleanup-logic files: '
                + `${metaCleanupResult.totalEntries} entries`
                + ` (${metaCleanupResult.mismatchCount} with cross-realm mismatches)`
            );
        }
    }

    return outputFilePath;
}

/**
 * Generate per-realm deletion files.
 * Re-classifies globally classified candidates using realm-specific value data.
 * A pref that is P2 globally (has values somewhere) might be P1 on a realm
 * where it has no values, and P2 on another realm where it does.
 * P5 candidates only appear in realms where their active code is NOT present.
 *
 * @param {Object} params
 * @param {Array} params.allCandidates - All globally classified deletion candidates
 * @param {Map<string, number>} params.tierLookup - Global tier lookup (prefId → tier number)
 * @param {Map} params.perRealmValues - Per-realm value data
 * @param {Map<string, Set<string>>} params.perRealmCartridges - Per-realm cartridge sets
 * @param {Map<string, Set<string>>} params.perRealmMetadata - Per-realm metadata attribute IDs
 * @param {string[]} params.allRealms - All available realms
 * @param {string|null} params.instanceTypeOverride - Instance type
 * @param {Map} params.codeUsageMap - Code usage data (prefId → {activeCartridges, deprecatedCartridges})
 * @param {Array} params.blacklistEntries - Pre-loaded blacklist entries for realm-specific filtering
 * @param {string[]} params.blacklistedPreferences - Globally blacklisted preference IDs
 * @param {number} params.totalAnalyzed - Total preferences analyzed
 * @param {number} params.dynamicRefCount - Dynamic reference count
 * @param {Array} params.dynamicProtected - Dynamic-protected preferences
 * @param {number} params.untrackedParentCount - Untracked parent count
 * @returns {{ generatedFiles: string[], perRealmTiers: Map<string, {p1: Array, p2: Array, p3: Array, p4: Array, p5: Array}> }}
 */
function generatePerRealmDeletionFiles({
    allCandidates,
    tierLookup,
    perRealmValues,
    perRealmCartridges,
    perRealmMetadata,
    allRealms,
    instanceTypeOverride,
    codeUsageMap,
    blacklistEntries,
    blacklistedPreferences,
    totalAnalyzed,
    dynamicRefCount,
    dynamicProtected,
    untrackedParentCount
}) {
    const generatedFiles = [];
    const perRealmTiers = new Map();

    for (const realm of allRealms) {
        const realmResultsDir = ensureResultsDir(realm, instanceTypeOverride);
        const realmCarts = perRealmCartridges.get(realm) || new Set();
        const realmAttributes = perRealmMetadata.get(realm) || null;

        // Re-classify each candidate for this specific realm
        const rp1 = [];
        const rp2 = [];
        const rp3 = [];
        const rp4 = [];
        const rp5 = [];
        let metadataSkipped = 0;

        for (const candidate of allCandidates) {
            const globalTier = tierLookup.get(candidate.id);
            if (!globalTier) {
                continue;
            }

            // Cross-check: skip if metadata is available and this attribute
            // does not exist on the realm (cannot delete what isn't there).
            // Exception: P5 candidates originate from active code analysis
            // and their definitions are typically shared across all realms
            // via core meta XML. The BM backup may be stale or incomplete,
            // so allow P5 through for per-realm reclassification. If the
            // attribute truly does not exist on the realm, the OCAPI DELETE
            // will return 404 which is handled gracefully downstream.
            if (globalTier !== 5
                && realmAttributes && !realmAttributes.has(candidate.id)) {
                metadataSkipped++;
                continue;
            }

            // Get realm-specific value data
            const realmData = perRealmValues.get(candidate.id)?.get(realm);
            const hasValuesOnRealm = realmData?.hasValues || realmData?.hasDefault || false;
            const siteCountOnRealm = realmData?.siteCount || 0;

            // For P5: skip if active code runs on this realm.
            // Otherwise, re-classify from this realm's perspective:
            //   - active cartridges NOT on this realm → no active code ref
            //   - check if deprecated cartridges are on this realm → P3/P4
            //   - otherwise → P1/P2 (no code reference at all)
            if (globalTier === 5) {
                const usage = codeUsageMap.get(candidate.id);
                const hasActiveCodeOnRealm = usage?.activeCartridges?.some(
                    c => realmCarts.has(c)
                ) || false;

                if (hasActiveCodeOnRealm) {
                    continue;
                }

                const realmCandidate = {
                    ...candidate,
                    hasValues: hasValuesOnRealm,
                    hasDefault: realmData?.hasDefault || false,
                    siteCount: siteCountOnRealm
                };

                // Check if deprecated cartridges are present on this realm
                const hasDeprecatedCodeOnRealm = usage?.deprecatedCartridges?.some(
                    c => realmCarts.has(c)
                ) || false;

                if (hasDeprecatedCodeOnRealm) {
                    // Deprecated code on this realm → P3 (no values) or P4 (has values)
                    if (hasValuesOnRealm) {
                        rp4.push(realmCandidate);
                    } else {
                        rp3.push(realmCandidate);
                    }
                } else if (hasValuesOnRealm) {
                    // No code on this realm, has values → P2
                    rp2.push(realmCandidate);
                } else {
                    // No code on this realm, no values → P1
                    rp1.push(realmCandidate);
                }
                continue;
            }

            // For P1/P2: re-classify based on realm-specific values
            if (globalTier === 1 || globalTier === 2) {
                const realmCandidate = {
                    ...candidate,
                    hasValues: hasValuesOnRealm,
                    hasDefault: realmData?.hasDefault || false,
                    siteCount: siteCountOnRealm
                };

                if (hasValuesOnRealm) {
                    rp2.push(realmCandidate);
                } else {
                    rp1.push(realmCandidate);
                }
                continue;
            }

            // For P3/P4: re-classify based on realm-specific cartridge presence
            // and value data. If the deprecated cartridge is not on this realm,
            // downgrade to P1/P2 (no code reference from this realm's perspective).
            if (globalTier === 3 || globalTier === 4) {
                const usage = codeUsageMap.get(candidate.id);
                const realmCandidate = {
                    ...candidate,
                    hasValues: hasValuesOnRealm,
                    hasDefault: realmData?.hasDefault || false,
                    siteCount: siteCountOnRealm
                };

                const hasDeprecatedCodeOnRealm = usage?.deprecatedCartridges?.some(
                    c => realmCarts.has(c)
                ) || false;

                if (hasDeprecatedCodeOnRealm) {
                    // Deprecated code IS on this realm → keep as P3/P4
                    if (hasValuesOnRealm) {
                        rp4.push(realmCandidate);
                    } else {
                        rp3.push(realmCandidate);
                    }
                } else if (hasValuesOnRealm) {
                    // Deprecated code NOT on this realm, has values → P2
                    rp2.push(realmCandidate);
                } else {
                    // Deprecated code NOT on this realm, no values → P1
                    rp1.push(realmCandidate);
                }
                continue;
            }
        }

        // Apply realm-specific blacklist filtering.
        // Global blacklist entries were already applied before per-realm generation.
        // Here we filter entries that target this specific realm.
        const realmCandidateIds = [
            ...rp1, ...rp2, ...rp3, ...rp4, ...rp5
        ].map(c => c.id);
        const { blocked: realmBlocked } = filterBlacklisted(
            realmCandidateIds, blacklistEntries, realm
        );
        const realmBlockedSet = new Set(realmBlocked);
        const filterRealmBlacklisted = (arr) => arr.filter(
            c => !realmBlockedSet.has(c.id)
        );
        const frp1 = filterRealmBlacklisted(rp1);
        const frp2 = filterRealmBlacklisted(rp2);
        const frp3 = filterRealmBlacklisted(rp3);
        const frp4 = filterRealmBlacklisted(rp4);
        const frp5 = filterRealmBlacklisted(rp5);

        // Combine global + realm-specific blacklisted for display in the file
        const combinedBlacklisted = [
            ...blacklistedPreferences,
            ...realmBlocked
        ];

        const totalCandidates = frp1.length + frp2.length + frp3.length
            + frp4.length + frp5.length;

        // Store tier data for this realm (even if empty, for cross-realm analysis)
        perRealmTiers.set(realm, {
            p1: frp1, p2: frp2, p3: frp3, p4: frp4, p5: frp5
        });

        if (totalCandidates === 0) {
            continue;
        }

        const filePath = writePerRealmDeletionFile({
            realm,
            resultsDir: realmResultsDir,
            instanceTypeOverride,
            rp1: frp1, rp2: frp2, rp3: frp3, rp4: frp4, rp5: frp5,
            blacklistedPreferences: combinedBlacklisted,
            totalAnalyzed,
            dynamicRefCount,
            dynamicProtected,
            untrackedParentCount
        });

        generatedFiles.push(filePath);

        const realmBlacklistNote = realmBlocked.length > 0
            ? `, ${realmBlocked.length} realm-blacklisted`
            : '';
        const metadataNote = metadataSkipped > 0
            ? ` (${metadataSkipped} excluded by metadata cross-check${realmBlacklistNote})`
            : realmBlocked.length > 0
                ? ` (${realmBlacklistNote.substring(2)})`
                : '';
        console.log(
            `  ${realm}: ${totalCandidates} candidate(s)`
            + ` [P1:${frp1.length} P2:${frp2.length} P3:${frp3.length}`
            + ` P4:${frp4.length} P5:${frp5.length}]${metadataNote}`
        );
    }

    return { generatedFiles, perRealmTiers };
}

/**
 * Write a per-realm deletion candidates file.
 * Format matches the unified file but omits realm tags (the file IS for one realm).
 *
 * @param {Object} params
 * @param {string} params.realm - Realm name
 * @param {string} params.resultsDir - Results directory for this realm
 * @param {string|null} params.instanceTypeOverride - Instance type
 * @param {Array} params.rp1-rp5 - Tier-classified candidates for this realm
 * @param {string[]} params.blacklistedPreferences - Blacklisted preference IDs
 * @param {number} params.totalAnalyzed - Total preferences analyzed
 * @param {number} params.dynamicRefCount - Dynamic reference count
 * @param {Array} params.dynamicProtected - Dynamic-protected preferences
 * @param {number} params.untrackedParentCount - Untracked parent count
 * @returns {string} Path to the generated file
 */
function writePerRealmDeletionFile({
    realm,
    resultsDir,
    instanceTypeOverride,
    rp1, rp2, rp3, rp4, rp5,
    blacklistedPreferences,
    totalAnalyzed,
    dynamicRefCount,
    dynamicProtected,
    untrackedParentCount
}) {
    const totalCandidates = rp1.length + rp2.length + rp3.length + rp4.length + rp5.length;
    const outputFilename = `${realm}${FILE_PATTERNS.PREFERENCES_FOR_DELETION}`;
    const outputFilePath = path.join(resultsDir, outputFilename);

    const lines = [
        `Site Preferences \u2014 Deletion Candidates for ${realm}`,
        `Generated: ${new Date().toISOString()}`,
        `Instance Type: ${instanceTypeOverride || 'ALL'}`,
        `Realm: ${realm}`,
        '',
        'Analysis Summary:',
        `  \u2022 Total preferences analyzed: ${totalAnalyzed}`,
        `  \u2022 [P1] Safe to delete (no code, no values on ${realm}): ${rp1.length}`,
        `  \u2022 [P2] Likely safe (no code, has values on ${realm}): ${rp2.length}`,
        `  \u2022 [P3] Review: deprecated code on ${realm}, no values: ${rp3.length}`,
        `  \u2022 [P4] Review: deprecated code on ${realm}, has values: ${rp4.length}`,
        `  \u2022 Total deletion candidates for ${realm}: ${totalCandidates}`
    ];

    if (dynamicRefCount > 0) {
        lines.push(
            `  \u2022 Dynamic value references: ${dynamicRefCount} (annotated with \u26a0)`
        );
    }

    if (dynamicProtected.length > 0) {
        lines.push(
            `  \u2022 Dynamic value protected: ${dynamicProtected.length}`
            + ' (referenced by active code)'
        );
    }

    if (untrackedParentCount > 0) {
        lines.push(
            `  \u2022 Untracked parents added: ${untrackedParentCount}`
            + ' (not in attribute definitions, reference candidates)'
        );
    }

    if (blacklistedPreferences.length > 0) {
        lines.push(`  \u2022 Blacklisted (protected): ${blacklistedPreferences.length}`);
    }

    lines.push(
        '',
        'Priority Legend:',
        `  [P1] No code references, no values on ${realm} \u2014 safest to remove`,
        `  [P2] No code references, but has values/defaults on ${realm} \u2014 verify before removing`,
        `  [P3] Only in deprecated cartridges on ${realm}, no values \u2014 probably safe`,
        `  [P4] Only in deprecated cartridges on ${realm}, has values \u2014 needs careful review`,
        '',
        'Note: Preferences with active code only on other realms (globally P5) are',
        `reclassified per-realm. Since ${realm} does not use those cartridges, they`,
        'appear as P1/P2 (no code reference) or P3/P4 (deprecated code only) above.',
        '',
        'NOTE: Preferences matching patterns in src/config/preference_blacklist.json are excluded',
        'from this list and will never be deleted.'
    );

    // --- P1 Section ---
    if (rp1.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P1] Safe to Delete (No Code, No Values on ${realm}) --- [${rp1.length} preferences]`
        );

        for (const c of rp1) {
            const parts = [];
            if (c.dynamicValueOf) {
                parts.push(`\u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`);
            }
            lines.push(parts.length > 0 ? `${c.id}  |  ${parts.join('  |  ')}` : c.id);
        }
    }

    // --- P2 Section ---
    if (rp2.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P2] Likely Safe (No Code, Has Values on ${realm}) --- [${rp2.length} preferences]`
        );

        for (const c of rp2) {
            const details = [];
            if (c.hasDefault) {
                details.push('has default value');
            }
            if (c.hasValues) {
                details.push(`sites with values: ${c.siteCount}`);
            }
            if (c.dynamicValueOf) {
                details.push(`\u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`);
            }
            lines.push(
                details.length > 0 ? `${c.id}  |  ${details.join('  |  ')}` : c.id
            );
        }
    }

    // --- P3 Section ---
    if (rp3.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P3] Review: Deprecated Code Only (No Values on ${realm}) ---`
            + ` [${rp3.length} preferences]`
        );

        for (const c of rp3) {
            const parts = [`deprecated: ${c.deprecatedCartridges.join(', ')}`];
            if (c.dynamicValueOf) {
                parts.push(`\u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`);
            }
            lines.push(`${c.id}  |  ${parts.join('  |  ')}`);
        }
    }

    // --- P4 Section ---
    if (rp4.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P4] Review: Deprecated Code + Values on ${realm} ---`
            + ` [${rp4.length} preferences]`
        );

        for (const c of rp4) {
            const details = [`deprecated: ${c.deprecatedCartridges.join(', ')}`];
            if (c.hasDefault) {
                details.push('has default value');
            }
            if (c.hasValues) {
                details.push(`sites with values: ${c.siteCount}`);
            }
            if (c.dynamicValueOf) {
                details.push(`\u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`);
            }
            lines.push(`${c.id}  |  ${details.join('  |  ')}`);
        }
    }

    // --- P5 Section ---
    if (rp5.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            '--- [P5] Realm-Specific: Active Code on Other Realms ---'
            + ` [${rp5.length} preferences]`
        );

        for (const c of rp5) {
            const details = [];
            if (c.codeRealms) {
                details.push(`active in: ${c.codeRealms.join(', ')}`);
            }
            if (c.activeCartridges) {
                details.push(`code: ${c.activeCartridges.join(', ')}`);
            }
            if (c.hasValues) {
                details.push(`sites with values: ${c.siteCount}`);
            }
            if (c.dynamicValueOf) {
                details.push(`\u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`);
            }
            lines.push(`${c.id}  |  ${details.join('  |  ')}`);
        }
    }

    // --- Blacklisted Section ---
    if (blacklistedPreferences.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            '--- Blacklisted Preferences (Protected) ---',
            ...blacklistedPreferences.sort()
        );
    }

    fs.writeFileSync(outputFilePath, lines.join('\n'), 'utf-8');

    return outputFilePath;
}

/**
 * Format a tier section for a single realm within a combined file.
 * @param {string} tierLabel - Tier label (e.g. 'P1')
 * @param {string} tierDescription - Tier description
 * @param {Array} candidates - Tier candidates
 * @param {string} realm - Realm name
 * @returns {string[]} Lines for this tier section
 * @private
 */
function formatTierSection(tierLabel, tierDescription, candidates, _realm) {
    const lines = [];
    if (candidates.length === 0) {
        return lines;
    }

    lines.push(
        '',
        `  --- [${tierLabel}] ${tierDescription} --- [${candidates.length} preferences]`
    );

    for (const c of candidates) {
        const parts = [];
        if (c.deprecatedCartridges) {
            parts.push(`deprecated: ${c.deprecatedCartridges.join(', ')}`);
        }
        if (c.hasDefault) {
            parts.push('has default value');
        }
        if (c.hasValues) {
            parts.push(`sites with values: ${c.siteCount}`);
        }
        if (c.codeRealms) {
            parts.push(`active in: ${c.codeRealms.join(', ')}`);
        }
        if (c.activeCartridges && c.activeCartridges.length > 0 && c.codeRealms) {
            parts.push(`code: ${c.activeCartridges.join(', ')}`);
        }
        if (c.dynamicValueOf) {
            parts.push(`\u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`);
        }
        lines.push(parts.length > 0 ? `    ${c.id}  |  ${parts.join('  |  ')}` : `    ${c.id}`);
    }

    return lines;
}

/**
 * Write a combined per-realm deletion candidates file.
 * Lists each realm's candidates grouped by tier within one file.
 *
 * @param {Object} params
 * @param {Map<string, Object>} params.perRealmTiers - Per-realm tier data
 * @param {string[]} params.allRealms - All realm names
 * @param {string|null} params.instanceTypeOverride - Instance type
 * @param {string} params.resultsDir - ALL_REALMS results directory
 * @returns {string} Path to the generated file
 */
function writeCombinedRealmDeletionFile({
    perRealmTiers,
    allRealms,
    instanceTypeOverride,
    resultsDir
}) {
    const outputFilename = `${instanceTypeOverride || 'ALL'}${FILE_PATTERNS.PREFERENCES_COMBINED_REALMS}`;
    const outputFilePath = path.join(resultsDir, outputFilename);

    const lines = [
        'Site Preferences \u2014 Combined Per-Realm Deletion Candidates',
        `Generated: ${new Date().toISOString()}`,
        `Instance Type: ${instanceTypeOverride || 'ALL'}`,
        `Realms: ${allRealms.join(', ')}`,
        '',
        'This file lists deletion candidates for each realm separately.',
        'Each realm has its own tier classifications based on realm-specific',
        'value data and cartridge presence.',
        '',
        'Priority Legend:',
        '  [P1] No code references, no values \u2014 safest to remove',
        '  [P2] No code references, but has values/defaults \u2014 verify before removing',
        '  [P3] Only in deprecated cartridges, no values \u2014 probably safe',
        '  [P4] Only in deprecated cartridges, has values \u2014 needs careful review',
        '  [P5] Active code only on other realms \u2014 realm-specific deletion'
    ];

    for (const realm of allRealms) {
        const tiers = perRealmTiers.get(realm);
        if (!tiers) {
            continue;
        }

        const total = tiers.p1.length + tiers.p2.length + tiers.p3.length
            + tiers.p4.length + tiers.p5.length;

        lines.push(
            '',
            '================================================================================',
            `  ${realm}  \u2014  ${total} deletion candidate(s)`
            + `  [P1:${tiers.p1.length} P2:${tiers.p2.length} P3:${tiers.p3.length}`
            + ` P4:${tiers.p4.length} P5:${tiers.p5.length}]`,
            '================================================================================'
        );

        if (total === 0) {
            lines.push('', '  No deletion candidates for this realm.');
            continue;
        }

        lines.push(
            ...formatTierSection('P1', `Safe to Delete (No Code, No Values on ${realm})`,
                tiers.p1, realm),
            ...formatTierSection('P2', `Likely Safe (No Code, Has Values on ${realm})`,
                tiers.p2, realm),
            ...formatTierSection('P3', `Deprecated Code Only (No Values on ${realm})`,
                tiers.p3, realm),
            ...formatTierSection('P4', `Deprecated Code + Values on ${realm}`,
                tiers.p4, realm),
            ...formatTierSection('P5', 'Active Code on Other Realms',
                tiers.p5, realm)
        );
    }

    fs.writeFileSync(outputFilePath, lines.join('\n'), 'utf-8');
    return outputFilePath;
}

/**
 * Write a cross-realm intersection file.
 * Contains only preferences that are classified at the SAME tier on ALL realms.
 *
 * @param {Object} params
 * @param {Map<string, Object>} params.perRealmTiers - Per-realm tier data
 * @param {string[]} params.allRealms - All realm names
 * @param {string|null} params.instanceTypeOverride - Instance type
 * @param {string} params.resultsDir - ALL_REALMS results directory
 * @returns {string|null} Path to the generated file, or null if no intersection found
 */
function writeCrossRealmIntersectionFile({
    perRealmTiers,
    allRealms,
    instanceTypeOverride,
    resultsDir
}) {
    const outputFilename = `${instanceTypeOverride || 'ALL'}${FILE_PATTERNS.PREFERENCES_CROSS_REALM}`;
    const outputFilePath = path.join(resultsDir, outputFilename);

    // Build a map: prefId → { realm → tier }
    const prefRealmTierMap = new Map();

    for (const realm of allRealms) {
        const tiers = perRealmTiers.get(realm);
        if (!tiers) {
            continue;
        }

        const tierArrays = [
            { tier: 'P1', candidates: tiers.p1 },
            { tier: 'P2', candidates: tiers.p2 },
            { tier: 'P3', candidates: tiers.p3 },
            { tier: 'P4', candidates: tiers.p4 },
            { tier: 'P5', candidates: tiers.p5 }
        ];

        for (const { tier, candidates } of tierArrays) {
            for (const c of candidates) {
                if (!prefRealmTierMap.has(c.id)) {
                    prefRealmTierMap.set(c.id, new Map());
                }
                prefRealmTierMap.get(c.id).set(realm, { tier, candidate: c });
            }
        }
    }

    // Find preferences that appear at the SAME tier on ALL realms
    const realmsWithData = allRealms.filter(r => perRealmTiers.has(r));
    const realmCount = realmsWithData.length;

    if (realmCount < 2) {
        return null;
    }

    const crossRealmByTier = { P1: [], P2: [], P3: [], P4: [], P5: [] };

    for (const [, realmTiers] of prefRealmTierMap) {
        // Must be present on ALL realms
        if (realmTiers.size !== realmCount) {
            continue;
        }

        // All realms must have the same tier
        const tiers = [...realmTiers.values()].map(v => v.tier);
        const firstTier = tiers[0];
        const allSameTier = tiers.every(t => t === firstTier);

        if (allSameTier) {
            // Use the candidate data from the first realm for display
            const firstEntry = [...realmTiers.values()][0];
            crossRealmByTier[firstTier].push(firstEntry.candidate);
        }
    }

    // Sort each tier alphabetically
    for (const tier of Object.keys(crossRealmByTier)) {
        crossRealmByTier[tier].sort((a, b) => a.id.localeCompare(b.id));
    }

    const totalIntersection = Object.values(crossRealmByTier)
        .reduce((sum, arr) => sum + arr.length, 0);

    if (totalIntersection === 0) {
        return null;
    }

    const lines = [
        'Site Preferences \u2014 Cross-Realm Deletion Candidates (Intersection)',
        `Generated: ${new Date().toISOString()}`,
        `Instance Type: ${instanceTypeOverride || 'ALL'}`,
        `Realms: ${realmsWithData.join(', ')}`,
        '',
        'This file lists preferences that are classified at the SAME priority',
        'tier on ALL realms. These are the safest candidates for bulk deletion',
        'because the analysis is consistent across every realm.',
        '',
        'Analysis Summary:',
        `  \u2022 Realms analyzed: ${realmCount} (${realmsWithData.join(', ')})`,
        `  \u2022 [P1] Same tier on all realms (no code, no values): ${crossRealmByTier.P1.length}`,
        `  \u2022 [P2] Same tier on all realms (no code, has values): ${crossRealmByTier.P2.length}`,
        '  \u2022 [P3] Same tier on all realms (deprecated code, no values): '
            + `${crossRealmByTier.P3.length}`,
        '  \u2022 [P4] Same tier on all realms (deprecated code, has values): '
            + `${crossRealmByTier.P4.length}`,
        `  \u2022 [P5] Same tier on all realms (realm-specific): ${crossRealmByTier.P5.length}`,
        `  \u2022 Total cross-realm candidates: ${totalIntersection}`,
        '',
        'Priority Legend:',
        '  [P1] No code references, no values on ANY realm \u2014 safest to remove',
        '  [P2] No code references, has values/defaults on ALL realms \u2014 verify',
        '  [P3] Only in deprecated cartridges on ALL realms, no values \u2014 probably safe',
        '  [P4] Only in deprecated cartridges on ALL realms, has values \u2014 careful review',
        '  [P5] Realm-specific on ALL realms \u2014 unusual but consistent'
    ];

    const tierConfigs = [
        { key: 'P1', desc: 'Safe to Delete on All Realms (No Code, No Values)' },
        { key: 'P2', desc: 'Likely Safe on All Realms (No Code, Has Values)' },
        { key: 'P3', desc: 'Deprecated Code Only on All Realms (No Values)' },
        { key: 'P4', desc: 'Deprecated Code + Values on All Realms' },
        { key: 'P5', desc: 'Realm-Specific on All Realms' }
    ];

    for (const { key, desc } of tierConfigs) {
        const candidates = crossRealmByTier[key];
        if (candidates.length === 0) {
            continue;
        }

        lines.push(
            '',
            '================================================================================',
            '',
            `--- [${key}] ${desc} --- [${candidates.length} preferences]`
        );

        for (const c of candidates) {
            const parts = [];
            if (c.deprecatedCartridges) {
                parts.push(`deprecated: ${c.deprecatedCartridges.join(', ')}`);
            }
            if (c.hasDefault) {
                parts.push('has default value');
            }
            if (c.hasValues) {
                parts.push(`sites with values: ${c.siteCount}`);
            }
            if (c.dynamicValueOf) {
                parts.push(`\u26a0 dynamic value of: ${c.dynamicValueOf.join(', ')}`);
            }
            lines.push(parts.length > 0 ? `${c.id}  |  ${parts.join('  |  ')}` : c.id);
        }
    }

    fs.writeFileSync(outputFilePath, lines.join('\n'), 'utf-8');
    return outputFilePath;
}

/**
 * Generate Meta-cleanup-logic files (.txt and .json).
 * Compares per-realm P-levels for every deletion candidate and identifies
 * preferences where P-levels differ across realms (mismatches). The JSON
 * file is consumed by the meta-cleanup command to drive migration logic
 * before removing attribute definitions from shared meta XMLs.
 *
 * @param {Object} params
 * @param {Map<string, {p1: Array, p2: Array, p3: Array, p4: Array, p5: Array}>} params.perRealmTiers
 * @param {string[]} params.allRealms - All realm names
 * @param {string|null} params.instanceTypeOverride - Instance type
 * @param {string} params.resultsDir - ALL_REALMS results directory
 * @returns {{ totalEntries: number, mismatchCount: number }|null}
 */
function generateMetaCleanupLogicFiles({
    perRealmTiers,
    allRealms,
    instanceTypeOverride,
    resultsDir
}) {
    const realmsWithData = allRealms.filter(r => perRealmTiers.has(r));
    if (realmsWithData.length < 2) {
        return null;
    }

    // Build a map: prefId → Map<realm, tierString>
    const prefRealmTierMap = new Map();

    for (const realm of realmsWithData) {
        const tiers = perRealmTiers.get(realm);
        if (!tiers) {
            continue;
        }

        const tierArrays = [
            { tier: 'P1', candidates: tiers.p1 },
            { tier: 'P2', candidates: tiers.p2 },
            { tier: 'P3', candidates: tiers.p3 },
            { tier: 'P4', candidates: tiers.p4 },
            { tier: 'P5', candidates: tiers.p5 }
        ];

        for (const { tier, candidates } of tierArrays) {
            for (const c of candidates) {
                if (!prefRealmTierMap.has(c.id)) {
                    prefRealmTierMap.set(c.id, new Map());
                }
                prefRealmTierMap.get(c.id).set(realm, tier);
            }
        }
    }

    if (prefRealmTierMap.size === 0) {
        return null;
    }

    // Build entries for JSON and TXT output
    const jsonEntries = [];

    for (const [prefId, realmTiers] of prefRealmTierMap) {
        // Determine the lowest (most deletable) P-level across all realms
        // where this preference is a candidate
        const tierValues = [...realmTiers.values()];
        const uniqueTiers = [...new Set(tierValues)];

        // Realms where this preference IS a deletion candidate
        const candidateRealms = [...realmTiers.keys()];

        // Realms where this preference is NOT a candidate at all
        const nonCandidateRealms = realmsWithData.filter(
            r => !realmTiers.has(r)
        );

        // Determine if there is a mismatch:
        // 1. Different P-levels across realms that have this preference
        // 2. Some realms have this preference as a candidate, others don't
        const hasTierMismatch = uniqueTiers.length > 1;
        const hasMismatch = hasTierMismatch || nonCandidateRealms.length > 0;

        // The primary P-level is the lowest (safest) tier among candidate realms
        const lowestTier = uniqueTiers.sort()[0];

        // P1 realms: realms where this preference is classified as P1
        const p1Realms = candidateRealms.filter(r => realmTiers.get(r) === 'P1');

        // Migrate-to realms: realms where this preference is NOT a P1 candidate
        // (either higher tier or not a candidate at all).
        // These realms need the preference migrated to their private meta XML
        // when removing it from the shared meta XML.
        const migrateToRealms = [
            ...candidateRealms.filter(r => realmTiers.get(r) !== 'P1'),
            ...nonCandidateRealms
        ];

        // Build per-realm P-level detail for the JSON entry
        const realmPLevels = {};
        for (const [realm, tier] of realmTiers) {
            realmPLevels[realm] = tier;
        }
        for (const realm of nonCandidateRealms) {
            realmPLevels[realm] = null;
        }

        jsonEntries.push({
            preferenceId: prefId,
            pLevel: lowestTier,
            realmPLevels,
            p1Realms,
            migrateToRealms,
            hasMismatch
        });
    }

    // Sort alphabetically by preferenceId
    jsonEntries.sort((a, b) => a.preferenceId.localeCompare(b.preferenceId));

    // --- Write JSON file ---
    const jsonOutput = {
        generated: new Date().toISOString(),
        instanceType: instanceTypeOverride || 'ALL',
        realms: realmsWithData,
        totalEntries: jsonEntries.length,
        mismatchCount: jsonEntries.filter(e => e.hasMismatch).length,
        excludedPaths: [],
        entries: jsonEntries
    };

    const jsonFilePath = path.join(resultsDir, FILE_PATTERNS.META_CLEANUP_LOGIC_JSON);
    fs.writeFileSync(jsonFilePath, JSON.stringify(jsonOutput, null, 2), 'utf-8');

    // --- Write TXT file ---
    const txtLines = [
        '# Meta-cleanup-logic Notation',
        '# Each entry lists a preference, its P-level, and the realms where that P-level applies.',
        '# Realms in brackets [ ] indicate where the preference should be migrated/copied to a private meta XML.',
        '# Example: BePay: P1(PNA, APAC, GB) [P2(EU)] means BePay is P1 in PNA, APAC, GB'
            + ' and must be migrated to EU\'s private meta XML (where it is P2).',
        '# Multiple migrate-to realms with different P-levels: BePay: P1(PNA, GB) [P2(EU), P3(APAC)]',
        '# A migrate-to realm with no P-level (not a deletion candidate): BePay: P1(PNA) [none(EU)]',
        '#',
        `# Generated: ${jsonOutput.generated}`,
        `# Instance Type: ${jsonOutput.instanceType}`,
        `# Realms: ${realmsWithData.join(', ')}`,
        `# Total entries: ${jsonOutput.totalEntries}`,
        `# Entries with cross-realm mismatches: ${jsonOutput.mismatchCount}`,
        ''
    ];

    for (const entry of jsonEntries) {
        const p1Label = entry.p1Realms.length > 0
            ? entry.p1Realms.join(', ')
            : 'none';

        if (entry.migrateToRealms.length > 0) {
            // Group migrate-to realms by their P-level for the notation
            const byPLevel = new Map();
            for (const realm of entry.migrateToRealms) {
                const realmTier = entry.realmPLevels[realm] || 'none';
                if (!byPLevel.has(realmTier)) {
                    byPLevel.set(realmTier, []);
                }
                byPLevel.get(realmTier).push(realm);
            }

            const migrateLabel = [...byPLevel.entries()]
                .map(([tier, realms]) => `${tier}(${realms.join(', ')})`)
                .join(', ');

            txtLines.push(
                `${entry.preferenceId}: ${entry.pLevel}(${p1Label})`
                + ` [${migrateLabel}]`
            );
        } else {
            txtLines.push(
                `${entry.preferenceId}: ${entry.pLevel}(${p1Label})`
            );
        }
    }

    const txtFilePath = path.join(resultsDir, FILE_PATTERNS.META_CLEANUP_LOGIC_TXT);
    fs.writeFileSync(txtFilePath, txtLines.join('\n'), 'utf-8');

    return {
        totalEntries: jsonEntries.length,
        mismatchCount: jsonEntries.filter(e => e.hasMismatch).length
    };
}

/**
 * Find usage for all active preferences in repository (optimized batch search)
 * @param {string} repositoryPath - Absolute path to repository root
 * @param {Object} [options] - Optional settings
 * @returns {Promise<Array>} Array of results for each preference
 */
export async function findAllActivePreferencesUsage(repositoryPathOrPaths, options = {}) {
    // Normalize to array so callers can pass a single string or an array
    const repositoryPaths = Array.isArray(repositoryPathOrPaths)
        ? repositoryPathOrPaths
        : [repositoryPathOrPaths];

    const matrixFiles = findAllMatrixFiles(options.realmFilter || null);
    const comparisonFilePath = options.comparisonFilePath || DEFAULT_COMPARISON_FILE_PATH;
    const progressCallback = options.progressCallback || null;

    const log = progressCallback ? () => {} : console.log.bind(console);

    if (matrixFiles.length === 0) {
        log('No matrix files found.');
        return [];
    }

    log(`Found ${matrixFiles.length} matrix file(s)\n`);

    const matrixFilePaths = matrixFiles.map(f => f.matrixFile);
    const activePreferences = Array.from(getActivePreferencesFromMatrices(matrixFilePaths)).sort();

    log(`Found ${activePreferences.length} active preference(s)\n`);

    // Get deprecated cartridges for tagging
    const deprecatedCartridges = getDeprecatedCartridges(comparisonFilePath);

    // Collect all file paths from every selected repository
    log('Collecting all file paths...');
    const allFiles = [];
    for (const repoPath of repositoryPaths) {
        const repoName = path.basename(repoPath);
        const filesForRepo = collectAllFilePaths(repoPath);
        log(`  ${repoName}: ${filesForRepo.length} files`);
        for (const fileInfo of filesForRepo) {
            allFiles.push({ ...fileInfo, repoRoot: repoPath });
        }
    }
    log(`Total files to scan: ${allFiles.length}\n`);

    // Track which preferences are found in which cartridges (with deprecation status)
    const preferenceToCartridges = new Map();
    activePreferences.forEach(pref => preferenceToCartridges.set(pref, {
        active: new Set(),
        deprecated: new Set()
    }));

    // Track per-preference code references (file, line, text, cartridge)
    const preferenceReferences = new Map();

    const logEvery = options.logEvery || 100;
    let scannedFiles = 0;

    // Start the spinner for scanning (only when no progress callback handles display)
    if (!progressCallback) {
        logStatusUpdate('Starting file scan...');
    }

    // Signal initial progress (0 of total)
    if (progressCallback) {
        progressCallback(0, allFiles.length);
    }

    // Scan files in parallel using p-limit to cap concurrent async reads.
    // UV_THREADPOOL_SIZE should be set to >= concurrency (done in main.js).
    const FILE_SCAN_CONCURRENCY = 50;
    const limit = pLimit(FILE_SCAN_CONCURRENCY);

    const scanTasks = allFiles.map(fileInfo =>
        limit(async () => {
            const { foundPreferences, referenceDetails } =
                await searchMultiplePreferencesInFileAsync(
                    fileInfo.path, activePreferences
                );

            // Record cartridges and file references for each found preference
            foundPreferences.forEach(pref => {
                if (fileInfo.cartridge) {
                    const isDeprecated = deprecatedCartridges.has(fileInfo.cartridge);
                    const category = isDeprecated ? 'deprecated' : 'active';
                    preferenceToCartridges.get(pref)[category].add(fileInfo.cartridge);
                }

                const lineDetails = referenceDetails.get(pref) || [];
                if (!preferenceReferences.has(pref)) {
                    preferenceReferences.set(pref, []);
                }
                const relativePath = path.relative(
                    fileInfo.repoRoot, fileInfo.path
                );
                for (const detail of lineDetails) {
                    preferenceReferences.get(pref).push({
                        file: relativePath,
                        line: detail.lineNumber,
                        text: detail.lineText,
                        cartridge: fileInfo.cartridge || null
                    });
                }
            });

            scannedFiles += 1;

            // Update progress callback every logEvery files
            if (scannedFiles % logEvery === 0 || scannedFiles === allFiles.length) {
                const percent = (
                    (scannedFiles / allFiles.length) * 100
                ).toFixed(1);
                if (progressCallback) {
                    progressCallback(scannedFiles, allFiles.length);
                } else {
                    logStatusUpdate(
                        `Scanned ${scannedFiles}/${allFiles.length}`
                        + ` files (${percent}%)`
                    );
                }
            }
        })
    );

    await Promise.all(scanTasks);

    logStatusClear();

    // Build results array
    const results = activePreferences.map(preferenceId => {
        const cartridgeData = preferenceToCartridges.get(preferenceId);
        const activeCartridgeList = Array.from(cartridgeData.active).sort();
        const deprecatedCartridgeList = Array.from(cartridgeData.deprecated).sort();
        const allCartridges = activeCartridgeList
            .concat(deprecatedCartridgeList.map(c => `${c} [possibly deprecated]`))
            .sort();

        return {
            preferenceId,
            repositoryPaths,
            comparisonFilePath,
            deprecatedCartridgesCount: deprecatedCartridges.size,
            totalMatches: allCartridges.length,
            cartridges: allCartridges,
            activeCartridges: activeCartridgeList,
            deprecatedCartridges: deprecatedCartridgeList
        };
    });

    // Export results to file
    const instanceTypeOverride = options.instanceTypeOverride || null;

    // Export unused preferences to separate file
    const unusedFile = exportUnusedPreferencesToFile(results, instanceTypeOverride);
    if (unusedFile) {
        console.log(`✓ Unused preferences saved to: ${unusedFile}`);
    }

    // Export cartridge-to-preferences mapping
    const cartridgeFile = exportCartridgePreferenceMapping(results, instanceTypeOverride);
    if (cartridgeFile) {
        console.log(`✓ Cartridge preference mapping saved to: ${cartridgeFile}`);
    }

    // Generate deletion candidates with priority ranking
    const deletionFile = generatePreferenceDeletionCandidates(instanceTypeOverride, results);
    if (deletionFile) {
        console.log(`✓ Preferences marked for deletion: ${deletionFile}`);
    }

    // Export per-preference code references (file, line, cartridge)
    const referencesFile = exportPreferenceReferences(
        preferenceReferences, instanceTypeOverride
    );
    if (referencesFile) {
        console.log(`✓ Preference code references saved to: ${referencesFile}`);
    }

    console.log('');

    return results;
}

export async function findPreferenceUsage(preferenceId, repositoryPath, options = {}) {
    const comparisonFilePath = options.comparisonFilePath || DEFAULT_COMPARISON_FILE_PATH;
    const isFirstSearch = options.isFirstSearch || false;
    const deprecatedCartridges = getDeprecatedCartridges(comparisonFilePath);
    const matches = [];
    const totalFiles = countScannableFiles(repositoryPath);
    const state = {
        scannedFiles: 0,
        matchesFound: 0,
        logEvery: options.logEvery || 200,
        totalFiles
    };

    if (isFirstSearch) {
        console.log(`Searching for '${preferenceId}'...`);
        console.log(`Filtering deprecated cartridges: ${deprecatedCartridges.size}`);
        console.log(`Logging every ${state.logEvery} files scanned.`);
        console.log(`Total files to scan: ${state.totalFiles}`);
    }

    searchDirectoryForPreference(repositoryPath, preferenceId, deprecatedCartridges, matches, state, isFirstSearch);

    if (isFirstSearch) {
        console.log(
            `Scan complete. Files scanned: ${state.scannedFiles}/${state.totalFiles}. `
            + `Matches: ${state.matchesFound}.`
        );
    }

    // Extract unique cartridge names from matches
    const cartridges = Array.from(new Set(
        matches
            .map(match => getCartridgeNameFromPath(match.filePath))
            .filter(Boolean)
    )).sort();

    return {
        preferenceId,
        repositoryPath,
        comparisonFilePath,
        deprecatedCartridgesCount: deprecatedCartridges.size,
        totalMatches: matches.length,
        cartridges
    };
}

/**
 * Generic code scanner: scan repositories for references to a list of attribute IDs.
 * Unlike findAllActivePreferencesUsage (which reads IDs from matrix files), this function
 * accepts the attribute ID list directly — useful for custom attributes, order attributes, etc.
 *
 * @param {string[]} attributeIds - List of attribute IDs to search for
 * @param {string|string[]} repositoryPathOrPaths - Repository path(s) to scan
 * @param {Object} [options] - Optional settings
 * @param {Function} [options.progressCallback] - (scannedCount, totalFiles) => void
 * @param {number} [options.logEvery] - Log progress every N files (default 100)
 * @returns {Promise<{used: Array<Object>, unused: string[]}>} Used/unused attribute results
 */
export async function scanAttributeUsageInCode(attributeIds, repositoryPathOrPaths, options = {}) {
    const repositoryPaths = Array.isArray(repositoryPathOrPaths)
        ? repositoryPathOrPaths
        : [repositoryPathOrPaths];

    const progressCallback = options.progressCallback || null;
    const logEvery = options.logEvery || 100;
    const log = progressCallback ? () => {} : console.log.bind(console);

    if (attributeIds.length === 0) {
        log('No attribute IDs to scan for.');
        return { used: [], unused: [] };
    }

    log(`Scanning for ${attributeIds.length} attribute(s) across ${repositoryPaths.length} repository(ies)\n`);

    // Get deprecated cartridges for tagging
    const deprecatedCartridges = getDeprecatedCartridges(DEFAULT_COMPARISON_FILE_PATH);

    // Collect all file paths
    log('Collecting all file paths...');
    const allFiles = [];
    for (const repoPath of repositoryPaths) {
        const repoName = path.basename(repoPath);
        const filesForRepo = collectAllFilePaths(repoPath);
        log(`  ${repoName}: ${filesForRepo.length} files`);
        for (const fileInfo of filesForRepo) {
            allFiles.push({ ...fileInfo, repoRoot: repoPath });
        }
    }
    log(`Total files to scan: ${allFiles.length}\n`);

    // Track which attributes are found in which cartridges
    const attributeToCartridges = new Map();
    attributeIds.forEach(id => attributeToCartridges.set(id, {
        active: new Set(),
        deprecated: new Set()
    }));

    // Track per-attribute code references
    const attributeReferences = new Map();

    let scannedFiles = 0;

    if (!progressCallback) {
        logStatusUpdate('Starting file scan...');
    }

    if (progressCallback) {
        progressCallback(0, allFiles.length);
    }

    const FILE_SCAN_CONCURRENCY = 50;
    const limit = pLimit(FILE_SCAN_CONCURRENCY);

    const scanTasks = allFiles.map(fileInfo =>
        limit(async () => {
            const { foundPreferences, referenceDetails } =
                await searchMultiplePreferencesInFileAsync(
                    fileInfo.path, attributeIds
                );

            foundPreferences.forEach(attrId => {
                if (fileInfo.cartridge) {
                    const isDeprecated = deprecatedCartridges.has(fileInfo.cartridge);
                    const category = isDeprecated ? 'deprecated' : 'active';
                    attributeToCartridges.get(attrId)[category].add(fileInfo.cartridge);
                }

                const lineDetails = referenceDetails.get(attrId) || [];
                if (!attributeReferences.has(attrId)) {
                    attributeReferences.set(attrId, []);
                }
                const relativePath = path.relative(fileInfo.repoRoot, fileInfo.path);
                for (const detail of lineDetails) {
                    attributeReferences.get(attrId).push({
                        file: relativePath,
                        line: detail.lineNumber,
                        text: detail.lineText,
                        cartridge: fileInfo.cartridge || null
                    });
                }
            });

            scannedFiles += 1;

            if (scannedFiles % logEvery === 0 || scannedFiles === allFiles.length) {
                if (progressCallback) {
                    progressCallback(scannedFiles, allFiles.length);
                } else {
                    const percent = ((scannedFiles / allFiles.length) * 100).toFixed(1);
                    logStatusUpdate(
                        `Scanned ${scannedFiles}/${allFiles.length} files (${percent}%)`
                    );
                }
            }
        })
    );

    await Promise.all(scanTasks);
    logStatusClear();

    // Build results
    const used = [];
    const unused = [];

    for (const attrId of attributeIds) {
        const cartridgeData = attributeToCartridges.get(attrId);
        const activeCartridges = Array.from(cartridgeData.active).sort();
        const deprecatedCartridgeList = Array.from(cartridgeData.deprecated).sort();
        const totalMatches = activeCartridges.length + deprecatedCartridgeList.length;

        if (totalMatches > 0) {
            used.push({
                attributeId: attrId,
                activeCartridges,
                deprecatedCartridges: deprecatedCartridgeList,
                references: attributeReferences.get(attrId) || []
            });
        } else {
            unused.push(attrId);
        }
    }

    log(`\nScan complete: ${used.length} used, ${unused.length} unused attribute(s)\n`);

    return { used, unused };
}

// ============================================================================
// CUSTOM ATTRIBUTE DELETION CANDIDATE GENERATION
// Mirrors the preference deletion pipeline but without value data.
// Tiers: P1 (no code), P3 (deprecated code only), P5 (realm-specific).
// ============================================================================

/**
 * Parse a metadata backup XML file to extract attribute definition IDs for a given object type.
 * Uses simple regex matching (no XML parser dependency).
 *
 * @param {string} xmlFilePath - Absolute path to the metadata backup XML file
 * @param {string} objectType - Object type to match (e.g. 'Order', 'Product')
 * @returns {Set<string>} Set of attribute definition IDs
 */
export function parseAttributeIdsFromMetadata(xmlFilePath, objectType) {
    const attributeIds = new Set();
    const content = fs.readFileSync(xmlFilePath, 'utf-8');
    const lines = content.split(/\r?\n/);
    const typeIdPattern = `type-id="${objectType}"`;

    let inTargetSection = false;

    for (const line of lines) {
        if (line.includes(typeIdPattern)) {
            inTargetSection = true;
            continue;
        }

        if (inTargetSection && line.includes('</type-extension>')) {
            inTargetSection = false;
            // Don't break — there may be multiple type-extension blocks for the same type
            continue;
        }

        if (inTargetSection) {
            const match = line.match(/attribute-definition\s+attribute-id="([^"]+)"/);
            if (match) {
                attributeIds.add(match[1]);
            }
        }
    }

    return attributeIds;
}

/**
 * Build a map of realm → Set of attribute IDs that exist in each realm's metadata
 * for a given object type.
 *
 * @param {string[]} allRealms - List of realm names
 * @param {string} objectType - Object type (e.g. 'Order')
 * @returns {Map<string, Set<string>>} Map of realm → attribute IDs
 * @private
 */
function buildPerRealmMetadataMap(allRealms, objectType) {
    const metadataMap = new Map();

    for (const realm of allRealms) {
        const metadataFile = findLatestMetadataFile(realm);

        if (!metadataFile) {
            console.log(
                `  ⚠ No metadata backup found for ${realm}`
                + ' — skipping metadata cross-check for this realm'
            );
            continue;
        }

        const attributeIds = parseAttributeIdsFromMetadata(metadataFile, objectType);
        metadataMap.set(realm, attributeIds);

        console.log(
            `  ${realm}: ${attributeIds.size} ${objectType} attribute definition(s)`
            + ` in metadata (${path.basename(metadataFile)})`
        );
    }

    return metadataMap;
}

/**
 * Generate custom attribute deletion candidates with per-realm targeting.
 * Mirrors the preference deletion pipeline but without value data.
 *
 * Tiers:
 *   [P1] No code references — safest to remove
 *   [P3] Only in deprecated cartridges — probably safe
 *   [P5] Active code only in some realms — delete from non-covered realms
 *
 * @param {Object} params
 * @param {Object} params.scanResults - Results from scanAttributeUsageInCode ({used, unused})
 * @param {string[]} params.allRealms - All available realm names
 * @param {string} params.instanceType - Instance type (development/sandbox/staging)
 * @param {string} params.objectType - Object type (e.g. 'Order')
 * @param {string[]} params.repoNames - Repository names scanned
 * @returns {{ outputFilePath: string|null, perRealmFiles: string[], perRealmTiers: Map }}
 */
export function generateCustomAttributeDeletionCandidates({
    scanResults,
    allRealms,
    instanceType,
    objectType,
    repoNames
}) {
    const resultsDir = ensureResultsDir(IDENTIFIERS.ALL_REALMS, instanceType, objectType);

    // Load per-realm active cartridge sets
    const perRealmCartridges = buildPerRealmCartridgeSet(instanceType);
    const hasRealmData = allRealms.length > 0 && perRealmCartridges.size > 0;

    // Load blacklist entries
    const blacklistEntries = loadBlacklist().blacklist;
    const allCandidateIds = [
        ...scanResults.unused,
        ...scanResults.used
            .filter(u =>
                u.activeCartridges.length === 0 && u.deprecatedCartridges.length > 0
            )
            .map(u => u.attributeId),
        ...scanResults.used
            .filter(u => {
                if (u.activeCartridges.length === 0) return false;
                const applicableRealms = determineRealmsByCode(
                    u.activeCartridges, perRealmCartridges, allRealms
                );
                return applicableRealms.length > 0
                    && !applicableRealms.includes(REALM_TAGS.ALL);
            })
            .map(u => u.attributeId)
    ];
    const { blocked: blacklistedAttributes } = filterBlacklisted(
        allCandidateIds, blacklistEntries
    );
    const blacklistedSet = new Set(blacklistedAttributes);

    // Build code usage map from scan results
    const codeUsageMap = new Map();
    for (const entry of scanResults.used) {
        codeUsageMap.set(entry.attributeId, {
            activeCartridges: entry.activeCartridges,
            deprecatedCartridges: entry.deprecatedCartridges
        });
    }

    // Classify into tiers (global)
    const fp1 = []; // No code refs
    const fp3 = []; // Deprecated code only
    const fp5 = []; // Active code, not on all realms

    for (const attrId of scanResults.unused) {
        if (blacklistedSet.has(attrId)) continue;
        fp1.push({ id: attrId, realms: [REALM_TAGS.ALL] });
    }

    for (const entry of scanResults.used) {
        if (blacklistedSet.has(entry.attributeId)) continue;

        const hasActiveCode = entry.activeCartridges.length > 0;
        const hasDeprecatedCode = entry.deprecatedCartridges.length > 0;

        if (!hasActiveCode && hasDeprecatedCode) {
            // P3: Only referenced in deprecated cartridges
            fp3.push({
                id: entry.attributeId,
                deprecatedCartridges: entry.deprecatedCartridges,
                realms: [REALM_TAGS.ALL]
            });
        } else if (hasActiveCode && hasRealmData) {
            // Check for P5: active code not on all realms
            const applicableRealms = determineRealmsByCode(
                entry.activeCartridges, perRealmCartridges, allRealms
            );

            if (applicableRealms.length > 0
                && !applicableRealms.includes(REALM_TAGS.ALL)) {
                fp5.push({
                    id: entry.attributeId,
                    activeCartridges: entry.activeCartridges,
                    deprecatedCartridges: entry.deprecatedCartridges,
                    codeRealms: allRealms.filter(
                        r => !applicableRealms.includes(r)
                    ),
                    realms: applicableRealms
                });
            }
        }
    }

    // Build tier lookup
    const tierLookup = new Map();
    for (const c of fp1) { tierLookup.set(c.id, 1); }
    for (const c of fp3) { tierLookup.set(c.id, 3); }
    for (const c of fp5) { tierLookup.set(c.id, 5); }

    const totalCandidates = fp1.length + fp3.length + fp5.length;

    if (totalCandidates === 0) {
        console.log(
            '✓ No custom attributes marked for deletion'
        );
        return { outputFilePath: null, perRealmFiles: [], perRealmTiers: new Map() };
    }

    // --- Write ALL_REALMS unified deletion file ---
    const outputFilename = `${objectType}${FILE_PATTERNS.CUSTOM_ATTR_FOR_DELETION}`;
    const outputFilePath = path.join(resultsDir, outputFilename);
    const totalAnalyzed = scanResults.used.length + scanResults.unused.length;

    const lines = [
        `${objectType} Custom Attributes — Deletion Candidates (Priority Ranked)`,
        `Generated: ${new Date().toISOString()}`,
        `Instance Type: ${instanceType}`,
        `Realms: ${allRealms.join(', ')}`,
        `Repositories scanned: ${repoNames.join(', ')}`,
        '',
        'Analysis Summary:',
        `  • Total ${objectType} attributes analyzed: ${totalAnalyzed}`,
        `  • [P1] Safe to delete (no code references): ${fp1.length}`,
        `  • [P3] Review: deprecated code only: ${fp3.length}`,
        `  • [P5] Realm-specific: active code not on all realms: ${fp5.length}`,
        `  • Total deletion candidates: ${totalCandidates}`
    ];

    if (blacklistedAttributes.length > 0) {
        lines.push(`  • Blacklisted (protected): ${blacklistedAttributes.length}`);
    }

    lines.push(
        '',
        'Priority Legend:',
        '  [P1] No code references — safest to remove',
        '  [P3] Only in deprecated cartridges — probably safe',
        '  [P5] Active code only in some realms — delete from non-covered realms',
        '',
        'NOTE: Custom attributes have no value data analysis (unlike site preferences).',
        'Tiers P2 and P4 are not applicable for custom attributes.'
    );

    // --- P1 Section ---
    if (fp1.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P1] Safe to Delete (No Code References) --- [${fp1.length} attributes]`
        );
        for (const c of fp1) {
            lines.push(`${c.id}  |  realms: ${c.realms.join(', ')}`);
        }
    }

    // --- P3 Section ---
    if (fp3.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P3] Review: Deprecated Code Only --- [${fp3.length} attributes]`
        );
        for (const c of fp3) {
            lines.push(
                `${c.id}  |  deprecated: ${c.deprecatedCartridges.join(', ')}`
                + `  |  realms: ${c.realms.join(', ')}`
            );
        }
    }

    // --- P5 Section ---
    if (fp5.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P5] Realm-Specific: Active Code Not on All Realms --- [${fp5.length} attributes]`
        );
        for (const c of fp5) {
            lines.push(
                `${c.id}  |  active in: ${c.codeRealms.join(', ')}`
                + `  |  code: ${c.activeCartridges.join(', ')}`
                + `  |  realms: ${c.realms.join(', ')}`
            );
        }
    }

    // --- Blacklisted Section ---
    if (blacklistedAttributes.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            '--- Blacklisted Attributes (Protected) ---',
            ...blacklistedAttributes.sort()
        );
    }

    fs.writeFileSync(outputFilePath, lines.join('\n'), 'utf-8');

    // --- Generate per-realm deletion files ---
    let perRealmFiles = [];
    let perRealmTiers = new Map();

    if (hasRealmData) {
        console.log('\nBuilding per-realm metadata cross-check map...');
        const perRealmMetadata = buildPerRealmMetadataMap(allRealms, objectType);

        const allCandidates = [...fp1, ...fp3, ...fp5];
        const result = generatePerRealmCustomAttrDeletionFiles({
            allCandidates,
            tierLookup,
            perRealmCartridges,
            perRealmMetadata,
            allRealms,
            instanceType,
            objectType,
            codeUsageMap,
            blacklistEntries,
            blacklistedAttributes,
            totalAnalyzed,
            repoNames
        });
        perRealmFiles = result.generatedFiles;
        perRealmTiers = result.perRealmTiers;

        console.log(
            `✓ Generated ${perRealmFiles.length} per-realm deletion file(s)`
        );

        // Generate combined per-realm listing
        const combinedPath = writeCustomAttrCombinedRealmFile({
            perRealmTiers, allRealms, instanceType, objectType, resultsDir
        });
        console.log(`✓ Generated combined per-realm listing: ${path.basename(combinedPath)}`);

        // Generate cross-realm intersection file
        const crossRealmPath = writeCustomAttrCrossRealmFile({
            perRealmTiers, allRealms, instanceType, objectType, resultsDir
        });
        if (crossRealmPath) {
            console.log(
                `✓ Generated cross-realm intersection file: ${path.basename(crossRealmPath)}`
            );
        } else {
            console.log('✓ No cross-realm intersection candidates found');
        }
    }

    return { outputFilePath, perRealmFiles, perRealmTiers };
}

/**
 * Generate per-realm custom attribute deletion files.
 * Re-classifies global candidates using realm-specific cartridge data.
 *
 * @param {Object} params
 * @returns {{ generatedFiles: string[], perRealmTiers: Map }}
 * @private
 */
function generatePerRealmCustomAttrDeletionFiles({
    allCandidates,
    tierLookup,
    perRealmCartridges,
    perRealmMetadata,
    allRealms,
    instanceType,
    objectType,
    codeUsageMap,
    blacklistEntries,
    blacklistedAttributes,
    totalAnalyzed,
    repoNames
}) {
    const generatedFiles = [];
    const perRealmTiers = new Map();

    for (const realm of allRealms) {
        const realmResultsDir = ensureResultsDir(realm, instanceType, objectType);
        const realmCarts = perRealmCartridges.get(realm) || new Set();
        const realmAttributes = perRealmMetadata.get(realm) || null;

        const rp1 = [];
        const rp3 = [];
        const rp5 = [];
        let metadataSkipped = 0;

        for (const candidate of allCandidates) {
            const globalTier = tierLookup.get(candidate.id);
            if (!globalTier) continue;

            // Cross-check: skip if metadata available and attribute not on realm
            // Exception: P5 candidates (may be in shared meta XML)
            if (globalTier !== 5
                && realmAttributes && !realmAttributes.has(candidate.id)) {
                metadataSkipped++;
                continue;
            }

            if (globalTier === 5) {
                const usage = codeUsageMap.get(candidate.id);
                const hasActiveCodeOnRealm = usage?.activeCartridges?.some(
                    c => realmCarts.has(c)
                ) || false;

                if (hasActiveCodeOnRealm) continue;

                // Check deprecated code on this realm
                const hasDeprecatedCodeOnRealm = usage?.deprecatedCartridges?.some(
                    c => realmCarts.has(c)
                ) || false;

                if (hasDeprecatedCodeOnRealm) {
                    rp3.push({ ...candidate });
                } else {
                    rp1.push({ ...candidate });
                }
                continue;
            }

            if (globalTier === 1) {
                rp1.push({ ...candidate });
                continue;
            }

            if (globalTier === 3) {
                const usage = codeUsageMap.get(candidate.id);
                const hasDeprecatedCodeOnRealm = usage?.deprecatedCartridges?.some(
                    c => realmCarts.has(c)
                ) || false;

                if (hasDeprecatedCodeOnRealm) {
                    rp3.push({ ...candidate });
                } else {
                    // Deprecated code NOT on this realm → downgrade to P1
                    rp1.push({ ...candidate });
                }
                continue;
            }
        }

        // Apply realm-specific blacklist filtering
        const realmCandidateIds = [...rp1, ...rp3, ...rp5].map(c => c.id);
        const { blocked: realmBlocked } = filterBlacklisted(
            realmCandidateIds, blacklistEntries, realm
        );
        const realmBlockedSet = new Set(realmBlocked);
        const filterBl = (arr) => arr.filter(c => !realmBlockedSet.has(c.id));
        const frp1 = filterBl(rp1);
        const frp3 = filterBl(rp3);
        const frp5 = filterBl(rp5);

        const combinedBlacklisted = [
            ...blacklistedAttributes,
            ...realmBlocked
        ].filter((v, i, a) => a.indexOf(v) === i).sort();

        // Store per-realm tier data
        perRealmTiers.set(realm, { p1: frp1, p3: frp3, p5: frp5 });

        // Write per-realm file
        const realmTotal = frp1.length + frp3.length + frp5.length;
        const realmFilename = `${realm}_${objectType}${FILE_PATTERNS.CUSTOM_ATTR_FOR_DELETION}`;
        const realmFilePath = path.join(realmResultsDir, realmFilename);

        const realmLines = [
            `${objectType} Custom Attributes — Deletion Candidates for ${realm}`,
            `Generated: ${new Date().toISOString()}`,
            `Instance Type: ${instanceType}`,
            `Realm: ${realm}`,
            `Repositories scanned: ${repoNames.join(', ')}`,
            '',
            'Analysis Summary:',
            `  • Total ${objectType} attributes analyzed: ${totalAnalyzed}`,
            `  • [P1] Safe to delete (no code references on ${realm}): ${frp1.length}`,
            `  • [P3] Review: deprecated code only on ${realm}: ${frp3.length}`,
            `  • [P5] Realm-specific: ${frp5.length}`,
            `  • Total deletion candidates for ${realm}: ${realmTotal}`
        ];

        if (metadataSkipped > 0) {
            realmLines.push(`  • Skipped (not in ${realm} metadata): ${metadataSkipped}`);
        }

        if (combinedBlacklisted.length > 0) {
            realmLines.push(`  • Blacklisted (protected): ${combinedBlacklisted.length}`);
        }

        // --- P1 Section ---
        if (frp1.length > 0) {
            realmLines.push(
                '',
                '================================================================================',
                '',
                `--- [P1] Safe to Delete (No Code References on ${realm}) --- [${frp1.length} attributes]`
            );
            for (const c of frp1) {
                realmLines.push(c.id);
            }
        }

        // --- P3 Section ---
        if (frp3.length > 0) {
            realmLines.push(
                '',
                '================================================================================',
                '',
                `--- [P3] Review: Deprecated Code Only on ${realm} --- [${frp3.length} attributes]`
            );
            for (const c of frp3) {
                const depCarts = c.deprecatedCartridges
                    ? `  |  deprecated: ${c.deprecatedCartridges.join(', ')}`
                    : '';
                realmLines.push(`${c.id}${depCarts}`);
            }
        }

        // --- P5 Section ---
        if (frp5.length > 0) {
            realmLines.push(
                '',
                '================================================================================',
                '',
                `--- [P5] Realm-Specific --- [${frp5.length} attributes]`
            );
            for (const c of frp5) {
                realmLines.push(
                    `${c.id}  |  active in: ${(c.codeRealms || []).join(', ')}`
                    + `  |  code: ${(c.activeCartridges || []).join(', ')}`
                );
            }
        }

        // --- Blacklisted Section ---
        if (combinedBlacklisted.length > 0) {
            realmLines.push(
                '',
                '================================================================================',
                '',
                '--- Blacklisted Attributes (Protected) ---',
                ...combinedBlacklisted
            );
        }

        fs.writeFileSync(realmFilePath, realmLines.join('\n'), 'utf-8');
        generatedFiles.push(realmFilePath);
    }

    return { generatedFiles, perRealmTiers };
}

/**
 * Write combined per-realm custom attribute deletion listing (all realms in one file).
 *
 * @param {Object} params
 * @returns {string} Path to the generated file
 * @private
 */
function writeCustomAttrCombinedRealmFile({
    perRealmTiers, allRealms, instanceType, objectType, resultsDir
}) {
    const filePath = path.join(
        resultsDir,
        `${objectType}${FILE_PATTERNS.CUSTOM_ATTR_COMBINED_REALMS}`
    );

    const lines = [
        `${objectType} Custom Attributes — Combined Per-Realm Deletion Candidates`,
        `Generated: ${new Date().toISOString()}`,
        `Instance Type: ${instanceType}`,
        `Realms: ${allRealms.join(', ')}`,
        ''
    ];

    for (const realm of allRealms) {
        const tiers = perRealmTiers.get(realm);
        if (!tiers) continue;

        const total = tiers.p1.length + tiers.p3.length + (tiers.p5?.length || 0);
        lines.push(
            '================================================================================',
            `=== ${realm} === [${total} deletion candidates]`,
            '================================================================================',
            ''
        );

        if (tiers.p1.length > 0) {
            lines.push(`--- [P1] Safe to Delete --- [${tiers.p1.length} attributes]`);
            for (const c of tiers.p1) { lines.push(c.id); }
            lines.push('');
        }

        if (tiers.p3.length > 0) {
            lines.push(`--- [P3] Deprecated Code Only --- [${tiers.p3.length} attributes]`);
            for (const c of tiers.p3) {
                const depCarts = c.deprecatedCartridges
                    ? `  |  deprecated: ${c.deprecatedCartridges.join(', ')}`
                    : '';
                lines.push(`${c.id}${depCarts}`);
            }
            lines.push('');
        }

        if (tiers.p5?.length > 0) {
            lines.push(`--- [P5] Realm-Specific --- [${tiers.p5.length} attributes]`);
            for (const c of tiers.p5) {
                lines.push(
                    `${c.id}  |  active in: ${(c.codeRealms || []).join(', ')}`
                    + `  |  code: ${(c.activeCartridges || []).join(', ')}`
                );
            }
            lines.push('');
        }
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
}

/**
 * Write cross-realm intersection file for custom attributes
 * (only attributes that are the same tier on ALL realms).
 *
 * @param {Object} params
 * @returns {string|null} Path to the generated file, or null if no intersection
 * @private
 */
function writeCustomAttrCrossRealmFile({
    perRealmTiers, allRealms, instanceType, objectType, resultsDir
}) {
    const realmCount = allRealms.length;
    const attrTierCounts = new Map();

    for (const realm of allRealms) {
        const tiers = perRealmTiers.get(realm);
        if (!tiers) return null;

        for (const c of tiers.p1) {
            if (!attrTierCounts.has(c.id)) attrTierCounts.set(c.id, new Map());
            const counts = attrTierCounts.get(c.id);
            counts.set('P1', (counts.get('P1') || 0) + 1);
        }
        for (const c of tiers.p3) {
            if (!attrTierCounts.has(c.id)) attrTierCounts.set(c.id, new Map());
            const counts = attrTierCounts.get(c.id);
            counts.set('P3', (counts.get('P3') || 0) + 1);
        }
        for (const c of (tiers.p5 || [])) {
            if (!attrTierCounts.has(c.id)) attrTierCounts.set(c.id, new Map());
            const counts = attrTierCounts.get(c.id);
            counts.set('P5', (counts.get('P5') || 0) + 1);
        }
    }

    // Find attributes that are the same tier on ALL realms
    const crossP1 = [];
    const crossP3 = [];

    for (const [attrId, counts] of attrTierCounts) {
        if (counts.get('P1') === realmCount) crossP1.push(attrId);
        if (counts.get('P3') === realmCount) crossP3.push(attrId);
    }

    crossP1.sort();
    crossP3.sort();

    const totalCross = crossP1.length + crossP3.length;
    if (totalCross === 0) return null;

    const filePath = path.join(
        resultsDir,
        `${objectType}${FILE_PATTERNS.CUSTOM_ATTR_CROSS_REALM}`
    );

    const lines = [
        `${objectType} Custom Attributes — Cross-Realm Deletion Candidates`,
        `Generated: ${new Date().toISOString()}`,
        `Instance Type: ${instanceType}`,
        `Realms analyzed: ${realmCount} (${allRealms.join(', ')})`,
        '',
        'Only attributes that have the SAME tier on ALL realms are listed here.',
        'These are the safest candidates for bulk deletion.',
        '',
        `[P1] Same tier on all realms (no code): ${crossP1.length}`,
        `[P3] Same tier on all realms (deprecated code only): ${crossP3.length}`,
        `Total: ${totalCross}`
    ];

    if (crossP1.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P1] Safe to Delete on All Realms (No Code References) --- [${crossP1.length} attributes]`
        );
        for (const id of crossP1) { lines.push(id); }
    }

    if (crossP3.length > 0) {
        lines.push(
            '',
            '================================================================================',
            '',
            `--- [P3] Deprecated Code Only on All Realms --- [${crossP3.length} attributes]`
        );
        for (const id of crossP3) { lines.push(id); }
    }

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
}
