import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock config helpers before importing module under test
vi.mock('../../src/config/helpers/helpers.js', () => ({
    getValidationConfig: vi.fn(() => ({ ignoreBmCartridges: false })),
    getInstanceType: vi.fn(() => 'development'),
    getAvailableRealms: vi.fn(() => ['EU05', 'APAC', 'PNA', 'GB'])
}));

vi.mock('../../src/config/constants.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        DIRECTORIES: { ...actual.DIRECTORIES, RESULTS: 'results' },
        IDENTIFIERS: { ...actual.IDENTIFIERS, ALL_REALMS: 'ALL_REALMS' }
    };
});

import {
    getResultsPath,
    ensureResultsDir,
    transformSiteToCartridgeInfo,
    buildGroupSummaries,
    filterSitesByScope,
    calculateValidationStats,
    findCartridgeFolders,
    findAllMatrixFiles,
    findAllUsageFiles,
    writeTestOutput
} from '../../src/io/util.js';

import { getInstanceType, getAvailableRealms, getValidationConfig } from '../../src/config/helpers/helpers.js';

// ============================================================================
// getResultsPath
// ============================================================================

describe('getResultsPath', () => {
    it('returns base results directory when no realm is given', () => {
        const result = getResultsPath();
        expect(result).toBe(path.join(process.cwd(), 'results'));
    });

    it('returns realm subdirectory with instance type from config', () => {
        getInstanceType.mockReturnValue('development');
        const result = getResultsPath('EU05');
        expect(result).toBe(path.join(process.cwd(), 'results', 'development', 'EU05'));
    });

    it('uses instanceTypeOverride when provided', () => {
        const result = getResultsPath('EU05', 'sandbox');
        expect(result).toBe(path.join(process.cwd(), 'results', 'sandbox', 'EU05'));
    });

    it('returns ALL_REALMS path with instanceTypeOverride', () => {
        const result = getResultsPath('ALL_REALMS', 'development');
        expect(result).toBe(path.join(process.cwd(), 'results', 'development', 'ALL_REALMS'));
    });

    it('returns ALL_REALMS path without instanceTypeOverride', () => {
        const result = getResultsPath('ALL_REALMS');
        expect(result).toBe(path.join(process.cwd(), 'results', 'ALL_REALMS'));
    });

    it('falls back to unknown when getInstanceType throws', () => {
        getInstanceType.mockImplementation(() => { throw new Error('not found'); });
        const result = getResultsPath('UNKNOWN_REALM');
        expect(result).toBe(path.join(process.cwd(), 'results', 'unknown', 'UNKNOWN_REALM'));
    });

    it('includes typeId when provided with realm and instance', () => {
        const result = getResultsPath('EU05', 'development', 'Organization');
        expect(result).toBe(path.join(process.cwd(), 'results', 'development', 'EU05', 'Organization'));
    });

    it('includes typeId with ALL_REALMS', () => {
        const result = getResultsPath('ALL_REALMS', 'development', 'Order');
        expect(result).toBe(path.join(process.cwd(), 'results', 'development', 'ALL_REALMS', 'Order'));
    });

    it('includes typeId when instanceType is derived from config', () => {
        getInstanceType.mockReturnValue('development');
        const result = getResultsPath('EU05', null, 'Organization');
        expect(result).toBe(path.join(process.cwd(), 'results', 'development', 'EU05', 'Organization'));
    });
});

// ============================================================================
// ensureResultsDir
// ============================================================================

