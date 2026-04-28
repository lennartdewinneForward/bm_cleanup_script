/**
 * Git Helper for Meta File Cleanup
 *
 * Provides git operations for the sibling SFCC repository:
 * branch listing, branch creation, staging, and committing.
 *
 * @module gitHelper
 */

import { execSync, execFileSync } from 'child_process';
import { LOG_PREFIX } from '../../../config/constants.js';
import { logError } from '../../../scripts/loggingScript/log.js';

// ============================================================================
// GIT QUERIES
// ============================================================================

/**
 * Get the current branch name in a repository.
 *
 * @param {string} repoPath - Absolute path to the git repository
 * @returns {string} Current branch name (e.g., 'main', 'develop')
 */
export function getCurrentBranch(repoPath) {
    return execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: repoPath,
        encoding: 'utf-8'
    }).trim();
}

/**
 * List local branch names in a repository.
 *
 * @param {string} repoPath - Absolute path to the git repository
 * @returns {string[]} Sorted array of branch names
 */
export function listBranches(repoPath) {
    const raw = execSync('git branch --format="%(refname:short)"', {
        cwd: repoPath,
        encoding: 'utf-8'
    });

    return raw
        .split('\n')
        .map(b => b.trim())
        .filter(Boolean)
        .sort();
}

/**
 * Check whether the working tree has uncommitted changes.
 *
 * @param {string} repoPath - Absolute path to the git repository
 * @returns {boolean} True if there are uncommitted changes
 */
export function hasUncommittedChanges(repoPath) {
    const status = execSync('git status --porcelain', {
        cwd: repoPath,
        encoding: 'utf-8'
    }).trim();

    return status.length > 0;
}

/**
 * Get a compact summary of the current git status.
 *
 * @param {string} repoPath - Absolute path to the git repository
 * @returns {string} Short status output
 */
export function getStatusSummary(repoPath) {
    return execSync('git status --short', {
        cwd: repoPath,
        encoding: 'utf-8'
    }).trim();
}

/**
 * Get lists of changed files in the working tree, grouped by change type.
 * Includes both staged and unstaged changes.
 *
 * @param {string} repoPath - Absolute path to the git repository
 * @returns {{ added: string[], modified: string[], deleted: string[] }} File paths relative to repoPath
 */
export function getChangedFiles(repoPath) {
    const raw = execSync('git status --porcelain', {
        cwd: repoPath,
        encoding: 'utf-8'
    }).trim();

    const added = [];
    const modified = [];
    const deleted = [];

    for (const line of raw.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        // Porcelain format: XY filename (X = staging, Y = working tree)
        const status = line.slice(0, 2);
        const filePath = line.slice(3).trim();
        const x = status[0];
        const y = status[1];

        if (x === '?' || x === 'A' || y === 'A') {
            added.push(filePath);
        } else if (x === 'D' || y === 'D') {
            deleted.push(filePath);
        } else if (x === 'M' || y === 'M') {
            modified.push(filePath);
        }
    }

    return { added, modified, deleted };
}

// ============================================================================
// GIT MUTATIONS
// ============================================================================

/**
 * Create and checkout a new branch from a base branch.
 *
 * @param {string} repoPath - Absolute path to the git repository
 * @param {string} branchName - Name for the new branch
 * @param {string} baseBranch - Branch to base the new branch on
 * @returns {boolean} True if branch was created successfully
 */
export function createAndCheckoutBranch(repoPath, branchName, baseBranch) {
    try {
        // Checkout base branch first
        execSync(`git checkout ${baseBranch}`, {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: 'pipe'
        });

        // Create and switch to new branch
        execSync(`git checkout -b ${branchName}`, {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: 'pipe'
        });

        console.log(`${LOG_PREFIX.SUCCESS} Created and checked out branch: ${branchName}`);
        return true;
    } catch (error) {
        logError(`Failed to create branch ${branchName}: ${error.message}`);
        return false;
    }
}

/**
 * Stage all changes in the repository.
 *
 * @param {string} repoPath - Absolute path to the git repository
 * @returns {boolean} True if staging succeeded
 */
export function stageAllChanges(repoPath) {
    try {
        execSync('git add -A', {
            cwd: repoPath,
            encoding: 'utf-8',
            stdio: 'pipe'
        });
        return true;
    } catch (error) {
        logError(`Failed to stage changes: ${error.message}`);
        return false;
    }
}

/**
 * Commit staged changes with a subject line and optional body.
 *
 * @param {string} repoPath - Absolute path to the git repository
 * @param {string} subject - Commit subject line
 * @param {string} [body] - Optional commit body (description)
 * @returns {boolean} True if commit succeeded
 */
export function commitChanges(repoPath, subject, body) {
    try {
        const args = ['commit', '-m', subject];
        if (body) {
            args.push('-m', body);
        }

        execFileSync('git', args, {
            cwd: repoPath, encoding: 'utf-8', stdio: 'pipe'
        });

        console.log(`${LOG_PREFIX.SUCCESS} Committed: ${subject}`);
        return true;
    } catch (error) {
        logError(`Failed to commit: ${error.message}`);
        return false;
    }
}

/**
 * Get a compact diff stat for staged changes.
 *
 * @param {string} repoPath - Absolute path to the git repository
 * @returns {string} Diff stat output (files changed, insertions, deletions)
 */
export function getStagedDiffStat(repoPath) {
    return execSync('git diff --cached --stat', {
        cwd: repoPath,
        encoding: 'utf-8'
    }).trim();
}

// ============================================================================
// BRANCH NAME GENERATION
// ============================================================================

/**
 * Generate a branch name for meta cleanup using the feature/meta-cleanup-<date> convention.
 *
 * @param {string} [suffix] - Optional suffix to append (e.g., tier or instance type)
 * @returns {string} Generated branch name
 */
export function generateCleanupBranchName(suffix) {
    const date = new Date().toISOString().slice(0, 10);
    const base = `feature/meta-cleanup-${date}`;
    return suffix ? `${base}-${suffix}` : base;
}
