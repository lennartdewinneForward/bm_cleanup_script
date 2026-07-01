import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// Mock all dependencies that preferences.js imports
vi.mock('../../../src/io/util.js', () => ({
    findAllMatrixFiles: vi.fn(() => []),
    getSiblingRepositories: vi.fn(() => ['repo-a'])
}));

vi.mock('../../../src/config/helpers/helpers.js', () => ({
    getAvailableRealms: vi.fn(() => ['EU05', 'APAC']),
    getInstanceType: vi.fn(() => 'development'),
    getRealmsByInstanceType: vi.fn(() => ['EU05', 'APAC']),
    getSandboxConfig: vi.fn(() => ({ hostname: 'eu05.example.com' }))
}));

vi.mock('../../../src/helpers/timer.js', () => ({
    startTimer: vi.fn(() => ({ stop: vi.fn(() => '1.0s') }))
}));

vi.mock('../../../src/scripts/loggingScript/progressDisplay.js', () => ({
    RealmProgressDisplay: vi.fn(function() {
        return {
            start: vi.fn(),
            stop: vi.fn(),
            finish: vi.fn(),
            startStep: vi.fn(),
            completeStep: vi.fn(),
            failStep: vi.fn(),
            failRealm: vi.fn(),
            completeRealm: vi.fn(),
            setStepProgress: vi.fn(),
            setStepMessage: vi.fn(),
            setTotalSteps: vi.fn()
        };
    })
}));

vi.mock('../../../src/commands/prompts/index.js', () => ({
    instanceTypePrompt: vi.fn(() => [{ name: 'instanceType' }]),
    realmPrompt: vi.fn(() => [{ name: 'realm' }]),
    objectTypePrompt: vi.fn(() => [{ name: 'objectType' }]),
    groupIdPrompt: vi.fn(() => [{ name: 'groupId' }]),
    resolveRealmScopeSelection: vi.fn(),
    deletionLevelPrompt: vi.fn(() => [{ name: 'deletionLevel' }]),
    deletionSourcePrompt: vi.fn(() => [{ name: 'deletionSource' }]),
    confirmExecutionPrompt: vi.fn(() => [{ name: 'confirm' }]),
    repositoryPrompt: vi.fn(() => [{ name: 'repository' }]),
    repositoriesMultiSelectPrompt: vi.fn(() => [{ name: 'repositories' }]),
    promptBackupCachePreference: vi.fn(() => false),
    selectRealmsForInstancePrompt: vi.fn(() => [{ name: 'realms' }]),
    runAnalyzePreferencesPrompt: vi.fn(() => [{ name: 'runAnalyze' }]),
    confirmPreferenceDeletionPrompt: vi.fn(() => [{ name: 'confirm' }]),
    confirmRestoreAfterDeletionPrompt: vi.fn(() => [{ name: 'restore' }]),
    confirmProceedRestorePrompt: vi.fn(() => [{ name: 'proceed' }]),
    overwriteBackupsPrompt: vi.fn(() => [{ name: 'createNew' }]),
    refreshMetadataPrompt: vi.fn(() => [{ name: 'refreshMetadata' }]),
    applyBackupCorrectionsPrompt: vi.fn(() => [{ name: 'applyCorrections' }])
}));

vi.mock('../../../src/config/constants.js', () => ({
    LOG_PREFIX: { SUCCESS: '[OK]', WARNING: '[WARN]', ERROR: '[ERR]', INFO: '[INFO]' },
    DIRECTORIES: { RESULTS: 'results', BACKUP: 'backup' },
    IDENTIFIERS: { ALL_REALMS: 'ALL_REALMS', SITE_PREFERENCES: 'SitePreferences', ALL: 'ALL' },
    FILE_PATTERNS: { PREFERENCES_FOR_DELETION: '_preferences_for_deletion.txt' },
    ANALYSIS_STEPS: { METADATA: 5, OCAPI: 4 }
}));

vi.mock('../../../src/scripts/loggingScript/log.js', () => ({
    logNoMatrixFiles: vi.fn(),
    logMatrixFilesFound: vi.fn(),
    logSummaryHeader: vi.fn(),
    logRealmSummary: vi.fn(),
    logSummaryFooter: vi.fn(),
    logSectionTitle: vi.fn(),
    logRuntime: vi.fn(),
    logDeletionSummary: vi.fn(),
    logRestoreSummary: vi.fn(),
    logBackupClassification: vi.fn()
}));

