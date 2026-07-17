import inquirer from 'inquirer';
import path from 'path';
import { startTimer } from '../../../helpers/timer.js';
import { getSiblingRepositories } from '../../../io/util.js';
import {
    repositoryPrompt,
    resolveRealmScopeSelection,
    deletionLevelPrompt,
    deletionSourcePrompt,
    confirmExecutionPrompt,
    uncommittedChangesPrompt,
    branchStrategyPrompt,
    baseBranchPrompt,
    branchNamePrompt,
    consolidateMetaPrompt,
    consolidationFailurePrompt,
    confirmCommitPrompt,
    commitMessagePrompt,
    debugBatchContinuePrompt,
    typeIdPrompt
} from '../../prompts/index.js';
import {
    buildMetaCleanupPlan,
    executeMetaCleanupPlan,
    formatCleanupPlan,
    formatExecutionResults,
    removePreferenceValuesFromSites,
    formatPreferenceValueResults,
    stripCustomPrefix,
    loadMetaCleanupLogic,
    enrichRegionalGroups,
    discoverTypeIds,
    getCoreMetaDir
} from '../helpers/metaFileCleanup.js';
import {
    validateMetaChanges,
    formatValidationReport,
    fixXmlIndentation
} from '../helpers/metaChangeValidator.js';
import {
    consolidateMetaFiles,
    formatConsolidationResults
} from '../helpers/metaConsolidation.js';
import { getInstanceType, getRealmsByInstanceType } from '../../../config/helpers/helpers.js';
import { TIER_DESCRIPTIONS, LOG_PREFIX } from '../../../config/constants.js';
import {
    getCurrentBranch,
    listBranches,
    hasUncommittedChanges,
    getStatusSummary,
    createAndCheckoutBranch,
    stageAllChanges,
    commitChanges,
    getStagedDiffStat,
    generateCleanupBranchName
} from '../helpers/gitHelper.js';
import { loadDeletionCandidates, runCrossRealmScanIfNeeded } from './shared.js';

// ============================================================================
// META CLEANUP
// Full git workflow — create branch, remove preference definitions, stage & commit
// ============================================================================

