/**
 * Custom Object Scanner
 *
 * Scans SFCC repository meta XML files for custom-type definitions and
 * cartridge code for custom object type references to determine usage
 * across realms.
 *
 * @module customObjectScanner
 */

import fs from 'fs';
import path from 'path';
import {
    getSandboxConfig,
    getCoreSiteTemplatePath
} from '../../../config/helpers/helpers.js';
import { findLatestMetadataFile, collectAllFilePaths } from '../../../io/codeScanner.js';
import { fetchAndTransformSites } from '../../cartridges/helpers/siteHelper.js';
import { LOG_PREFIX } from '../../../config/constants.js';

// ============================================================================
// XML PARSING — CUSTOM-TYPE DEFINITIONS
// ============================================================================

/**
 * Regex to match a complete `<custom-type type-id="...">...</custom-type>` block.
 * Uses a non-greedy match to handle multiple custom-type blocks in one file.
 * @private
 */
const CUSTOM_TYPE_BLOCK_RE = /<custom-type\s+type-id="([^"]+)"[\s\S]*?<\/custom-type>/g;

/**
 * Extract all custom-type IDs from a single meta XML file.
 * @param {string} filePath - Absolute path to a meta XML file
 * @returns {Set<string>} Set of custom-type IDs found
 */
export function extractCustomTypeIdsFromFile(filePath) {
    const ids = new Set();
    const content = fs.readFileSync(filePath, 'utf-8');
    const pattern = /<custom-type\s+type-id="([^"]+)"/g;
    let match;

    while ((match = pattern.exec(content)) !== null) {
        ids.add(match[1]);
    }

    return ids;
}

/**
 * Extract a full `<custom-type>` XML block for a given type ID from file content.
 * @param {string} content - Raw XML string
 * @param {string} typeId - Custom object type ID
 * @returns {string|null} The full XML block or null if not found
 */
export function extractCustomTypeBlock(content, typeId) {
    const escaped = typeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `[ \\t]*<custom-type\\s+type-id="${escaped}"[\\s\\S]*?</custom-type>`,
        'g'
    );
    const match = pattern.exec(content);
    return match ? match[0] : null;
}

/**
 * List all XML files in a meta directory that contain custom-type definitions.
 * @param {string} metaDir - Absolute path to a meta/ directory
 * @returns {string[]} Array of absolute file paths containing custom-type blocks
 */
export function listCustomTypeMetaFiles(metaDir) {
    if (!fs.existsSync(metaDir)) {
        return [];
    }

    return fs.readdirSync(metaDir)
        .filter(name => name.endsWith('.xml'))
        .map(name => path.join(metaDir, name))
        .filter(filePath => {
            const content = fs.readFileSync(filePath, 'utf-8');
            return /<custom-type\s+type-id="/.test(content);
        });
}

/**
 * Collect all custom-type IDs defined in a directory's meta XML files.
 * @param {string} metaDir - Absolute path to meta/ directory
 * @returns {{ typeIds: Set<string>, fileMap: Map<string, string[]> }}
 *   typeIds: all unique type IDs found
 *   fileMap: typeId → array of file paths where it's defined
 */
export function collectCustomTypeIds(metaDir) {
    const typeIds = new Set();
    const fileMap = new Map();

    const xmlFiles = listCustomTypeMetaFiles(metaDir);

    for (const filePath of xmlFiles) {
        const ids = extractCustomTypeIdsFromFile(filePath);
        for (const id of ids) {
            typeIds.add(id);
            if (!fileMap.has(id)) {
                fileMap.set(id, []);
            }
            fileMap.get(id).push(filePath);
        }
    }

    return { typeIds, fileMap };
}