describe('ensureResultsDir', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'util-test-'));
        vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('creates results directory if it does not exist', () => {
        const dir = ensureResultsDir('EU05', 'development');
        expect(fs.existsSync(dir)).toBe(true);
        expect(dir).toContain('EU05');
    });

    it('returns existing directory without error', () => {
        const dir1 = ensureResultsDir('EU05', 'development');
        const dir2 = ensureResultsDir('EU05', 'development');
        expect(dir1).toBe(dir2);
        expect(fs.existsSync(dir2)).toBe(true);
    });

    it('creates typeId subdirectory when provided', () => {
        const dir = ensureResultsDir('EU05', 'development', 'Organization');
        expect(fs.existsSync(dir)).toBe(true);
        expect(dir).toContain('Organization');
        expect(dir).toContain('EU05');
    });

    it('creates nested typeId directory structure', () => {
        const dir = ensureResultsDir('ALL_REALMS', 'development', 'Order');
        expect(fs.existsSync(dir)).toBe(true);
        expect(dir).toMatch(/development[\\\/]ALL_REALMS[\\\/]Order/);
    });
});

// ============================================================================
// transformSiteToCartridgeInfo
// ============================================================================

describe('transformSiteToCartridgeInfo', () => {
    it('transforms site with colon-separated cartridges string', () => {
        const site = { id: 'MySite', cartridges: 'app_custom:app_base:int_payment' };
        const result = transformSiteToCartridgeInfo(site);

        expect(result.id).toBe('MySite');
        expect(result.name).toBe('MySite');
        expect(result.cartridges).toEqual(['app_custom', 'app_base', 'int_payment']);
    });

    it('includes realm name when provided', () => {
        const site = { id: 'MySite', cartridges: 'app_custom' };
        const result = transformSiteToCartridgeInfo(site, 'EU05');

        expect(result.name).toBe('MySite (EU05)');
        expect(result.realm).toBe('EU05');
    });

    it('does not include realm property when realmName is null', () => {
        const site = { id: 'MySite', cartridges: 'app_custom' };
        const result = transformSiteToCartridgeInfo(site);

        expect(result.realm).toBeUndefined();
    });

    it('falls back to site_id and cartridgesPath', () => {
        const site = { site_id: 'AltSite', cartridgesPath: 'app_alt:app_core' };
        const result = transformSiteToCartridgeInfo(site);

        expect(result.id).toBe('AltSite');
        expect(result.cartridges).toEqual(['app_alt', 'app_core']);
    });

    it('handles missing fields with N/A fallback', () => {
        const site = {};
        const result = transformSiteToCartridgeInfo(site);

        expect(result.id).toBe('N/A');
    });
});

// ============================================================================
// buildGroupSummaries
// ============================================================================

describe('buildGroupSummaries', () => {
    it('builds summaries from group objects', () => {
        const groups = [
            { id: 'SearchSettings', name: 'Search', display_name: 'Search Configuration' },
            { id: 'GlobalPrefs', name: 'Global' }
        ];

        const summaries = buildGroupSummaries(groups);

        expect(summaries).toHaveLength(2);
        expect(summaries[0]).toEqual({
            groupId: 'SearchSettings',
            groupName: 'Search',
            displayName: 'Search Configuration'
        });
        expect(summaries[1]).toEqual({
            groupId: 'GlobalPrefs',
            groupName: 'Global',
            displayName: 'GlobalPrefs'
        });
    });

    it('uses id as fallback for name and displayName', () => {
        const groups = [{ id: 'MyGroup' }];
        const summaries = buildGroupSummaries(groups);

        expect(summaries[0].groupName).toBe('MyGroup');
        expect(summaries[0].displayName).toBe('MyGroup');
    });

    it('returns empty array for empty input', () => {
        expect(buildGroupSummaries([])).toEqual([]);
    });
});

// ============================================================================
// filterSitesByScope
// ============================================================================

describe('filterSitesByScope', () => {
    const sites = [
        { id: 'site1' },
        { id: 'site2' },
        { id: 'site3' }
    ];

    it('returns all sites for scope "all"', () => {
        expect(filterSitesByScope(sites, 'all', 'site1')).toEqual(sites);
    });

    it('returns single site for scope "single"', () => {
        const result = filterSitesByScope(sites, 'single', 'site2');
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('site2');
    });

    it('returns empty array when single site not found', () => {
        const result = filterSitesByScope(sites, 'single', 'nonexistent');
        expect(result).toEqual([]);
    });
});

