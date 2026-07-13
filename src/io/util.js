import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { getValidationConfig, getInstanceType, getAvailableRealms } from '../config/helpers/helpers.js';
import { DIRECTORIES, IDENTIFIERS, FILE_PATTERNS } from '../config/constants.js';

/**
 * Get the absolute path to the results directory
 * @param {string} [realm] - Optional realm name for subdirectory
 * @param {string} [instanceTypeOverride] - Optional instance type override
 * @param {string} [typeId] - Optional type ID for custom attributes subdirectory
 * @returns {string} Absolute path to results or results/{instanceType}/{realm}/{typeId} directory
 */
export function getResultsPath(realm = null, instanceTypeOverride = null, typeId = null) {
    const resultsDir = path.join(process.cwd(), DIRECTORIES.RESULTS);
    if (realm) {
        if (realm === IDENTIFIERS.ALL_REALMS) {
            if (instanceTypeOverride) {
                const realmPath = path.join(resultsDir, instanceTypeOverride, realm);
                return typeId ? path.join(realmPath, typeId) : realmPath;
            }
            const realmPath = path.join(resultsDir, realm);
            return typeId ? path.join(realmPath, typeId) : realmPath;
        }

        if (instanceTypeOverride) {
            const realmPath = path.join(resultsDir, instanceTypeOverride, realm);
            return typeId ? path.join(realmPath, typeId) : realmPath;
        }

        try {
            const instanceType = getInstanceType(realm);
            const realmPath = path.join(resultsDir, instanceType, realm);
            return typeId ? path.join(realmPath, typeId) : realmPath;
        } catch {
            const realmPath = path.join(resultsDir, 'unknown', realm);
            return typeId ? path.join(realmPath, typeId) : realmPath;
        }
    }
    return resultsDir;
}

/**
 * Ensure results directory exists for a realm
 * @param {string} realm - Realm name
 * @param {string} [instanceTypeOverride] - Optional instance type override
 * @param {string} [typeId] - Optional type ID for custom attributes subdirectory
 * @returns {string} Absolute path to the created directory
 */