vi.mock('../../../src/helpers/analyzer.js', () => ({
    processPreferenceMatrixFiles: vi.fn(() => []),
    executePreferenceSummarization: vi.fn(),
    executeSummarizationFromMetadata: vi.fn()
}));

vi.mock('../../../src/io/csv.js', () => ({
    exportSitesCartridgesToCSV: vi.fn()
}));

vi.mock('../../../src/io/codeScanner.js', () => ({
    findAllActivePreferencesUsage: vi.fn(),
    getActivePreferencesFromMatrices: vi.fn(() => new Set())
}));

vi.mock('../../../src/commands/preferences/helpers/preferenceRemoval.js', () => ({
    generateDeletionSummary: vi.fn(() => ({
        total: 2,
        topPrefixes: [['c_custom', 2]]
    })),
    buildRealmPreferenceMapFromFiles: vi.fn(() => ({
        realmPreferenceMap: new Map([['EU05', ['c_prefA', 'c_prefB']]]),
        blockedByBlacklist: [],
        skippedByWhitelist: [],
        missingRealms: []
    })),
    buildCrossRealmPreferenceMap: vi.fn(() => ({
        realmPreferenceMap: new Map([['EU05', ['c_prefA']]]),
        blockedByBlacklist: [],
        skippedByWhitelist: [],
        missingRealms: [],
        filePath: '/mock/cross-realm.txt'
    })),
    openRealmDeletionFilesInEditor: vi.fn(() => []),
    openCrossRealmFileInEditor: vi.fn(() => null)
}));

vi.mock('../../../src/io/backupUtils.js', () => ({
    loadBackupFile: vi.fn(() => ({
        attributes: [{ id: 'c_prefA' }, { id: 'c_prefB' }]
    }))
}));

vi.mock('../../../src/helpers/backupJob.js', () => ({
    refreshMetadataBackupForRealm: vi.fn(() => ({
        ok: true,
        status: 'EXISTING',
        filePath: '/mock/backup.xml'
    }))
}));

vi.mock('../../../src/commands/preferences/helpers/realmHelpers.js', () => ({
    validateRealmsSelection: vi.fn(() => true)
}));

vi.mock('../../../src/commands/preferences/helpers/backupHelpers.js', () => ({
    findLatestBackupFile: vi.fn(() => '/mock/backup.json'),
    validateAndCorrectBackup: vi.fn(() => ({
        corrected: false,
        backup: { attributes: [] }
    })),
    createBackupsForRealms: vi.fn(() => ({ successCount: 1 }))
}));

vi.mock('../../../src/commands/preferences/helpers/deleteHelpers.js', () => ({
    runAnalyzePreferencesSubprocess: vi.fn(),
    deletePreferencesForRealms: vi.fn(() => ({
        totalDeleted: 2, totalFailed: 0
    })),
    classifyRealmBackupStatus: vi.fn(() => ({
        withBackups: [],
        withoutBackups: ['EU05']
    }))
}));

vi.mock('../../../src/commands/preferences/helpers/restoreHelper.js', () => ({
    restorePreferencesForRealm: vi.fn(() => ({
        restored: 2, failed: 0
    }))
}));

vi.mock('fs', () => ({
    default: {
        existsSync: vi.fn(() => true),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        readFileSync: vi.fn(),
        readdirSync: vi.fn(() => [])
    },
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    readdirSync: vi.fn(() => [])
}));

vi.mock('inquirer', () => ({
    default: { prompt: vi.fn() }
}));

