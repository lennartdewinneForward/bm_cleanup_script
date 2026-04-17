import inquirer from 'inquirer';
import path from 'path';
import { startTimer } from '../../../helpers/timer.js';
import { promptForRepositoryPath } from '../../meta/actions/shared.js';
import {
    getAvailableRealms
} from '../../../config/helpers/helpers.js';
import { LOG_PREFIX } from '../../../config/constants.js';
import {
    logSectionTitle,
    logRuntime
} from '../../../scripts/loggingScript/log.js';
import { ensureResultsDir } from '../../../io/util.js';
import {
    collectAllCustomTypeIds,
    scanCodeForCustomObjectUsage,
    analyzeCustomObjectUsageByRealm,
    classifyCustomObjectTypes,
    formatAnalysisReport
} from '../helpers/customObjectScanner.js';
import { filterBlacklisted } from '../helpers/customObjectBlacklistHelper.js';
import { filterWhitelisted } from '../helpers/customObjectWhitelistHelper.js';
import {
    checkOrphanedRecordsForMoves,
    formatOrphanedRecordWarnings,
    checkLiveCustomObjectRecords,
    formatLiveRecordWarnings
} from '../helpers/customObjectMover.js';
import { selectRealmsForInstancePrompt, instanceTypePrompt } from '../../prompts/index.js';
import { getRealmsByInstanceType } from '../../../config/helpers/helpers.js';
import fs from 'fs';

// ============================================================================
// ANALYZE CUSTOM OBJECTS
// Scan repo meta XML for CO type definitions, scan code for usage, classify
// ============================================================================