// ============================================================================
// calculateValidationStats
// ============================================================================

describe('calculateValidationStats', () => {
    it('counts matching and mismatched comparisons', () => {
        const comparisons = [
            { comparison: { isMatch: true } },
            { comparison: { isMatch: false } },
            { comparison: { isMatch: true } }
        ];

        const stats = calculateValidationStats(comparisons);

        expect(stats.total).toBe(3);
        expect(stats.matching).toBe(2);
        expect(stats.mismatched).toBe(1);
    });

    it('handles all matching', () => {
        const comparisons = [
            { comparison: { isMatch: true } },
            { comparison: { isMatch: true } }
        ];

        const stats = calculateValidationStats(comparisons);
        expect(stats.matching).toBe(2);
        expect(stats.mismatched).toBe(0);
    });

    it('handles empty array', () => {
        const stats = calculateValidationStats([]);
        expect(stats).toEqual({ total: 0, matching: 0, mismatched: 0 });
    });
});

// ============================================================================
// findCartridgeFolders
// ============================================================================

describe('findCartridgeFolders', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartridge-test-'));
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('finds cartridges inside a "cartridges" directory', () => {
        const cartridgesDir = path.join(tmpDir, 'cartridges');
        fs.mkdirSync(cartridgesDir);
        fs.mkdirSync(path.join(cartridgesDir, 'app_custom'));
        fs.mkdirSync(path.join(cartridgesDir, 'int_payment'));

        const result = findCartridgeFolders(tmpDir);
        expect(result).toContain('app_custom');
        expect(result).toContain('int_payment');
    });

    it('finds cartridges by presence of "cartridge" subfolder', () => {
        const projectDir = path.join(tmpDir, 'myProject');
        fs.mkdirSync(projectDir, { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'cartridge'));

        const result = findCartridgeFolders(tmpDir);
        expect(result).toContain('myProject');
    });

    it('returns empty array for empty directory', () => {
        const result = findCartridgeFolders(tmpDir);
        expect(result).toEqual([]);
    });

    it('skips hidden directories and node_modules', () => {
        fs.mkdirSync(path.join(tmpDir, '.hidden'));
        fs.mkdirSync(path.join(tmpDir, 'node_modules'));

        const result = findCartridgeFolders(tmpDir);
        expect(result).not.toContain('.hidden');
        expect(result).not.toContain('node_modules');
    });

    it('excludes bm_ cartridges when configured', () => {
        getValidationConfig.mockReturnValue({ ignoreBmCartridges: true });

        const cartridgesDir = path.join(tmpDir, 'cartridges');
        fs.mkdirSync(cartridgesDir);
        fs.mkdirSync(path.join(cartridgesDir, 'app_custom'));
        fs.mkdirSync(path.join(cartridgesDir, 'bm_admin'));

        const result = findCartridgeFolders(tmpDir);
        expect(result).toContain('app_custom');
        expect(result).not.toContain('bm_admin');
    });

    it('returns sorted results', () => {
        const cartridgesDir = path.join(tmpDir, 'cartridges');
        fs.mkdirSync(cartridgesDir);
        fs.mkdirSync(path.join(cartridgesDir, 'z_cart'));
        fs.mkdirSync(path.join(cartridgesDir, 'a_cart'));
        fs.mkdirSync(path.join(cartridgesDir, 'm_cart'));

        const result = findCartridgeFolders(tmpDir);
        expect(result).toEqual(['a_cart', 'm_cart', 'z_cart']);
    });

    it('searches subdirectories recursively', () => {
        const subDir = path.join(tmpDir, 'level1', 'level2');
        fs.mkdirSync(subDir, { recursive: true });
        fs.mkdirSync(path.join(subDir, 'cartridge'));

        const result = findCartridgeFolders(tmpDir);
        expect(result).toContain('level2');
    });
});

