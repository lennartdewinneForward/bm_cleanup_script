/**
 * Prompts for meta file cleanup commands.
 * Used by test-meta-cleanup and meta-cleanup in meta.js.
 *
 * @module metaPrompts
 */

/**
 * Confirm execution of a meta cleanup plan.
 * Supports both dry-run (test-meta-cleanup) and live (meta-cleanup) modes.
 * @param {Object} options
 * @param {number} options.actionCount - Number of planned actions
 * @param {boolean} [options.dryRun=false] - Whether this is a dry-run
 * @param {string} [options.repoName] - Repository name for display in live mode
 * @returns {Object[]} Inquirer prompt config — answer key: `confirm`
 */
export const confirmExecutionPrompt = ({ actionCount, dryRun = false, repoName }) => ([{
    name: 'confirm',
    type: 'confirm',
    message: dryRun
        ? `Execute dry-run for ${actionCount} action(s)? (no files will be changed)`
        : `⚠  Execute ${actionCount} action(s)?`
            + ` This will modify files in ${repoName || 'the repository'}.`,
    default: dryRun
}]);

/**
 * Warn about uncommitted changes in the repository.
 * @returns {Object[]} Inquirer prompt config — answer key: `proceed`
 */
export const uncommittedChangesPrompt = () => ([{
    name: 'proceed',
    type: 'confirm',
    message: 'There are uncommitted changes. Continue anyway?',
    default: false
}]);

/**
 * Ask whether to apply changes to the current branch or create a new one.
 * Defaults to current branch for simplicity — select "Create a new branch"
 * when you want an isolated cleanup branch for a pull request.
 * @param {string} currentBranch - Currently checked-out branch
 * @returns {Object[]} Inquirer prompt config — answer key: `branchStrategy`
 */
export const branchStrategyPrompt = (currentBranch) => ([{
    name: 'branchStrategy',
    type: 'list',
    message: 'Where should changes be applied?',
    choices: [
        { name: `Current branch (${currentBranch})`, value: 'current' },
        { name: 'Create a new branch', value: 'new' }
    ],
    default: 'current'
}]);

/**
 * Select the base branch for the cleanup.
 * @param {string[]} branches - Available branch names
 * @param {string} currentBranch - Currently checked-out branch
 * @returns {Object[]} Inquirer prompt config — answer key: `baseBranch`
 */
export const baseBranchPrompt = (branches, currentBranch) => ([{
    name: 'baseBranch',
    type: 'list',
    message: 'Select the base branch for the cleanup:',
    choices: branches,
    default: currentBranch
}]);

/**
 * Input the branch name for the cleanup.
 * @param {string} suggestedName - Default branch name suggestion
 * @param {string[]} existingBranches - List of existing branch names
 * @returns {Object[]} Inquirer prompt config — answer key: `branchName`
 */
export const branchNamePrompt = (suggestedName, existingBranches) => ([{
    name: 'branchName',
    type: 'input',
    message: 'Branch name:',
    default: suggestedName,
    validate: (input) => {
        if (!input || !input.trim()) {
            return 'Branch name cannot be empty';
        }
        if (/\s/.test(input.trim())) {
            return 'Branch name cannot contain spaces';
        }
        if (existingBranches.includes(input.trim())) {
            return 'Branch already exists';
        }
        return true;
    }
}]);

/**
 * Ask whether to consolidate meta files to a single file per realm.
 * @returns {Object[]} Inquirer prompt config — answer key: `consolidate`
 */
export const consolidateMetaPrompt = () => ([{
    name: 'consolidate',
    type: 'confirm',
    message: 'Consolidate to single meta file per realm?'
        + ' (runs backup job to download fresh metadata)',
    default: false
}]);

/**
 * Ask whether to continue after partial consolidation failure.
 * @param {number} failCount - Number of realms that failed consolidation
 * @returns {Object[]} Inquirer prompt config — answer key: `continueAnyway`
 */
export const consolidationFailurePrompt = (failCount) => ([{
    name: 'continueAnyway',
    type: 'confirm',
    message: `${failCount} realm(s) failed to consolidate.`
        + ' Continue with commit?',
    default: true
}]);

/**
 * Confirm staging and committing changed files.
 * @param {number} totalChanged - Number of files changed
 * @returns {Object[]} Inquirer prompt config — answer key: `confirmCommit`
 */
export const confirmCommitPrompt = (totalChanged) => ([{
    name: 'confirmCommit',
    type: 'confirm',
    message: `Stage and commit ${totalChanged} changed file(s)?`,
    default: true
}]);

/**
 * Input the commit message.
 * @param {string} suggestedMsg - Default commit message suggestion
 * @returns {Object[]} Inquirer prompt config — answer key: `commitMsg`
 */
export const commitMessagePrompt = (suggestedMsg) => ([{
    name: 'commitMsg',
    type: 'input',
    message: 'Commit message:',
    default: suggestedMsg
}]);

/**
 * Select which type-id to clean up from meta XML files.
 * @param {string[]} typeIds - Available type-id values discovered from the repository
 * @returns {Object[]} Inquirer prompt config — answer key: `typeId`
 */
export const typeIdPrompt = (typeIds) => ([{
    name: 'typeId',
    type: 'list',
    message: 'Which type-id should be cleaned up?',
    choices: typeIds.map(id => ({ name: id, value: id })),
    default: typeIds.includes('SitePreferences') ? 'SitePreferences' : typeIds[0]
}]);

/**
 * Select which attributes to remove for a non-SitePreferences type-id.
 * Presents a checkbox list of all discovered attribute-definition IDs.
 * @param {string} typeId - The selected type-id
 * @param {string[]} attributeIds - Available attribute IDs discovered from the repository
 * @returns {Object[]} Inquirer prompt config — answer key: `selectedAttributes`
 */
export const attributeSelectionPrompt = (typeId, attributeIds) => ([{
    name: 'selectedAttributes',
    type: 'checkbox',
    message: `Select attributes to remove from ${typeId} (${attributeIds.length} found):`,
    choices: attributeIds.map(id => ({ name: id, value: id })),
    validate: (answer) => answer.length > 0 ? true : 'Select at least one attribute.'
}]);

/**
 * Ask the user how to continue after a debug batch completes.
 * @param {number} processed - Number of preferences processed so far
 * @param {number} remaining - Number of preferences remaining
 * @returns {Object[]} Inquirer prompt config — answer key: `debugAction`
 */
export const debugBatchContinuePrompt = (processed, remaining) => ([{
    name: 'debugAction',
    type: 'list',
    message: `Batch done (${processed} processed, ${remaining} remaining). How to continue?`,
    choices: [
        { name: `Next batch (up to ${Math.min(remaining, 10)} preferences)`, value: 'next' },
        { name: `Run all remaining (${remaining} preferences)`, value: 'all' },
        { name: 'Stop here', value: 'stop' }
    ],
    default: 'next'
}]);