/**
 * Collect custom-type IDs from site template meta sources in the repository:
 * 1. Core site template meta (sites/site_template/meta/)
 * 2. Realm-specific site template meta (sites/site_template_apac/meta/ etc.)
 *
 * Note: Cartridge-level meta (projects/.../meta/) is intentionally excluded — those
 * definitions are not part of the build process and must be reviewed manually.
 *
 * @param {string} repoPath - Absolute path to the SFCC repository
 * @param {string[]} realms - Realm names to check
 * @returns {Object} Result with typeIds (Set), fileMap (Map), and sourceMap (Map)
 */
export function collectAllCustomTypeIds(repoPath, realms) {
    const typeIds = new Set();
    const fileMap = new Map();
    const sourceMap = new Map();

    /**
     * Merge results from a directory scan into the accumulator.
     * @param {string} metaDir - Path to scan
     * @param {string} sourceLabel - Label for the source (e.g. 'core', 'PNA', 'bc_integrationframework')
     */
    function mergeFromDir(metaDir, sourceLabel) {
        const result = collectCustomTypeIds(metaDir);
        for (const [id, files] of result.fileMap) {
            typeIds.add(id);
            if (!fileMap.has(id)) {
                fileMap.set(id, []);
            }
            fileMap.get(id).push(...files);
            if (!sourceMap.has(id)) {
                sourceMap.set(id, sourceLabel);
            }
        }
    }

    // 1. Core site template meta
    const coreMetaDir = path.join(repoPath, getCoreSiteTemplatePath(), 'meta');
    mergeFromDir(coreMetaDir, 'core');

    // 2. Realm-specific site template meta
    for (const realm of realms) {
        try {
            const config = getSandboxConfig(realm);
            const realmMetaDir = path.join(repoPath, config.siteTemplatesPath, 'meta');

            // Skip if same as core
            if (path.resolve(realmMetaDir) === path.resolve(coreMetaDir)) {
                continue;
            }

            mergeFromDir(realmMetaDir, realm);
        } catch {
            // Realm config not found — skip
        }
    }

    return { typeIds, fileMap, sourceMap };
}

// ============================================================================
// CODE SCANNING — CUSTOM OBJECT USAGE
// Uses the same file discovery as the preference scanner (collectAllFilePaths)
// which walks the entire repo root, respecting SKIP_DIRECTORIES.
// ============================================================================

/**
 * Check whether a line contains a reference to a custom object type ID.
 * Matches common SFCC patterns:
 *   - String literals: 'TypeId', "TypeId"
 *   - CustomObjectMgr calls: CustomObjectMgr.getCustomObject('TypeId', ...)
 *   - XML type references: type-id="TypeId"
 *
 * @param {string} line - Source line to test
 * @param {string} typeId - Custom object type ID to look for
 * @returns {boolean} True if the line references the type ID
 */
export function isCustomObjectTypeMatch(line, typeId) {
    const escaped = typeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const pattern = new RegExp(
        `['"]${escaped}['"]`
        + `|type-id="${escaped}"`
        + `|type-id='${escaped}'`
    );

    return pattern.test(line);
}

/**
 * Scan all code in a repository for references to custom object type IDs.
 * Uses the same collectAllFilePaths approach as the preference scanner —
 * walks the entire repo from root, skipping .git, node_modules, sites, etc.
 *
 * @param {string} repoPath - Absolute path to the SFCC repository
 * @param {string[]} typeIds - Custom object type IDs to search for
 * @returns {Map<string, Array<{ file: string, lineNumber: number, cartridge: string|null }>>}
 */
export function scanCodeForCustomObjectUsage(repoPath, typeIds) {
    const usageMap = new Map();

    for (const typeId of typeIds) {
        usageMap.set(typeId, []);
    }

    const allFiles = collectAllFilePaths(repoPath);
    console.log(`  ${allFiles.length} scannable file(s) found.\n`);

    for (const fileInfo of allFiles) {
        const content = fs.readFileSync(fileInfo.path, 'utf-8');

        // Fast pre-filter: skip files that don't mention any type ID
        const relevantTypeIds = typeIds.filter(id => content.includes(id));
        if (relevantTypeIds.length === 0) {
            continue;
        }

        const lines = content.split(/\r?\n/);

        for (let i = 0; i < lines.length; i++) {
            for (const typeId of relevantTypeIds) {
                if (isCustomObjectTypeMatch(lines[i], typeId)) {
                    usageMap.get(typeId).push({
                        file: path.relative(repoPath, fileInfo.path),
                        lineNumber: i + 1,
                        cartridge: fileInfo.cartridge
                    });
                }
            }
        }
    }

    return usageMap;
}

