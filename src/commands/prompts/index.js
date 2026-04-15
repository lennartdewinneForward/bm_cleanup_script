// Re-export all prompts for convenience
export {
    realmPrompt,
    realmWithAllPrompt,
    addRealmPrompts,
    selectRealmToRemovePrompt,
    confirmRealmRemovalPrompt,
    instanceTypePrompt,
    realmByInstanceTypePrompt,
    selectRealmsForInstancePrompt
} from './realmPrompts.js';

export {
    deletionSourcePrompt,
    deletionLevelPrompt,
    preferenceIdPrompt,
    confirmPreferenceDeletionPrompt,
    runAnalyzePreferencesPrompt,
    confirmRestoreAfterDeletionPrompt,
    confirmProceedRestorePrompt,
    overwriteBackupsPrompt,
    refreshMetadataPrompt,
    applyBackupCorrectionsPrompt,
    useExistingBackupPrompt,
    useExistingBackupsForAllRealmsPrompt,
    promptBackupCachePreference,
    objectTypePrompt,
    scopePrompts,
    includeDefaultsPrompt
} from './preferencePrompts.js';

export {
    repositoryPrompt,
    repositoriesMultiSelectPrompt,
    realmScopePrompt,
    resolveRealmScopeSelection,
    realmsByInstanceTypePrompt,
    getRealmsForInstanceType
} from './commonPrompts.js';

export {
    groupIdPrompt
} from './debugPrompts.js';

export {
    confirmExecutionPrompt,
    uncommittedChangesPrompt,
    branchStrategyPrompt,
    baseBranchPrompt,
    branchNamePrompt,
    consolidateMetaPrompt,
    consolidationFailurePrompt,
    confirmCommitPrompt,
    commitMessagePrompt
} from './metaPrompts.js';

export {
    confirmMovePrompt,
    confirmDryRunMovePrompt,
    selectCustomObjectTypesPrompt
} from './customObjectPrompts.js';
