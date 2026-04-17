/**
 * Custom Object Mover
 *
 * Moves custom-type definitions from the core site_template meta directory
 * to realm-specific meta directories. Used when a CO type is determined to
 * be used in only one realm.
 *
 * @module customObjectMover
 */

import fs from 'fs';
import path from 'path';
import { LOG_PREFIX } from '../../../config/constants.js';
import { logError } from '../../../scripts/loggingScript/log.js';
import {
    getSandboxConfig,
    getAvailableRealms,
    getCoreSiteTemplatePath,
    getCoreSiteDemoPath
} from '../../../config/helpers/helpers.js';
import {
    extractCustomTypeBlock,
    listCustomTypeMetaFiles,
    extractCustomTypeIdsFromFile
} from './customObjectScanner.js';
import { searchCustomObjects } from '../../../api/api.js';

// ============================================================================
// DIRECTORY DISCOVERY
// ============================================================================

/**
 * Collect all custom-objects directories across core and all realm paths,
 * including per-site subdirectories (e.g. sites/GB/custom-objects/).
 * @param {string} repoPath - Absolute path to the sibling repository
 * @returns {string[]} All existing custom-objects directory paths
 * @private
 */
function collectAllCustomObjectDirs(repoPath) {
    const dirs = new Set();
    const basePaths = new Set();

    // Core paths
    basePaths.add(path.join(repoPath, getCoreSiteTemplatePath()));
    basePaths.add(path.join(repoPath, getCoreSiteDemoPath()));

    // Realm-specific paths
    for (const realmName of getAvailableRealms()) {
        try {
            const realmConfig = getSandboxConfig(realmName);
            if (realmConfig.siteTemplatesPath) {
                basePaths.add(path.join(repoPath, realmConfig.siteTemplatesPath));
            }
            if (realmConfig.siteDemoPath) {
                basePaths.add(path.join(repoPath, realmConfig.siteDemoPath));
            }
        } catch {
            // Realm not found — skip
        }
    }

    for (const basePath of basePaths) {
        // Top-level custom-objects/
        const topLevel = path.join(basePath, 'custom-objects');
        if (fs.existsSync(topLevel)) {
            dirs.add(topLevel);
        }

        // Per-site: sites/*/custom-objects/
        const sitesDir = path.join(basePath, 'sites');
        if (fs.existsSync(sitesDir)) {
            try {
                const entries = fs.readdirSync(sitesDir, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.isDirectory()) {
                        const siteCoDir = path.join(sitesDir, entry.name, 'custom-objects');
                        if (fs.existsSync(siteCoDir)) {
                            dirs.add(siteCoDir);
                        }
                    }
                }
            } catch {
                // Not readable — skip
            }
        }
    }

    return [...dirs];
}

// ============================================================================
// XML MANIPULATION
// ============================================================================

/**
 * Remove a custom-type block from XML content.
 * @param {string} xmlContent - Raw XML string
 * @param {string} typeId - Custom object type ID to remove
 * @returns {{ content: string, removed: boolean }}
 * @private
 */
function removeCustomTypeBlock(xmlContent, typeId) {
    const escaped = typeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `\\n?[ \\t]*<custom-type\\s+type-id="${escaped}"[\\s\\S]*?</custom-type>[ \\t]*\\n?`,
        'g'
    );

    let result = xmlContent.replace(pattern, '\n');
    // Collapse any resulting consecutive blank lines into a single newline
    result = result.replace(/\n{3,}/g, '\n\n');
    return { content: result, removed: result !== xmlContent };
}

/**
 * Check if a meta file still has any custom-type definitions.
 * @param {string} xmlContent - Raw XML string
 * @returns {boolean} True if no custom types remain
 * @private
 */
function isCustomTypeFileEmpty(xmlContent) {
    return !/<custom-type\s+type-id="/.test(xmlContent);
}

/**
 * Check if a meta file has no meaningful content (no custom-types, no type-extensions).
 * @param {string} xmlContent - Raw XML string
 * @returns {boolean} True if file is effectively empty
 * @private
 */
function isMetaFileEffectivelyEmpty(xmlContent) {
    const hasCustomTypes = /<custom-type\s/.test(xmlContent);
    const hasTypeExtensions = /<type-extension\s/.test(xmlContent);
    return !hasCustomTypes && !hasTypeExtensions;
}

// ============================================================================
// CUSTOM OBJECT INSTANCE FILE DISCOVERY
// ============================================================================

/**
 * Extract the type-id from a custom-object instance XML file.
 * @param {string} filePath - Path to the XML file
 * @returns {string|null} The type-id or null if not found
 * @private
 */
function extractInstanceTypeId(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const match = content.match(/type-id="([^"]+)"/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/**
 * Find CO instance files in a custom-objects directory that match a given type ID.
 * @param {string} customObjectsDir - Path to a custom-objects/ directory
 * @param {string} typeId - The CO type ID to match
 * @returns {string[]} Matching file paths
 * @private
 */
function findInstanceFilesForType(customObjectsDir, typeId) {
    if (!fs.existsSync(customObjectsDir)) {
        return [];
    }

    const matches = [];
    try {
        const files = fs.readdirSync(customObjectsDir)
            .filter(f => f.endsWith('.xml'));

        for (const file of files) {
            const filePath = path.join(customObjectsDir, file);
            const fileTypeId = extractInstanceTypeId(filePath);
            if (fileTypeId === typeId) {
                matches.push(filePath);
            }
        }
    } catch {
        // Directory not readable — skip
    }

    return matches;
}