import { registerPreferenceCommands } from '../../../src/commands/preferences/preferences.js';
import inquirer from 'inquirer';
import fs from 'fs';
import { getSiblingRepositories, findAllMatrixFiles } from '../../../src/io/util.js';
import {
    getAvailableRealms, getInstanceType, getRealmsByInstanceType, getSandboxConfig
} from '../../../src/config/helpers/helpers.js';
import { startTimer } from '../../../src/helpers/timer.js';
import { RealmProgressDisplay } from '../../../src/scripts/loggingScript/progressDisplay.js';
import * as prompts from '../../../src/commands/prompts/index.js';
import { validateRealmsSelection } from '../../../src/commands/preferences/helpers/realmHelpers.js';
import { refreshMetadataBackupForRealm } from '../../../src/helpers/backupJob.js';
import {
    executeSummarizationFromMetadata,
    executePreferenceSummarization,
    processPreferenceMatrixFiles
} from '../../../src/helpers/analyzer.js';
import { getActivePreferencesFromMatrices, findAllActivePreferencesUsage } from '../../../src/io/codeScanner.js';
import { exportSitesCartridgesToCSV } from '../../../src/io/csv.js';
import {
    buildRealmPreferenceMapFromFiles,
    buildCrossRealmPreferenceMap,
    generateDeletionSummary,
    openRealmDeletionFilesInEditor,
    openCrossRealmFileInEditor
} from '../../../src/commands/preferences/helpers/preferenceRemoval.js';
import {
    deletePreferencesForRealms, classifyRealmBackupStatus, runAnalyzePreferencesSubprocess
} from '../../../src/commands/preferences/helpers/deleteHelpers.js';
import { createBackupsForRealms, findLatestBackupFile, validateAndCorrectBackup } from '../../../src/commands/preferences/helpers/backupHelpers.js';
import { restorePreferencesForRealm } from '../../../src/commands/preferences/helpers/restoreHelper.js';
import { loadBackupFile } from '../../../src/io/backupUtils.js';
import {
    logSectionTitle,
    logRuntime,
    logDeletionSummary,
    logRestoreSummary,
    logBackupClassification
} from '../../../src/scripts/loggingScript/log.js';

// Helper to trigger a preference command
async function triggerCommand(commandName, args = []) {
    const program = new Command();
    program.exitOverride();
    registerPreferenceCommands(program);
    await program.parseAsync(['node', 'test', commandName, ...args]);
}

/**
 * Re-establish all factory-default mock implementations.
 * Called after vi.resetAllMocks() to ensure every mock has a sane default.
 */
function setupDefaults() {
    // io/util
    getSiblingRepositories.mockReturnValue(['repo-a']);
    findAllMatrixFiles.mockReturnValue([]);

    // config/helpers
    getAvailableRealms.mockReturnValue(['EU05', 'APAC']);
    getInstanceType.mockReturnValue('development');
    getRealmsByInstanceType.mockReturnValue(['EU05', 'APAC']);
    getSandboxConfig.mockReturnValue({ hostname: 'eu05.example.com' });

    // timer
    startTimer.mockReturnValue({ stop: vi.fn(() => '1.0s') });

    // progressDisplay (needs function keyword, not arrow, to work with new)
    RealmProgressDisplay.mockImplementation(function() {
        return {
            start: vi.fn(), stop: vi.fn(), finish: vi.fn(),
            startStep: vi.fn(), completeStep: vi.fn(), failStep: vi.fn(),
            failRealm: vi.fn(), completeRealm: vi.fn(),
            setStepProgress: vi.fn(), setStepMessage: vi.fn(), setTotalSteps: vi.fn()
        };
    });

    // analyzer
    processPreferenceMatrixFiles.mockResolvedValue([]);
    getActivePreferencesFromMatrices.mockReturnValue(new Set());

    // preferenceRemoval
    generateDeletionSummary.mockReturnValue({ total: 2, topPrefixes: [['c_custom', 2]] });
    buildRealmPreferenceMapFromFiles.mockReturnValue({
        realmPreferenceMap: new Map([['EU05', ['c_prefA', 'c_prefB']]]),
        blockedByBlacklist: [], skippedByWhitelist: [], missingRealms: []
    });
    buildCrossRealmPreferenceMap.mockReturnValue({
        realmPreferenceMap: new Map([['EU05', ['c_prefA']]]),
        blockedByBlacklist: [], skippedByWhitelist: [], missingRealms: [],
        filePath: '/mock/cross-realm.txt'
    });
    openRealmDeletionFilesInEditor.mockResolvedValue([]);
    openCrossRealmFileInEditor.mockResolvedValue(null);

    // backupUtils / backupJob
    loadBackupFile.mockResolvedValue({ attributes: [{ id: 'c_prefA' }, { id: 'c_prefB' }] });
    refreshMetadataBackupForRealm.mockResolvedValue({
        ok: true, status: 'EXISTING', filePath: '/mock/backup.xml'
    });

    // realmHelpers
    validateRealmsSelection.mockReturnValue(true);

    // backupHelpers
    findLatestBackupFile.mockReturnValue('/mock/backup.json');
    validateAndCorrectBackup.mockReturnValue({ corrected: false, backup: { attributes: [] } });
    createBackupsForRealms.mockResolvedValue({ successCount: 1 });

    // deleteHelpers
    deletePreferencesForRealms.mockResolvedValue({ totalDeleted: 2, totalFailed: 0 });
    classifyRealmBackupStatus.mockReturnValue({ withBackups: [], withoutBackups: ['EU05'] });

    // restoreHelper
    restorePreferencesForRealm.mockResolvedValue({ restored: 2, failed: 0 });

    // fs (default import used by source)
    fs.existsSync.mockReturnValue(true);
}