export function ensureResultsDir(realm, instanceTypeOverride = null, typeId = null) {
    const dir = getResultsPath(realm, instanceTypeOverride, typeId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * Get sibling directories of the current project
 * Excludes hidden directories and the current project directory
 * @returns {Promise<Array<string>>} Array of sibling directory names sorted alphabetically
 */
export async function getSiblingRepositories() {
    try {
        // Get the parent directory of the current project
        const currentDir = process.cwd();
        const parentDir = path.dirname(currentDir);
        const currentDirName = path.basename(currentDir);

        // Read all entries in parent directory
        const entries = fs.readdirSync(parentDir);

        // Filter for directories excluding current project and hidden dirs
        const siblings = entries.filter((entry) => {
            if (entry === currentDirName || entry.startsWith('.')) {
                return false;
            }
            const fullPath = path.join(parentDir, entry);
            return fs.statSync(fullPath).isDirectory();
        }).sort();

        return siblings;
    } catch (error) {
        console.error('Error reading sibling repositories:', error.message);
        return [];
    }
}

/**
 * Recursively search for cartridge folders in a project
 * Excludes bm_ cartridges if configured in validation settings
 * @param {string} searchPath - Root path to search from
 * @returns {Array<string>} Array of paths to cartridge folders found
 */
export function findCartridgeFolders(searchPath) {
    const validationConfig = getValidationConfig();
    const ignoreBmCartridges = validationConfig.ignoreBmCartridges;
    const cartridgeNames = new Set();

    try {
        const entries = fs.readdirSync(searchPath, { withFileTypes: true });

        for (const entry of entries) {
            // Skip hidden directories and node_modules
            if (entry.name.startsWith('.') || entry.name === 'node_modules') {
                continue;
            }

            if (entry.isDirectory()) {
                const fullPath = path.join(searchPath, entry.name);

                // Check if this directory is named "cartridges"
                if (entry.name === 'cartridges') {
                    // Read all cartridges inside this cartridges folder
                    try {
                        const cartridges = fs.readdirSync(fullPath, {
                            withFileTypes: true
                        });
                        for (const cartridge of cartridges) {
                            // Add only directories (actual cartridges)
                            // Optionally exclude bm_ cartridges based on config
                            if (cartridge.isDirectory() &&
                                !cartridge.name.startsWith('.') &&
                                !(ignoreBmCartridges && cartridge.name.startsWith('bm_'))) {
                                cartridgeNames.add(cartridge.name);
                            }
                        }
                    } catch (error) {
                        console.error(
                            `Error reading cartridges from ${fullPath}:`,
                            error.message
                        );
                    }
                } else {
                    const cartridgeDir = path.join(fullPath, 'cartridge');
                    const hasCartridgeFolder = fs.existsSync(cartridgeDir)
                        && fs.statSync(cartridgeDir).isDirectory();

                    if (hasCartridgeFolder) {
                        // Optionally exclude bm_ cartridges based on config
                        if (!(ignoreBmCartridges && entry.name.startsWith('bm_'))) {
                            cartridgeNames.add(entry.name);
                        }
                    } else {
                        // Recursively search subdirectories
                        const subCartridges = findCartridgeFolders(fullPath);
                        subCartridges.forEach((cartridge) => {
                            cartridgeNames.add(cartridge);
                        });
                    }
                }
            }
        }
    } catch (error) {
        console.error(
            `Error searching for cartridges in ${searchPath}:`,
            error.message
        );
    }

    return Array.from(cartridgeNames).sort();
}

/**
 * Transform a site object into cartridge info format
 * @param {Object} site - Site object from API
 * @param {string} realmName - Optional realm name to include
 * @returns {Object} Transformed site object with id and cartridges array
 */
export function transformSiteToCartridgeInfo(site, realmName = null) {
    const siteId = site.id || site.site_id || site.siteId || 'N/A';
    const cartridges = site.cartridges || site.cartridgesPath || site.cartridges_path || 'N/A';
    const cartridgeArray = (typeof cartridges === 'string'
        ? cartridges
        : cartridges?.join(':') || 'N/A'
    ).split(':').filter(Boolean);

    return {
        name: realmName ? `${siteId} (${realmName})` : siteId,
        id: siteId,
        ...(realmName && { realm: realmName }),
        cartridges: cartridgeArray
    };
}

/**
 * Build attribute group summaries from attribute groups
 * @param {Array} groups - Array of attribute group objects
 * @returns {Array} Array of group summary objects
 */
export function buildGroupSummaries(groups) {
    return groups.map(g => ({
        groupId: g.id,
        groupName: g.name || g.id,
        displayName: g.display_name || g.displayname || g.id
    }));
}

/**
 * Filter sites by scope (all or single)
 * @param {Array} sites - Array of sites
 * @param {string} scope - 'all' or 'single'
 * @param {string} siteId - Site ID to filter by (if scope is 'single')
 * @returns {Array} Filtered sites array
 */
export function filterSitesByScope(sites, scope, siteId) {
    if (scope === 'single') {
        return sites.filter(s => (s.id || s.site_id || s.siteId) === siteId);
    }
    return sites;
}

/**
 * Calculate validation statistics from comparisons
 * @param {Array} comparisons - Array of comparison objects
 * @returns {Object} Statistics object with counts
 */
export function calculateValidationStats(comparisons) {
    const matchCount = comparisons.filter(c => c.comparison.isMatch).length;
    const mismatchCount = comparisons.length - matchCount;

    return {
        total: comparisons.length,
        matching: matchCount,
        mismatched: mismatchCount
    };
}

// ============================================================================
// VS CODE FILE OPENER
// ============================================================================

/**
 * Open a file in VS Code editor.
 * @param {string} filePath - Absolute path to the file to open
 * @returns {Promise<void>} Resolves when VS Code opens the file
 */
export function openFileInVSCode(filePath) {
    return new Promise((resolve, reject) => {
        exec(`code "${filePath}"`, (error) => {
            if (error) {
                reject(new Error(`Failed to open file in VS Code: ${error.message}`));
            } else {
                resolve();
            }
        });
    });
}

// ============================================================================
// TEST DATA UTILITIES
// Write test/debug output to files
// ============================================================================

/**
 * Write test data to a JSON file with optional console output
 * @param {string} filename - Name/path of the file to write
 * @param {*} data - Data to serialize as JSON
 * @param {Object} options - Configuration options
 * @returns {void}
 */
export function writeTestOutput(filename, data, options = {}) {
    fs.writeFileSync(filename, JSON.stringify(data, null, 2));

    if (options.consoleOutput !== false) {
        console.log(`Full response written to ${filename}`);
        if (options.preview) {
            console.log(JSON.stringify(options.preview, null, 2));
        }
    }
}

// ============================================================================
// REALM FILE DISCOVERY
// ============================================================================

/**
 * Find all realm-specific files matching a given pattern in the results directory.
 * Generic helper used by findAllMatrixFiles and findAllUsageFiles.
 *
 * @param {string} filePattern - Pattern string to match (e.g. FILE_PATTERNS.PREFERENCES_MATRIX)
 * @param {string} propName - Property name for the file path in result objects
 * @param {string[]|null} [realmFilter] - Optional list of realm names to filter by
 * @returns {Array<{realm: string, [propName]: string}>} Array of realm + file path objects
 * @private
 */
function findAllRealmFiles(filePattern, propName, realmFilter = null) {
    const results = [];
    const realms = realmFilter && realmFilter.length > 0
        ? realmFilter
        : getAvailableRealms();

    for (const realmName of realms) {
        try {
            const realmDir = getResultsPath(realmName);

            if (!fs.existsSync(realmDir)) {
                continue;
            }

            const files = fs.readdirSync(realmDir);
            const matched = files.find(f => f.includes(filePattern));

            if (matched) {
                results.push({
                    realm: realmName,
                    [propName]: path.join(realmDir, matched)
                });
            }
        } catch {
            // Skip realms with read errors
        }
    }

    return results;
}

/**
 * Find all preference matrix CSV files in the results directory.
 * @param {string[]|null} [realmFilter] - Optional list of realm names to filter by
 * @returns {Array<{realm: string, matrixFile: string}>} Array of realm and matrix file paths
 */
export function findAllMatrixFiles(realmFilter = null) {
    return findAllRealmFiles(FILE_PATTERNS.PREFERENCES_MATRIX, 'matrixFile', realmFilter);
}

/**
 * Find all preference usage CSV files in the results directory.
 * @param {string[]|null} [realmFilter] - Optional list of realm names to filter by
 * @returns {Array<{realm: string, usageFile: string}>} Array of realm and usage file paths
 */
export function findAllUsageFiles(realmFilter = null) {
    return findAllRealmFiles(FILE_PATTERNS.PREFERENCES_USAGE, 'usageFile', realmFilter);
}
