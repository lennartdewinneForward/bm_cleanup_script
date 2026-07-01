import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================================
// Module Mocks
// ============================================================================

vi.mock('../../src/io/csv.js', () => ({
    parseCSVToNestedArray: vi.fn(() => []),
    findUnusedPreferences: vi.fn(() => []),
    writeUnusedPreferencesFile: vi.fn(() => '/mock/unused.txt'),
    writeUsageCSV: vi.fn(() => '/mock/usage.csv'),
    writeMatrixCSV: vi.fn(() => '/mock/matrix.csv')
}));

vi.mock('../../src/io/util.js', () => ({
    ensureResultsDir: vi.fn(() => '/mock/results'),
    buildGroupSummaries: vi.fn(() => ({})),
    filterSitesByScope: vi.fn((sites) => sites)
}));

vi.mock('../../src/scripts/loggingScript/log.js', () => ({
    logProcessingRealm: vi.fn(),
    logEmptyCSV: vi.fn(),
    logRealmResults: vi.fn(),
    logError: vi.fn(),
    logStatusUpdate: vi.fn(),
    logStatusClear: vi.fn()
}));

vi.mock('../../src/api/api.js', () => ({
    getAttributeGroups: vi.fn(),
    getAllSites: vi.fn(),
    getSitePreferences: vi.fn()
}));

vi.mock('../../src/helpers/summarize.js', () => ({
    buildMeta: vi.fn(() => ({})),
    processSitesAndGroups: vi.fn(async () => ({ usageRows: [] })),
    buildAttributeMatrix: vi.fn(() => [])
}));

vi.mock('../../src/io/siteXmlHelper.js', () => ({
    getAllAttributeDefinitionsFromMetadata: vi.fn(),
    getAttributeGroupsFromMetadataFile: vi.fn()
}));

vi.mock('../../src/config/constants.js', async (importOriginal) => {
    const original = await importOriginal();
    return {
        ...original,
        LOG_PREFIX: original.LOG_PREFIX || { INFO: 'ℹ' }
    };
});

// ============================================================================
// Imports — after mocks
// ============================================================================

import {
    processPreferenceMatrixFiles,
    executePreferenceSummarization,
    executeSummarizationFromMetadata
} from '../../src/helpers/analyzer.js';
import {
    parseCSVToNestedArray,
    findUnusedPreferences,
    writeUnusedPreferencesFile,
    writeUsageCSV,
    writeMatrixCSV
} from '../../src/io/csv.js';
import { logProcessingRealm, logEmptyCSV, logRealmResults, logError } from '../../src/scripts/loggingScript/log.js';
import { ensureResultsDir, filterSitesByScope, buildGroupSummaries } from '../../src/io/util.js';
import { getAttributeGroups, getAllSites, getSitePreferences } from '../../src/api/api.js';
import { buildMeta, processSitesAndGroups, buildAttributeMatrix } from '../../src/helpers/summarize.js';
import {
    getAllAttributeDefinitionsFromMetadata,
    getAttributeGroupsFromMetadataFile
} from '../../src/io/siteXmlHelper.js';

// ============================================================================
// processPreferenceMatrixFiles
// ============================================================================