beforeEach(() => {
    vi.resetAllMocks();
    setupDefaults();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

// ============================================================================
// registerPreferenceCommands
// ============================================================================

describe('registerPreferenceCommands', () => {
    it('registers commands', () => {
        const program = new Command();
        program.exitOverride();
        registerPreferenceCommands(program);
        expect(program.commands).toHaveLength;
    });

    it('registers analyze-preferences command', () => {
        const program = new Command();
        registerPreferenceCommands(program);
        const cmd = program.commands.find(c => c.name() === 'analyze-preferences');
        expect(cmd).toBeDefined();
        expect(cmd.description()).toContain('analysis');
    });

    it('registers remove-preferences command with dry-run option', () => {
        const program = new Command();
        registerPreferenceCommands(program);
        const cmd = program.commands.find(c => c.name() === 'remove-preferences');
        expect(cmd).toBeDefined();
        const optionNames = cmd.options.map(o => o.long);
        expect(optionNames).toContain('--dry-run');
    });

    it('registers restore-preferences command', () => {
        const program = new Command();
        registerPreferenceCommands(program);
        const cmd = program.commands.find(c => c.name() === 'restore-preferences');
        expect(cmd).toBeDefined();
        expect(cmd.description()).toContain('Restore');
    });

    it('registers backup-site-preferences command', () => {
        const program = new Command();
        registerPreferenceCommands(program);
        const cmd = program.commands.find(c => c.name() === 'backup-site-preferences');
        expect(cmd).toBeDefined();
        expect(cmd.description()).toContain('backup');
    });

    it('registers inspect-preference-group command', () => {
        const program = new Command();
        registerPreferenceCommands(program);
        const cmd = program.commands.find(c => c.name() === 'inspect-preference-group');
        expect(cmd).toBeDefined();
        expect(cmd.description()).toContain('group');
    });

    it('all commands have descriptions', () => {
        const program = new Command();
        registerPreferenceCommands(program);
        for (const cmd of program.commands) {
            expect(cmd.description()).toBeTruthy();
        }
    });
});

// ============================================================================
// analyzePreferences — command flow
// ============================================================================

describe('analyzePreferences', () => {
    it('exits early when realm validation fails', async () => {
        validateRealmsSelection.mockReturnValueOnce(false);

        inquirer.prompt.mockResolvedValueOnce({ repositories: ['repo-a'] });
        prompts.resolveRealmScopeSelection.mockResolvedValueOnce({
            realmList: [], instanceTypeOverride: null
        });

        await triggerCommand('analyze-preferences');

        expect(refreshMetadataBackupForRealm).not.toHaveBeenCalled();
    });

    it('processes realms in parallel using metadata flow', async () => {
        inquirer.prompt.mockResolvedValueOnce({ repositories: ['repo-a'] });
        prompts.resolveRealmScopeSelection.mockResolvedValueOnce({
            realmList: ['EU05'], instanceTypeOverride: null
        });
        prompts.promptBackupCachePreference.mockResolvedValueOnce(false);

        executeSummarizationFromMetadata.mockResolvedValueOnce({
            matrixPath: '/mock/matrix.csv'
        });

        findAllMatrixFiles.mockReturnValueOnce([
            { realm: 'EU05', matrixFile: '/mock/matrix.csv' }
        ]);
        processPreferenceMatrixFiles.mockResolvedValueOnce([
            { realm: 'EU05', total: 10, unused: 2 }
        ]);
        getActivePreferencesFromMatrices.mockReturnValueOnce(new Set(['pref_a']));

        await triggerCommand('analyze-preferences');

        expect(refreshMetadataBackupForRealm).toHaveBeenCalled();
        expect(executeSummarizationFromMetadata).toHaveBeenCalled();
    });

    it('falls back to OCAPI when metadata backup fails', async () => {
        inquirer.prompt.mockResolvedValueOnce({ repositories: ['repo-a'] });
        prompts.resolveRealmScopeSelection.mockResolvedValueOnce({
            realmList: ['EU05'], instanceTypeOverride: null
        });
        prompts.promptBackupCachePreference.mockResolvedValueOnce(false);

        refreshMetadataBackupForRealm.mockResolvedValueOnce({
            ok: false, reason: 'Job failed'
        });
        executePreferenceSummarization.mockResolvedValueOnce({
            matrixPath: '/mock/matrix.csv'
        });

        findAllMatrixFiles.mockReturnValueOnce([]);

        await triggerCommand('analyze-preferences');

        expect(executePreferenceSummarization).toHaveBeenCalled();
    });

    it('aborts when all realms fail', async () => {
        inquirer.prompt.mockResolvedValueOnce({ repositories: ['repo-a'] });
        prompts.resolveRealmScopeSelection.mockResolvedValueOnce({
            realmList: ['EU05'], instanceTypeOverride: null
        });
        prompts.promptBackupCachePreference.mockResolvedValueOnce(false);

        refreshMetadataBackupForRealm.mockResolvedValueOnce({ ok: true, filePath: '/mock/backup.xml' });
        executeSummarizationFromMetadata.mockRejectedValueOnce(new Error('API down'));

        await triggerCommand('analyze-preferences');

        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('EU05')
        );
    });

    it('calls findAllActivePreferencesUsage for cartridge scanning', async () => {
        inquirer.prompt.mockResolvedValueOnce({ repositories: ['repo-a'] });
        prompts.resolveRealmScopeSelection.mockResolvedValueOnce({
            realmList: ['EU05'], instanceTypeOverride: null
        });
        prompts.promptBackupCachePreference.mockResolvedValueOnce(false);

        executeSummarizationFromMetadata.mockResolvedValueOnce({});

        findAllMatrixFiles.mockReturnValueOnce([
            { realm: 'EU05', matrixFile: '/mock/EU05_matrix.csv' }
        ]);
        processPreferenceMatrixFiles.mockResolvedValueOnce([
            { realm: 'EU05', total: 10, unused: 2 }
        ]);
        getActivePreferencesFromMatrices.mockReturnValueOnce(new Set(['pref_a']));

        await triggerCommand('analyze-preferences');

        expect(findAllActivePreferencesUsage).toHaveBeenCalled();
    });

    it('refreshes site cartridge lists for processed realms', async () => {
        inquirer.prompt.mockResolvedValueOnce({ repositories: ['repo-a'] });
        prompts.resolveRealmScopeSelection.mockResolvedValueOnce({
            realmList: ['EU05'], instanceTypeOverride: null
        });
        prompts.promptBackupCachePreference.mockResolvedValueOnce(false);

        executeSummarizationFromMetadata.mockResolvedValueOnce({});
        findAllMatrixFiles.mockReturnValueOnce([
            { realm: 'EU05', matrixFile: '/mock/EU05_matrix.csv' }
        ]);
        processPreferenceMatrixFiles.mockResolvedValueOnce([]);
        getActivePreferencesFromMatrices.mockReturnValueOnce(new Set());

        await triggerCommand('analyze-preferences');

        expect(exportSitesCartridgesToCSV).toHaveBeenCalledWith('EU05');
    });
});

// ============================================================================
// removePreferences — command flow
// ============================================================================

describe('removePreferences', () => {
    function setupRemovePreferencesFlow(overrides = {}) {
        const defaults = {
            instanceType: 'development',
            realms: ['EU05'],
            deletionLevel: 'P3',
            deletionSource: 'per-realm',
            confirm: true,
            restore: false
        };
        const opts = { ...defaults, ...overrides };

        inquirer.prompt
            .mockResolvedValueOnce({ instanceType: opts.instanceType })
            .mockResolvedValueOnce({ realms: opts.realms })
            .mockResolvedValueOnce({ deletionLevel: opts.deletionLevel })
            .mockResolvedValueOnce({ deletionSource: opts.deletionSource })
            .mockResolvedValueOnce({ refreshMetadata: false })
            .mockResolvedValueOnce({ confirm: opts.confirm })
            .mockResolvedValueOnce({ restore: opts.restore });
    }

    it('calls deletePreferencesForRealms on happy path', async () => {
        setupRemovePreferencesFlow();

        await triggerCommand('remove-preferences');

        expect(deletePreferencesForRealms).toHaveBeenCalledWith({
            realmPreferenceMap: expect.any(Map),
            objectType: 'SitePreferences',
            dryRun: false
        });
        expect(logDeletionSummary).toHaveBeenCalled();
    });

    it('exits early when no realms for instance type', async () => {
        getRealmsByInstanceType.mockReturnValueOnce([]);

        inquirer.prompt
            .mockResolvedValueOnce({ instanceType: 'development' });

        await triggerCommand('remove-preferences');

        expect(deletePreferencesForRealms).not.toHaveBeenCalled();
    });

    it('exits early when no realms selected', async () => {
        inquirer.prompt
            .mockResolvedValueOnce({ instanceType: 'development' })
            .mockResolvedValueOnce({ realms: [] });

        await triggerCommand('remove-preferences');

        expect(deletePreferencesForRealms).not.toHaveBeenCalled();
    });

    it('cancels when user declines confirmation', async () => {
        setupRemovePreferencesFlow({ confirm: false });

        await triggerCommand('remove-preferences');

        expect(deletePreferencesForRealms).not.toHaveBeenCalled();
    });

    it('uses buildCrossRealmPreferenceMap when cross-realm selected', async () => {
        inquirer.prompt
            .mockResolvedValueOnce({ instanceType: 'development' })
            .mockResolvedValueOnce({ realms: ['EU05'] })
            .mockResolvedValueOnce({ deletionLevel: 'P1' })
            .mockResolvedValueOnce({ deletionSource: 'cross-realm' })
            .mockResolvedValueOnce({ refreshMetadata: false })
            .mockResolvedValueOnce({ confirm: true })
            .mockResolvedValueOnce({ restore: false });

        await triggerCommand('remove-preferences');

        expect(buildCrossRealmPreferenceMap).toHaveBeenCalled();
        expect(buildRealmPreferenceMapFromFiles).not.toHaveBeenCalled();
    });

    it('uses buildRealmPreferenceMapFromFiles in per-realm mode', async () => {
        setupRemovePreferencesFlow();

        await triggerCommand('remove-preferences');

        expect(buildRealmPreferenceMapFromFiles).toHaveBeenCalledWith(
            ['EU05'], 'development', { maxTier: 'P3' }
        );
    });

    it('logs deletion level summary', async () => {
        setupRemovePreferencesFlow();

        await triggerCommand('remove-preferences');

        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining('P3')
        );
    });

    it('exits when no preferences to delete', async () => {
        buildRealmPreferenceMapFromFiles.mockReturnValueOnce({
            realmPreferenceMap: new Map([['EU05', []]]),
            blockedByBlacklist: [],
            skippedByWhitelist: [],
            missingRealms: []
        });

        inquirer.prompt
            .mockResolvedValueOnce({ instanceType: 'development' })
            .mockResolvedValueOnce({ realms: ['EU05'] })
            .mockResolvedValueOnce({ deletionLevel: 'P1' })
            .mockResolvedValueOnce({ deletionSource: 'per-realm' });

        await triggerCommand('remove-preferences');

        expect(deletePreferencesForRealms).not.toHaveBeenCalled();
    });

    it('creates backups before deletion', async () => {
        setupRemovePreferencesFlow();

        await triggerCommand('remove-preferences');

        expect(classifyRealmBackupStatus).toHaveBeenCalled();
        expect(createBackupsForRealms).toHaveBeenCalled();
    });

    it('skips backup in dry-run mode', async () => {
        inquirer.prompt
            .mockResolvedValueOnce({ instanceType: 'development' })
            .mockResolvedValueOnce({ realms: ['EU05'] })
            .mockResolvedValueOnce({ deletionLevel: 'P1' })
            .mockResolvedValueOnce({ deletionSource: 'per-realm' })
            .mockResolvedValueOnce({ confirm: true })
            .mockResolvedValueOnce({ restore: false });

        await triggerCommand('remove-preferences', ['--dry-run']);

        expect(createBackupsForRealms).not.toHaveBeenCalled();
        expect(deletePreferencesForRealms).toHaveBeenCalledWith(
            expect.objectContaining({ dryRun: true })
        );
    });

    it('calls openRealmDeletionFilesInEditor for per-realm review', async () => {
        setupRemovePreferencesFlow();

        await triggerCommand('remove-preferences');

        expect(openRealmDeletionFilesInEditor).toHaveBeenCalledWith(
            ['EU05'], 'development'
        );
    });

    it('calls openCrossRealmFileInEditor for cross-realm review', async () => {
        inquirer.prompt
            .mockResolvedValueOnce({ instanceType: 'development' })
            .mockResolvedValueOnce({ realms: ['EU05'] })
            .mockResolvedValueOnce({ deletionLevel: 'P1' })
            .mockResolvedValueOnce({ deletionSource: 'cross-realm' })
            .mockResolvedValueOnce({ refreshMetadata: false })
            .mockResolvedValueOnce({ confirm: true })
            .mockResolvedValueOnce({ restore: false });

        await triggerCommand('remove-preferences');

        expect(openCrossRealmFileInEditor).toHaveBeenCalledWith('development');
    });

    it('calls generateDeletionSummary for prefix analysis', async () => {
        setupRemovePreferencesFlow();

        await triggerCommand('remove-preferences');

        expect(generateDeletionSummary).toHaveBeenCalled();
    });

    it('aborts when backup creation fails entirely', async () => {
        createBackupsForRealms.mockResolvedValueOnce({ successCount: 0 });

        setupRemovePreferencesFlow();

        await triggerCommand('remove-preferences');

        expect(deletePreferencesForRealms).not.toHaveBeenCalled();
    });

    it('prompts for restore after successful deletion', async () => {
        setupRemovePreferencesFlow({ restore: true });

        await triggerCommand('remove-preferences');

        expect(restorePreferencesForRealm).toHaveBeenCalled();
        expect(logRestoreSummary).toHaveBeenCalled();
    });

    it('skips restore when user declines', async () => {
        setupRemovePreferencesFlow({ restore: false });

        await triggerCommand('remove-preferences');

        expect(restorePreferencesForRealm).not.toHaveBeenCalled();
    });

    it('logs per-realm deletion breakdown', async () => {
        setupRemovePreferencesFlow();

        await triggerCommand('remove-preferences');

        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining('Per-Realm Deletion Breakdown')
        );
    });

    it('logs whitelist/blacklist usage when applicable', async () => {
        buildRealmPreferenceMapFromFiles.mockReturnValueOnce({
            realmPreferenceMap: new Map([['EU05', ['c_prefA']]]),
            blockedByBlacklist: ['c_blocked'],
            skippedByWhitelist: ['c_skipped'],
            missingRealms: []
        });

        setupRemovePreferencesFlow();

        await triggerCommand('remove-preferences');

        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining('Whitelist skipped')
        );
        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining('Blacklist protected')
        );
    });

    it('runs analyze subprocess when per-realm files missing', async () => {
        const { runAnalyzePreferencesSubprocess } = await import(
            '../../../src/commands/preferences/helpers/deleteHelpers.js'
        );

        buildRealmPreferenceMapFromFiles
            .mockReturnValueOnce({
                realmPreferenceMap: new Map(),
                blockedByBlacklist: [],
                skippedByWhitelist: [],
                missingRealms: ['EU05']
            })
            .mockReturnValueOnce({
                realmPreferenceMap: new Map([['EU05', ['c_prefA']]]),
                blockedByBlacklist: [],
                skippedByWhitelist: [],
                missingRealms: []
            });

        inquirer.prompt
            .mockResolvedValueOnce({ instanceType: 'development' })
            .mockResolvedValueOnce({ realms: ['EU05'] })
            .mockResolvedValueOnce({ deletionLevel: 'P1' })
            .mockResolvedValueOnce({ deletionSource: 'per-realm' })
            .mockResolvedValueOnce({ runAnalyze: true })
            .mockResolvedValueOnce({ refreshMetadata: false })
            .mockResolvedValueOnce({ confirm: true })
            .mockResolvedValueOnce({ restore: false });

        await triggerCommand('remove-preferences');

        expect(runAnalyzePreferencesSubprocess).toHaveBeenCalled();
    });
});