// ============================================================================
// MOVE PLAN
// ============================================================================

/**
 * @typedef {Object} MoveAction
 * @property {'move'|'move-instances'|'skip'} type - Action type
 * @property {string} typeId - Custom object type ID
 * @property {string} sourceFile - Source meta/instance file path
 * @property {string} targetDir - Target realm meta or custom-objects directory
 * @property {string} targetRealm - Target realm name
 * @property {string} [reason] - Explanation
 */

/**
 * @typedef {Object} MovePlan
 * @property {MoveAction[]} actions - Ordered list of move actions
 * @property {string[]} warnings - Non-fatal issues found during planning
 * @property {string[]} skipped - Type IDs that could not be moved
 */

/**
 * Build a plan for moving custom-type definitions from core to realm-specific folders.
 *
 * @param {Object} params
 * @param {string} params.repoPath - Absolute path to the sibling repository
 * @param {Map<string, string>} params.singleRealmMap - typeId → target realm name
 * @returns {MovePlan}
 */
export function buildMovePlan({ repoPath, singleRealmMap }) {
    const actions = [];
    const warnings = [];
    const skipped = [];

    const coreMetaDir = path.join(repoPath, getCoreSiteTemplatePath(), 'meta');

    for (const [typeId, targetRealm] of singleRealmMap) {
        // Find which core meta file contains this CO type
        const coreFiles = listCustomTypeMetaFiles(coreMetaDir);
        let sourceFile = null;

        for (const filePath of coreFiles) {
            const ids = extractCustomTypeIdsFromFile(filePath);
            if (ids.has(typeId)) {
                sourceFile = filePath;
                break;
            }
        }

        if (!sourceFile) {
            skipped.push(typeId);
            warnings.push(`${typeId}: not found in core meta directory`);
            continue;
        }

        // Determine target realm meta directory
        let targetDir;
        let realmConfig;
        try {
            realmConfig = getSandboxConfig(targetRealm);
            targetDir = path.join(repoPath, realmConfig.siteTemplatesPath, 'meta');
        } catch {
            skipped.push(typeId);
            warnings.push(`${typeId}: realm ${targetRealm} not found in config`);
            continue;
        }

        // Check if the target realm already has this CO type
        const targetFiles = listCustomTypeMetaFiles(targetDir);
        let alreadyExists = false;

        for (const filePath of targetFiles) {
            const ids = extractCustomTypeIdsFromFile(filePath);
            if (ids.has(typeId)) {
                alreadyExists = true;
                break;
            }
        }

        if (alreadyExists) {
            skipped.push(typeId);
            warnings.push(`${typeId}: already exists in ${targetRealm} meta — skipping`);
            continue;
        }

        actions.push({
            type: 'move',
            typeId,
            sourceFile,
            targetDir,
            targetRealm,
            reason: `Move definition from core to ${targetRealm}`
        });

        // Also find CO instance files in core custom-objects/
        const coreInstancesDir = path.join(repoPath, getCoreSiteTemplatePath(), 'custom-objects');
        const instanceFiles = findInstanceFilesForType(coreInstancesDir, typeId);

        for (const instFile of instanceFiles) {
            const targetInstancesDir = path.join(
                repoPath, realmConfig.siteTemplatesPath, 'custom-objects'
            );

            actions.push({
                type: 'move-instances',
                typeId,
                sourceFile: instFile,
                targetDir: targetInstancesDir,
                targetRealm,
                reason: `Move instances from core to ${targetRealm}`
            });
        }

        // Also find CO instance files in core site_demo custom-objects/
        const coreDemoDir = path.join(repoPath, getCoreSiteDemoPath(), 'custom-objects');
        const demoInstanceFiles = findInstanceFilesForType(coreDemoDir, typeId);
        const realmDemoPath = realmConfig.siteDemoPath;

        if (demoInstanceFiles.length > 0 && realmDemoPath) {
            for (const instFile of demoInstanceFiles) {
                const targetDemoDir = path.join(repoPath, realmDemoPath, 'custom-objects');

                actions.push({
                    type: 'move-instances',
                    typeId,
                    sourceFile: instFile,
                    targetDir: targetDemoDir,
                    targetRealm,
                    reason: `Move demo instances from core to ${targetRealm}`
                });
            }
        } else if (demoInstanceFiles.length > 0 && !realmDemoPath) {
            warnings.push(
                `${typeId}: found demo instance files but no siteDemoPath configured for ${targetRealm}`
            );
        }
    }

    return { actions, warnings, skipped };
}

/**
 * Execute a move plan: copy CO type blocks to realm-specific files, remove from core.
 * Also moves CO instance files when the plan includes 'move-instances' actions.
 *
 * @param {MovePlan} plan - The move plan to execute
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - If true, only log what would happen
 * @returns {{ moved: string[], errors: Array<{ typeId: string, error: Error }>, filesModified: string[], filesCreated: string[] }}
 */
