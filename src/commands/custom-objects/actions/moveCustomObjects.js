import inquirer from 'inquirer';
import path from 'path';
import fs from 'fs';
import { startTimer } from '../../../helpers/timer.js';
import { promptForRepositoryPath } from '../../meta/actions/shared.js';
import {
    getAvailableRealms,
    getRealmsByInstanceType,
    getCoreSiteTemplatePath
} from '../../../config/helpers/helpers.js';
import { LOG_PREFIX } from '../../../config/constants.js';
import {
    logSectionTitle,
    logRuntime
} from '../../../scripts/loggingScript/log.js';
import {
    collectCustomTypeIds,
    scanCodeForCustomObjectUsage,
    analyzeCustomObjectUsageByRealm,
    classifyCustomObjectTypes
} from '../helpers/customObjectScanner.js';
import { filterBlacklisted } from '../helpers/customObjectBlacklistHelper.js';
import { filterWhitelisted } from '../helpers/customObjectWhitelistHelper.js';
import {
    buildMovePlan,
    executeMovePlan,
    formatMovePlan,
    formatMoveResults,
    formatMoveReport,
    buildDeletePlan,
    executeDeletePlan,
    formatDeletePlan,
    formatDeleteResults,
    formatDeleteReport,
    checkLiveCustomObjectRecords,
    formatLiveRecordWarnings
} from '../helpers/customObjectMover.js';
import {
    instanceTypePrompt,
    selectRealmsForInstancePrompt
} from '../../prompts/index.js';
import {
    confirmMovePrompt,
    confirmDeletePrompt,
    selectCustomObjectTypesPrompt,
    selectUnusedTypesForDeletionPrompt
} from '../../prompts/customObjectPrompts.js';
import { ensureResultsDir } from '../../../io/util.js';

// ============================================================================
// MOVE CUSTOM OBJECTS
// Move single-realm CO types from core to realm-specific meta directories
// ============================================================================

