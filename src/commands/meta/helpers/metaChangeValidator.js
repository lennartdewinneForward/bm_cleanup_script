/**
 * Meta Change Validator
 *
 * Validates changes made by meta-cleanup in the sibling repository.
 * Checks that removed attributes match deletion files, no blacklisted
 * preferences were touched, and created realm files are structurally correct.
 *
 * @module metaChangeValidator
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

import { LOG_PREFIX } from '../../../config/constants.js';
import { getSandboxConfig, getRealmsByInstanceType } from '../../../config/helpers/helpers.js';
import { loadBlacklist, isBlacklisted } from '../../setup/helpers/blacklistHelper.js';
import {
    stripCustomPrefix,
    getRealmMetaDir,
    getCoreMetaDir,
    extractSitePreferencesBlock,
    listSitePrefMetaFiles
} from './metaFileCleanup.js';
import { getChangedFiles } from './gitHelper.js';

const SITE_PREF_TYPE_EXTENSION = /type-id=["']SitePreferences["']/i;

// ============================================================================
// DIFF ANALYSIS
// ============================================================================

/**
 * Parse removed attribute IDs from the git diff of a single file.
 * Compares `-` lines (removed) against `+` lines (added) to exclude
 * attributes that were merely reformatted (e.g., tabs → spaces) but
 * not actually deleted.
 *
 * @param {string} repoPath - Absolute path to the git repository
 * @param {string} relativeFilePath - File path relative to repo root
 * @returns {string[]} Attribute IDs that were truly removed (not just reformatted)
 */
function parseRemovedAttributeIds(repoPath, relativeFilePath) {
    let diffOutput;
    try {
        diffOutput = execSync(
            `git diff HEAD -- "${relativeFilePath}"`,
            { cwd: repoPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
    } catch {
        // File might be untracked (new) — no diff to parse
        return [];
    }

    const removedIds = new Set();
    const addedIds = new Set();
    const defPattern = /<attribute-definition\s+attribute-id="([^"]+)"/i;

    for (const line of diffOutput.split('\n')) {
        if (line.startsWith('---') || line.startsWith('+++')) {
            continue;
        }

        if (line.startsWith('-')) {
            const match = line.match(defPattern);
            if (match) {
                removedIds.add(match[1]);
            }
        } else if (line.startsWith('+')) {
            const match = line.match(defPattern);
            if (match) {
                addedIds.add(match[1]);
            }
        }
    }

    // Subtract IDs that also appear in `+` lines — those were reformatted, not removed
    for (const id of addedIds) {
        removedIds.delete(id);
    }

    return [...removedIds];
}

/**
 * Parse attribute IDs present in a new (untracked) file's SitePreferences section.
 *
 * @param {string} filePath - Absolute path to the file
 * @returns {string[]} Attribute IDs found in the SitePreferences block
 */
function parseAttributeIdsFromNewFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const spBlock = extractSitePreferencesBlock(content) || content;

    const ids = [];
    const defPattern = /attribute-definition\s+attribute-id="([^"]+)"/gi;
    let match;
    while ((match = defPattern.exec(spBlock)) !== null) {
        ids.push(match[1]);
    }

    return [...new Set(ids)];
}

// ============================================================================
// STRUCTURAL CHECKS
// ============================================================================

/**
 * Check a newly created realm file for structural issues:
 * - Must contain a SitePreferences type-extension
 * - Every attribute in a group-assignment should have a definition
 * - No non-SitePreferences type-extensions allowed
 *
 * @param {string} filePath - Absolute path to the file
 * @returns {{ ok: boolean, issues: string[] }}
 */
function validateRealmFileStructure(filePath) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const issues = [];

    // Check for SitePreferences block
    if (!SITE_PREF_TYPE_EXTENSION.test(content)) {
        issues.push('Missing SitePreferences type-extension');
        return { ok: false, issues };
    }

    // Check for non-SitePreferences type-extensions
    const typeExtMatches = content.match(/type-extension\s+type-id="([^"]+)"/gi) || [];
    for (const typeMatch of typeExtMatches) {
        const idMatch = typeMatch.match(/type-id="([^"]+)"/i);
        if (idMatch && idMatch[1] !== 'SitePreferences') {
            issues.push(`Contains non-SitePreferences type-extension: ${idMatch[1]}`);
        }
    }

    // Extract SitePreferences block for definition/assignment check
    const spBlock = extractSitePreferencesBlock(content);
    if (!spBlock) {
        return { ok: issues.length === 0, issues };
    }

    // Collect defined attribute IDs
    const defIds = new Set();
    const defPattern = /attribute-definition\s+attribute-id="([^"]+)"/gi;
    let match;
    while ((match = defPattern.exec(spBlock)) !== null) {
        defIds.add(match[1]);
    }

    // Collect group-assigned attribute IDs
    const assignedIds = new Set();
    const assignPattern = /<attribute\s+attribute-id="([^"]+)"\s*\/>/gi;
    while ((match = assignPattern.exec(spBlock)) !== null) {
        assignedIds.add(match[1]);
    }

    // Check for orphaned group assignments (assigned but not defined)
    for (const assignedId of assignedIds) {
        if (!defIds.has(assignedId)) {
            issues.push(`Orphaned group assignment: ${assignedId} (no definition)`);
        }
    }

    return { ok: issues.length === 0, issues };
}