export function executeMovePlan(plan, { dryRun = false } = {}) {
    const moved = [];
    const errors = [];
    const filesModified = new Set();
    const filesCreated = new Set();
    const prefix = dryRun ? '[DRY-RUN] ' : '';

    const metaActions = plan.actions.filter(a => a.type === 'move');
    const instanceActions = plan.actions.filter(a => a.type === 'move-instances');

    // Group meta actions by source file for efficient removal
    const metaActionsBySource = new Map();
    for (const action of metaActions) {
        if (!metaActionsBySource.has(action.sourceFile)) {
            metaActionsBySource.set(action.sourceFile, []);
        }
        metaActionsBySource.get(action.sourceFile).push(action);
    }

    // Build a set of source files where ALL types go to the same target dir.
    // These files can be copied as-is instead of extracting individual blocks.
    const wholeCopyFiles = new Set();
    for (const [sourceFile, fileActions] of metaActionsBySource) {
        const allIds = extractCustomTypeIdsFromFile(sourceFile);
        const allSameTarget = fileActions.length === allIds.size
            && new Set(fileActions.map(a => a.targetDir)).size === 1;
        if (allSameTarget) {
            wholeCopyFiles.add(sourceFile);
        }
    }

    // Phase 1: Copy CO type definition blocks to target realm meta files
    // Track files already whole-copied so subsequent actions on the same file skip.
    const wholeCopied = new Set();

    for (const action of metaActions) {
        try {
            const targetFile = path.join(action.targetDir, path.basename(action.sourceFile));

            console.log(
                `${prefix}${LOG_PREFIX.INFO} MOVE: ${action.typeId}`
                + ` → ${action.targetRealm} (${path.basename(targetFile)})`
            );

            if (!dryRun) {
                // Ensure target directory exists
                if (!fs.existsSync(action.targetDir)) {
                    fs.mkdirSync(action.targetDir, { recursive: true });
                }

                if (wholeCopyFiles.has(action.sourceFile) && !wholeCopied.has(action.sourceFile)) {
                    // All types from this file go to the same target — copy as-is
                    fs.copyFileSync(action.sourceFile, targetFile);
                    filesCreated.add(targetFile);
                    wholeCopied.add(action.sourceFile);
                } else if (wholeCopied.has(action.sourceFile)) {
                    // Already whole-copied this file — nothing to do for this type
                } else if (fs.existsSync(targetFile)) {
                    // Append the custom-type block before the closing </metadata> tag
                    const sourceContent = fs.readFileSync(action.sourceFile, 'utf-8');
                    const block = extractCustomTypeBlock(sourceContent, action.typeId);
                    if (!block) {
                        logError(`Could not extract custom-type block for ${action.typeId}`);
                        errors.push({ typeId: action.typeId, error: new Error('Block extraction failed') });
                        continue;
                    }
                    appendCustomTypeToFile(targetFile, block);
                } else {
                    // Multiple types in source going to different targets — extract and create
                    const sourceContent = fs.readFileSync(action.sourceFile, 'utf-8');
                    const block = extractCustomTypeBlock(sourceContent, action.typeId);
                    if (!block) {
                        logError(`Could not extract custom-type block for ${action.typeId}`);
                        errors.push({ typeId: action.typeId, error: new Error('Block extraction failed') });
                        continue;
                    }
                    createMetaFileWithCustomType(targetFile, sourceContent, block, action.typeId);
                    filesCreated.add(targetFile);
                }

                filesModified.add(targetFile);
            }

            moved.push(action.typeId);
        } catch (error) {
            logError(`Failed to move ${action.typeId}: ${error.message}`);
            errors.push({ typeId: action.typeId, error });
        }
    }

    // Phase 2: Remove moved CO type definitions from core meta files
    for (const [sourceFile, fileActions] of metaActionsBySource) {
        const movedTypeIds = fileActions
            .filter(a => moved.includes(a.typeId))
            .map(a => a.typeId);

        if (movedTypeIds.length === 0) {
            continue;
        }

        try {
            let content = fs.readFileSync(sourceFile, 'utf-8');

            for (const typeId of movedTypeIds) {
                const result = removeCustomTypeBlock(content, typeId);
                if (result.removed) {
                    content = result.content;
                    console.log(
                        `${prefix}${LOG_PREFIX.INFO} REMOVE: ${typeId}`
                        + ` from ${path.basename(sourceFile)} [CORE]`
                    );
                }
            }

            if (!dryRun) {
                if (isMetaFileEffectivelyEmpty(content)) {
                    fs.unlinkSync(sourceFile);
                    console.log(
                        `${prefix}${LOG_PREFIX.INFO} DELETE: ${path.basename(sourceFile)}`
                        + ' — no definitions remaining'
                    );
                } else {
                    fs.writeFileSync(sourceFile, content, 'utf-8');
                }
                filesModified.add(sourceFile);
            }
        } catch (error) {
            logError(`Failed to clean source file ${sourceFile}: ${error.message}`);
        }
    }

    // Phase 3: Move CO instance files from core to realm-specific custom-objects/
    for (const action of instanceActions) {
        // Only move instances if the definition was successfully moved
        if (!moved.includes(action.typeId)) {
            continue;
        }

        try {
            const targetFile = path.join(action.targetDir, path.basename(action.sourceFile));

            console.log(
                `${prefix}${LOG_PREFIX.INFO} MOVE INSTANCES: ${path.basename(action.sourceFile)}`
                + ` → ${action.targetRealm}/custom-objects/`
            );

            if (!dryRun) {
                if (!fs.existsSync(action.targetDir)) {
                    fs.mkdirSync(action.targetDir, { recursive: true });
                }

                // Copy file to target
                fs.copyFileSync(action.sourceFile, targetFile);
                filesCreated.add(targetFile);

                // Remove from core
                fs.unlinkSync(action.sourceFile);
                filesModified.add(action.sourceFile);
            }
        } catch (error) {
            logError(`Failed to move instance file ${path.basename(action.sourceFile)}: ${error.message}`);
            errors.push({ typeId: action.typeId, error });
        }
    }

    return {
        moved,
        errors,
        filesModified: [...filesModified],
        filesCreated: [...filesCreated]
    };
}