describe('processPreferenceMatrixFiles', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-test-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('returns empty array for empty input', async () => {
        const result = await processPreferenceMatrixFiles([]);
        expect(result).toEqual([]);
    });

    it('processes a single matrix file and returns summary', async () => {
        const matrixPath = path.join(tmpDir, 'EU05_matrix.csv');
        fs.writeFileSync(matrixPath, 'placeholder', 'utf-8');

        // Mock CSV parsing to return matrix data
        parseCSVToNestedArray.mockReturnValue([
            ['preferenceId', 'defaultValue', 'EU'],
            ['c_prefA', '', 'X'],
            ['c_prefB', 'default', ''],
            ['c_prefC', '', '']
        ]);

        findUnusedPreferences.mockReturnValue(['c_prefC']);
        writeUnusedPreferencesFile.mockReturnValue(path.join(tmpDir, 'EU05_unused.txt'));

        const result = await processPreferenceMatrixFiles([
            { realm: 'EU05', matrixFile: matrixPath }
        ]);

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            realm: 'EU05',
            total: 3,
            unused: 1,
            used: 2
        });
    });

    it('processes multiple realm matrix files', async () => {
        const eu05Path = path.join(tmpDir, 'EU05_matrix.csv');
        const apacPath = path.join(tmpDir, 'APAC_matrix.csv');
        fs.writeFileSync(eu05Path, 'placeholder', 'utf-8');
        fs.writeFileSync(apacPath, 'placeholder', 'utf-8');

        let callCount = 0;
        parseCSVToNestedArray.mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                // EU05: 5 prefs, 2 unused
                return [
                    ['preferenceId', 'defaultValue', 'EU'],
                    ['c_a', '', 'X'],
                    ['c_b', '', 'X'],
                    ['c_c', '', ''],
                    ['c_d', '', ''],
                    ['c_e', 'val', '']
                ];
            }
            // APAC: 3 prefs, 1 unused
            return [
                ['preferenceId', 'defaultValue', 'APAC_site'],
                ['c_x', '', 'X'],
                ['c_y', '', 'X'],
                ['c_z', '', '']
            ];
        });

        let unusedCallCount = 0;
        findUnusedPreferences.mockImplementation(() => {
            unusedCallCount++;
            return unusedCallCount === 1 ? ['c_c', 'c_d'] : ['c_z'];
        });

        const result = await processPreferenceMatrixFiles([
            { realm: 'EU05', matrixFile: eu05Path },
            { realm: 'APAC', matrixFile: apacPath }
        ]);

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ realm: 'EU05', total: 5, unused: 2, used: 3 });
        expect(result[1]).toEqual({ realm: 'APAC', total: 3, unused: 1, used: 2 });
    });

    it('skips realms with empty CSV data', async () => {
        const emptyPath = path.join(tmpDir, 'EMPTY_matrix.csv');
        const validPath = path.join(tmpDir, 'EU05_matrix.csv');
        fs.writeFileSync(emptyPath, '', 'utf-8');
        fs.writeFileSync(validPath, 'placeholder', 'utf-8');

        let callCount = 0;
        parseCSVToNestedArray.mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                return []; // Empty CSV
            }
            return [
                ['preferenceId', 'defaultValue', 'EU'],
                ['c_valid', '', 'X']
            ];
        });

        findUnusedPreferences.mockReturnValue([]);

        const result = await processPreferenceMatrixFiles([
            { realm: 'EMPTY', matrixFile: emptyPath },
            { realm: 'EU05', matrixFile: validPath }
        ]);

        expect(result).toHaveLength(1);
        expect(result[0].realm).toBe('EU05');
        expect(logEmptyCSV).toHaveBeenCalledOnce();
    });

    it('calls logProcessingRealm for each realm', async () => {
        const matrixPath = path.join(tmpDir, 'GB_matrix.csv');
        fs.writeFileSync(matrixPath, 'placeholder', 'utf-8');

        parseCSVToNestedArray.mockReturnValue([
            ['preferenceId', 'defaultValue', 'GB'],
            ['c_pref', '', 'X']
        ]);
        findUnusedPreferences.mockReturnValue([]);

        await processPreferenceMatrixFiles([
            { realm: 'GB', matrixFile: matrixPath }
        ]);

        expect(logProcessingRealm).toHaveBeenCalledWith('GB');
    });

    it('passes correct arguments to writeUnusedPreferencesFile', async () => {
        const matrixPath = path.join(tmpDir, 'PNA_matrix.csv');
        fs.writeFileSync(matrixPath, 'placeholder', 'utf-8');

        parseCSVToNestedArray.mockReturnValue([
            ['preferenceId', 'defaultValue', 'PNA_site'],
            ['c_a', '', ''],
            ['c_b', '', '']
        ]);

        const unusedList = ['c_a', 'c_b'];
        findUnusedPreferences.mockReturnValue(unusedList);

        await processPreferenceMatrixFiles([
            { realm: 'PNA', matrixFile: matrixPath }
        ]);

        expect(writeUnusedPreferencesFile).toHaveBeenCalledWith(
            path.dirname(matrixPath),
            'PNA',
            unusedList
        );
    });

    it('reports results via logRealmResults', async () => {
        const matrixPath = path.join(tmpDir, 'EU05_matrix.csv');
        fs.writeFileSync(matrixPath, 'placeholder', 'utf-8');

        parseCSVToNestedArray.mockReturnValue([
            ['preferenceId', 'defaultValue', 'EU'],
            ['c_a', '', 'X'],
            ['c_b', '', '']
        ]);

        findUnusedPreferences.mockReturnValue(['c_b']);
        writeUnusedPreferencesFile.mockReturnValue('/output/unused.txt');

        await processPreferenceMatrixFiles([
            { realm: 'EU05', matrixFile: matrixPath }
        ]);

        expect(logRealmResults).toHaveBeenCalledWith(2, 1, '/output/unused.txt');
    });

    it('computes used count as total minus unused', async () => {
        const matrixPath = path.join(tmpDir, 'EU05_matrix.csv');
        fs.writeFileSync(matrixPath, 'placeholder', 'utf-8');

        // 10 prefs, 3 unused → 7 used
        const rows = [['preferenceId', 'defaultValue', 'EU']];
        for (let i = 0; i < 10; i++) {
            rows.push([`c_pref${i}`, '', i < 7 ? 'X' : '']);
        }
        parseCSVToNestedArray.mockReturnValue(rows);
        findUnusedPreferences.mockReturnValue(['c_pref7', 'c_pref8', 'c_pref9']);

        const result = await processPreferenceMatrixFiles([
            { realm: 'EU05', matrixFile: matrixPath }
        ]);

        expect(result[0].total).toBe(10);
        expect(result[0].unused).toBe(3);
        expect(result[0].used).toBe(7);
    });
});