// ============================================================================
// MAIN VALIDATION
// ============================================================================

/**
 * Validate changes made by meta-cleanup in the sibling repository.
 *
 * @param {Object} params
 * @param {string} params.repoPath - Absolute path to the sibling repository
 * @param {string} params.instanceType - Instance type (e.g., 'development')
 * @param {Map<string, string[]>} params.realmPreferenceMap - Realm → preference IDs approved for deletion
 * @returns {MetaValidationReport}
 */
export function validateMetaChanges({ repoPath, instanceType, realmPreferenceMap }) {
    const { added, modified } = getChangedFiles(repoPath);
    const allRealms = getRealmsByInstanceType(instanceType);
    const coreMetaDir = getCoreMetaDir(repoPath);

    // Build set of ALL approved deletion IDs (bare, across all realms)
    const approvedIds = new Set();
    for (const preferenceIds of realmPreferenceMap.values()) {
        for (const id of preferenceIds) {
            approvedIds.add(stripCustomPrefix(id));
        }
    }

    // Build realm → directory mapping
    const dirToRealm = new Map();
    for (const realm of allRealms) {
        const config = getSandboxConfig(realm);
        const metaDir = getRealmMetaDir(repoPath, config.siteTemplatesPath);
        dirToRealm.set(metaDir, realm);
    }
    dirToRealm.set(coreMetaDir, 'CORE');

    // Load blacklist
    const { blacklist: blacklistEntries } = loadBlacklist();

    const report = {
        removedAttributes: { total: 0, approved: 0, unapproved: [] },
        blacklistViolations: [],
        createdFiles: { total: 0, valid: 0, issues: [] },
        modifiedFiles: [],
        summary: ''
    };

    // --- Check MODIFIED files (attributes removed) ---
    const metaModified = modified.filter(f => f.endsWith('.xml'));
    for (const relPath of metaModified) {
        const absPath = path.join(repoPath, relPath);
        if (!fs.existsSync(absPath)) {
            continue;
        }

        // Only check files in meta directories
        const dir = path.dirname(absPath);
        const isSitePrefFile = listSitePrefMetaFiles(dir).includes(absPath);
        if (!isSitePrefFile) {
            continue;
        }

        const removedIds = parseRemovedAttributeIds(repoPath, relPath);
        report.modifiedFiles.push({ file: relPath, removedCount: removedIds.length });

        for (const attrId of removedIds) {
            report.removedAttributes.total++;
            const bareId = stripCustomPrefix(attrId);

            if (approvedIds.has(bareId)) {
                report.removedAttributes.approved++;
            } else {
                report.removedAttributes.unapproved.push({
                    attributeId: bareId,
                    file: relPath
                });
            }

            if (isBlacklisted(bareId, blacklistEntries)) {
                report.blacklistViolations.push({
                    attributeId: bareId,
                    file: relPath,
                    action: 'removed'
                });
            }
        }
    }

    // --- Check ADDED files (new realm files) ---
    const metaAdded = added.filter(f => f.endsWith('.xml'));
    for (const relPath of metaAdded) {
        const absPath = path.join(repoPath, relPath);
        if (!fs.existsSync(absPath)) {
            continue;
        }

        report.createdFiles.total++;

        // Structural validation
        const structural = validateRealmFileStructure(absPath);
        if (!structural.ok) {
            report.createdFiles.issues.push({
                file: relPath,
                problems: structural.issues
            });
        } else {
            report.createdFiles.valid++;
        }

        // Check that attributes in new files aren't blacklisted
        const newFileIds = parseAttributeIdsFromNewFile(absPath);
        for (const attrId of newFileIds) {
            if (isBlacklisted(attrId, blacklistEntries)) {
                report.blacklistViolations.push({
                    attributeId: attrId,
                    file: relPath,
                    action: 'created'
                });
            }
        }
    }

    report.summary = buildSummary(report);
    return report;
}

/**
 * Build a human-readable summary from a validation report.
 *
 * @param {Object} report - Validation report
 * @returns {string} Multi-line summary
 */
