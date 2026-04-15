import inquirer from 'inquirer';
import path from 'path';
import fs from 'fs';
import { startTimer } from '../../../helpers/timer.js';
import { promptForRepositoryPath } from '../../meta/actions/shared.js';
import {
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
    selectUnusedTypesForDeletionPrompt,
    confirmDeletePrompt
} from '../../prompts/customObjectPrompts.js';
import { ensureResultsDir } from '../../../io/util.js';

// ============================================================================
// DELETE CUSTOM OBJECTS
// Remove unused CO type definitions and instance records from the repo
// ============================================================================

export async function deleteCustomObjects(options = {}) {
    const dryRun = options.dryRun === true;
    const timer = startTimer();

    console.log(`\n${'═'.repeat(80)}`);
    console.log(` DELETE UNUSED CUSTOM OBJECT TYPES${dryRun ? ' (DRY RUN)' : ''}`);
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
    const { analysisMap } = await analyzeCustomObjectUsageByRealm({
        repoPath,
        coreTypeIds: filteredTypeIdSet,
        codeUsageMap,
        realms: realmsToProcess
    });

    const { unused } = classifyCustomObjectTypes(analysisMap, realmsToProcess);

    // --- STEP 4: Select unused types to delete ---
    logSectionTitle('STEP 4: Select Unused Types to Delete');

    if (unused.length === 0) {
        console.log(`${LOG_PREFIX.INFO} No unused custom object types found.\n`);
        logRuntime(timer);
        return;
    }

    console.log(`  ${unused.length} unused type(s) found:`);
    for (const typeId of unused) {
        console.log(`    ${typeId}`);
    }
    console.log('');

    const { selectedTypes } = await inquirer.prompt(
        selectUnusedTypesForDeletionPrompt(unused)
    );

    if (selectedTypes.length === 0) {
        console.log(`${LOG_PREFIX.INFO} No types selected. Aborting.\n`);
        logRuntime(timer);
        return;
    }

    // --- STEP 5: Build and review delete plan ---
    logSectionTitle('STEP 5: Review Delete Plan');
    const plan = buildDeletePlan({ repoPath, unusedTypes: selectedTypes });

    console.log(formatDeletePlan(plan));

    if (plan.actions.length === 0) {
        console.log(`${LOG_PREFIX.INFO} No actions to execute.\n`);
        logRuntime(timer);
        return;
    }

    // --- STEP 6: Check for live records on instance ---
    logSectionTitle('STEP 6: Check for Live Records');
    console.log('  Checking SFCC instances for existing records...\n');
    const typesWithRecords = await checkLiveCustomObjectRecords(selectedTypes, realmsToProcess);

    if (typesWithRecords.size > 0) {
        console.log(formatLiveRecordWarnings(typesWithRecords));
    } else {
        console.log(`  ${LOG_PREFIX.INFO} No live records found for selected types.\n`);
    }

    // --- STEP 7: Confirm and execute ---
    logSectionTitle(`STEP 7: Execute${dryRun ? ' (Dry Run)' : ''}`);
    const defCount = plan.actions.filter(a => a.type === 'delete-def').length;
    const { confirm } = await inquirer.prompt(confirmDeletePrompt(defCount));

    if (!confirm) {
        console.log(`\n${LOG_PREFIX.INFO} Deletion cancelled.\n`);
        logRuntime(timer);
        return;
    }

    const results = executeDeletePlan(plan, { dryRun });

    console.log(`\n${formatDeleteResults(results)}\n`);

    // Write QA report
    const repoName = path.basename(repoPath);
    const report = formatDeleteReport({
        repoName,
        instanceType,
        realms: realmsToProcess,
        selectedTypes,
        plan,
        typesWithRecords,
        results,
        dryRun
    });
    const resultsDir = ensureResultsDir('ALL_REALMS', instanceType);
    const reportPath = path.join(resultsDir, `${instanceType}_custom_object_deletion.txt`);
    fs.writeFileSync(reportPath, report, 'utf-8');
    console.log(`${LOG_PREFIX.INFO} Report saved to: ${reportPath}`);

    if (dryRun) {
        console.log(`${LOG_PREFIX.INFO} Dry-run complete. No files were modified.\n`);
    } else {
        console.log(`${LOG_PREFIX.INFO} Deletion complete. Review the changes in your repository.\n`);
    }

    logRuntime(timer);
}