// ============================================================================
// REALM USAGE ANALYSIS
// ============================================================================

/**
 * Parse custom-type IDs from a BM metadata backup XML file.
 * Similar to parseSitePreferencesFromMetadata but for custom types.
 *
 * @param {string} xmlFilePath - Absolute path to the metadata backup XML file
 * @returns {Set<string>} Set of custom-type IDs found
 */
export function parseCustomTypesFromMetadata(xmlFilePath) {
    const typeIds = new Set();
    const content = fs.readFileSync(xmlFilePath, 'utf-8');
    const pattern = /<custom-type\s+type-id="([^"]+)"/g;
    let match;

    while ((match = pattern.exec(content)) !== null) {
        typeIds.add(match[1]);
    }

    return typeIds;
}

/**
 * Extract cartridge names from a site.xml file's <custom-cartridges> element.
 * @param {string} filePath - Absolute path to a site.xml file
 * @returns {Set<string>} Set of cartridge names
 * @private
 */
function extractCartridgesFromSiteXml(filePath) {
    const cartridges = new Set();
    const content = fs.readFileSync(filePath, 'utf-8');
    const match = content.match(/<custom-cartridges>([\s\S]*?)<\/custom-cartridges>/);

    if (match) {
        for (const name of match[1].split(':')) {
            const trimmed = name.trim();
            if (trimmed) {
                cartridges.add(trimmed);
            }
        }
    }

    return cartridges;
}

/**
 * Build per-realm cartridge sets by fetching live site data via OCAPI.
 * Falls back to reading site.xml files from the repository if OCAPI fails.
 *
 * @param {string} repoPath - Absolute path to the SFCC repository (used for fallback)
 * @param {string[]} realms - Realm names to build sets for
 * @returns {Promise<{ realmCartridges: Map<string, Set<string>>, realmSites: Map<string, Array<{ id: string, cartridges: string[] }>> }>}
 */
export async function buildRealmCartridgeSets(repoPath, realms) {
    const realmCartridges = new Map();
    const realmSites = new Map();

    for (const realm of realms) {
        const cartridges = new Set();

        try {
            // Primary: fetch live cartridge data from OCAPI
            const sites = await fetchAndTransformSites(realm);

            if (sites && sites.length > 0) {
                realmSites.set(realm, sites.map(s => ({ id: s.id, cartridges: s.cartridges })));
                for (const site of sites) {
                    for (const c of site.cartridges) {
                        cartridges.add(c);
                    }
                }
                console.log(`  ${LOG_PREFIX.INFO} ${realm}: ${cartridges.size} cartridges from OCAPI (${sites.length} site(s))`);
                realmCartridges.set(realm, cartridges);
                continue;
            }
        } catch {
            console.log(`  ${LOG_PREFIX.WARNING} ${realm}: OCAPI unavailable, falling back to repo site.xml`);
        }

        // Fallback: read site.xml files from repo
        const fallbackSites = [];
        let templatePaths;
        try {
            const config = getSandboxConfig(realm);
            templatePaths = [config.siteTemplatesPath];
        } catch {
            realmCartridges.set(realm, cartridges);
            continue;
        }

        for (const templatePath of templatePaths) {
            const sitesDir = path.join(repoPath, templatePath, 'sites');

            if (!fs.existsSync(sitesDir)) {
                continue;
            }

            const siteDirs = fs.readdirSync(sitesDir, { withFileTypes: true })
                .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

            for (const siteDir of siteDirs) {
                const siteXmlPath = path.join(sitesDir, siteDir.name, 'site.xml');

                if (!fs.existsSync(siteXmlPath)) {
                    continue;
                }

                const siteCartridges = extractCartridgesFromSiteXml(siteXmlPath);
                fallbackSites.push({ id: siteDir.name, cartridges: siteCartridges });
                for (const c of siteCartridges) {
                    cartridges.add(c);
                }
            }
        }

        if (fallbackSites.length > 0) {
            realmSites.set(realm, fallbackSites);
        }

        if (cartridges.size > 0) {
            console.log(`  ${LOG_PREFIX.INFO} ${realm}: ${cartridges.size} cartridges from repo site.xml (fallback)`);
        } else {
            console.log(`  ${LOG_PREFIX.WARNING} ${realm}: no cartridge data found`);
        }

        realmCartridges.set(realm, cartridges);
    }

    return { realmCartridges, realmSites };
}

