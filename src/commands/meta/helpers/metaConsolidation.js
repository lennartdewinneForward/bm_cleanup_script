import fs from 'fs';
import path from 'path';

import { refreshMetadataBackupForRealm } from '../../../helpers/backupJob.js';
import { getSandboxConfig, getWebdavConfig } from '../../../config/helpers/helpers.js';
import { getRealmMetaDir } from './metaFileCleanup.js';

const SITE_PREFERENCES_TYPE = 'SitePreferences';
const DEFAULT_CORE_THRESHOLD = 2;

// ============================================================================
// XML PARSING UTILITIES
// ============================================================================

/**
 * Extract a <type-extension type-id="..."> block from XML content.
 * @param {string} content - Raw XML string
 * @param {string} typeId - The type-id attribute value to find
 * @returns {string} The full type-extension block
 */
export function extractTypeExtension(content, typeId) {
    const marker = `<type-extension type-id="${typeId}">`;
    const startIndex = content.indexOf(marker);

    if (startIndex === -1) {
        throw new Error(`Missing ${marker}`);
    }

    const rest = content.slice(startIndex);
    const endRelativeIndex = rest.indexOf('</type-extension>');

    if (endRelativeIndex === -1) {
        throw new Error(`Unclosed type-extension for ${typeId}`);
    }

    return rest.slice(0, endRelativeIndex + '</type-extension>'.length);
}

/**
 * Extract a named XML block using a regex.
 * @param {string} content - XML string to search
 * @param {string} tagName - Tag name to extract (e.g. 'custom-attribute-definitions')
 * @returns {string|null} The matched block or null
 */
export function extractBlock(content, tagName) {
    const regex = new RegExp(`<${tagName}[^>]*>[\\s\\S]*?<\\/${tagName}>`);
    const match = content.match(regex);
    return match ? match[0] : null;
}

/**
 * Parse attribute-definition elements into a Map keyed by attribute-id.
 * @param {string} customDefinitionsBlock - The <custom-attribute-definitions> block
 * @returns {Map<string, string>} Map of attributeId to definition XML block
 */
export function parseAttributeDefinitions(customDefinitionsBlock) {
    const result = new Map();
    const matches = customDefinitionsBlock.match(
        /<attribute-definition\b[\s\S]*?<\/attribute-definition>|<attribute-definition\b[^>]*\/>/g
    ) || [];

    for (const block of matches) {
        const idMatch = block.match(/attribute-id="([^"]+)"/);
        if (idMatch) {
            result.set(idMatch[1], block.trim());
        }
    }

    return result;
}

/**
 * Parse attribute-group elements into a Map keyed by group-id.
 * @param {string} groupDefinitionsBlock - The <group-definitions> block
 * @returns {Map<string, {startTag: string, preservedInner: string, attributeIds: Set<string>}>}
 */
export function parseGroupDefinitions(groupDefinitionsBlock) {
    const groups = new Map();
    const groupMatches = groupDefinitionsBlock.match(
        /<attribute-group\b[\s\S]*?<\/attribute-group>/g
    ) || [];

    for (const groupBlock of groupMatches) {
        const startTagMatch = groupBlock.match(/<attribute-group\b[^>]*>/);
        const idMatch = groupBlock.match(/group-id="([^"]+)"/);

        if (!startTagMatch || !idMatch) {
            continue;
        }

        const startTag = startTagMatch[0];
        const groupId = idMatch[1];
        const endTag = '</attribute-group>';
        const inner = groupBlock.slice(startTag.length, groupBlock.lastIndexOf(endTag));
        const attributeMatches = inner.match(
            /<attribute\b[^>]*attribute-id="([^"]+)"[^>]*\/>/g
        ) || [];

        const attributeIds = new Set();
        for (const attributeTag of attributeMatches) {
            const attributeIdMatch = attributeTag.match(/attribute-id="([^"]+)"/);
            if (attributeIdMatch) {
                attributeIds.add(attributeIdMatch[1]);
            }
        }

        const nonAttributeInner = inner
            .replace(/\s*<attribute\b[^>]*\/>(\r?\n)?/g, '\n')
            .trim();

        groups.set(groupId, { startTag, preservedInner: nonAttributeInner, attributeIds });
    }

    return groups;
}

// ============================================================================
// STRING FORMATTING UTILITIES
// ============================================================================

/**
 * Remove leading whitespace common to all non-empty lines.
 * @param {string} block - Multi-line string
 * @returns {string} Dedented string
 */
