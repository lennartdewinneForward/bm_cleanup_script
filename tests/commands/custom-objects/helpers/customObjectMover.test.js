import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing module under test
vi.mock('../../../../src/api/api.js', () => ({
    searchCustomObjects: vi.fn()
}));

vi.mock('../../../../src/config/constants.js', () => ({
    LOG_PREFIX: {
        INFO: '[INFO]',
        WARNING: '[WARNING]',
        ERROR: '[ERROR]'
    }
}));

vi.mock('../../../../src/scripts/loggingScript/log.js', () => ({
    logError: vi.fn()
}));

vi.mock('../../../../src/config/helpers/helpers.js', () => ({
    getSandboxConfig: vi.fn(() => ({})),
    getAvailableRealms: vi.fn(() => []),
    getCoreSiteTemplatePath: vi.fn(() => '/mock/site_template'),
    getCoreSiteDemoPath: vi.fn(() => '/mock/site_demo')
}));

vi.mock('../../../../src/commands/custom-objects/helpers/customObjectScanner.js', () => ({
    extractCustomTypeBlock: vi.fn(),
    listCustomTypeMetaFiles: vi.fn(() => []),
    extractCustomTypeIdsFromFile: vi.fn(() => [])
}));

import { searchCustomObjects } from '../../../../src/api/api.js';
import {
    checkOrphanedRecordsForMoves,
    formatOrphanedRecordWarnings,
    formatMoveReport
} from '../../../../src/commands/custom-objects/helpers/customObjectMover.js';

// ============================================================================
// checkOrphanedRecordsForMoves
// ============================================================================

describe('checkOrphanedRecordsForMoves', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns empty map when no types have records in non-target realms', async () => {
        searchCustomObjects.mockResolvedValue({ exists: false, total: 0 });

        const singleRealmMap = new Map([['MyType', 'PNA']]);
        const allRealms = ['EU05', 'APAC', 'PNA', 'GB'];

        const result = await checkOrphanedRecordsForMoves(singleRealmMap, allRealms);

        expect(result.size).toBe(0);
        // Should only check non-target realms (EU05, APAC, GB)
        expect(searchCustomObjects).toHaveBeenCalledTimes(3);
        expect(searchCustomObjects).not.toHaveBeenCalledWith('MyType', 'PNA');
    });

    it('returns types that have records in non-target realms', async () => {
        searchCustomObjects.mockImplementation((typeId, realm) => {
            if (realm === 'EU05') return Promise.resolve({ exists: true, total: 5 });
            if (realm === 'GB') return Promise.resolve({ exists: true, total: 2 });
            return Promise.resolve({ exists: false, total: 0 });
        });

        const singleRealmMap = new Map([['OrderExport', 'PNA']]);
        const allRealms = ['EU05', 'APAC', 'PNA', 'GB'];

        const result = await checkOrphanedRecordsForMoves(singleRealmMap, allRealms);

        expect(result.size).toBe(1);
        expect(result.has('OrderExport')).toBe(true);
        const hits = result.get('OrderExport');
        expect(hits).toHaveLength(2);
        expect(hits).toContainEqual({ realm: 'EU05', total: 5 });
        expect(hits).toContainEqual({ realm: 'GB', total: 2 });
    });

    it('handles multiple single-realm types', async () => {
        searchCustomObjects.mockImplementation((typeId, realm) => {
            if (typeId === 'TypeA' && realm === 'EU05') {
                return Promise.resolve({ exists: true, total: 3 });
            }
            if (typeId === 'TypeB' && realm === 'APAC') {
                return Promise.resolve({ exists: true, total: 1 });
            }
            return Promise.resolve({ exists: false, total: 0 });
        });

        const singleRealmMap = new Map([
            ['TypeA', 'PNA'],
            ['TypeB', 'EU05']
        ]);
        const allRealms = ['EU05', 'APAC', 'PNA'];

        const result = await checkOrphanedRecordsForMoves(singleRealmMap, allRealms);

        expect(result.size).toBe(2);
        expect(result.get('TypeA')).toContainEqual({ realm: 'EU05', total: 3 });
        expect(result.get('TypeB')).toContainEqual({ realm: 'APAC', total: 1 });
    });

    it('returns empty map when singleRealmMap is empty', async () => {
        const result = await checkOrphanedRecordsForMoves(new Map(), ['EU05', 'PNA']);

        expect(result.size).toBe(0);
        expect(searchCustomObjects).not.toHaveBeenCalled();
    });

    it('skips target realm when checking for records', async () => {
        searchCustomObjects.mockResolvedValue({ exists: false, total: 0 });

        const singleRealmMap = new Map([['MyType', 'APAC']]);
        const allRealms = ['EU05', 'APAC', 'PNA'];

        await checkOrphanedRecordsForMoves(singleRealmMap, allRealms);

        const calledRealms = searchCustomObjects.mock.calls.map(c => c[1]);
        expect(calledRealms).toContain('EU05');
        expect(calledRealms).toContain('PNA');
        expect(calledRealms).not.toContain('APAC');
    });
});

