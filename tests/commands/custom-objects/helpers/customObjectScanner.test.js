import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/scripts/loggingScript/log.js', () => ({
    logError: vi.fn(),
    logStatusUpdate: vi.fn(),
    logStatusClear: vi.fn(),
    logProgress: vi.fn()
}));

vi.mock('../../../../src/config/helpers/helpers.js', () => ({
    getSandboxConfig: vi.fn(() => ({})),
    getAvailableRealms: vi.fn(() => []),
    getCoreSiteTemplatePath: vi.fn(() => '/mock/site_template'),
    getCoreSiteDemoPath: vi.fn(() => '/mock/site_demo'),
    getRealmsByInstanceType: vi.fn(() => [])
}));

vi.mock('../../../../src/io/util.js', () => ({
    ensureResultsDir: vi.fn(() => '/mock/results'),
    findAllMatrixFiles: vi.fn(() => []),
    findAllUsageFiles: vi.fn(() => []),
    getResultsPath: vi.fn((realm) => `/mock/results/${realm}`)
}));

vi.mock('../../../../src/commands/setup/helpers/blacklistHelper.js', () => ({
    loadBlacklist: vi.fn(() => ({ blacklist: [] })),
    filterBlacklisted: vi.fn((ids) => ({ allowed: ids, blocked: [] }))
}));

vi.mock('../../../../src/helpers/backupJob.js', () => ({
    getMetadataBackupPathForRealm: vi.fn(() => '/nonexistent')
}));

vi.mock('../../../../src/io/csv.js', () => ({
    parseCSVToNestedArray: vi.fn(() => [])
}));

import {
    formatAnalysisReport
} from '../../../../src/commands/custom-objects/helpers/customObjectScanner.js';

// ============================================================================
// formatAnalysisReport — live records & orphaned records integration
// ============================================================================

describe('formatAnalysisReport', () => {
    const baseArgs = {
        unused: ['ObsoleteType'],
        singleRealm: new Map([['SingleType', 'PNA']]),
        multiRealm: ['SharedType'],
        analysisMap: new Map([
            ['ObsoleteType', { codeRefs: 0, realms: [], cartridges: [] }],
            ['SingleType', { codeRefs: 3, realms: ['PNA'], cartridges: ['int_pna'] }],
            ['SharedType', { codeRefs: 5, realms: ['EU05', 'PNA'], cartridges: ['app_core'] }]
        ]),
        realmSites: null,
        repoName: 'TestRepo'
    };

    it('includes LIVE RECORDS WARNING section when typesWithRecords is provided', () => {
        const typesWithRecords = new Map([
            ['ObsoleteType', [{ realm: 'EU05', total: 3 }, { realm: 'GB', total: 1 }]],
            ['SingleType', [{ realm: 'PNA', total: 5 }]]
        ]);

        const result = formatAnalysisReport({ ...baseArgs, typesWithRecords });

        expect(result).toContain('LIVE RECORDS WARNING');
        expect(result).toContain('ObsoleteType — EU05: 3 record(s), GB: 1 record(s)');
        expect(result).toContain('SingleType — PNA: 5 record(s)');
    });

    it('shows inline live records warning in unused section', () => {
        const typesWithRecords = new Map([
            ['ObsoleteType', [{ realm: 'EU05', total: 3 }]]
        ]);

        const result = formatAnalysisReport({ ...baseArgs, typesWithRecords });

        expect(result).toContain('UNUSED / OBSOLETE');
        expect(result).toContain('Live records: EU05: 3');
    });

    it('shows inline live records warning in single-realm section', () => {
        const typesWithRecords = new Map([
            ['SingleType', [{ realm: 'PNA', total: 5 }]]
        ]);

        const result = formatAnalysisReport({ ...baseArgs, typesWithRecords });

        expect(result).toContain('SINGLE-REALM');
        expect(result).toContain('Live records: PNA: 5');
    });

    it('omits LIVE RECORDS WARNING section when typesWithRecords is empty', () => {
        const result = formatAnalysisReport({ ...baseArgs, typesWithRecords: new Map() });

        expect(result).not.toContain('LIVE RECORDS WARNING');
    });

    it('omits LIVE RECORDS WARNING section when typesWithRecords is undefined', () => {
        const result = formatAnalysisReport({ ...baseArgs });

        expect(result).not.toContain('LIVE RECORDS WARNING');
    });

    it('includes orphaned records section when provided', () => {
        const orphanedRecords = new Map([
            ['SingleType', [{ realm: 'EU05', total: 7 }, { realm: 'GB', total: 2 }]]
        ]);

        const result = formatAnalysisReport({ ...baseArgs, orphanedRecords });

        expect(result).toContain('ORPHANED RECORDS');
        expect(result).toContain('SingleType');
        expect(result).toContain('EU05: 7 record(s)');
        expect(result).toContain('GB: 2 record(s)');
        expect(result).toContain('target: PNA');
    });

    it('shows inline orphaned warning in single-realm section', () => {
        const orphanedRecords = new Map([
            ['SingleType', [{ realm: 'EU05', total: 7 }]]
        ]);

        const result = formatAnalysisReport({ ...baseArgs, orphanedRecords });

        expect(result).toContain('ORPHANED in other realms: EU05: 7');
    });

    it('omits orphaned records section when empty', () => {
        const result = formatAnalysisReport({ ...baseArgs, orphanedRecords: new Map() });

        expect(result).not.toContain('ORPHANED RECORDS');
    });

    it('omits orphaned records section when undefined', () => {
        const result = formatAnalysisReport({ ...baseArgs });

        expect(result).not.toContain('ORPHANED RECORDS');
    });

    it('includes all standard sections regardless of orphaned records', () => {
        const result = formatAnalysisReport({ ...baseArgs, orphanedRecords: new Map() });

        expect(result).toContain('CUSTOM OBJECT TYPE ANALYSIS REPORT');
        expect(result).toContain('UNUSED / OBSOLETE');
        expect(result).toContain('SINGLE-REALM');
        expect(result).toContain('MULTI-REALM');
        expect(result).toContain('ObsoleteType');
        expect(result).toContain('SingleType');
        expect(result).toContain('SharedType');
    });
});