export function dedent(block) {
    const normalized = block.replace(/\r\n/g, '\n');
    const lines = normalized.split('\n');

    while (lines.length > 0 && lines[0].trim() === '') {
        lines.shift();
    }

    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
    }

    if (lines.length === 0) {
        return '';
    }

    const minIndent = lines
        .filter(line => line.trim() !== '')
        .reduce((min, line) => {
            const leadingSpaces = line.match(/^\s*/)[0].length;
            return Math.min(min, leadingSpaces);
        }, Number.POSITIVE_INFINITY);

    return lines.map(line => line.slice(minIndent)).join('\n');
}

/**
 * Indent every line of a block by the given number of spaces.
 * @param {string} block - Multi-line string
 * @param {number} spaces - Number of spaces to prepend
 * @returns {string} Indented string
 */
export function indentBlock(block, spaces) {
    const pad = ' '.repeat(spaces);
    return block.split('\n').map(line => `${pad}${line}`).join('\n');
}

// ============================================================================
// MERGE ALGORITHM
// ============================================================================

/**
 * Find items that appear in at least `threshold` of the given sets.
 * @param {Set[]} sets - Array of Sets
 * @param {number} threshold - Minimum occurrence count
 * @returns {Set} Items meeting the threshold
 */
export function itemsInAtLeast(sets, threshold) {
    const counts = new Map();
    for (const set of sets) {
        for (const value of set) {
            counts.set(value, (counts.get(value) || 0) + 1);
        }
    }

    const result = new Set();
    for (const [value, count] of counts) {
        if (count >= threshold) {
            result.add(value);
        }
    }

    return result;
}

/**
 * Build a complete XML document from attribute definitions and group assignments.
 * @param {Array} allParsed - Array of parsed file objects with attributeDefinitions and groups
 * @param {Set<string>} attributeIds - Set of attribute IDs to include
 * @param {Set<string>} groupPairs - Set of "groupId|||attributeId" pairs
 * @returns {string} Complete XML document string
 */
export function buildOutputXml(allParsed, attributeIds, groupPairs) {
    const sortedAttributeIds = Array.from(attributeIds).sort((a, b) => a.localeCompare(b));

    const definitionsXml = sortedAttributeIds
        .map(attributeId => {
            const source = allParsed.find(p => p.attributeDefinitions.has(attributeId));
            return indentBlock(dedent(source.attributeDefinitions.get(attributeId)), 12);
        })
        .join('\n');

    const groupToAttributes = new Map();
    for (const pair of groupPairs) {
        const [groupId, attributeId] = pair.split('|||');
        if (!groupToAttributes.has(groupId)) {
            groupToAttributes.set(groupId, []);
        }
        groupToAttributes.get(groupId).push(attributeId);
    }

    const sortedGroupIds = Array.from(groupToAttributes.keys())
        .sort((a, b) => a.localeCompare(b));
    const groupBlocks = [];

    for (const groupId of sortedGroupIds) {
        const groupData = allParsed.reduce(
            (found, p) => found || p.groups.get(groupId), null
        );

        if (!groupData) {
            continue;
        }

        const lines = [];
        lines.push(groupData.startTag);

        if (groupData.preservedInner) {
            lines.push(indentBlock(dedent(groupData.preservedInner), 4));
        }

        const attrs = groupToAttributes.get(groupId)
            .sort((a, b) => a.localeCompare(b));
        for (const attributeId of attrs) {
            lines.push(`    <attribute attribute-id="${attributeId}"/>`);
        }

        lines.push('</attribute-group>');
        groupBlocks.push(indentBlock(lines.join('\n'), 12));
    }

    const groupDefinitionsXml = groupBlocks.join('\n');

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<metadata xmlns="http://www.demandware.com/xml/impex/metadata/2006-10-31">',
        '    <type-extension type-id="SitePreferences">',
        '        <custom-attribute-definitions>',
        definitionsXml,
        '        </custom-attribute-definitions>',
        '        <group-definitions>',
        groupDefinitionsXml,
        '        </group-definitions>',
        '    </type-extension>',
        '</metadata>',
        ''
    ].join('\n');
}

/**
 * Parse a single realm's meta XML content into a structured object.
 * @param {string} content - Raw XML file content
 * @param {string} realm - Realm name for identification
 * @returns {{ realm: string, attributeDefinitions: Map, groups: Map }}
 */
export function parseRealmMetaXml(content, realm) {
    const sitePreferences = extractTypeExtension(content, SITE_PREFERENCES_TYPE);
    const customDefinitionsBlock = extractBlock(sitePreferences, 'custom-attribute-definitions');
    const groupDefinitionsBlock = extractBlock(sitePreferences, 'group-definitions');

    if (!customDefinitionsBlock) {
        throw new Error(`${realm}: missing custom-attribute-definitions for SitePreferences`);
    }

    if (!groupDefinitionsBlock) {
        throw new Error(`${realm}: missing group-definitions for SitePreferences`);
    }

    return {
        realm,
        attributeDefinitions: parseAttributeDefinitions(customDefinitionsBlock),
        groups: parseGroupDefinitions(groupDefinitionsBlock)
    };
}

