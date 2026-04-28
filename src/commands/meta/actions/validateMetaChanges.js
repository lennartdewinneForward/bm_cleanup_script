import inquirer from 'inquirer';
import { startTimer } from '../../../helpers/timer.js';
import { getInstanceType } from '../../../config/helpers/helpers.js';
import {
    resolveRealmScopeSelection,
    deletionLevelPrompt,
    deletionSourcePrompt
} from '../../prompts/index.js';
import { promptForRepositoryPath, loadDeletionCandidates } from './shared.js';
import {
    validateMetaChanges,
    formatValidationReport
} from '../helpers/metaChangeValidator.js';
import { hasUncommittedChanges } from '../helpers/gitHelper.js';

// ============================================================================
// VALIDATE META CHANGES
// Verify meta-cleanup results against deletion files and blacklist
// ============================================================================

export async function validateMetaChangesAction() {
    const timer = startTimer();

    console.log(`\n${'═'.repeat(80)}`);
    console.log(' VALIDATE META CHANGES');
    console.log(`${'═'.repeat(80)}\n`);

    // --- STEP 1: Select sibling repository ---
    const repoPath = await promptForRepositoryPath();
    if (!repoPath) {
        return;
    }

    if (!hasUncommittedChanges(repoPath)) {
        console.log('  No uncommitted changes found in the repository.');
        console.log('  Run meta-cleanup first, then validate before committing.\n');
        return;
    }

    // --- STEP 2: Select realms ---
    const { realmList, instanceTypeOverride } = await resolveRealmScopeSelection(
        (questions) => inquirer.prompt(questions)
    );

    if (!realmList || realmList.length === 0) {
        console.log('No realms selected.');
        return;
    }

    const instanceType = instanceTypeOverride || getInstanceType(realmList[0]);

    // --- STEP 3: Select deletion tier & source ---
    const tierAnswers = await inquirer.prompt(deletionLevelPrompt());
    const maxTier = tierAnswers.deletionLevel;

    const { deletionSource } = await inquirer.prompt(deletionSourcePrompt());
    const useCrossRealm = deletionSource === 'cross-realm';

    // --- STEP 4: Load the same deletion candidates that meta-cleanup used ---
    console.log(`\n  Loading deletion candidates up to tier ${maxTier}...`);

    const { realmPreferenceMap, totalPrefs } = loadDeletionCandidates({
        realmList, instanceType, maxTier, useCrossRealm
    });

    if (totalPrefs === 0) {
        console.log('\n  No deletion candidates loaded. Nothing to validate against.\n');
        return;
    }

    // --- STEP 5: Run validation ---
    console.log('\n  Validating changes in repository...\n');

    const report = validateMetaChanges({
        repoPath,
        instanceType,
        realmPreferenceMap
    });

    console.log(formatValidationReport(report));

    const elapsed = timer.stop();
    console.log(`  Completed in ${elapsed}\n`);
}