export async function metaCleanup(options = {}) {
    const timer = startTimer();
    const debugBatchSize = parseDebugOption(options.debug);
    const isDebug = debugBatchSize > 0;

    console.log(`\n${'═'.repeat(80)}`);
    console.log(' META FILE CLEANUP — FULL WORKFLOW');
    console.log(`${'═'.repeat(80)}\n`);

    if (isDebug) {
        console.log(`  🔍 Debug mode: processing ${debugBatchSize} preference(s) per batch\n`);
    }

    // --- STEP 1: Select sibling repository ---
    const siblings = await getSiblingRepositories();
    if (siblings.length === 0) {
        console.log('No sibling repositories found.');
        return;
    }

    const siblingAnswers = await inquirer.prompt(await repositoryPrompt(siblings));
    const repoPath = path.join(path.dirname(process.cwd()), siblingAnswers.repository);

    // --- STEP 1b: Select type-id ---
    const coreMetaDir = getCoreMetaDir(repoPath);
    const availableTypeIds = discoverTypeIds(coreMetaDir);

    if (availableTypeIds.length === 0) {
        console.log('  No type-extension definitions found in core meta directory.');
        return;
    }

    const { typeId } = await inquirer.prompt(typeIdPrompt(availableTypeIds));
    console.log(`  Selected type-id: ${typeId}\n`);

    // --- STEP 2: Show repo status ---
    const currentBranch = getCurrentBranch(repoPath);
    console.log(`  Repository: ${repoPath}`);
    console.log(`  Current branch: ${currentBranch}`);

    if (hasUncommittedChanges(repoPath)) {
        console.log('\n  ⚠  Uncommitted changes detected:\n');
        console.log(getStatusSummary(repoPath)
            .split('\n')
            .map(l => `    ${l}`)
            .join('\n'));

        const { proceed } = await inquirer.prompt(
            uncommittedChangesPrompt()
        );

        if (!proceed) {
            console.log('\n  Aborted — commit or stash changes first.\n');
            return;
        }
    }

    // --- STEP 3: Select realms ---
    const { realmList, instanceTypeOverride } = await resolveRealmScopeSelection(
        (questions) => inquirer.prompt(questions)
    );

    if (!realmList || realmList.length === 0) {
        console.log('No realms selected.');
        return;
    }

    const instanceType = instanceTypeOverride || getInstanceType(realmList[0]);
    const isSitePreferences = typeId === 'SitePreferences';

    // --- STEP 4–5: Load attributes (branched by type-id) ---
    let realmPreferenceMap;
    let selectedPreferenceIds;
    let maxTier = null;
    let useCrossRealm = false;
    let metaCleanupLogic = null;

    // Tier selection — applies to all type-ids
    const tierAnswers = await inquirer.prompt(deletionLevelPrompt());
    maxTier = tierAnswers.deletionLevel;

    const { deletionSource } = await inquirer.prompt(deletionSourcePrompt());
    useCrossRealm = deletionSource === 'cross-realm';

    console.log(`\n  Loading ${typeId} deletion candidates up to tier ${maxTier}...`);
    console.log(`  Source: ${useCrossRealm ? 'Cross-realm intersection' : 'Per-realm files'}`);
    console.log(`  Realms: ${realmList.join(', ')}`);
    console.log(`  Instance type: ${instanceType}\n`);

    const loaded = loadDeletionCandidates({
        realmList,
        instanceType,
        maxTier,
        useCrossRealm,
        objectType: isSitePreferences ? undefined : typeId
    });
    realmPreferenceMap = loaded.realmPreferenceMap;
    selectedPreferenceIds = loaded.selectedPreferenceIds;

    if (loaded.totalPrefs === 0) {
        console.log(
            `\n  No ${typeId} deletion candidates found.`
            + ' Run analyze-preferences first.\n'
        );
        return;
    }

    if (isSitePreferences) {
        metaCleanupLogic = loadMetaCleanupLogic(instanceType);
        if (metaCleanupLogic) {
            console.log(
                `  Meta-cleanup-logic: ${metaCleanupLogic.totalEntries} entries`
                + ` (${metaCleanupLogic.mismatchCount} cross-realm mismatches)`
            );
            if (metaCleanupLogic.excludedPaths.length > 0) {
                console.log(
                    `  Protected paths from previous migrations: ${metaCleanupLogic.excludedPaths.length}`
                );
            }
        } else {
            console.log('  Meta-cleanup-logic.json not found — run analyze-preferences first for'
                + ' cross-realm migration support.');
        }
    }

    const allInstanceRealms = getRealmsByInstanceType(instanceType);

    // --- Build and show full plan first ---
    const fullPlan = buildMetaCleanupPlan(
        repoPath, realmPreferenceMap, allInstanceRealms, { crossRealm: useCrossRealm, typeId }
    );

    console.log(formatCleanupPlan(fullPlan));

    if (fullPlan.actions.length === 0) {
        console.log('  No meta file changes needed.');
        runCrossRealmScanIfNeeded({ useCrossRealm, repoPath, selectedPreferenceIds });
        return;
    }

    // --- STEP 6: Branch strategy ---
    const { branchStrategy } = await inquirer.prompt(
        branchStrategyPrompt(currentBranch)
    );
    const useCurrentBranch = branchStrategy === 'current';

    let branchName = currentBranch;

    if (!useCurrentBranch) {
        const branches = listBranches(repoPath);
        const { baseBranch } = await inquirer.prompt(
            baseBranchPrompt(branches, currentBranch)
        );

        const branchSuffix = isSitePreferences
            ? `${maxTier}-${instanceType}`
            : `${typeId}-${instanceType}`;
        const suggestedName = generateCleanupBranchName(branchSuffix);

        const { branchName: newBranchName } = await inquirer.prompt(
            branchNamePrompt(suggestedName, branches)
        );
        branchName = newBranchName;

        console.log(`\n  Creating branch ${branchName} from ${baseBranch}...`);

        const branchCreated = createAndCheckoutBranch(repoPath, branchName.trim(), baseBranch);
        if (!branchCreated) {
            console.log('  ✗ Failed to create branch. Aborting.\n');
            return;
        }
    } else {
        console.log(`\n  Applying changes to current branch: ${currentBranch}`);
    }

    // --- STEP 7: Confirm and execute (batched in debug mode) ---
    const excludedPaths = metaCleanupLogic?.excludedPaths || [];
    const aggregatedResults = {
        filesModified: [], filesDeleted: [], filesCreated: [], errors: [], executedActions: []
    };

    if (isDebug) {
        // Collect all unique preference IDs across realms
        const allPrefIds = collectUniquePrefIds(realmPreferenceMap);
        let offset = 0;
        let batchNumber = 0;

        while (offset < allPrefIds.length) {
            const batchIds = allPrefIds.slice(offset, offset + debugBatchSize);
            batchNumber++;
            const remaining = allPrefIds.length - offset - batchIds.length;

            console.log(`\n${'─'.repeat(60)}`);
            console.log(
                `  DEBUG BATCH ${batchNumber}: ${batchIds.length} preference(s)`
                + ` (${offset + 1}–${offset + batchIds.length} of ${allPrefIds.length})`
            );
            console.log(`${'─'.repeat(60)}`);

            // Slice the realmPreferenceMap to only include this batch's IDs
            const batchMap = sliceRealmPreferenceMap(realmPreferenceMap, batchIds);
            const batchPlan = buildMetaCleanupPlan(
                repoPath, batchMap, allInstanceRealms, { crossRealm: useCrossRealm, typeId }
            );

            console.log(formatCleanupPlan(batchPlan));

            if (batchPlan.actions.length === 0) {
                console.log('  No actions for this batch — skipping.\n');
                offset += batchIds.length;
                continue;
            }

            const { confirm: confirmBatch } = await inquirer.prompt(
                confirmExecutionPrompt({
                    actionCount: batchPlan.actions.length,
                    repoName: siblingAnswers.repository
                })
            );

            if (!confirmBatch) {
                console.log('\n  Batch skipped.\n');
                offset += batchIds.length;
                continue;
            }

            console.log('');
            const batchResults = executeMetaCleanupPlan(batchPlan, { dryRun: false, excludedPaths, typeId });
            console.log(formatExecutionResults(batchResults));
            mergeExecutionResults(aggregatedResults, batchResults, batchPlan);

            offset += batchIds.length;

            if (remaining > 0) {
                const { debugAction } = await inquirer.prompt(
                    debugBatchContinuePrompt(offset, remaining)
                );

                if (debugAction === 'stop') {
                    console.log('\n  Stopped by user. Remaining preferences were not processed.\n');
                    break;
                }

                if (debugAction === 'all') {
                    // Run all remaining in one final batch
                    const restIds = allPrefIds.slice(offset);
                    batchNumber++;

                    console.log(`\n${'─'.repeat(60)}`);
                    console.log(
                        `  FINAL BATCH ${batchNumber}: ${restIds.length} remaining preference(s)`
                    );
                    console.log(`${'─'.repeat(60)}`);

                    const restMap = sliceRealmPreferenceMap(realmPreferenceMap, restIds);
                    const restPlan = buildMetaCleanupPlan(
                        repoPath, restMap, allInstanceRealms, { crossRealm: useCrossRealm, typeId }
                    );

                    console.log(formatCleanupPlan(restPlan));

                    if (restPlan.actions.length > 0) {
                        const { confirm: confirmRest } = await inquirer.prompt(
                            confirmExecutionPrompt({
                                actionCount: restPlan.actions.length,
                                repoName: siblingAnswers.repository
                            })
                        );

                        if (confirmRest) {
                            console.log('');
                            const restResults = executeMetaCleanupPlan(
                                restPlan, { dryRun: false, excludedPaths, typeId }
                            );
                            console.log(formatExecutionResults(restResults));
                            mergeExecutionResults(aggregatedResults, restResults, restPlan);
                        }
                    }

                    break;
                }
                // debugAction === 'next' → continue loop
            }
        }
    } else {
        // Normal (non-debug) execution — single pass
        const { confirm: confirmExecute } = await inquirer.prompt(
            confirmExecutionPrompt({
                actionCount: fullPlan.actions.length,
                repoName: siblingAnswers.repository
            })
        );

        if (!confirmExecute) {
            console.log('\n  Aborted. No files were modified.\n');
            return;
        }

        console.log('');
        const results = executeMetaCleanupPlan(fullPlan, { dryRun: false, excludedPaths, typeId });
        console.log(formatExecutionResults(results));
        mergeExecutionResults(aggregatedResults, results, fullPlan);
    }

    // --- STEP 8a: Remove orphaned preference values (SitePreferences only) ---
    if (isSitePreferences) {
        console.log('\n  Cleaning preference values from preferences.xml files...');
        const prefValueResults = removePreferenceValuesFromSites({
            repoPath,
            preferenceIds: selectedPreferenceIds
        });
        console.log(formatPreferenceValueResults(prefValueResults));

        if (prefValueResults.totalRemoved > 0) {
            aggregatedResults.filesModified.push(
                ...prefValueResults.filesModified
                    .map(rel => path.join(repoPath, rel))
            );
        }

        runCrossRealmScanIfNeeded({ useCrossRealm, repoPath, selectedPreferenceIds });
    }

    // --- STEP 8b: Enrich regional groups with core attribute references ---
    console.log('\n  Enriching regional meta files with core group references...');
    const enrichResult = enrichRegionalGroups({ repoPath, realmList, typeId });

    if (enrichResult.enriched.length > 0) {
        const totalAdded = enrichResult.enriched.reduce((sum, e) => sum + e.added, 0);
        console.log(
            `  ✓ Added ${totalAdded} core group ref(s) across`
            + ` ${enrichResult.enriched.length} file(s).`
        );
        aggregatedResults.filesModified.push(
            ...enrichResult.enriched.map(e => path.join(repoPath, e.file))
        );
    } else {
        console.log('  ✓ All regional files already up-to-date.\n');
    }

    // --- STEP 8c: Meta file consolidation ---
    const { consolidate } = await inquirer.prompt(
        consolidateMetaPrompt()
    );

    if (consolidate) {
        console.log('\n  Consolidating meta files...\n');

        const consolidation = await consolidateMetaFiles({
            repoPath, realmList, instanceType
        });
        console.log(formatConsolidationResults(consolidation));

        if (consolidation.failCount > 0 && consolidation.successCount === 0) {
            console.log('  All consolidations failed — skipping.\n');
        } else if (consolidation.failCount > 0) {
            const { continueAnyway } = await inquirer.prompt(
                consolidationFailurePrompt(consolidation.failCount)
            );

            if (!continueAnyway) {
                console.log('  Aborted.\n');
                const elapsed = timer.stop();
                console.log(`  Completed in ${elapsed}\n`);
                return;
            }
        }
    }

    // --- STEP 8d: Fix XML indentation ---
    console.log('\n  Fixing XML indentation (tabs → spaces, trailing whitespace)...');
    const lintResults = fixXmlIndentation(repoPath);
    if (lintResults.fixed.length > 0) {
        console.log(`    ${LOG_PREFIX.INFO} Fixed: ${lintResults.fixed.length} file(s)`);
    } else {
        console.log(`    ${LOG_PREFIX.INFO} All XML files already clean`);
    }

    // --- STEP 8e: Validate changes ---
    console.log('\n  Validating changes...');
    const validationReport = validateMetaChanges({
        repoPath, instanceType, realmPreferenceMap
    });
    console.log(formatValidationReport(validationReport));

    const hasValidationIssues = validationReport.removedAttributes.unapproved.length > 0
        || validationReport.blacklistViolations.length > 0
        || validationReport.createdFiles.issues.length > 0
        || validationReport.indentationIssues.length > 0;

    if (hasValidationIssues) {
        const { proceed } = await inquirer.prompt([{
            name: 'proceed',
            type: 'confirm',
            message: 'Validation found issues. Continue with commit anyway?',
            default: false
        }]);

        if (!proceed) {
            console.log('  Aborted — review the validation issues above.\n');
            const elapsed = timer.stop();
            console.log(`  Completed in ${elapsed}\n`);
            return;
        }
    }

    // --- STEP 9: Stage & commit ---
    const totalChanged = aggregatedResults.filesModified.length
        + aggregatedResults.filesDeleted.length
        + aggregatedResults.filesCreated.length;

    if (totalChanged === 0) {
        console.log('  No files were changed — skipping commit.\n');
        const elapsed = timer.stop();
        console.log(`  Completed in ${elapsed}\n`);
        return;
    }

    const { confirmCommit } = await inquirer.prompt(
        confirmCommitPrompt(totalChanged)
    );

    if (!confirmCommit) {
        console.log('  Changes left unstaged. Commit manually when ready.\n');
        const elapsed = timer.stop();
        console.log(`  Completed in ${elapsed}\n`);
        return;
    }

    stageAllChanges(repoPath);

    const diffStat = getStagedDiffStat(repoPath);
    if (diffStat) {
        console.log(`\n  Staged changes:\n${diffStat.split('\n').map(l => `    ${l}`).join('\n')}\n`);
    }

    // Build list of selected attribute IDs from deletion source + P level
    const removedIds = [...new Set(
        selectedPreferenceIds.map(stripCustomPrefix)
    )].sort();

    const suggestedMsg = isSitePreferences
        ? `chore: remove ${removedIds.length} unused site preference definition(s)`
            + ` — ${maxTier} ${instanceType}`
        : `chore: remove ${removedIds.length} ${typeId} attribute definition(s)`
            + ` — ${instanceType}`;

    const { commitMsg } = await inquirer.prompt(
        commitMessagePrompt(suggestedMsg)
    );

    // Build commit body with source context, selected level, and attribute list
    const tierDesc = isSitePreferences ? (TIER_DESCRIPTIONS[maxTier] || maxTier) : typeId;
    const commitBody = buildCommitBody({
        useCrossRealm, maxTier: maxTier || typeId, tierDesc, executedActions: aggregatedResults.executedActions
    });

    const committed = commitChanges(
        repoPath, commitMsg.trim(), commitBody
    );
    if (committed) {
        console.log(`\n  Branch: ${branchName}`);
        console.log('  Ready to push and create a pull request.\n');
    }

    const elapsed = timer.stop();
    console.log(`  Completed in ${elapsed}\n`);
}