/**
 * Merge multiple parsed realm meta files into core + per-region outputs.
 *
 * Core attributes are those present in at least `coreThreshold` files.
 * Per-region attributes are unique to a single region (not in core).
 *
 * @param {Object} options
 * @param {Array} options.parsedFiles - Array of parseRealmMetaXml results
 * @param {number} [options.coreThreshold=2] - Min files for an attribute to be "core"
 * @returns {{ coreXml: string, coreAttributeCount: number, coreGroupPairCount: number,
 *             regionOutputs: Map<string, { xml: string, attributeCount: number, groupPairCount: number }> }}
 */
export function mergeMetaFiles({ parsedFiles, coreThreshold = DEFAULT_CORE_THRESHOLD }) {
    const coreAttributeIds = itemsInAtLeast(
        parsedFiles.map(entry => new Set(entry.attributeDefinitions.keys())),
        coreThreshold
    );

    const coreAssignmentSets = parsedFiles.map(entry => {
        const pairs = new Set();
        for (const [groupId, groupData] of entry.groups.entries()) {
            for (const attributeId of groupData.attributeIds) {
                if (coreAttributeIds.has(attributeId)) {
                    pairs.add(`${groupId}|||${attributeId}`);
                }
            }
        }
        return pairs;
    });

    const coreGroupPairs = itemsInAtLeast(coreAssignmentSets, coreThreshold);
    const coreXml = buildOutputXml(parsedFiles, coreAttributeIds, coreGroupPairs);

    const regionOutputs = new Map();

    for (const entry of parsedFiles) {
        const uniqueAttributeIds = new Set();
        for (const attrId of entry.attributeDefinitions.keys()) {
            if (!coreAttributeIds.has(attrId)) {
                uniqueAttributeIds.add(attrId);
            }
        }

        // Identify groups that will appear in the regional file (have at least one unique attr)
        const regionalGroupIds = new Set();
        for (const [groupId, groupData] of entry.groups.entries()) {
            for (const attributeId of groupData.attributeIds) {
                if (uniqueAttributeIds.has(attributeId)) {
                    regionalGroupIds.add(groupId);
                    break;
                }
            }
        }

        // For groups in the regional file, include ALL attribute assignments (core + unique)
        // so the replace import does not strip core attributes from those groups.
        const regionalGroupPairs = new Set();
        for (const groupId of regionalGroupIds) {
            const groupData = entry.groups.get(groupId);
            for (const attributeId of groupData.attributeIds) {
                regionalGroupPairs.add(`${groupId}|||${attributeId}`);
            }
        }

        if (uniqueAttributeIds.size > 0) {
            regionOutputs.set(entry.realm, {
                xml: buildOutputXml([entry], uniqueAttributeIds, regionalGroupPairs),
                attributeCount: uniqueAttributeIds.size,
                groupPairCount: regionalGroupPairs.size
            });
        }
        // TODO: If a realm has 0 unique attributes, it currently gets no regional file.
        // A future ticket should ensure every realm always gets a regional file during
        // consolidation so the replace import always has a complete group definition set.
    }

    return {
        coreXml,
        coreAttributeCount: coreAttributeIds.size,
        coreGroupPairCount: coreGroupPairs.size,
        regionOutputs
    };
}

// ============================================================================
// FILE OPERATIONS
// ============================================================================

/**
 * Build the single-file meta filename for a realm (no date, no "backup" suffix).
 * @param {string} realmIdentifier - Hostname or realm name
 * @returns {string} Filename like "<hostname>_meta_data.xml"
 */
export function buildConsolidatedMetaFileName(realmIdentifier) {
    const safe = String(realmIdentifier || 'unknown').replace(/[^A-Za-z0-9.-]/g, '-');
    return `${safe}_meta_data.xml`;
}

/**
 * Remove all XML files from a directory except the specified file(s) to keep.
 * @param {string} dirPath - Absolute path to the meta directory
 * @param {string|string[]} keepFileNames - Filename(s) to preserve
 * @returns {{ removed: string[], kept: string[] }} Summary of removals
 */
