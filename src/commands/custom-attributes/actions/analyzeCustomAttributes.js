import inquirer from 'inquirer';
import path from 'path';
import fs from 'fs';
import { getSiblingRepositories, ensureResultsDir } from '../../../io/util.js';
import { getInstanceType, getSandboxConfig } from '../../../config/helpers/helpers.js';
import { startTimer } from '../../../helpers/timer.js';
import { RealmProgressDisplay } from '../../../scripts/loggingScript/progressDisplay.js';
import * as prompts from '../../prompts/index.js';
import { LOG_PREFIX, IDENTIFIERS, FILE_PATTERNS } from '../../../config/constants.js';
import { logSectionTitle, logRuntime } from '../../../scripts/loggingScript/log.js';
import { getAllAttributeDefinitionsFromMetadata } from '../../../io/siteXmlHelper.js';
import {
    scanAttributeUsageInCode,
    generateCustomAttributeDeletionCandidates
} from '../../../io/codeScanner.js';
import { exportSitesCartridgesToCSV } from '../../../io/csv.js';
import { refreshMetadataBackupForRealm } from '../../../helpers/backupJob.js';
import { validateRealmsSelection } from '../helpers/realmHelpers.js';

// ============================================================================
// ANALYZE CUSTOM ATTRIBUTES
// Workflow: download metadata -> extract attribute definitions -> scan code
// ============================================================================