// ============================================================================
// FILE CREATION HELPERS
// ============================================================================

/**
 * Append a custom-type block to an existing meta XML file.
 * Inserts before the closing `</metadata>` tag.
 *
 * @param {string} filePath - File to append to
 * @param {string} block - Custom-type XML block
 * @private
 */
function appendCustomTypeToFile(filePath, block) {
    let content = fs.readFileSync(filePath, 'utf-8');

    const closingTag = '</metadata>';
    const closingIndex = content.lastIndexOf(closingTag);

    if (closingIndex === -1) {
        logError(`No closing </metadata> tag found in ${filePath}`);
        return;
    }

    const before = content.slice(0, closingIndex);
    const after = content.slice(closingIndex);

    // Preserve the block's original indentation
    content = before + '\n' + block + '\n\n' + after;
    fs.writeFileSync(filePath, content, 'utf-8');
}

/**
 * Create a new meta XML file containing a single custom-type block.
 * Copies the XML declaration and metadata wrapper from the source file.
 *
 * @param {string} targetFile - Target file path
 * @param {string} sourceContent - Content of the source file (for XML header)
 * @param {string} block - Custom-type XML block to include
 * @param {string} typeId - Type ID for identification
 * @private
 */
function createMetaFileWithCustomType(targetFile, sourceContent, block, typeId) {
    // Extract XML declaration and metadata opening tag from source
    const xmlDeclMatch = sourceContent.match(/<\?xml[^?]*\?>/);
    const xmlDecl = xmlDeclMatch ? xmlDeclMatch[0] : '<?xml version="1.0" encoding="UTF-8"?>';

    const metadataOpenMatch = sourceContent.match(/<metadata\s[^>]*>/);
    const metadataOpen = metadataOpenMatch
        ? metadataOpenMatch[0]
        : '<metadata xmlns="http://www.demandware.com/xml/impex/metadata/2006-10-31">';

    // Preserve the block's original indentation
    const content = [
        xmlDecl,
        metadataOpen,
        block,
        '</metadata>'
    ].join('\n');

    fs.writeFileSync(targetFile, content, 'utf-8');
}

// ============================================================================
// REPORT FORMATTING
// ============================================================================

/**
 * Format a move plan as a human-readable summary.
 * @param {MovePlan} plan - The move plan
 * @returns {string} Formatted plan summary
 */