export async function moveCustomObjects(options = {}) {
    const dryRun = options.dryRun === true;
    const timer = startTimer();

    console.log(`\n${'═'.repeat(80)}`);
    console.log(` MOVE CUSTOM OBJECT TYPES${dryRun ? ' (DRY RUN)' : ''}`);
    console.log(`${'═'.repeat(80)}\n`);

    if (dryRun) {
        const yellow = '\x1b[33m';
        const reset = '\x1b[0m';
        console.log(`${yellow}  ⚠  DRY-RUN MODE: No files will be modified.${reset}\n`);
    }

    // --- STEP 1: Select sibling repository ---
    logSectionTitle('STEP 1: Select Repository');
    const repoPath = await promptForRepositoryPath();
    if (!repoPath) {
        return;
    }
    console.log(`  Repository: ${repoPath}\n`);

    // --- STEP 2: Select realms ---
    logSectionTitle('STEP 2: Select Realms');
    const { instanceType } = await inquirer.prompt(instanceTypePrompt('sandbox'));
    const realmsForInstance = getRealmsByInstanceType(instanceType);

    if (realmsForInstance.length === 0) {
        console.log(`${LOG_PREFIX.WARNING} No realms found for instance type: ${instanceType}\n`);
        logRuntime(timer);
        return;
    }

    let realmsToProcess = realmsForInstance;
    if (realmsForInstance.length > 1) {
        const realmSelection = await inquirer.prompt(selectRealmsForInstancePrompt(instanceType));
        realmsToProcess = realmSelection.realms;
    }

    console.log(`  Realms: ${realmsToProcess.join(', ')}\n`);

    // --- STEP 3: Scan and analyze ---
    logSectionTitle('STEP 3: Scan & Analyze Custom Object Types');
    const coreMetaDir = path.join(repoPath, getCoreSiteTemplatePath(), 'meta');

    if (!fs.existsSync(coreMetaDir)) {
        console.log(`${LOG_PREFIX.WARNING} Core meta directory not found: ${coreMetaDir}\n`);
        logRuntime(timer);
        return;
    }

    const { typeIds: coreTypeIds } = collectCustomTypeIds(coreMetaDir);

    if (coreTypeIds.size === 0) {
        console.log(`${LOG_PREFIX.INFO} No custom object types found in core meta.\n`);
        logRuntime(timer);
        return;
    }

    console.log(`  Found ${coreTypeIds.size} custom object type(s) in core meta.`);

    // Apply blacklist/whitelist filters
    const allCoreIds = [...coreTypeIds];
    const { allowed: afterBlacklist, blocked: blacklisted } = filterBlacklisted(allCoreIds);
    if (blacklisted.length > 0) {
        console.log(`  ${LOG_PREFIX.INFO} Blacklisted (excluded): ${blacklisted.length} type(s)`);
    }
    const { allowed: filteredIds, blocked: notWhitelisted } = filterWhitelisted(afterBlacklist);
    if (notWhitelisted.length > 0) {
        console.log(`  ${LOG_PREFIX.INFO} Not whitelisted (excluded): ${notWhitelisted.length} type(s)`);
    }

    if (filteredIds.length === 0) {
        console.log(`${LOG_PREFIX.WARNING} No custom object types remaining after filtering.\n`);
        logRuntime(timer);
        return;
    }

    const filteredTypeIdSet = new Set(filteredIds);

    const codeUsageMap = scanCodeForCustomObjectUsage(repoPath, filteredIds);
    const { analysisMap, realmSites } = await analyzeCustomObjectUsageByRealm({
        repoPath,
        coreTypeIds: filteredTypeIdSet,
        codeUsageMap,
        realms: realmsToProcess
    });

    const { unused, singleRealm, multiRealm } = classifyCustomObjectTypes(
        analysisMap, realmsToProcess
    );

    console.log(`  Unused: ${unused.length}, Single-realm: ${singleRealm.size}, Multi-realm: ${multiRealm.length}\n`);

    // --- STEP 4: Select types to move ---
    logSectionTitle('STEP 4: Select Types to Move');

    if (singleRealm.size === 0) {
        console.log(`${LOG_PREFIX.INFO} No single-realm custom object types found to move.\n`);
        await deleteUnusedTypesPhase({ unused, repoPath, realms: realmsToProcess, instanceType, dryRun });
        logRuntime(timer);
        return;
    }

    // Show candidates
    console.log('  Single-realm candidates:');
    for (const [typeId, realm] of singleRealm) {
        const info = analysisMap.get(typeId);
        console.log(`    ${typeId} → ${realm} (${info?.codeRefs || 0} code refs)`);
    }
    console.log('');

    // Let user select which ones to move
    const typeIdsToSelect = [...singleRealm.keys()];
    const { selectedTypes } = await inquirer.prompt(
        selectCustomObjectTypesPrompt(typeIdsToSelect)
    );

    if (selectedTypes.length === 0) {
        console.log(`${LOG_PREFIX.INFO} No types selected for move.\n`);
        await deleteUnusedTypesPhase({ unused, repoPath, realms: realmsToProcess, instanceType, dryRun });
        logRuntime(timer);
        return;
    }

    // Filter singleRealmMap to only selected types
    const selectedMap = new Map();
    for (const typeId of selectedTypes) {
        selectedMap.set(typeId, singleRealm.get(typeId));
    }

    // --- STEP 5: Build and review move plan ---
    logSectionTitle('STEP 5: Review Move Plan');
    const plan = buildMovePlan({ repoPath, singleRealmMap: selectedMap });

    console.log(formatMovePlan(plan));

    if (plan.actions.length === 0) {
        console.log(`${LOG_PREFIX.INFO} No actions to execute.\n`);
        logRuntime(timer);
        return;
    }

    // --- STEP 6: Confirm and execute ---
    logSectionTitle(`STEP 6: Execute${dryRun ? ' (Dry Run)' : ''}`);
    const { confirm } = await inquirer.prompt(confirmMovePrompt(plan.actions.length));

    if (!confirm) {
        console.log(`\n${LOG_PREFIX.INFO} Move cancelled.\n`);
        await deleteUnusedTypesPhase({ unused, repoPath, realms: realmsToProcess, instanceType, dryRun });
        logRuntime(timer);
        return;
    }

    const results = executeMovePlan(plan, { dryRun });

    console.log(`\n${formatMoveResults(results)}\n`);

    // Write QA report
    const repoName = path.basename(repoPath);
    const moveReport = formatMoveReport({
        repoName,
        instanceType,
        realms: realmsToProcess,
        selectedMap,
        analysisMap,
        realmSites,
        results,
        dryRun
    });
    const resultsDir = ensureResultsDir('ALL_REALMS', instanceType);
    const reportPath = path.join(resultsDir, `${instanceType}_custom_object_move.txt`);
    fs.writeFileSync(reportPath, moveReport, 'utf-8');
    console.log(`${LOG_PREFIX.INFO} Report saved to: ${reportPath}`);

    if (dryRun) {
        console.log(`${LOG_PREFIX.INFO} Dry-run complete. No files were modified.\n`);
    } else {
        console.log(`${LOG_PREFIX.INFO} Move complete.\n`);
    }

    // --- STEP 7: Delete unused types ---
    await deleteUnusedTypesPhase({ unused, repoPath, realms: realmsToProcess, instanceType, dryRun });

    logRuntime(timer);
}