// ============================================================================
// formatOrphanedRecordWarnings
// ============================================================================

describe('formatOrphanedRecordWarnings', () => {
    it('returns empty string when no orphaned records', () => {
        const result = formatOrphanedRecordWarnings(new Map());

        expect(result).toBe('');
    });

    it('formats single type with single realm hit', () => {
        const orphanedRecords = new Map([
            ['OrderExport', [{ realm: 'EU05', total: 3 }]]
        ]);

        const result = formatOrphanedRecordWarnings(orphanedRecords);

        expect(result).toContain('OrderExport');
        expect(result).toContain('EU05: 3 record(s)');
        expect(result).toContain('OTHER realms');
    });

    it('formats multiple types with multiple realm hits', () => {
        const orphanedRecords = new Map([
            ['TypeA', [{ realm: 'EU05', total: 5 }, { realm: 'GB', total: 2 }]],
            ['TypeB', [{ realm: 'APAC', total: 1 }]]
        ]);

        const result = formatOrphanedRecordWarnings(orphanedRecords);

        expect(result).toContain('TypeA');
        expect(result).toContain('EU05: 5 record(s)');
        expect(result).toContain('GB: 2 record(s)');
        expect(result).toContain('TypeB');
        expect(result).toContain('APAC: 1 record(s)');
    });
});

// ============================================================================
// formatMoveReport — orphaned records integration
// ============================================================================

describe('formatMoveReport', () => {
    const baseArgs = {
        repoName: 'TestRepo',
        instanceType: 'sandbox',
        realms: ['EU05', 'PNA'],
        selectedMap: new Map([['TypeA', 'PNA']]),
        analysisMap: new Map([['TypeA', { codeRefs: 2, realms: ['PNA'], cartridges: ['int_pna'] }]]),
        realmSites: null,
        results: {
            moved: ['TypeA'],
            filesCreated: ['/path/to/file.xml'],
            filesModified: ['/path/to/existing.xml'],
            errors: []
        },
        dryRun: false
    };

    it('includes orphaned records section when orphanedRecords is provided', () => {
        const orphanedRecords = new Map([
            ['TypeA', [{ realm: 'EU05', total: 4 }]]
        ]);

        const result = formatMoveReport({ ...baseArgs, orphanedRecords });

        expect(result).toContain('ORPHANED RECORDS');
        expect(result).toContain('TypeA');
        expect(result).toContain('EU05: 4 record(s)');
        expect(result).toContain('moved to: PNA');
    });

    it('omits orphaned records section when empty', () => {
        const result = formatMoveReport({ ...baseArgs, orphanedRecords: new Map() });

        expect(result).not.toContain('ORPHANED RECORDS');
    });

    it('omits orphaned records section when undefined', () => {
        const result = formatMoveReport({ ...baseArgs });

        expect(result).not.toContain('ORPHANED RECORDS');
    });

    it('shows orphaned record count in summary', () => {
        const orphanedRecords = new Map([
            ['TypeA', [{ realm: 'EU05', total: 4 }]]
        ]);

        const result = formatMoveReport({ ...baseArgs, orphanedRecords });

        expect(result).toContain('Orphaned record warnings: 1 type(s)');
    });

    it('shows inline orphaned warning per type in moved section', () => {
        const orphanedRecords = new Map([
            ['TypeA', [{ realm: 'EU05', total: 4 }, { realm: 'GB', total: 1 }]]
        ]);

        const result = formatMoveReport({ ...baseArgs, orphanedRecords });

        expect(result).toContain('Orphaned records: EU05: 4, GB: 1');
    });
});