export function formatMovePlan(plan) {
    const lines = [];

    const metaActions = plan.actions.filter(a => a.type === 'move');
    const instanceActions = plan.actions.filter(a => a.type === 'move-instances');

    if (plan.actions.length === 0 && plan.skipped.length === 0) {
        return '  No custom object types to move.\n';
    }

    if (metaActions.length > 0) {
        lines.push(`  ${metaActions.length} type definition(s) to move:\n`);
        for (const action of metaActions) {
            lines.push(`    ${action.typeId} → ${action.targetRealm}`);
            lines.push(`      Source: ${path.basename(action.sourceFile)}`);

            // Show associated instance files
            const relatedInstances = instanceActions.filter(a => a.typeId === action.typeId);
            for (const inst of relatedInstances) {
                lines.push(`      + instances: ${path.basename(inst.sourceFile)} → ${action.targetRealm}/custom-objects/`);
            }
        }
        lines.push('');
    }

    if (plan.warnings.length > 0) {
        lines.push('  Warnings:');
        for (const warning of plan.warnings) {
            lines.push(`    ${LOG_PREFIX.WARNING} ${warning}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Format execution results as a human-readable summary.
 * @param {Object} results - Results from executeMovePlan
 * @returns {string} Formatted results summary
 */
export function formatMoveResults(results) {
    const lines = [];

    lines.push(`  Moved: ${results.moved.length} custom object type(s)`);

    if (results.filesCreated.length > 0) {
        lines.push(`  Files created: ${results.filesCreated.length}`);
    }

    if (results.filesModified.length > 0) {
        lines.push(`  Files modified: ${results.filesModified.length}`);
    }

    if (results.errors.length > 0) {
        lines.push(`  Errors: ${results.errors.length}`);
        for (const { typeId, error } of results.errors) {
            lines.push(`    ${LOG_PREFIX.ERROR} ${typeId}: ${error.message}`);
        }
    }

    return lines.join('\n');
}

// ============================================================================
// LIVE RECORD CHECK
// ============================================================================

/**
 * Check each CO type for live records across all selected realms via OCAPI.
 * Returns a map of typeId → { realm, total } for types that have records.
 * @param {string[]} typeIds - CO type IDs to check
 * @param {string[]} realms - Realms to check against
 * @returns {Promise<Map<string, Array<{ realm: string, total: number }>>>}
 */
export async function checkLiveCustomObjectRecords(typeIds, realms) {
    const typesWithRecords = new Map();

    for (const typeId of typeIds) {
        for (const realm of realms) {
            const result = await searchCustomObjects(typeId, realm);
            if (result.exists) {
                if (!typesWithRecords.has(typeId)) {
                    typesWithRecords.set(typeId, []);
                }
                typesWithRecords.get(typeId).push({ realm, total: result.total });
            }
        }
    }

    return typesWithRecords;
}

/**
 * Format live record warnings for display.
 * @param {Map<string, Array<{ realm: string, total: number }>>} typesWithRecords
 * @returns {string} Formatted warning message
 */
export function formatLiveRecordWarnings(typesWithRecords) {
    if (typesWithRecords.size === 0) {
        return '';
    }

    const lines = [
        `${LOG_PREFIX.WARNING} The following types have live records on the instance:`,
        '  These records must be deleted manually before removing the type definition.',
        '  Deleting the definition does NOT delete existing records in SFCC.\n'
    ];

    for (const [typeId, realmHits] of typesWithRecords) {
        const details = realmHits.map(h => `${h.realm}: ${h.total} record(s)`).join(', ');
        lines.push(`  ⚠  ${typeId} — ${details}`);
    }

    lines.push('');
    return lines.join('\n');
}

/**
 * For each single-realm CO type, check non-target realms for live records via OCAPI.
 * If a type is marked as PNA-only, checks EU05, APAC, GB etc. for existing records.
 * This detects orphaned records that will remain after moving the definition away.
 *
 * @param {Map<string, string>} singleRealmMap - typeId → targetRealm
 * @param {string[]} allRealms - All realms being processed
 * @returns {Promise<Map<string, Array<{ realm: string, total: number }>>>}
 *   Map of typeId → array of { realm, total } for non-target realms that have records
 */
export async function checkOrphanedRecordsForMoves(singleRealmMap, allRealms) {
    const orphanedRecords = new Map();

    for (const [typeId, targetRealm] of singleRealmMap) {
        const nonTargetRealms = allRealms.filter(r => r !== targetRealm);

        for (const realm of nonTargetRealms) {
            const result = await searchCustomObjects(typeId, realm);
            if (result.exists) {
                if (!orphanedRecords.has(typeId)) {
                    orphanedRecords.set(typeId, []);
                }
                orphanedRecords.get(typeId).push({ realm, total: result.total });
            }
        }
    }

    return orphanedRecords;
}

/**
 * Format orphaned record warnings for display.
 * @param {Map<string, Array<{ realm: string, total: number }>>} orphanedRecords
 * @returns {string} Formatted warning message
 */
export function formatOrphanedRecordWarnings(orphanedRecords) {
    if (orphanedRecords.size === 0) {
        return '';
    }

    const lines = [
        `${LOG_PREFIX.WARNING} The following single-realm types have live records in OTHER realms:`,
        '  After moving, these records will no longer have a type definition deployed',
        '  to those realms. Clean up or back up these records before proceeding.\n'
    ];

    for (const [typeId, realmHits] of orphanedRecords) {
        const details = realmHits.map(h => `${h.realm}: ${h.total} record(s)`).join(', ');
        lines.push(`  ⚠  ${typeId} — ${details}`);
    }

    lines.push('');
    return lines.join('\n');
}

// ============================================================================
// DELETE PLAN (unused CO types)
// ============================================================================

/**
 * @typedef {Object} DeleteAction
 * @property {'delete-def'|'delete-instances'} type - Action type
 * @property {string} typeId - Custom object type ID
 * @property {string} sourceFile - File to delete or remove block from
 * @property {string} [reason] - Explanation
 */

/**
 * @typedef {Object} DeletePlan
 * @property {DeleteAction[]} actions - Ordered list of delete actions
 * @property {string[]} warnings - Non-fatal issues
 * @property {string[]} skipped - Type IDs that could not be processed
 */

/**
 * Build a plan for deleting unused custom-type definitions and their instance records.
 *
 * @param {Object} params
 * @param {string} params.repoPath - Absolute path to the sibling repository
 * @param {string[]} params.unusedTypes - Type IDs to delete from core
 * @returns {DeletePlan}
 */
export function buildDeletePlan({ repoPath, unusedTypes }) {
    const actions = [];
    const warnings = [];
    const skipped = [];

    const coreMetaDir = path.join(repoPath, getCoreSiteTemplatePath(), 'meta');
    const allCustomObjectDirs = collectAllCustomObjectDirs(repoPath);

    for (const typeId of unusedTypes) {
        // Find which core meta file contains this type
        const coreFiles = listCustomTypeMetaFiles(coreMetaDir);
        let sourceFile = null;

        for (const filePath of coreFiles) {
            const ids = extractCustomTypeIdsFromFile(filePath);
            if (ids.has(typeId)) {
                sourceFile = filePath;
                break;
            }
        }

        if (!sourceFile) {
            skipped.push(typeId);
            warnings.push(`${typeId}: not found in core meta directory`);
            continue;
        }

        actions.push({
            type: 'delete-def',
            typeId,
            sourceFile,
            reason: 'Remove unused type definition from core'
        });

        // Find instance files across all custom-objects directories
        for (const coDir of allCustomObjectDirs) {
            for (const instFile of findInstanceFilesForType(coDir, typeId)) {
                actions.push({
                    type: 'delete-instances',
                    typeId,
                    sourceFile: instFile,
                    reason: `Remove instance records from ${path.relative(repoPath, coDir)}`
                });
            }
        }
    }

    return { actions, warnings, skipped };
}

/**
 * Execute a delete plan: remove CO type blocks from meta files, delete instance files.
 *
 * @param {DeletePlan} plan - The delete plan to execute
 * @param {Object} [options]
 * @param {boolean} [options.dryRun=false] - If true, only log what would happen
 * @returns {{ deleted: string[], errors: Array<{ typeId: string, error: Error }>, filesModified: string[] }}
 */
export function executeDeletePlan(plan, { dryRun = false } = {}) {
    const deleted = [];
    const errors = [];
    const filesModified = new Set();
    const prefix = dryRun ? '[DRY-RUN] ' : '';

    // Phase 1: Remove type definitions from core meta files
    const defActions = plan.actions.filter(a => a.type === 'delete-def');

    // Group by source file for efficient batch removal
    const defsBySource = new Map();
    for (const action of defActions) {
        if (!defsBySource.has(action.sourceFile)) {
            defsBySource.set(action.sourceFile, []);
        }
        defsBySource.get(action.sourceFile).push(action);
    }

    for (const [sourceFile, fileActions] of defsBySource) {
        try {
            let content = fs.readFileSync(sourceFile, 'utf-8');

            for (const action of fileActions) {
                const result = removeCustomTypeBlock(content, action.typeId);
                if (result.removed) {
                    content = result.content;
                    console.log(
                        `${prefix}${LOG_PREFIX.INFO} DELETE DEF: ${action.typeId}`
                        + ` from ${path.basename(sourceFile)}`
                    );
                    deleted.push(action.typeId);
                }
            }

            if (!dryRun) {
                if (isMetaFileEffectivelyEmpty(content)) {
                    fs.unlinkSync(sourceFile);
                    console.log(
                        `${prefix}${LOG_PREFIX.INFO} DELETE FILE: ${path.basename(sourceFile)}`
                        + ' — no definitions remaining'
                    );
                } else {
                    fs.writeFileSync(sourceFile, content, 'utf-8');
                }
                filesModified.add(sourceFile);
            }
        } catch (error) {
            logError(`Failed to delete types from ${sourceFile}: ${error.message}`);
            for (const action of fileActions) {
                errors.push({ typeId: action.typeId, error });
            }
        }
    }

    // Phase 2: Delete instance files
    const instanceActions = plan.actions.filter(a => a.type === 'delete-instances');
    for (const action of instanceActions) {
        if (!deleted.includes(action.typeId)) {
            continue;
        }

        try {
            console.log(
                `${prefix}${LOG_PREFIX.INFO} DELETE INSTANCES: ${path.basename(action.sourceFile)}`
            );

            if (!dryRun) {
                fs.unlinkSync(action.sourceFile);
                filesModified.add(action.sourceFile);
            }
        } catch (error) {
            logError(`Failed to delete instance file ${path.basename(action.sourceFile)}: ${error.message}`);
            errors.push({ typeId: action.typeId, error });
        }
    }

    return {
        deleted,
        errors,
        filesModified: [...filesModified]
    };
}

/**
 * Format a delete plan as a human-readable summary.
 * @param {DeletePlan} plan - The delete plan
 * @returns {string} Formatted plan summary
 */
export function formatDeletePlan(plan) {
    const lines = [];

    const defActions = plan.actions.filter(a => a.type === 'delete-def');
    const instanceActions = plan.actions.filter(a => a.type === 'delete-instances');

    if (plan.actions.length === 0 && plan.skipped.length === 0) {
        return '  No custom object types to delete.\n';
    }

    if (defActions.length > 0) {
        lines.push(`  ${defActions.length} unused type definition(s) to delete:\n`);
        for (const action of defActions) {
            lines.push(`    ${action.typeId}`);
            lines.push(`      Source: ${path.basename(action.sourceFile)}`);

            const relatedInstances = instanceActions.filter(a => a.typeId === action.typeId);
            for (const inst of relatedInstances) {
                lines.push(`      + instances: ${path.basename(inst.sourceFile)}`);
            }
        }
        lines.push('');
    }

    if (plan.warnings.length > 0) {
        lines.push('  Warnings:');
        for (const warning of plan.warnings) {
            lines.push(`    ${LOG_PREFIX.WARNING} ${warning}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

/**
 * Format delete execution results as a human-readable summary.
 * @param {Object} results - Results from executeDeletePlan
 * @returns {string} Formatted results summary
 */
export function formatDeleteResults(results) {
    const lines = [];

    lines.push(`  Deleted: ${results.deleted.length} custom object type(s)`);

    if (results.filesModified.length > 0) {
        lines.push(`  Files modified/deleted: ${results.filesModified.length}`);
    }

    if (results.errors.length > 0) {
        lines.push(`  Errors: ${results.errors.length}`);
        for (const { typeId, error } of results.errors) {
            lines.push(`    ${LOG_PREFIX.ERROR} ${typeId}: ${error.message}`);
        }
    }

    return lines.join('\n');
}

// ============================================================================
// QA SUMMARY REPORTS
// Persistent report files for QA regression planning
// ============================================================================

/**
 * Format a move operation report for QA.
 *
 * @param {Object} params
 * @param {string} params.repoName - Repository name
 * @param {string} params.instanceType - Instance type
 * @param {string[]} params.realms - Realms processed
 * @param {Map<string, string>} params.selectedMap - typeId → targetRealm for moved types
 * @param {Map<string, Object>} params.analysisMap - Full analysis data per type
 * @param {Map<string, Array<{ id: string, cartridges: string[] }>>} [params.realmSites] - Site data per realm
 * @param {Object} params.results - executeMovePlan results
 * @param {boolean} params.dryRun - Whether this was a dry run
 * @returns {string} Formatted report
 */
export function formatMoveReport({ repoName, instanceType, realms, selectedMap, analysisMap, realmSites, orphanedRecords, results, dryRun }) {
    const sep = '='.repeat(80);
    const dash = '-'.repeat(80);
    const date = new Date().toISOString().slice(0, 10);
    const lines = [];

    lines.push(sep);
    lines.push(` CUSTOM OBJECT MOVE REPORT${dryRun ? ' (DRY RUN)' : ''}`);
    lines.push(` Repository: ${repoName}`);
    lines.push(` Instance: ${instanceType}`);
    lines.push(` Realms: ${realms.join(', ')}`);
    lines.push(` Date: ${date}`);
    lines.push(sep);
    lines.push('');

    // Summary
    lines.push(`Types moved: ${results.moved.length}`);
    lines.push(`Files created: ${results.filesCreated.length}`);
    lines.push(`Files modified: ${results.filesModified.length}`);
    if (results.errors.length > 0) {
        lines.push(`Errors: ${results.errors.length}`);
    }
    if (orphanedRecords && orphanedRecords.size > 0) {
        lines.push(`Orphaned record warnings: ${orphanedRecords.size} type(s)`);
    }
    lines.push('');

    // Orphaned records section — before the moved types, so QA sees it first
    if (orphanedRecords && orphanedRecords.size > 0) {
        lines.push(dash);
        lines.push(' ⚠ ORPHANED RECORDS — live records in non-target realms');
        lines.push(dash);
        lines.push('');
        lines.push('  These moved types have live records in realms where the type definition');
        lines.push('  will NO LONGER be deployed. The records still exist on the instance but');
        lines.push('  have no matching type definition. Back up or delete them.');
        lines.push('');

        for (const [typeId, realmHits] of orphanedRecords) {
            const target = selectedMap.get(typeId) || '?';
            const details = realmHits.map(h => `${h.realm}: ${h.total} record(s)`).join(', ');
            lines.push(`  ${typeId} (moved to: ${target})`);
            lines.push(`    Orphaned records in: ${details}`);
        }
        lines.push('');
    }

    // Group moved types by target realm
    const byRealm = new Map();
    for (const typeId of results.moved) {
        const targetRealm = selectedMap.get(typeId);
        if (!byRealm.has(targetRealm)) {
            byRealm.set(targetRealm, []);
        }
        byRealm.get(targetRealm).push(typeId);
    }

    if (byRealm.size > 0) {
        lines.push(dash);
        lines.push(' MOVED TYPES — by target realm');
        lines.push(dash);
        lines.push('');
        lines.push('  Each type below was moved FROM core (site_template) TO the realm-specific');
        lines.push('  meta directory. QA should verify these types still function on the listed sites.');
        lines.push('');

        for (const [realm, typeIds] of byRealm) {
            lines.push(`  ── ${realm} (${typeIds.length} type(s)) ──`);
            lines.push('');

            for (const typeId of typeIds) {
                const info = analysisMap.get(typeId);
                lines.push(`    ${typeId}`);
                if (info && info.cartridges.length > 0) {
                    lines.push(`      Cartridges: ${info.cartridges.join(', ')}`);
                }
                if (realmSites) {
                    const sites = findAffectedSitesForReport(info?.cartridges || [], realm, realmSites);
                    if (sites.length > 0) {
                        lines.push(`      Affected sites: ${sites.join(', ')}`);
                    }
                }
                if (orphanedRecords && orphanedRecords.has(typeId)) {
                    const hits = orphanedRecords.get(typeId);
                    const detail = hits.map(h => `${h.realm}: ${h.total}`).join(', ');
                    lines.push(`      ⚠ Orphaned records: ${detail}`);
                }
            }
            lines.push('');
        }
    }

    // Files changed
    if (results.filesCreated.length > 0 || results.filesModified.length > 0) {
        lines.push(dash);
        lines.push(' FILES CHANGED');
        lines.push(dash);

        if (results.filesCreated.length > 0) {
            lines.push('');
            lines.push('  Created:');
            for (const f of results.filesCreated) {
                lines.push(`    + ${f}`);
            }
        }
        if (results.filesModified.length > 0) {
            lines.push('');
            lines.push('  Modified:');
            for (const f of results.filesModified) {
                lines.push(`    ~ ${f}`);
            }
        }
        lines.push('');
    }

    // Errors
    if (results.errors.length > 0) {
        lines.push(dash);
        lines.push(' ERRORS');
        lines.push(dash);
        for (const { typeId, error } of results.errors) {
            lines.push(`  ${typeId}: ${error.message}`);
        }
        lines.push('');
    }

    lines.push(sep);
    return lines.join('\n');
}

/**
 * Format a delete operation report for QA.
 *
 * @param {Object} params
 * @param {string} params.repoName - Repository name
 * @param {string} params.instanceType - Instance type
 * @param {string[]} params.realms - Realms checked
 * @param {string[]} params.selectedTypes - Type IDs selected for deletion
 * @param {Object} params.plan - The delete plan
 * @param {Map<string, Array<{ realm: string, total: number }>>} [params.typesWithRecords] - Live record data
 * @param {Object} params.results - executeDeletePlan results
 * @param {boolean} params.dryRun - Whether this was a dry run
 * @returns {string} Formatted report
 */
export function formatDeleteReport({ repoName, instanceType, realms, selectedTypes, plan, typesWithRecords, results, dryRun }) {
    const sep = '='.repeat(80);
    const dash = '-'.repeat(80);
    const date = new Date().toISOString().slice(0, 10);
    const lines = [];

    lines.push(sep);
    lines.push(` CUSTOM OBJECT DELETION REPORT${dryRun ? ' (DRY RUN)' : ''}`);
    lines.push(` Repository: ${repoName}`);
    lines.push(` Instance: ${instanceType}`);
    lines.push(` Realms checked: ${realms.join(', ')}`);
    lines.push(` Date: ${date}`);
    lines.push(sep);
    lines.push('');

    // Summary
    lines.push(`Types deleted: ${results.deleted.length} of ${selectedTypes.length} selected`);
    lines.push(`Files modified/removed: ${results.filesModified.length}`);
    if (results.errors.length > 0) {
        lines.push(`Errors: ${results.errors.length}`);
    }
    lines.push('');

    // Live records section — important for QA
    if (typesWithRecords && typesWithRecords.size > 0) {
        lines.push(dash);
        lines.push(' LIVE RECORDS WARNING');
        lines.push(dash);
        lines.push('');
        lines.push('  The following types had live records on the SFCC instance at time of deletion.');
        lines.push('  Removing the type definition does NOT delete existing records.');
        lines.push('  These records must be cleaned up separately via BM or a job.');
        lines.push('');

        for (const [typeId, realmHits] of typesWithRecords) {
            const details = realmHits.map(h => `${h.realm}: ${h.total} record(s)`).join(', ');
            lines.push(`  ⚠  ${typeId} — ${details}`);
        }
        lines.push('');
    }

    // Deleted types
    if (results.deleted.length > 0) {
        lines.push(dash);
        lines.push(' DELETED TYPES');
        lines.push(dash);
        lines.push('');
        lines.push('  These custom object type definitions and their instance records were removed');
        lines.push('  from the repository. They will no longer be deployed to SFCC.');
        lines.push('');

        const defActions = plan.actions.filter(a => a.type === 'delete-def');
        const instanceActions = plan.actions.filter(a => a.type === 'delete-instances');

        for (const typeId of results.deleted) {
            lines.push(`    ${typeId}`);
            const def = defActions.find(a => a.typeId === typeId);
            if (def) {
                lines.push(`      Definition: ${path.basename(def.sourceFile)}`);
            }
            const instances = instanceActions.filter(a => a.typeId === typeId);
            if (instances.length > 0) {
                for (const inst of instances) {
                    lines.push(`      Instance:   ${path.relative(process.cwd(), inst.sourceFile)}`);
                }
            }
        }
        lines.push('');
    }

    // Files changed
    if (results.filesModified.length > 0) {
        lines.push(dash);
        lines.push(' FILES CHANGED');
        lines.push(dash);
        lines.push('');
        for (const f of results.filesModified) {
            lines.push(`    ${f}`);
        }
        lines.push('');
    }

    // Errors
    if (results.errors.length > 0) {
        lines.push(dash);
        lines.push(' ERRORS');
        lines.push(dash);
        for (const { typeId, error } of results.errors) {
            lines.push(`  ${typeId}: ${error.message}`);
        }
        lines.push('');
    }

    lines.push(sep);
    return lines.join('\n');
}

/**
 * Find sites affected by a set of cartridges within a realm.
 * @param {string[]} cartridges - Cartridge names
 * @param {string} realm - Realm name
 * @param {Map<string, Array<{ id: string, cartridges: string[] }>>} realmSites - Site data
 * @returns {string[]} Affected site IDs
 * @private
 */
function findAffectedSitesForReport(cartridges, realm, realmSites) {
    const sites = realmSites.get(realm);
    if (!sites || cartridges.length === 0) {
        return [];
    }
    const cartridgeSet = new Set(cartridges);
    return sites
        .filter(site => site.cartridges.some(c => cartridgeSet.has(c)))
        .map(site => site.id);
}
