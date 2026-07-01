import inquirer from 'inquirer';
import path from 'path';
import fs from 'fs';
import {
    findAllMatrixFiles,
    getSiblingRepositories
} from '../../../io/util.js';
import {
    getInstanceType,
    getSandboxConfig
} from '../../../config/helpers/helpers.js';
import { startTimer } from '../../../helpers/timer.js';
import { RealmProgressDisplay } from '../../../scripts/loggingScript/progressDisplay.js';
import * as prompts from '../../prompts/index.js';
import {
    LOG_PREFIX, DIRECTORIES, IDENTIFIERS, FILE_PATTERNS, ANALYSIS_STEPS
} from '../../../config/constants.js';
import {
    logNoMatrixFiles,
    logMatrixFilesFound,
    logSummaryHeader,
    logRealmSummary,
    logSummaryFooter,
    logSectionTitle,
    logRuntime
} from '../../../scripts/loggingScript/log.js';
import {
    processPreferenceMatrixFiles,
    executePreferenceSummarization,
    executeSummarizationFromMetadata
} from '../../../helpers/analyzer.js';
import { exportSitesCartridgesToCSV } from '../../../io/csv.js';
import {
    findAllActivePreferencesUsage,
    getActivePreferencesFromMatrices
} from '../../../io/codeScanner.js';
import { refreshMetadataBackupForRealm } from '../../../helpers/backupJob.js';
import { validateRealmsSelection } from '../helpers/realmHelpers.js';

// ============================================================================
// ANALYZE PREFERENCES
// Full workflow: fetch -> summarize -> check usage in cartridges
// ============================================================================