// ============================================================================
// restorePreferences — command flow
// ============================================================================

describe('restorePreferences', () => {
    it('calls restorePreferencesForRealm with correct args', async () => {
        inquirer.prompt
            .mockResolvedValueOnce({ realm: 'EU05' })
            .mockResolvedValueOnce({ proceed: true });

        await triggerCommand('restore-preferences');

        expect(findLatestBackupFile).toHaveBeenCalledWith('EU05', 'SitePreferences');
        expect(loadBackupFile).toHaveBeenCalled();
        expect(restorePreferencesForRealm).toHaveBeenCalledWith({
            preferenceIds: ['c_prefA', 'c_prefB'],
            backup: expect.any(Object),
            objectType: 'SitePreferences',
            instanceType: 'development',
            realm: 'EU05'
        });
        expect(logRestoreSummary).toHaveBeenCalled();
    });

    it('exits early when no realms configured', async () => {
        getAvailableRealms.mockReturnValueOnce([]);

        await triggerCommand('restore-preferences');

        expect(findLatestBackupFile).not.toHaveBeenCalled();
    });

    it('exits early when no backup file found', async () => {
        findLatestBackupFile.mockReturnValueOnce(null);

        inquirer.prompt.mockResolvedValueOnce({ realm: 'EU05' });

        await triggerCommand('restore-preferences');

        expect(loadBackupFile).not.toHaveBeenCalled();
    });

    it('cancels when user declines restore', async () => {
        inquirer.prompt
            .mockResolvedValueOnce({ realm: 'EU05' })
            .mockResolvedValueOnce({ proceed: false });

        await triggerCommand('restore-preferences');

        expect(loadBackupFile).not.toHaveBeenCalled();
    });

    it('validates backup before restoring', async () => {
        inquirer.prompt
            .mockResolvedValueOnce({ realm: 'EU05' })
            .mockResolvedValueOnce({ proceed: true });

        await triggerCommand('restore-preferences');

        expect(validateAndCorrectBackup).toHaveBeenCalled();
    });

    it('prompts for corrections when backup has issues', async () => {
        validateAndCorrectBackup.mockReturnValueOnce({
            corrected: true,
            corrections: ['Fixed missing field'],
            backup: { attributes: [{ id: 'c_fixed' }] }
        });

        inquirer.prompt
            .mockResolvedValueOnce({ realm: 'EU05' })
            .mockResolvedValueOnce({ proceed: true })
            .mockResolvedValueOnce({ applyCorrections: true });

        await triggerCommand('restore-preferences');

        expect(restorePreferencesForRealm).toHaveBeenCalledWith(
            expect.objectContaining({
                backup: expect.objectContaining({
                    attributes: [{ id: 'c_fixed' }]
                })
            })
        );
    });
});