/**
 * Determine which realms use each custom object type based on:
 * 1. Cartridge-to-realm mapping: which realms include the cartridges that reference the CO type
 * 2. Whether the CO type is defined in the realm-specific meta directory
 * 3. Whether the CO type is defined in the BM backup XML for the realm
 *
 * A CO type is considered "used" by a realm if ANY of its referencing cartridges
 * appear in that realm's site cartridge paths. CO types with no code references
 * and no realm-specific presence are classified as unused.
 *
 * @param {Object} params
 * @param {string} params.repoPath - Absolute path to the sibling SFCC repository
 * @param {Set<string>} params.coreTypeIds - CO type IDs found in core meta
 * @param {Map<string, Array>} params.codeUsageMap - Code usage scan results
 * @param {string[]} params.realms - Realm names to check
 * @returns {Promise<{ analysisMap: Map<string, Object>, realmSites: Map<string, Array<{ id: string, cartridges: string[] }>> }>}
 */
export async function analyzeCustomObjectUsageByRealm({ repoPath, coreTypeIds, codeUsageMap, realms }) {
    const analysisMap = new Map();

    // Initialize for all core type IDs
    for (const typeId of coreTypeIds) {
        analysisMap.set(typeId, {
            realms: [],
            codeRefs: codeUsageMap.get(typeId)?.length || 0,
            realmSpecificMeta: [],
            bmRealms: [],
            cartridges: new Set()
        });
    }

    // Collect unique cartridges from code usage
    for (const [typeId, matches] of codeUsageMap) {
        if (!analysisMap.has(typeId)) {
            continue;
        }
        for (const match of matches) {
            if (match.cartridge) {
                analysisMap.get(typeId).cartridges.add(match.cartridge);
            }
        }
    }

    // Build per-realm cartridge sets (OCAPI with repo site.xml fallback)
    const { realmCartridges: perRealmCartridges, realmSites } = await buildRealmCartridgeSets(repoPath, realms);

    // Check each realm's meta directory and BM backup
    for (const realm of realms) {
        let realmMetaDir;
        try {
            const config = getSandboxConfig(realm);
            realmMetaDir = path.join(repoPath, config.siteTemplatesPath, 'meta');
        } catch {
            continue;
        }

        // Check realm-specific meta directory for CO type definitions
        const realmResult = collectCustomTypeIds(realmMetaDir);

        for (const typeId of realmResult.typeIds) {
            if (analysisMap.has(typeId)) {
                analysisMap.get(typeId).realmSpecificMeta.push(realm);
            }
        }

        // Check BM backup XML for this realm
        try {
            const bmFile = findLatestMetadataFile(realm);

            if (bmFile) {
                const bmTypeIds = parseCustomTypesFromMetadata(bmFile);
                for (const typeId of bmTypeIds) {
                    if (analysisMap.has(typeId)) {
                        analysisMap.get(typeId).bmRealms.push(realm);
                    }
                }
            }
        } catch {
            // BM backup not available — skip
        }
    }

    // Determine which realms "use" each CO type using cartridge-to-realm mapping.
    // A realm uses a CO type if ANY of the cartridges referencing that CO type
    // are in the realm's site cartridge path.
    for (const [typeId, analysis] of analysisMap) {
        const activeRealms = new Set();

        if (analysis.cartridges.size > 0) {
            // Map referencing cartridges → realms via site.xml cartridge paths
            for (const realm of realms) {
                const realmCarts = perRealmCartridges.get(realm) || new Set();
                const hasActiveCode = [...analysis.cartridges].some(c => realmCarts.has(c));

                if (hasActiveCode) {
                    activeRealms.add(realm);
                }
            }
        }

        // Also include realms with realm-specific meta or BM presence
        for (const realm of analysis.realmSpecificMeta) {
            activeRealms.add(realm);
        }
        for (const realm of analysis.bmRealms) {
            activeRealms.add(realm);
        }

        if (activeRealms.size > 0) {
            analysis.realms = [...activeRealms].sort();
        } else if (analysis.codeRefs > 0) {
            // Has code refs but couldn't match to any realm's cartridge path.
            // Conservatively assign to all realms.
            analysis.realms = [...realms].sort();
        } else {
            // No code refs, no realm-specific meta, no BM backup → unused
            analysis.realms = [];
        }
    }

    // Convert cartridge Sets to arrays
    for (const analysis of analysisMap.values()) {
        analysis.cartridges = [...analysis.cartridges].sort();
    }

    return { analysisMap, realmSites };
}