// ============================================================================
// executePreferenceSummarization
// ============================================================================

describe('executePreferenceSummarization', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-exec-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});

        // Reset all mocks to clean state
        vi.clearAllMocks();

        // Setup default mock returns
        ensureResultsDir.mockReturnValue(tmpDir);
        getSitePreferences.mockResolvedValue([
            { id: 'c_pref1', value_type: 'string' },
            { id: 'c_pref2', value_type: 'boolean' }
        ]);
        getAttributeGroups.mockResolvedValue([
            { id: 'GeneralSettings', name: 'GeneralSettings', display_name: 'General' }
        ]);
        buildGroupSummaries.mockReturnValue({
            GeneralSettings: { id: 'GeneralSettings', display_name: 'General' }
        });
        getAllSites.mockResolvedValue([
            { id: 'SiteA' },
            { id: 'SiteB' }
        ]);
        filterSitesByScope.mockImplementation((sites) => sites);
        buildMeta.mockReturnValue({
            c_pref1: { id: 'c_pref1', type: 'string' },
            c_pref2: { id: 'c_pref2', type: 'boolean' }
        });
        processSitesAndGroups.mockResolvedValue({ usageRows: [] });
        buildAttributeMatrix.mockReturnValue([]);
        writeUsageCSV.mockReturnValue(path.join(tmpDir, 'usage.csv'));
        writeMatrixCSV.mockReturnValue(path.join(tmpDir, 'matrix.csv'));
        parseCSVToNestedArray.mockReturnValue([
            ['preferenceId', 'defaultValue', 'SiteA'],
            ['c_pref1', '', 'X']
        ]);
        findUnusedPreferences.mockReturnValue([]);
        writeUnusedPreferencesFile.mockReturnValue(path.join(tmpDir, 'unused.txt'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('returns realmDir and success flag on successful run', async () => {
        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            includeDefaults: false
        };

        const result = await executePreferenceSummarization(params);

        expect(result).not.toBeNull();
        expect(result.realmDir).toBe(tmpDir);
        expect(result.success).toBe(true);
    });

    it('calls ensureResultsDir with the realm', async () => {
        const params = {
            realm: 'APAC',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            includeDefaults: false
        };

        await executePreferenceSummarization(params);

        expect(ensureResultsDir).toHaveBeenCalledWith('APAC');
    });

    it('fetches preferences, groups, and sites from API', async () => {
        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            includeDefaults: true
        };

        await executePreferenceSummarization(params);

        expect(getSitePreferences).toHaveBeenCalled();
        expect(getAttributeGroups).toHaveBeenCalled();
        expect(getAllSites).toHaveBeenCalled();
    });

    it('builds preference matrices and exports results', async () => {
        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            includeDefaults: false
        };

        await executePreferenceSummarization(params);

        expect(buildMeta).toHaveBeenCalled();
        expect(processSitesAndGroups).toHaveBeenCalled();
        expect(buildAttributeMatrix).toHaveBeenCalled();
        expect(writeUsageCSV).toHaveBeenCalled();
        expect(writeMatrixCSV).toHaveBeenCalled();
    });

    it('returns null when no sites match scope filter', async () => {
        filterSitesByScope.mockReturnValue([]);

        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'single',
            siteId: 'NonExistentSite',
            includeDefaults: false
        };

        const result = await executePreferenceSummarization(params);

        expect(result).toBeNull();
        expect(logError).toHaveBeenCalled();
    });

    it('writes unused preferences file during export', async () => {
        const params = {
            realm: 'GB',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            includeDefaults: false
        };

        await executePreferenceSummarization(params);

        expect(writeUnusedPreferencesFile).toHaveBeenCalled();
    });

    it('passes progress display info when provided', async () => {
        const mockDisplay = {
            startStep: vi.fn(),
            completeStep: vi.fn(),
            setStepProgress: vi.fn()
        };

        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            includeDefaults: false
        };

        const progressInfo = {
            display: mockDisplay,
            hostname: 'dev-eu05.example.com',
            realmName: 'EU05'
        };

        const result = await executePreferenceSummarization(params, progressInfo);

        expect(result).not.toBeNull();
        expect(result.success).toBe(true);
    });

    it('handles single site scope', async () => {
        filterSitesByScope.mockReturnValue([{ id: 'SiteA' }]);

        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'single',
            siteId: 'SiteA',
            includeDefaults: false
        };

        const result = await executePreferenceSummarization(params);

        expect(result).not.toBeNull();
        expect(filterSitesByScope).toHaveBeenCalledWith(
            expect.any(Array),
            'single',
            'SiteA'
        );
    });

    it('passes includeDefaults to getSitePreferences', async () => {
        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            includeDefaults: true
        };

        await executePreferenceSummarization(params);

        expect(getSitePreferences).toHaveBeenCalledWith(
            'SitePreferences',
            'EU05',
            true,
            undefined,
            expect.any(Function),
            expect.any(Function),
            expect.anything()
        );
    });
});