export async function analyzePreferences() {
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

    // Hardcoded defaults — objectType is always SitePreferences,
    // scope is always all sites, and defaults are always included
    const objectType = IDENTIFIERS.SITE_PREFERENCES;
    const scope = 'all';
    const siteId = undefined;
    const includeDefaults = true;

    const useCachedBackup = await prompts.promptBackupCachePreference(realmsToProcess, objectType);

    // --- STEP 2: Backup, Fetch & Summarize ---
    logSectionTitle('STEP 2: Backup, Fetch & Summarize Preferences');

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
                    // Config lookup failed — can't even identify the realm
                    console.error(
                        `${LOG_PREFIX.ERROR} ${realm}: ${configError.message}`
                    );
                    return {
                        realm, success: false,
                        error: configError, mode: 'config'
                    };
                }

                // Step 1: Trigger backup job and download metadata XML
                display.setTotalSteps(realmHostname, ANALYSIS_STEPS.METADATA);
                display.startStep(
                    realmHostname, realm, 'backup', 'Downloading Backup'
                );

                let refreshResult;
                try {
                    refreshResult = await refreshMetadataBackupForRealm(
                        realm,
                        instanceType,
                        { forceJobExecution: !useCachedBackup }
                    );
                } catch (backupError) {
                    refreshResult = { ok: false, reason: backupError.message };
                }

                if (refreshResult.ok) {
                    if (refreshResult.status === 'EXISTING') {
                        console.log(
                            `${LOG_PREFIX.INFO} ${realm}: using existing metadata backup (no new job execution).`
                        );
                    } else {
                        console.log(
                            `${LOG_PREFIX.INFO} ${realm}: using freshly generated metadata backup (job execution).`
                        );
                    }

                    display.completeStep(realmHostname, 'backup');

                    // Steps 2-5: metadata flow (fetch, groups, matrices, export)
                    try {
                        const result = await executeSummarizationFromMetadata(
                            {
                                realm, objectType, instanceType, scope, siteId,
                                metadataFilePath: refreshResult.filePath,
                                repositoryPaths
                            },
                            { display, hostname: realmHostname, realmName: realm }
                        );
                        display.completeRealm(realmHostname);
                        return {
                            realm,
                            success: true,
                            result,
                            mode: 'metadata',
                            backupStatus: refreshResult.status || 'OK'
                        };
                    } catch (realmError) {
                        display.failStep(realmHostname, 'fetch');
                        display.failRealm(realmHostname, realmError.message);
                        return {
                            realm, success: false, error: realmError, mode: 'metadata'
                        };
                    }
                }

                // Backup failed — fall back to OCAPI
                const backupReason = refreshResult.reason || 'unknown';
                console.log(
                    `${LOG_PREFIX.WARNING} ${realm}: switching to old data method (OCAPI) — ${backupReason}`
                );
                display.failStep(realmHostname, 'backup');
                display.setTotalSteps(realmHostname, ANALYSIS_STEPS.OCAPI);

                try {
                    const result = await executePreferenceSummarization(
                        {
                            realm, objectType, instanceType, scope, siteId,
                            includeDefaults, useCachedBackup, repositoryPaths
                        },
                        { display, hostname: realmHostname, realmName: realm }
                    );
                    display.completeRealm(realmHostname);
                    return {
                        realm, success: true, result,
                        mode: 'ocapi', backupReason, backupStatus: 'FALLBACK_OCAPI'
                    };
                } catch (realmError) {
                    display.failStep(realmHostname, 'fetch');
                    display.failRealm(realmHostname, realmError.message);
                    return {
                        realm, success: false, error: realmError,
                        mode: 'ocapi', backupReason
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

    console.log(`${LOG_PREFIX.INFO} Metadata strategy by realm:`);
    for (const result of allResults) {
        if (result.mode === 'metadata') {
            if (result.backupStatus === 'EXISTING') {
                console.log(`  - ${result.realm}: metadata existing file (no job run)`);
            } else {
                console.log(`  - ${result.realm}: metadata fresh job execution`);
            }
        } else if (result.mode === 'ocapi') {
            console.log(
                `  - ${result.realm}: switched to old OCAPI method`
                + `${result.backupReason ? ` (${result.backupReason})` : ''}`
            );
        } else {
            console.log(`  - ${result.realm}: ${result.mode || 'unknown mode'}`);
        }
    }
    console.log('');

    // Report backup fallbacks (why metadata was skipped per realm)
    const ocapiFallbacks = allResults.filter(r => r.backupReason);
    if (ocapiFallbacks.length > 0) {
        for (const { realm, backupReason } of ocapiFallbacks) {
            console.log(
                `${LOG_PREFIX.WARNING} ${realm}: ` +
                `metadata backup skipped — ${backupReason}. Used OCAPI.`
            );
        }
        console.log('');
    }

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

    console.log('');

    // --- STEP 3: Check Preference Usage ---
    logSectionTitle('STEP 3: Checking Preference Usage');

    const realmsProcessed = allResults.filter(r => r.success).map(r => r.realm);
    const matrixFiles = findAllMatrixFiles(realmsProcessed);

    if (matrixFiles.length === 0) {
        logNoMatrixFiles();
        console.log('');
        logRuntime(timer);
        return;
    }

    logMatrixFilesFound(matrixFiles.length);

    const summary = await processPreferenceMatrixFiles(matrixFiles);

    logSummaryHeader();
    for (const stats of summary) {
        logRealmSummary(stats);
    }
    logSummaryFooter();

    // --- STEP 4: Active Preferences Summary ---
    logSectionTitle('STEP 4: Active Preferences Summary');

    const matrixFilePaths = matrixFiles.map(f => f.matrixFile);
    const activePreferences = Array.from(getActivePreferencesFromMatrices(matrixFilePaths)).sort();
    console.log(`Active Preferences (${activePreferences.length}):\n`);

    // --- STEP 5: Refresh Active Site Cartridge Lists ---
    logSectionTitle('STEP 5: Refresh Active Site Cartridge Lists');

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
            console.log(
                `${LOG_PREFIX.WARNING} Realm-specific deletion tags may fall back to `
                + `${IDENTIFIERS.ALL} for affected realm(s).`
            );
        }
    }

    // --- STEP 6: Find Preference Usage in Cartridges ---
    logSectionTitle('STEP 6: Finding Preference Usage in Cartridges');

    if (repositoryPaths.length > 0 && realmsProcessed.length > 0) {
        const repoNames = repositoryPaths.map(p => path.basename(p));
        const repoLabel = repoNames.length === 1
            ? repoNames[0]
            : `${repoNames.length} repositories`;
        const realmsByInstanceType = new Map();

        for (const realm of realmsProcessed) {
            const instanceType = getInstanceType(realm);
            if (!realmsByInstanceType.has(instanceType)) {
                realmsByInstanceType.set(instanceType, []);
            }
            realmsByInstanceType.get(instanceType).push(realm);
        }

        const scanDisplay = new RealmProgressDisplay(250);
        const scanStep = `scan_${Date.now()}`;
        scanDisplay.startStep(
            'codeScanner', 'Code Scanner', scanStep,
            `Scanning ${repoLabel} for references`
        );
        scanDisplay.start();

        const scanCallback = (scannedCount, totalFiles) => {
            const percentage = Math.round(
                (scannedCount / totalFiles) * 100
            );
            scanDisplay.setStepProgress(
                'codeScanner', scanStep, percentage
            );
            scanDisplay.setStepMessage(
                'codeScanner', scanStep,
                `${scannedCount}/${totalFiles} files`, 'info'
            );
        };

        try {
            for (const [instanceType, realmsForType] of realmsByInstanceType.entries()) {
                console.log(
                    `${LOG_PREFIX.INFO} Creating deletion list for instance type `
                    + `${instanceType} (${realmsForType.length} realm(s))...`
                );

                await findAllActivePreferencesUsage(repositoryPaths, {
                    instanceTypeOverride: instanceType,
                    progressCallback: scanCallback,
                    realmFilter: realmsForType
                });

                const deletionFilePath = path.join(
                    process.cwd(),
                    DIRECTORIES.RESULTS,
                    instanceType,
                    IDENTIFIERS.ALL_REALMS,
                    `${instanceType}${FILE_PATTERNS.PREFERENCES_FOR_DELETION}`
                );

                if (fs.existsSync(deletionFilePath)) {
                    console.log(`${LOG_PREFIX.INFO} Deletion list created: ${deletionFilePath}`);
                } else {
                    console.log(
                        `${LOG_PREFIX.WARNING} No deletion list created for ${instanceType}. `
                        + 'This usually means no candidates were found after safety filters.'
                    );
                }
            }

            scanDisplay.completeStep('codeScanner', scanStep);
        } catch (scanError) {
            scanDisplay.failStep('codeScanner', scanStep);
            throw scanError;
        } finally {
            scanDisplay.finish();
        }
    }

    console.log('');
    logRuntime(timer);
}