// ============================================================================
// DEBUG BATCH HELPERS
// ============================================================================

const DEFAULT_DEBUG_BATCH_SIZE = 10;

/**
 * Parse the --debug option value into a batch size.
 * @param {boolean|string|undefined} debugValue - Raw option value from Commander
 * @returns {number} Batch size (0 means debug is disabled)
 */
function parseDebugOption(debugValue) {
    if (debugValue === undefined || debugValue === false) {
        return 0;
    }
    if (debugValue === true) {
        return DEFAULT_DEBUG_BATCH_SIZE;
    }
    const parsed = parseInt(debugValue, 10);
    return (Number.isFinite(parsed) && parsed > 0) ? parsed : DEFAULT_DEBUG_BATCH_SIZE;
}

/**
 * Collect all unique preference IDs from a realm → preferenceIds map.
 * @param {Map<string, string[]>} realmPreferenceMap
 * @returns {string[]} Sorted unique preference IDs
 */
function collectUniquePrefIds(realmPreferenceMap) {
    const idSet = new Set();
    for (const preferenceIds of realmPreferenceMap.values()) {
        for (const id of preferenceIds) {
            idSet.add(stripCustomPrefix(id));
        }
    }
    return [...idSet].sort();
}

/**
 * Create a subset of a realmPreferenceMap containing only the given preference IDs.
 * @param {Map<string, string[]>} fullMap - Original realm → preferenceIds map
 * @param {string[]} keepIds - Bare preference IDs to keep
 * @returns {Map<string, string[]>} Filtered map (realms with no matches are omitted)
 */