export async function analyzeCustomObjects() {
    const timer = startTimer();

    console.log(`\n${'═'.repeat(80)}`);
    console.log(' CUSTOM OBJECT TYPE ANALYSIS');
    console.log(`${'═'.repeat(80)}\n`);

    // --- STEP 1: Select sibling repository ---
    logSectionTitle('STEP 1: Select Repository');
    const repoPath = await promptForRepositoryPath();
    if (!repoPath) {
        return;
    }
    const repoName = path.basename(repoPath);
    console.log(`  Repository: ${repoPath}\n`);

    // --- STEP 2: Select realms ---
    logSectionTitle('STEP 2: Select Realms');
    const allRealms = getAvailableRealms();

    if (allRealms.length === 0) {
        console.log(`${LOG_PREFIX.WARNING} No realms configured. Run "add-realm" first.\n`);
        logRuntime(timer);
        return;
    }

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

    console.log(`  Processing ${realmsToProcess.length} realm(s): ${realmsToProcess.join(', ')}\n`);

    // --- STEP 3: Scan ALL meta sources for custom-type definitions ---
    logSectionTitle('STEP 3: Scan All Meta Sources for Custom Object Types');

    const { typeIds: allTypeIds, fileMap: allFileMap, sourceMap } = collectAllCustomTypeIds(
        repoPath, realmsToProcess
    );

    if (allTypeIds.size === 0) {
        console.log(`${LOG_PREFIX.INFO} No custom object type definitions found in any meta source.\n`);
        logRuntime(timer);
        return;
    }

    console.log(`  Found ${allTypeIds.size} custom object type(s) across all meta sources:`);
    for (const [typeId, files] of allFileMap) {
        const source = sourceMap.get(typeId) || 'unknown';
        console.log(`    ${typeId} (${files.map(f => path.basename(f)).join(', ')}) [${source}]`);
    }
    console.log('');

    // --- STEP 3b: Apply blacklist/whitelist filters ---
    const allTypeIdArray = [...allTypeIds];

    const { allowed: afterBlacklist, blocked: blacklisted } = filterBlacklisted(allTypeIdArray);
    if (blacklisted.length > 0) {
        console.log(`  ${LOG_PREFIX.INFO} Blacklisted (excluded): ${blacklisted.length} type(s)`);
        for (const id of blacklisted) {
            console.log(`    - ${id}`);
        }
        console.log('');
    }

    const { allowed: filteredTypeIds, blocked: notWhitelisted } = filterWhitelisted(afterBlacklist);
    if (notWhitelisted.length > 0) {
        console.log(`  ${LOG_PREFIX.INFO} Not whitelisted (excluded): ${notWhitelisted.length} type(s)`);
        console.log('');
    }

    if (filteredTypeIds.length === 0) {
        console.log(`${LOG_PREFIX.WARNING} No custom object types remaining after filtering.\n`);
        logRuntime(timer);
        return;
    }

    if (filteredTypeIds.length < allTypeIdArray.length) {
        console.log(
            `  Proceeding with ${filteredTypeIds.length} of ${allTypeIdArray.length}`
            + ` type(s) after filtering.\n`
        );
    }

    const filteredTypeIdSet = new Set(filteredTypeIds);

    // --- STEP 4: Scan cartridge code for CO type references ---
    logSectionTitle('STEP 4: Scan Cartridge Code for Usage');
    const codeUsageMap = scanCodeForCustomObjectUsage(repoPath, filteredTypeIds);

    let totalRefs = 0;
    let typesWithRefs = 0;
    for (const [typeId, matches] of codeUsageMap) {
        if (matches.length > 0) {
            typesWithRefs++;
            totalRefs += matches.length;
            console.log(`  ${typeId}: ${matches.length} reference(s)`);
        }
    }

    if (typesWithRefs === 0) {
        console.log(`  ${LOG_PREFIX.WARNING} No code references found for any custom object type.`);
    } else {
        console.log(`\n  ${typesWithRefs} type(s) with code references, ${totalRefs} total references.`);
    }
    console.log('');

    // --- STEP 5: Analyze realm usage ---
    logSectionTitle('STEP 5: Analyze Realm Usage');
    const { analysisMap, realmSites } = await analyzeCustomObjectUsageByRealm({
        repoPath,
        coreTypeIds: filteredTypeIdSet,
        codeUsageMap,
        realms: realmsToProcess
    });

    for (const [typeId, analysis] of analysisMap) {
        console.log(
            `  ${typeId}: realms=[${analysis.realms.join(', ')}]`
            + ` codeRefs=${analysis.codeRefs}`
            + ` cartridges=[${analysis.cartridges.join(', ')}]`
        );
    }
    console.log('');

    // --- STEP 6: Classify and report ---
    logSectionTitle('STEP 6: Classification & Report');
    const { unused, singleRealm, multiRealm } = classifyCustomObjectTypes(
        analysisMap, realmsToProcess
    );

    // --- STEP 6b: Check for live records on SFCC instances (OCAPI) ---
    let typesWithRecords = new Map();
    const allCandidateTypes = [...unused, ...[...singleRealm.keys()]];
    if (allCandidateTypes.length > 0) {
        logSectionTitle('STEP 6b: Check for Live Records (OCAPI)');
        console.log('  Checking all realms for existing records...\n');
        typesWithRecords = await checkLiveCustomObjectRecords(allCandidateTypes, realmsToProcess);

        if (typesWithRecords.size > 0) {
            console.log(formatLiveRecordWarnings(typesWithRecords));
        } else {
            console.log(`  ${LOG_PREFIX.INFO} No live records found.\n`);
        }
    }

    // --- STEP 6c: Check for orphaned records in non-target realms ---
    let orphanedRecords = new Map();
    if (singleRealm.size > 0 && realmsToProcess.length > 1) {
        logSectionTitle('STEP 6c: Check for Orphaned Records (OCAPI)');
        console.log('  Checking non-target realms for existing records...\n');
        orphanedRecords = await checkOrphanedRecordsForMoves(singleRealm, realmsToProcess);

        if (orphanedRecords.size > 0) {
            console.log(formatOrphanedRecordWarnings(orphanedRecords));
        } else {
            console.log(`  ${LOG_PREFIX.INFO} No orphaned records found.\n`);
        }
    }

    const report = formatAnalysisReport({
        unused,
        singleRealm,
        multiRealm,
        analysisMap,
        realmSites,
        typesWithRecords,
        orphanedRecords,
        repoName
    });

    console.log(report);

    // Write report to results directory
    const resultsDir = ensureResultsDir('ALL_REALMS', instanceType);
    const reportPath = path.join(resultsDir, `${instanceType}_custom_object_analysis.txt`);
    fs.writeFileSync(reportPath, report, 'utf-8');
    console.log(`\n${LOG_PREFIX.INFO} Report saved to: ${reportPath}`);

    // Summary
    console.log(`\n${'─'.repeat(80)}`);
    console.log(' Summary:');
    console.log(`  ${unused.length} unused / obsolete type(s) (candidates for deletion)`);
    console.log(`  ${singleRealm.size} single-realm type(s) (candidates for move)`);
    console.log(`  ${multiRealm.length} shared type(s) (keep in core)`);
    console.log(`\n  ${unused.length + singleRealm.size + multiRealm.length} type(s) analyzed in total`);

    if (singleRealm.size > 0) {
        console.log(`\n  Run "move-custom-objects" to move single-realm types to their realm folder.`);
    }
    console.log('');

    logRuntime(timer);
}