export async function analyzeCustomAttributes() {
    const timer = startTimer();

    // --- STEP 1: Configure Scope & Options ---
    logSectionTitle('STEP 1: Configure Scope & Options');

    const siblings = await getSiblingRepositories();
    const repositoryAnswers = await inquirer.prompt(
        await prompts.repositoriesMultiSelectPrompt(siblings)
    );
    const repositoryPaths = repositoryAnswers.repositories.map(
        repo => path.join(path.dirname(process.cwd()), repo)
    );

    const selection = await prompts.resolveRealmScopeSelection(inquirer.prompt);
    const realmsToProcess = selection.realmList;

    if (!validateRealmsSelection(realmsToProcess)) {
        return;
    }

    const objectType = IDENTIFIERS.ORDER;

    const useCachedBackup = await prompts.promptBackupCachePreference(realmsToProcess, objectType);

    // --- STEP 2: Download Metadata & Extract Attribute Definitions ---
    logSectionTitle('STEP 2: Download Metadata & Extract Attribute Definitions');

    const realmEntries = realmsToProcess.map(realm => ({
        realm,
        instanceType: getInstanceType(realm)
    }));

    if (realmEntries.length === 0) {
        console.log(`\n${LOG_PREFIX.ERROR} No realms to process. Aborting.\n`);
        logRuntime(timer);
        return;
    }

    const allResults = [];
    const display = new RealmProgressDisplay(250);
    display.start();

    try {
        const realmPromises = realmEntries.map(
            async ({ realm, instanceType }) => {
                let realmHostname;

                try {
                    const realmConfig = getSandboxConfig(realm);
                    realmHostname = realmConfig.hostname;
                } catch (configError) {
                    console.error(
                        `${LOG_PREFIX.ERROR} ${realm}: ${configError.message}`
                    );
                    return { realm, success: false, error: configError, mode: 'config' };
                }

                // Step 1: Download metadata backup
                display.setTotalSteps(realmHostname, 2);
                display.startStep(
                    realmHostname, realm, 'backup', 'Downloading Backup'
                );

                let refreshResult;
                try {
                    refreshResult = await refreshMetadataBackupForRealm(
                        realm, instanceType,
                        { forceJobExecution: !useCachedBackup }
                    );
                } catch (backupError) {
                    refreshResult = { ok: false, reason: backupError.message };
                }

                if (!refreshResult.ok) {
                    display.failStep(realmHostname, 'backup');
                    display.failRealm(realmHostname, refreshResult.reason || 'Backup failed');
                    return {
                        realm, success: false,
                        error: new Error(refreshResult.reason || 'Backup failed'),
                        mode: 'metadata'
                    };
                }

                const statusLabel = refreshResult.status === 'EXISTING'
                    ? 'existing metadata backup (no new job execution)'
                    : 'freshly generated metadata backup (job execution)';
                console.log(`${LOG_PREFIX.INFO} ${realm}: using ${statusLabel}.`);
                display.completeStep(realmHostname, 'backup');

                // Step 2: Extract attribute definitions from metadata XML
                display.startStep(
                    realmHostname, realm, 'extract', 'Extracting Attribute Definitions'
                );

                try {
                    const attributeDefinitions = await getAllAttributeDefinitionsFromMetadata(
                        refreshResult.filePath, objectType
                    );

                    display.completeStep(realmHostname, 'extract');
                    display.completeRealm(realmHostname);

                    return {
                        realm, success: true,
                        attributeDefinitions,
                        metadataFilePath: refreshResult.filePath,
                        backupStatus: refreshResult.status || 'OK',
                        mode: 'metadata'
                    };
                } catch (extractError) {
                    display.failStep(realmHostname, 'extract');
                    display.failRealm(realmHostname, extractError.message);
                    return {
                        realm, success: false, error: extractError, mode: 'metadata'
                    };
                }
            }
        );

        const results = await Promise.all(realmPromises);
        allResults.push(...results);
    } finally {
        display.finish();
    }

    console.log('');

    // Report failures
    const failures = allResults.filter(r => !r.success);
    if (failures.length > 0) {
        for (const { realm, error, mode } of failures) {
            console.error(`${LOG_PREFIX.ERROR} ${realm} (${mode}): ${error.message}`);
        }
        if (failures.length === allResults.length) {
            console.log(`\n${LOG_PREFIX.ERROR} All realms failed. Aborting.\n`);
            logRuntime(timer);
            return;
        }
    }

    // Merge attribute definitions across realms (union of all IDs)
    const successfulResults = allResults.filter(r => r.success);
    const allAttributeIds = new Set();

    for (const result of successfulResults) {
        for (const def of result.attributeDefinitions) {
            allAttributeIds.add(def.id);
        }
    }

    const attributeIds = Array.from(allAttributeIds).sort();
    console.log(
        `${LOG_PREFIX.INFO} Found ${attributeIds.length} unique ${objectType}`
        + ` attribute definition(s) across ${successfulResults.length} realm(s).`
    );
    console.log('');

    // --- STEP 3: Scan Code for Attribute References ---
    logSectionTitle('STEP 3: Scan Code for Attribute References');

    const repoNames = repositoryPaths.map(p => path.basename(p));
    const repoLabel = repoNames.length === 1
        ? repoNames[0]
        : `${repoNames.length} repositories`;

    const scanDisplay = new RealmProgressDisplay(250);
    const scanStep = `scan_${Date.now()}`;
    scanDisplay.startStep(
        'codeScanner', 'Code Scanner', scanStep,
        `Scanning ${repoLabel} for ${objectType} attribute references`
    );
    scanDisplay.start();

    const scanCallback = (scannedCount, totalFiles) => {
        const percentage = Math.round((scannedCount / totalFiles) * 100);
        scanDisplay.setStepProgress('codeScanner', scanStep, percentage);
        scanDisplay.setStepMessage(
            'codeScanner', scanStep,
            `${scannedCount}/${totalFiles} files`, 'info'
        );
    };

    let scanResults;
    try {
        scanResults = await scanAttributeUsageInCode(attributeIds, repositoryPaths, {
            progressCallback: scanCallback
        });
        scanDisplay.completeStep('codeScanner', scanStep);
    } catch (scanError) {
        scanDisplay.failStep('codeScanner', scanStep);
        throw scanError;
    } finally {
        scanDisplay.finish();
    }

    // --- STEP 4: Refresh Active Site Cartridge Lists ---
    logSectionTitle('STEP 4: Refresh Active Site Cartridge Lists');

    const realmsProcessed = successfulResults.map(r => r.realm);
    const instanceType = getInstanceType(realmsProcessed[0]);

    if (realmsProcessed.length > 0) {
        const exportResults = await Promise.all(
            realmsProcessed.map(async (realm) => {
                try {
                    await exportSitesCartridgesToCSV(realm);
                    return { realm, success: true };
                } catch (error) {
                    return { realm, success: false, error };
                }
            })
        );

        const exportFailures = exportResults.filter(r => !r.success);
        const exportSuccesses = exportResults.length - exportFailures.length;

        console.log(
            `${LOG_PREFIX.INFO} Refreshed active site cartridge lists for ${exportSuccesses}`
            + `/${exportResults.length} realm(s).`
        );

        if (exportFailures.length > 0) {
            for (const { realm, error } of exportFailures) {
                console.log(
                    `${LOG_PREFIX.WARNING} ${realm}: failed to export site cartridge list — `
                    + `${error.message}`
                );
            }
        }
    }

    // --- STEP 5: Generate Deletion Candidates ---
    logSectionTitle('STEP 5: Generate Deletion Candidates');

    console.log(`  Total ${objectType} attributes: ${attributeIds.length}`);
    console.log(`  Used in code: ${scanResults.used.length}`);
    console.log(`  Unused (no code references): ${scanResults.unused.length}`);
    console.log('');

    // Write ALL_REALMS unused/used summary files (quick reference)
    const allRealmsDir = ensureResultsDir(IDENTIFIERS.ALL_REALMS, instanceType);

    if (scanResults.unused.length > 0) {
        const unusedFile = path.join(
            allRealmsDir, `${objectType}_unused_custom_attributes.txt`
        );
        const unusedLines = [
            `# Unused ${objectType} Custom Attributes`,
            `# Generated: ${new Date().toISOString()}`,
            `# Realms analyzed: ${realmsProcessed.join(', ')}`,
            `# Repositories scanned: ${repoNames.join(', ')}`,
            `# Total definitions: ${attributeIds.length}`,
            `# Unused: ${scanResults.unused.length}`,
            '',
            ...scanResults.unused
        ];
        fs.writeFileSync(unusedFile, unusedLines.join('\n'), 'utf-8');
        console.log(`${LOG_PREFIX.INFO} Unused attributes saved to: ${unusedFile}`);
    }

    if (scanResults.used.length > 0) {
        const usedFile = path.join(
            allRealmsDir, `${objectType}_used_custom_attributes.txt`
        );
        const usedLines = [
            `# Used ${objectType} Custom Attributes`,
            `# Generated: ${new Date().toISOString()}`,
            `# Realms analyzed: ${realmsProcessed.join(', ')}`,
            `# Repositories scanned: ${repoNames.join(', ')}`,
            `# Total definitions: ${attributeIds.length}`,
            `# Used: ${scanResults.used.length}`,
            ''
        ];
        for (const entry of scanResults.used) {
            const cartridges = [
                ...entry.activeCartridges,
                ...entry.deprecatedCartridges.map(c => `${c} [deprecated]`)
            ];
            usedLines.push(`${entry.attributeId} → ${cartridges.join(', ')}`);
        }
        fs.writeFileSync(usedFile, usedLines.join('\n'), 'utf-8');
        console.log(`${LOG_PREFIX.INFO} Used attributes saved to: ${usedFile}`);
    }

    // Export attribute references JSON (file/line/cartridge per attribute)
    const attributeReferences = new Map();
    for (const entry of scanResults.used) {
        if (entry.references && entry.references.length > 0) {
            attributeReferences.set(entry.attributeId, entry.references);
        }
    }

    if (attributeReferences.size > 0) {
        const refsOutput = {
            generated: new Date().toISOString(),
            objectType,
            totalAttributes: attributeReferences.size,
            attributes: {}
        };

        for (const [attrId, refs] of attributeReferences) {
            refsOutput.attributes[attrId] = refs.map(r => ({
                file: (r.file || '').replace(/\\/g, '/'),
                line: r.line,
                text: r.text,
                cartridge: r.cartridge
            }));
        }

        const refsFilePath = path.join(
            allRealmsDir,
            `${objectType}${FILE_PATTERNS.CUSTOM_ATTR_REFERENCES}`
        );
        fs.writeFileSync(refsFilePath, JSON.stringify(refsOutput, null, 2), 'utf-8');
        console.log(`${LOG_PREFIX.INFO} Attribute references saved to: ${refsFilePath}`);
    }

    console.log('');

    // Generate tiered deletion candidates with per-realm targeting
    const { outputFilePath, perRealmFiles, perRealmTiers } =
        generateCustomAttributeDeletionCandidates({
            scanResults,
            allRealms: realmsProcessed,
            instanceType,
            objectType,
            repoNames
        });

    if (outputFilePath) {
        console.log(`\n${LOG_PREFIX.INFO} Unified deletion candidates: ${outputFilePath}`);
    }

    if (perRealmFiles.length > 0) {
        console.log(
            `${LOG_PREFIX.INFO} Per-realm deletion files generated:`
            + ` ${perRealmFiles.length} realm(s)`
        );
    }

    // Generate Meta-cleanup-logic files (cross-realm tier mismatch tracking)
    if (perRealmTiers && perRealmTiers.size >= 2) {
        // Normalize perRealmTiers to include p2/p4/p5 empty arrays for compatibility
        const normalizedTiers = new Map();
        for (const [realm, tiers] of perRealmTiers) {
            normalizedTiers.set(realm, {
                p1: tiers.p1 || [],
                p2: [],
                p3: tiers.p3 || [],
                p4: [],
                p5: tiers.p5 || []
            });
        }

        const metaResult = generateMetaCleanupLogicForCustomAttrs({
            perRealmTiers: normalizedTiers,
            allRealms: realmsProcessed,
            instanceType,
            objectType,
            resultsDir: allRealmsDir
        });

        if (metaResult) {
            console.log(
                `${LOG_PREFIX.INFO} Generated Meta-cleanup-logic files: `
                + `${metaResult.totalEntries} entries`
                + ` (${metaResult.mismatchCount} with cross-realm mismatches)`
            );
        }
    }

    console.log('');
    logRuntime(timer);
}