export function removeOtherXmlFiles(dirPath, keepFileNames) {
    const keepSet = new Set(
        Array.isArray(keepFileNames) ? keepFileNames : [keepFileNames]
    );
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    const removed = [];

    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }

        const isXml = entry.name.toLowerCase().endsWith('.xml');
        if (isXml && !keepSet.has(entry.name)) {
            fs.unlinkSync(path.join(dirPath, entry.name));
            removed.push(entry.name);
        }
    }

    return { removed, kept: Array.from(keepSet) };
}

// ============================================================================
// CONSOLIDATION ORCHESTRATION
// ============================================================================

/**
 * Download a fresh meta backup for a single realm.
 * @param {Object} options
 * @param {string} options.realm - Realm name
 * @param {string} options.instanceType - Instance type
 * @returns {Promise<{ok: boolean, realm: string, filePath?: string, reason?: string}>}
 */
export async function downloadRealmMetaBackup({ realm, instanceType }) {
    console.log(`  ${realm}: triggering backup job for fresh metadata...`);

    const result = await refreshMetadataBackupForRealm(
        realm, instanceType, { forceJobExecution: true }
    );

    if (!result.ok) {
        return { ok: false, realm, reason: result.reason || 'Backup job failed' };
    }

    return { ok: true, realm, filePath: result.filePath };
}

/**
 * Consolidate meta files for multiple realms using the merge algorithm.
 *
 * Downloads fresh backups for all realms, parses them, merges core vs
 * per-region attributes, and writes the output files to each realm's
 * meta directory. Core attributes (shared across >= coreThreshold realms)
 * go into meta.core.xml; region-unique attributes go into meta.<realm>.xml.
 *
 * When fewer than 2 realms succeed downloading, falls back to single-file copy.
 *
 * @param {Object} options
 * @param {string} options.repoPath - Absolute path to the sibling repository
 * @param {string[]} options.realmList - Realm names to consolidate
 * @param {string} options.instanceType - Instance type
 * @param {number} [options.coreThreshold=2] - Min realms for an attribute to be "core"
 * @returns {Promise<{results: Array, successCount: number, failCount: number,
 *           coreAttributeCount: number}>}
 */