// ============================================================================
// findAllMatrixFiles / findAllUsageFiles
// ============================================================================

describe('findAllMatrixFiles', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-test-'));
        vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('finds matrix files across realm directories', () => {
        getInstanceType.mockReturnValue('development');
        // Create directory structure matching getResultsPath pattern
        const eu05Dir = path.join(tmpDir, 'results', 'development', 'EU05');
        fs.mkdirSync(eu05Dir, { recursive: true });
        fs.writeFileSync(path.join(eu05Dir, 'EU05_development_preferences_matrix.csv'), 'data');

        const apacDir = path.join(tmpDir, 'results', 'development', 'APAC');
        fs.mkdirSync(apacDir, { recursive: true });
        fs.writeFileSync(path.join(apacDir, 'APAC_development_preferences_matrix.csv'), 'data');

        const result = findAllMatrixFiles(['EU05', 'APAC']);

        expect(result).toHaveLength(2);
        expect(result[0].realm).toBe('EU05');
        expect(result[0].matrixFile).toContain('preferences_matrix.csv');
        expect(result[1].realm).toBe('APAC');
    });

    it('returns empty array when no matrix files exist', () => {
        getInstanceType.mockReturnValue('development');
        // Create realm dirs without matrix files
        const eu05Dir = path.join(tmpDir, 'results', 'development', 'EU05');
        fs.mkdirSync(eu05Dir, { recursive: true });

        const result = findAllMatrixFiles(['EU05']);
        expect(result).toEqual([]);
    });

    it('respects realmFilter parameter', () => {
        getInstanceType.mockReturnValue('development');
        const eu05Dir = path.join(tmpDir, 'results', 'development', 'EU05');
        fs.mkdirSync(eu05Dir, { recursive: true });
        fs.writeFileSync(path.join(eu05Dir, 'EU05_development_preferences_matrix.csv'), 'data');

        // Verify path resolution matches
        const expectedPath = getResultsPath('EU05');
        expect(expectedPath).toBe(eu05Dir);

        const result = findAllMatrixFiles(['EU05']);

        expect(result).toHaveLength(1);
        expect(result[0].realm).toBe('EU05');
    });
});

describe('findAllUsageFiles', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
        vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('finds usage files across realm directories', () => {
        getInstanceType.mockReturnValue('development');
        const eu05Dir = path.join(tmpDir, 'results', 'development', 'EU05');
        fs.mkdirSync(eu05Dir, { recursive: true });
        fs.writeFileSync(path.join(eu05Dir, 'EU05_development_preferences_usage.csv'), 'data');

        const result = findAllUsageFiles(['EU05']);
        expect(result).toHaveLength(1);
        expect(result[0].usageFile).toContain('preferences_usage.csv');
    });
});

// ============================================================================
// writeTestOutput
// ============================================================================

describe('writeTestOutput', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'write-test-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('writes JSON data to file', () => {
        const filePath = path.join(tmpDir, 'output.json');
        const data = { key: 'value', nested: { arr: [1, 2, 3] } };

        writeTestOutput(filePath, data);

        const written = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        expect(written).toEqual(data);
    });

    it('logs filename to console by default', () => {
        const filePath = path.join(tmpDir, 'output.json');
        writeTestOutput(filePath, { test: true });

        expect(console.log).toHaveBeenCalledWith(expect.stringContaining(filePath));
    });

    it('suppresses console output when consoleOutput is false', () => {
        const filePath = path.join(tmpDir, 'output.json');
        writeTestOutput(filePath, { test: true }, { consoleOutput: false });

        expect(console.log).not.toHaveBeenCalled();
    });

    it('logs preview when provided', () => {
        const filePath = path.join(tmpDir, 'output.json');
        const preview = { summary: 'short' };
        writeTestOutput(filePath, { full: 'data' }, { preview });

        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"summary"'));
    });
});