function buildSummary(report) {
    const lines = [];
    lines.push('');
    lines.push('═'.repeat(70));
    lines.push(' META CHANGE VALIDATION REPORT');
    lines.push('═'.repeat(70));

    // Removed attributes
    lines.push('');
    lines.push(`  Removed attributes: ${report.removedAttributes.total}`);
    lines.push(`    ${LOG_PREFIX.INFO} Approved: ${report.removedAttributes.approved}`);
    if (report.removedAttributes.unapproved.length > 0) {
        lines.push(
            `    ${LOG_PREFIX.ERROR} Unapproved: ${report.removedAttributes.unapproved.length}`
        );
        for (const { attributeId, file } of report.removedAttributes.unapproved) {
            lines.push(`      - ${attributeId} in ${path.basename(file)}`);
        }
    } else {
        lines.push(`    ${LOG_PREFIX.INFO} All removals match deletion files`);
    }

    // Blacklist violations
    lines.push('');
    if (report.blacklistViolations.length > 0) {
        lines.push(
            `  ${LOG_PREFIX.ERROR} Blacklist violations: ${report.blacklistViolations.length}`
        );
        for (const { attributeId, file, action } of report.blacklistViolations) {
            lines.push(`    - ${attributeId} (${action}) in ${path.basename(file)}`);
        }
    } else {
        lines.push(`  ${LOG_PREFIX.INFO} No blacklisted preferences were touched`);
    }

    // Created files
    lines.push('');
    lines.push(`  Created realm files: ${report.createdFiles.total}`);
    if (report.createdFiles.total > 0) {
        lines.push(`    ${LOG_PREFIX.INFO} Valid: ${report.createdFiles.valid}`);
        if (report.createdFiles.issues.length > 0) {
            lines.push(
                `    ${LOG_PREFIX.ERROR} Issues: ${report.createdFiles.issues.length}`
            );
            for (const { file, problems } of report.createdFiles.issues) {
                lines.push(`    ${path.basename(file)}:`);
                for (const problem of problems) {
                    lines.push(`      - ${problem}`);
                }
            }
        }
    }

    // Overall verdict
    lines.push('');
    const hasProblems = report.removedAttributes.unapproved.length > 0
        || report.blacklistViolations.length > 0
        || report.createdFiles.issues.length > 0;
    lines.push(hasProblems
        ? `  ${LOG_PREFIX.ERROR} VALIDATION FAILED — review issues above`
        : `  ${LOG_PREFIX.INFO} VALIDATION PASSED — all changes look correct`
    );
    lines.push('═'.repeat(70));
    lines.push('');

    return lines.join('\n');
}

/**
 * Format the validation report for console output.
 *
 * @param {MetaValidationReport} report - Validation report
 * @returns {string} Formatted output
 */
export function formatValidationReport(report) {
    return report.summary;
}

// ============================================================================
// XML INDENTATION FIX
// ============================================================================

const INDENT_UNIT = '    '; // 4 spaces — matches SFCC conventions

/**
 * Normalize XML indentation in all modified and created XML files.
 * Converts leading tabs to 4 spaces and trims trailing whitespace.
 *
 * @param {string} repoPath - Absolute path to the sibling repository
 * @returns {{ fixed: string[], skipped: string[] }} Lists of fixed and skipped file paths
 */
export function fixXmlIndentation(repoPath) {
    const { added, modified } = getChangedFiles(repoPath);
    const xmlFiles = [...added, ...modified].filter(f => f.endsWith('.xml'));
    const fixed = [];
    const skipped = [];

    for (const relPath of xmlFiles) {
        const absPath = path.join(repoPath, relPath);
        if (!fs.existsSync(absPath)) {
            skipped.push(relPath);
            continue;
        }

        const original = fs.readFileSync(absPath, 'utf-8');
        const normalized = normalizeXmlWhitespace(original);

        if (normalized !== original) {
            fs.writeFileSync(absPath, normalized, 'utf-8');
            fixed.push(relPath);
        }
    }

    return { fixed, skipped };
}

/**
 * Normalize whitespace in an XML string.
 * Converts leading tabs to 4 spaces per tab and trims trailing whitespace per line.
 * Preserves the original nesting structure — only whitespace characters change.
 *
 * @param {string} xml - Raw XML content
 * @returns {string} Whitespace-normalized XML
 * @private
 */
function normalizeXmlWhitespace(xml) {
    return xml
        .split('\n')
        .map(line => {
            // Replace each leading tab with 4 spaces, preserving mixed indent
            const replaced = line.replace(/^\t+/, match => INDENT_UNIT.repeat(match.length));
            return replaced.trimEnd();
        })
        .join('\n');
}