// ============================================================================
// executeSummarizationFromMetadata
// ============================================================================

describe('executeSummarizationFromMetadata', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'analyzer-meta-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});

        // Reset all mocks
        vi.clearAllMocks();

        // Setup default mock returns
        ensureResultsDir.mockReturnValue(tmpDir);
        getAllAttributeDefinitionsFromMetadata.mockResolvedValue([
            { id: 'c_pref1', value_type: 'string', default_value: null },
            { id: 'c_pref2', value_type: 'boolean', default_value: 'true' }
        ]);
        getAttributeGroupsFromMetadataFile.mockResolvedValue([
            { group_id: 'GeneralSettings', group_display_name: 'General', attributes: [] }
        ]);
        buildGroupSummaries.mockReturnValue({
            GeneralSettings: { id: 'GeneralSettings', display_name: 'General' }
        });
        getAllSites.mockResolvedValue([
            { id: 'SiteA' },
            { id: 'SiteB' }
        ]);
        filterSitesByScope.mockImplementation((sites) => sites);
        buildMeta.mockReturnValue({
            c_pref1: { id: 'c_pref1', type: 'string' },
            c_pref2: { id: 'c_pref2', type: 'boolean' }
        });
        processSitesAndGroups.mockResolvedValue({ usageRows: [] });
        buildAttributeMatrix.mockReturnValue([]);
        writeUsageCSV.mockReturnValue(path.join(tmpDir, 'usage.csv'));
        writeMatrixCSV.mockReturnValue(path.join(tmpDir, 'matrix.csv'));
        parseCSVToNestedArray.mockReturnValue([
            ['preferenceId', 'defaultValue', 'SiteA'],
            ['c_pref1', '', 'X']
        ]);
        findUnusedPreferences.mockReturnValue([]);
        writeUnusedPreferencesFile.mockReturnValue(path.join(tmpDir, 'unused.txt'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('returns realmDir and success flag on successful run', async () => {
        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            metadataFilePath: '/path/to/metadata.xml'
        };

        const result = await executeSummarizationFromMetadata(params);

        expect(result).not.toBeNull();
        expect(result.realmDir).toBe(tmpDir);
        expect(result.success).toBe(true);
    });

    it('reads definitions from metadata XML instead of OCAPI', async () => {
        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            metadataFilePath: '/path/to/metadata.xml'
        };

        await executeSummarizationFromMetadata(params);

        expect(getAllAttributeDefinitionsFromMetadata).toHaveBeenCalledWith(
            '/path/to/metadata.xml',
            'SitePreferences'
        );
        expect(getAttributeGroupsFromMetadataFile).toHaveBeenCalledWith(
            '/path/to/metadata.xml',
            'SitePreferences'
        );
        // OCAPI preference fetch should NOT be called
        expect(getSitePreferences).not.toHaveBeenCalled();
        expect(getAttributeGroups).not.toHaveBeenCalled();
    });

    it('still fetches sites via OCAPI', async () => {
        const params = {
            realm: 'APAC',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            metadataFilePath: '/path/to/metadata.xml'
        };

        await executeSummarizationFromMetadata(params);

        expect(getAllSites).toHaveBeenCalledWith('APAC', null);
    });

    it('converts XML group format to OCAPI-like format', async () => {
        getAttributeGroupsFromMetadataFile.mockResolvedValue([
            { group_id: 'Search', group_display_name: 'Search Settings', attributes: [] },
            { group_id: 'Payment', group_display_name: 'Payment Config', attributes: [] }
        ]);

        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            metadataFilePath: '/path/to/metadata.xml'
        };

        await executeSummarizationFromMetadata(params);

        expect(buildGroupSummaries).toHaveBeenCalledWith([
            { id: 'Search', name: 'Search', display_name: 'Search Settings' },
            { id: 'Payment', name: 'Payment', display_name: 'Payment Config' }
        ]);
    });

    it('returns null when no sites match scope filter', async () => {
        filterSitesByScope.mockReturnValue([]);

        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'single',
            siteId: 'NonExistent',
            metadataFilePath: '/path/to/metadata.xml'
        };

        const result = await executeSummarizationFromMetadata(params);

        expect(result).toBeNull();
    });

    it('throws metadata error with context when XML parsing fails', async () => {
        getAllAttributeDefinitionsFromMetadata.mockRejectedValue(
            new Error('Invalid XML format')
        );

        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            metadataFilePath: '/bad/path.xml'
        };

        await expect(
            executeSummarizationFromMetadata(params)
        ).rejects.toThrow('Metadata file error for EU05');
    });

    it('preserves original error in thrown error', async () => {
        const originalError = new Error('Cannot read file');
        getAllAttributeDefinitionsFromMetadata.mockRejectedValue(originalError);

        const params = {
            realm: 'GB',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            metadataFilePath: '/bad/path.xml'
        };

        try {
            await executeSummarizationFromMetadata(params);
        } catch (error) {
            expect(error.originalError).toBe(originalError);
            expect(error.realm).toBe('GB');
            expect(error.isMetadataError).toBe(true);
        }
    });

    it('passes progress info to all steps', async () => {
        const mockDisplay = {
            startStep: vi.fn(),
            completeStep: vi.fn(),
            setStepProgress: vi.fn()
        };

        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            metadataFilePath: '/path/to/metadata.xml'
        };

        const progressInfo = {
            display: mockDisplay,
            hostname: 'dev-eu05.example.com',
            realmName: 'EU05'
        };

        const result = await executeSummarizationFromMetadata(params, progressInfo);

        expect(result.success).toBe(true);
        expect(mockDisplay.startStep).toHaveBeenCalled();
        expect(mockDisplay.completeStep).toHaveBeenCalled();
    });

    it('uses group_id as fallback display name when group_display_name is missing', async () => {
        getAttributeGroupsFromMetadataFile.mockResolvedValue([
            { group_id: 'NoDisplayName', attributes: [] }
        ]);

        const params = {
            realm: 'EU05',
            objectType: 'SitePreferences',
            instanceType: 'development',
            scope: 'all',
            siteId: null,
            metadataFilePath: '/path/to/metadata.xml'
        };

        await executeSummarizationFromMetadata(params);

        expect(buildGroupSummaries).toHaveBeenCalledWith([
            { id: 'NoDisplayName', name: 'NoDisplayName', display_name: 'NoDisplayName' }
        ]);
    });
});