// ============================================================================
// backupSitePreferences — command flow
// ============================================================================

describe('backupSitePreferences', () => {
    it('calls refreshMetadataBackupForRealm with forceJobExecution', async () => {
        inquirer.prompt.mockResolvedValueOnce({ realm: 'EU05' });

        await triggerCommand('backup-site-preferences');

        expect(refreshMetadataBackupForRealm).toHaveBeenCalledWith(
            'EU05',
            'development',
            { forceJobExecution: true }
        );
    });

    it('logs failure message when backup fails', async () => {
        refreshMetadataBackupForRealm.mockResolvedValueOnce({
            ok: false, reason: 'Connection timeout'
        });

        inquirer.prompt.mockResolvedValueOnce({ realm: 'EU05' });

        await triggerCommand('backup-site-preferences');

        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining('Connection timeout')
        );
    });

    it('logs success path when backup succeeds', async () => {
        refreshMetadataBackupForRealm.mockResolvedValueOnce({
            ok: true, filePath: '/mock/downloaded.xml'
        });

        inquirer.prompt.mockResolvedValueOnce({ realm: 'EU05' });

        await triggerCommand('backup-site-preferences');

        expect(console.log).toHaveBeenCalledWith(
            expect.stringContaining('/mock/downloaded.xml')
        );
    });
});