/**
 * Classify custom object types into categories for reporting.
 *
 * @param {Map<string, Object>} analysisMap - Output from analyzeCustomObjectUsageByRealm
 * @param {string[]} allRealms - All configured realms
 * @returns {{ unused: string[], singleRealm: Map<string, string>, multiRealm: string[] }}
 *   unused: CO types with no code refs and no realm-specific presence
 *   singleRealm: CO types used in exactly 1 realm (typeId → realm name)
 *   multiRealm: CO types used in 2+ realms (should stay in core)
 */
export function classifyCustomObjectTypes(analysisMap, allRealms) {
    const unused = [];
    const singleRealm = new Map();
    const multiRealm = [];

    for (const [typeId, analysis] of analysisMap) {
        const hasCodeRefs = analysis.codeRefs > 0;
        const realmCount = analysis.realms.length;

        if (!hasCodeRefs && realmCount === allRealms.length) {
            // No code references and present in all realms (core-only) → unused
            unused.push(typeId);
        } else if (realmCount === 1) {
            singleRealm.set(typeId, analysis.realms[0]);
        } else if (realmCount === 0) {
            unused.push(typeId);
        } else if (realmCount >= 2 && realmCount < allRealms.length) {
            // Used in some but not all realms — keep in core
            multiRealm.push(typeId);
        } else {
            // Used in all realms — keep in core
            multiRealm.push(typeId);
        }
    }

    return {
        unused: unused.sort(),
        singleRealm,
        multiRealm: multiRealm.sort()
    };
}

// ============================================================================
// REPORT GENERATION
// ============================================================================

/**
 * Format analysis results as a human-readable report string.
 *
 * @param {Object} params
 * @param {string[]} params.unused - Unused CO type IDs
 * @param {Map<string, string>} params.singleRealm - Single-realm CO types (typeId → realm)
 * @param {string[]} params.multiRealm - Multi-realm CO type IDs
 * @param {Map<string, Object>} params.analysisMap - Full analysis data
 * @param {string} params.repoName - Repository name for the report header
 * @returns {string} Formatted report
 */
/**
 * Find which sites within a realm are affected by a set of cartridges.
 * @param {string[]} typeCartridges - Cartridges that reference the CO type
 * @param {string} realm - Realm name
 * @param {Map<string, Array<{ id: string, cartridges: string[] }>>} realmSites - Site data per realm
 * @returns {string[]} Site IDs that include at least one of the cartridges
 */