function sliceRealmPreferenceMap(fullMap, keepIds) {
    const keepSet = new Set(keepIds);
    const sliced = new Map();

    for (const [realm, preferenceIds] of fullMap) {
        const filtered = preferenceIds.filter(
            id => keepSet.has(stripCustomPrefix(id))
        );
        if (filtered.length > 0) {
            sliced.set(realm, filtered);
        }
    }

    return sliced;
}

/**
 * Merge batch execution results into an aggregated results object.
 * @param {Object} target - Aggregated results to append to
 * @param {Object} source - Batch results to merge from
 */
function mergeExecutionResults(target, source, plan) {
    target.filesModified.push(...(source.filesModified || []));
    target.filesDeleted.push(...(source.filesDeleted || []));
    target.filesCreated.push(...(source.filesCreated || []));
    target.errors.push(...(source.errors || []));
    if (plan?.actions) {
        target.executedActions.push(...plan.actions);
    }
}

/**
 * Build the commit body with moved and removed attribute lists.
 * Moved attributes (create-realm-file) are listed first, then removed.
 *
 * @param {Object} params
 * @param {boolean} params.useCrossRealm - Whether cross-realm source was used
 * @param {string} params.maxTier - Selected P-level tier
 * @param {string} params.tierDesc - Human-readable tier description
 * @param {Array<{type: string, attributeId: string}>} params.executedActions - All executed plan actions
 * @returns {string} Formatted commit body
 */
function buildCommitBody({ useCrossRealm, maxTier, tierDesc, executedActions }) {
    const movedIds = new Set();
    const removedIds = new Set();

    for (const action of executedActions) {
        if (!action.attributeId) {
            continue;
        }
        const bareId = stripCustomPrefix(action.attributeId);
        if (action.type === 'create-realm-file') {
            movedIds.add(bareId);
        }
    }

    for (const action of executedActions) {
        if (action.type !== 'remove' || !action.attributeId) {
            continue;
        }
        const bareId = stripCustomPrefix(action.attributeId);
        if (!movedIds.has(bareId)) {
            removedIds.add(bareId);
        }
    }

    const lines = [
        `Source: ${useCrossRealm ? 'cross-realm intersection' : 'per-realm deletion files'}`,
        `Level: ${maxTier} — ${tierDesc}`
    ];

    if (movedIds.size > 0) {
        lines.push('', 'Moved to realm (removed from core):');
        for (const id of [...movedIds].sort()) {
            lines.push(`- ${id}`);
        }
    }

    if (removedIds.size > 0) {
        lines.push('', 'Removed attributes:');
        for (const id of [...removedIds].sort()) {
            lines.push(`- ${id}`);
        }
    }

    return lines.join('\n');
}