export async function consolidateMetaFiles({ repoPath, realmList, instanceType,
    coreThreshold = DEFAULT_CORE_THRESHOLD }) {
    const results = [];
    const downloads = [];

    // -- Phase 1: Download fresh backups for all realms --
    for (const realm of realmList) {
        const realmConfig = getSandboxConfig(realm);
        if (!realmConfig) {
            results.push({ ok: false, realm, reason: `No config found for realm ${realm}` });
            continue;
        }

        const metaDir = getRealmMetaDir(repoPath, realmConfig.siteTemplatesPath);
        if (!fs.existsSync(metaDir)) {
            results.push({ ok: false, realm, reason: `Meta directory not found: ${metaDir}` });
            continue;
        }

        const download = await downloadRealmMetaBackup({ realm, instanceType });
        if (!download.ok) {
            results.push({ ok: false, realm, reason: download.reason });
            continue;
        }

        downloads.push({ realm, filePath: download.filePath, realmConfig, metaDir });
    }

    // If fewer than 2 successful downloads, fall back to single-file copy
    if (downloads.length < 2) {
        for (const dl of downloads) {
            const webdavConfig = getWebdavConfig(dl.realm);
            const realmIdentifier = webdavConfig.name || webdavConfig.hostname;
            const consolidatedName = buildConsolidatedMetaFileName(realmIdentifier);
            const destinationPath = path.join(dl.metaDir, consolidatedName);

            try {
                fs.copyFileSync(dl.filePath, destinationPath);
                const { removed } = removeOtherXmlFiles(dl.metaDir, consolidatedName);
                console.log(
                    `  ${dl.realm}: single-realm copy to ${consolidatedName}`
                    + (removed.length > 0 ? ` (removed ${removed.length} old file(s))` : '')
                );
                results.push({
                    ok: true, realm: dl.realm,
                    metaFiles: [consolidatedName], removed
                });
            } catch (copyError) {
                results.push({
                    ok: false, realm: dl.realm,
                    reason: `Failed to copy: ${copyError.message}`
                });
            }
        }

        const successCount = results.filter(r => r.ok).length;
        const failCount = results.filter(r => !r.ok).length;
        return { results, successCount, failCount, coreAttributeCount: 0 };
    }

    // -- Phase 2: Parse all downloaded files --
    const parsedFiles = [];
    for (const dl of downloads) {
        try {
            const content = fs.readFileSync(dl.filePath, 'utf-8');
            const parsed = parseRealmMetaXml(content, dl.realm);
            parsedFiles.push({ ...parsed, metaDir: dl.metaDir });
        } catch (parseError) {
            results.push({
                ok: false, realm: dl.realm,
                reason: `Failed to parse meta XML: ${parseError.message}`
            });
        }
    }

    if (parsedFiles.length < 2) {
        // Not enough parseable files for a merge; copy remaining as single file
        for (const pf of parsedFiles) {
            const dl = downloads.find(d => d.realm === pf.realm);
            const webdavConfig = getWebdavConfig(pf.realm);
            const realmIdentifier = webdavConfig.name || webdavConfig.hostname;
            const consolidatedName = buildConsolidatedMetaFileName(realmIdentifier);

            try {
                fs.copyFileSync(dl.filePath, path.join(pf.metaDir, consolidatedName));
                const { removed } = removeOtherXmlFiles(pf.metaDir, consolidatedName);
                results.push({
                    ok: true, realm: pf.realm,
                    metaFiles: [consolidatedName], removed
                });
            } catch (copyError) {
                results.push({
                    ok: false, realm: pf.realm,
                    reason: `Failed to copy: ${copyError.message}`
                });
            }
        }

        const successCount = results.filter(r => r.ok).length;
        const failCount = results.filter(r => !r.ok).length;
        return { results, successCount, failCount, coreAttributeCount: 0 };
    }

    // -- Phase 3: Merge core + per-region --
    const effectiveThreshold = Math.min(coreThreshold, parsedFiles.length);
    const merged = mergeMetaFiles({ parsedFiles, coreThreshold: effectiveThreshold });

    console.log(
        `  Merged ${parsedFiles.length} realms:`
        + ` ${merged.coreAttributeCount} core attributes,`
        + ` ${merged.coreGroupPairCount} core group assignments.`
    );

    // -- Phase 4: Write files to each realm's meta directory --
    const coreFileName = 'meta.core.xml';

    for (const pf of parsedFiles) {
        const filesToKeep = [coreFileName];
        const writtenFiles = [];

        try {
            // Write core file
            fs.writeFileSync(path.join(pf.metaDir, coreFileName), merged.coreXml, 'utf-8');
            writtenFiles.push(coreFileName);

            // Write region-specific file if realm has unique attributes
            const regionOutput = merged.regionOutputs.get(pf.realm);
            if (regionOutput) {
                const regionFileName = `meta.${pf.realm}.xml`;
                fs.writeFileSync(
                    path.join(pf.metaDir, regionFileName), regionOutput.xml, 'utf-8'
                );
                filesToKeep.push(regionFileName);
                writtenFiles.push(regionFileName);
                console.log(
                    `  ${pf.realm}: ${regionOutput.attributeCount} unique attributes`
                    + ` -> ${regionFileName}`
                );
            } else {
                console.log(`  ${pf.realm}: 0 unique attributes -- core only.`);
            }

            // Remove old XML files
            const { removed } = removeOtherXmlFiles(pf.metaDir, filesToKeep);

            results.push({
                ok: true, realm: pf.realm,
                metaFiles: writtenFiles, removed
            });
        } catch (writeError) {
            results.push({
                ok: false, realm: pf.realm,
                reason: `Failed to write meta files: ${writeError.message}`
            });
        }
    }

    const successCount = results.filter(r => r.ok).length;
    const failCount = results.filter(r => !r.ok).length;

    return {
        results, successCount, failCount,
        coreAttributeCount: merged.coreAttributeCount
    };
}

// ============================================================================
// FORMATTING
// ============================================================================

/**
 * Format consolidation results for console output.
 * @param {Object} consolidation - Return value from consolidateMetaFiles
 * @param {Array} consolidation.results - Per-realm results
 * @param {number} consolidation.successCount - Count of successful consolidations
 * @param {number} consolidation.failCount - Count of failed consolidations
 * @param {number} [consolidation.coreAttributeCount] - Number of shared core attributes
 * @returns {string} Formatted output string
 */
export function formatConsolidationResults({ results, successCount, failCount,
    coreAttributeCount = 0 }) {
    const lines = ['\n  Meta File Consolidation Summary:'];

    if (coreAttributeCount > 0) {
        lines.push(`    Core attributes (shared): ${coreAttributeCount}`);
    }

    for (const r of results) {
        if (r.ok) {
            const removedCount = r.removed ? r.removed.length : 0;
            const fileList = Array.isArray(r.metaFiles)
                ? r.metaFiles.join(', ')
                : (r.metaFile || 'unknown');
            lines.push(`    + ${r.realm}: ${fileList} (${removedCount} old file(s) removed)`);
        } else {
            lines.push(`    x ${r.realm}: ${r.reason}`);
        }
    }

    lines.push(`\n  Total: ${successCount} succeeded, ${failCount} failed`);
    return lines.join('\n');
}