/**
 * Generate Meta-cleanup-logic files for custom attributes.
 * Tracks cross-realm P-level mismatches for meta-cleanup command.
 *
 * @param {Object} params
 * @param {Map} params.perRealmTiers - Per-realm tier data
 * @param {string[]} params.allRealms - All realms
 * @param {string} params.instanceType - Instance type
 * @param {string} params.objectType - Object type (e.g. 'Order')
 * @param {string} params.resultsDir - Output directory
 * @returns {{ totalEntries: number, mismatchCount: number }|null}
 * @private
 */
function generateMetaCleanupLogicForCustomAttrs({
    perRealmTiers,
    allRealms,
    instanceType,
    objectType,
    resultsDir
}) {
    const realmsWithData = allRealms.filter(r => perRealmTiers.has(r));
    if (realmsWithData.length < 2) {
        return null;
    }

    // Build a map: attrId → Map<realm, tierString>
    const attrRealmTierMap = new Map();

    for (const realm of realmsWithData) {
        const tiers = perRealmTiers.get(realm);
        if (!tiers) continue;

        const tierArrays = [
            { tier: 'P1', candidates: tiers.p1 },
            { tier: 'P3', candidates: tiers.p3 },
            { tier: 'P5', candidates: tiers.p5 || [] }
        ];

        for (const { tier, candidates } of tierArrays) {
            for (const c of candidates) {
                if (!attrRealmTierMap.has(c.id)) {
                    attrRealmTierMap.set(c.id, new Map());
                }
                attrRealmTierMap.get(c.id).set(realm, tier);
            }
        }
    }

    if (attrRealmTierMap.size === 0) {
        return null;
    }

    // Build entries
    const jsonEntries = [];

    for (const [attrId, realmTiers] of attrRealmTierMap) {
        const tierValues = [...realmTiers.values()];
        const uniqueTiers = [...new Set(tierValues)];
        const candidateRealms = [...realmTiers.keys()];
        const nonCandidateRealms = realmsWithData.filter(r => !realmTiers.has(r));

        const hasTierMismatch = uniqueTiers.length > 1;
        const hasMismatch = hasTierMismatch || nonCandidateRealms.length > 0;
        const lowestTier = uniqueTiers.sort()[0];
        const p1Realms = candidateRealms.filter(r => realmTiers.get(r) === 'P1');
        const migrateToRealms = [
            ...candidateRealms.filter(r => realmTiers.get(r) !== 'P1'),
            ...nonCandidateRealms
        ];

        const realmPLevels = {};
        for (const [realm, tier] of realmTiers) {
            realmPLevels[realm] = tier;
        }
        for (const realm of nonCandidateRealms) {
            realmPLevels[realm] = null;
        }

        jsonEntries.push({
            attributeId: attrId,
            objectType,
            pLevel: lowestTier,
            realmPLevels,
            p1Realms,
            migrateToRealms,
            hasMismatch
        });
    }

    jsonEntries.sort((a, b) => a.attributeId.localeCompare(b.attributeId));

    // Write JSON file
    const jsonOutput = {
        generated: new Date().toISOString(),
        instanceType,
        objectType,
        realms: realmsWithData,
        totalEntries: jsonEntries.length,
        mismatchCount: jsonEntries.filter(e => e.hasMismatch).length,
        excludedPaths: [],
        entries: jsonEntries
    };

    const jsonFilePath = path.join(
        resultsDir, `${objectType}${FILE_PATTERNS.CUSTOM_ATTR_META_CLEANUP_LOGIC_JSON}`
    );
    fs.writeFileSync(jsonFilePath, JSON.stringify(jsonOutput, null, 2), 'utf-8');

    // Write TXT file
    const txtLines = [
        `# ${objectType} Meta-cleanup-logic Notation`,
        '# Each entry lists an attribute, its P-level, and the realms where that P-level applies.',
        '# Realms in brackets [ ] indicate where the attribute should be migrated/copied to a private meta XML.',
        '#',
        `# Generated: ${jsonOutput.generated}`,
        `# Instance Type: ${instanceType}`,
        `# Object Type: ${objectType}`,
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
                `${entry.attributeId}: ${entry.pLevel}(${p1Label}) [${migrateLabel}]`
            );
        } else {
            txtLines.push(
                `${entry.attributeId}: ${entry.pLevel}(${p1Label})`
            );
        }
    }

    const txtFilePath = path.join(
        resultsDir, `${objectType}${FILE_PATTERNS.CUSTOM_ATTR_META_CLEANUP_LOGIC_TXT}`
    );
    fs.writeFileSync(txtFilePath, txtLines.join('\n'), 'utf-8');

    return {
        totalEntries: jsonEntries.length,
        mismatchCount: jsonEntries.filter(e => e.hasMismatch).length
    };
}