/**
 * Post-move phase: offer to delete unused CO types.
 * @param {Object} options
 * @param {string[]} options.unused - Unused type IDs from classification
 * @param {string} options.repoPath - Repository path
 * @param {string[]} options.realms - Realms to check for live records
 * @param {string} options.instanceType - Instance type for report path
 * @param {boolean} options.dryRun - Dry-run mode
 */
async function deleteUnusedTypesPhase({ unused, repoPath, realms, instanceType, dryRun }) {
    if (unused.length === 0) {
        return;
    }

    logSectionTitle('STEP 7: Delete Unused Types');
    console.log(`  ${unused.length} unused type(s) found:`);
    for (const typeId of unused) {
        console.log(`    ${typeId}`);
    }
    console.log('');

    const { selectedTypes } = await inquirer.prompt(
        selectUnusedTypesForDeletionPrompt(unused)
    );

    if (selectedTypes.length === 0) {
        console.log(`${LOG_PREFIX.INFO} No unused types selected for deletion.\n`);
        return;
    }

    const deletePlan = buildDeletePlan({ repoPath, unusedTypes: selectedTypes });
    console.log(formatDeletePlan(deletePlan));

    if (deletePlan.actions.length === 0) {
        console.log(`${LOG_PREFIX.INFO} No delete actions to execute.\n`);
        return;
    }

    // Check for live records on the instance
    console.log('  Checking SFCC instances for existing records...\n');
    const typesWithRecords = await checkLiveCustomObjectRecords(selectedTypes, realms);

    if (typesWithRecords.size > 0) {
        console.log(formatLiveRecordWarnings(typesWithRecords));
    } else {
        console.log(`  ${LOG_PREFIX.INFO} No live records found for selected types.\n`);
    }

    const defCount = deletePlan.actions.filter(a => a.type === 'delete-def').length;
    const { confirm } = await inquirer.prompt(confirmDeletePrompt(defCount));

    if (!confirm) {
        console.log(`\n${LOG_PREFIX.INFO} Deletion skipped.\n`);
        return;
    }

    const deleteResults = executeDeletePlan(deletePlan, { dryRun });
    console.log(`\n${formatDeleteResults(deleteResults)}\n`);

    // Write QA report
    const repoName = path.basename(repoPath);
    const deleteReport = formatDeleteReport({
        repoName,
        instanceType,
        realms,
        selectedTypes,
        plan: deletePlan,
        typesWithRecords,
        results: deleteResults,
        dryRun
    });
    const resultsDir = ensureResultsDir('ALL_REALMS', instanceType);
    const reportPath = path.join(resultsDir, `${instanceType}_custom_object_deletion.txt`);
    fs.writeFileSync(reportPath, deleteReport, 'utf-8');
    console.log(`${LOG_PREFIX.INFO} Report saved to: ${reportPath}`);
}