function findAffectedSites(typeCartridges, realm, realmSites) {
    const sites = realmSites.get(realm);
    if (!sites || typeCartridges.length === 0) {
        return [];
    }
    const cartridgeSet = new Set(typeCartridges);
    return sites
        .filter(site => site.cartridges.some(c => cartridgeSet.has(c)))
        .map(site => site.id);
}

/**
 * Format a single CO type entry with QA-oriented detail lines.
 * @param {string} typeId - CO type ID
 * @param {Object} info - Analysis map entry
 * @param {Map<string, Array<{ id: string, cartridges: string[] }>>} realmSites - Site data per realm
 * @returns {string[]} Array of formatted lines
 */
function formatTypeDetail(typeId, info, realmSites) {
    const detailLines = [];

    if (!info || info.cartridges.length === 0) {
        return detailLines;
    }

    detailLines.push(`    Cartridges: ${info.cartridges.join(', ')}`);

    for (const realm of info.realms) {
        const affected = findAffectedSites(info.cartridges, realm, realmSites);
        if (affected.length > 0) {
            detailLines.push(`    ${realm} sites: ${affected.join(', ')}`);
        }
    }

    return detailLines;
}

export function formatAnalysisReport({ unused, singleRealm, multiRealm, analysisMap, realmSites, repoName }) {
    const lines = [];
    const separator = '='.repeat(80);
    const hasDetail = realmSites && realmSites.size > 0;

    lines.push(separator);
    lines.push(' CUSTOM OBJECT TYPE ANALYSIS REPORT');
    lines.push(` Repository: ${repoName}`);
    lines.push(` Date: ${new Date().toISOString().slice(0, 10)}`);
    lines.push(separator);
    lines.push('');

    // Summary
    const total = unused.length + singleRealm.size + multiRealm.length;
    lines.push(`Total custom object types in core meta: ${total}`);
    lines.push(`  Unused / obsolete:     ${unused.length}`);
    lines.push(`  Single-realm only:     ${singleRealm.size} (candidates for move)`);
    lines.push(`  Multi-realm / shared:  ${multiRealm.length} (keep in core)`);
    lines.push('');

    // Unused section
    if (unused.length > 0) {
        lines.push('-'.repeat(80));
        lines.push(' UNUSED / OBSOLETE (no code references, no realm-specific data)');
        lines.push('-'.repeat(80));
        for (const typeId of unused) {
            lines.push(`  ${typeId}`);
        }
        lines.push('');
    }

    // Single-realm section
    if (singleRealm.size > 0) {
        lines.push('-'.repeat(80));
        lines.push(' SINGLE-REALM (used in 1 realm only — candidates for move)');
        lines.push('-'.repeat(80));
        for (const [typeId, realm] of singleRealm) {
            const info = analysisMap.get(typeId);
            const refs = info ? `${info.codeRefs} code ref(s)` : '';
            lines.push(`  ${typeId} → ${realm}  [${refs}]`);
            if (hasDetail && info) {
                lines.push(...formatTypeDetail(typeId, info, realmSites));
            }
        }
        lines.push('');
    }

    // Multi-realm section
    if (multiRealm.length > 0) {
        lines.push('-'.repeat(80));
        lines.push(' MULTI-REALM / SHARED (keep in core)');
        lines.push('-'.repeat(80));
        for (const typeId of multiRealm) {
            const info = analysisMap.get(typeId);
            const realms = info ? info.realms.join(', ') : '';
            const refs = info ? `${info.codeRefs} code ref(s)` : '';
            lines.push(`  ${typeId}  [${realms}] [${refs}]`);
            if (hasDetail && info) {
                lines.push(...formatTypeDetail(typeId, info, realmSites));
            }
        }
        lines.push('');
    }

    lines.push(separator);
    return lines.join('\n');
}
