import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

vi.mock('../../src/io/util.js', () => ({
    ensureResultsDir: vi.fn(() => '/mock/results'),
    findAllMatrixFiles: vi.fn(() => []),
    findAllUsageFiles: vi.fn(() => []),
    getResultsPath: vi.fn((realm) => `/mock/results/${realm}`)
}));

vi.mock('../../src/config/helpers/helpers.js', () => ({
    getRealmsByInstanceType: vi.fn(() => [])
}));

vi.mock('../../src/commands/setup/helpers/blacklistHelper.js', () => ({
    loadBlacklist: vi.fn(() => ({ blacklist: [] })),
    filterBlacklisted: vi.fn((ids) => ({ allowed: ids, blocked: [] }))
}));

vi.mock('../../src/helpers/backupJob.js', () => ({
    getMetadataBackupPathForRealm: vi.fn(() => '/nonexistent')
}));

vi.mock('../../src/scripts/loggingScript/log.js', () => ({
    logStatusUpdate: vi.fn(),
    logStatusClear: vi.fn(),
    logProgress: vi.fn(),
    logError: vi.fn()
}));

vi.mock('../../src/io/csv.js', () => ({
    parseCSVToNestedArray: vi.fn(() => [])
}));

import {
    getActivePreferencesFromMatrices,
    findPreferenceUsage,
    findAllActivePreferencesUsage,
    isPreferenceAccessMatch
} from '../../src/io/codeScanner.js';
import { findAllMatrixFiles, ensureResultsDir } from '../../src/io/util.js';

// ============================================================================
// isPreferenceAccessMatch — strict preference pattern matching
// ============================================================================

describe('isPreferenceAccessMatch', () => {
    // Positive matches — should return true
    it('matches single-quoted string literal', () => {
        expect(isPreferenceAccessMatch("getCustomPreferenceValue('enableSearch')", 'enableSearch')).toBe(true);
    });

    it('matches double-quoted string literal', () => {
        expect(isPreferenceAccessMatch('getCustomPreferenceValue("enableSearch")', 'enableSearch')).toBe(true);
    });

    it('matches JSON key with double quotes', () => {
        expect(isPreferenceAccessMatch('{"enableSearch": true}', 'enableSearch')).toBe(true);
    });

    it('matches .custom.PrefId dot access', () => {
        expect(isPreferenceAccessMatch('Site.current.preferences.custom.enableSearch', 'enableSearch')).toBe(true);
    });

    it('matches .custom["PrefId"] bracket access with double quotes', () => {
        expect(isPreferenceAccessMatch('prefs.custom["enableSearch"]', 'enableSearch')).toBe(true);
    });

    it("matches .custom['PrefId'] bracket access with single quotes", () => {
        expect(isPreferenceAccessMatch("prefs.custom['enableSearch']", 'enableSearch')).toBe(true);
    });

    it('matches bracket access with spaces inside brackets', () => {
        expect(isPreferenceAccessMatch('prefs.custom[ "enableSearch" ]', 'enableSearch')).toBe(true);
    });

    it('matches SFCC query syntax (custom.PrefId without leading dot)', () => {
        expect(isPreferenceAccessMatch(
            'shippingStatus = {0} AND custom.amazonCaptureStatus= {1}',
            'amazonCaptureStatus'
        )).toBe(true);
    });

    // Negative matches — should return false
    it('rejects bare word in plain text', () => {
        expect(isPreferenceAccessMatch('enableSearch is used here', 'enableSearch')).toBe(false);
    });

    it('rejects function name containing the preference ID', () => {
        expect(isPreferenceAccessMatch('imageUtils.getPisaVideoHostname()', 'PisaVideoHostname')).toBe(false);
    });

    it('rejects variable assignment with same name', () => {
        expect(isPreferenceAccessMatch('const enableSearch = true;', 'enableSearch')).toBe(false);
    });

    it('rejects partial match inside longer word', () => {
        expect(isPreferenceAccessMatch('enableSearchAndFilter()', 'enableSearch')).toBe(false);
    });

    it('rejects comment mentioning preference name without quotes', () => {
        expect(isPreferenceAccessMatch('// enable search feature via enableSearch', 'enableSearch')).toBe(false);
    });

    // OCAPI c_ prefix matches — should return true
    it('matches OCAPI c_ prefixed string literal (double quotes)', () => {
        expect(isPreferenceAccessMatch('const val = order["c_enableSearch"]', 'enableSearch')).toBe(true);
    });

    it('matches OCAPI c_ prefixed string literal (single quotes)', () => {
        expect(isPreferenceAccessMatch("const val = order['c_enableSearch']", 'enableSearch')).toBe(true);
    });

    it('matches OCAPI c_ prefixed dot property access', () => {
        expect(isPreferenceAccessMatch('const val = order.c_enableSearch', 'enableSearch')).toBe(true);
    });

    it('matches OCAPI c_ prefixed bracket access', () => {
        expect(isPreferenceAccessMatch('order["c_enableSearch"]', 'enableSearch')).toBe(true);
    });

    it('matches c_ prefix in JSON key', () => {
        expect(isPreferenceAccessMatch('{"c_enableSearch": true}', 'enableSearch')).toBe(true);
    });

    // Custom variable dot access — handles destructured custom objects (e.g. orderCustom)
    it('matches custom object variable dot access (orderCustom.attrId)', () => {
        expect(isPreferenceAccessMatch(
            'orderLine.push(getValue(orderCustom.amazonOrderReferenceID));',
            'amazonOrderReferenceID'
        )).toBe(true);
    });

    it('matches generic xyzCustom.attrId variable pattern', () => {
        expect(isPreferenceAccessMatch('lineItemCustom.enableSearch', 'enableSearch')).toBe(true);
    });

    it('matches getCustom() method call dot access (.getCustom().attrId)', () => {
        expect(isPreferenceAccessMatch(
            'let val = order.getCustom().radialWalletType;',
            'radialWalletType'
        )).toBe(true);
    });

    // Prefs variable dot access — handles site preference holder variables (e.g. sitePrefs, prefs)
    it('matches sitePrefs variable dot access (sitePrefs.prefId)', () => {
        expect(isPreferenceAccessMatch('sitePrefs.disableforterorderupdate', 'disableforterorderupdate')).toBe(true);
    });

    it('matches prefs variable dot access (prefs.prefId)', () => {
        expect(isPreferenceAccessMatch('prefs.enableSearch', 'enableSearch')).toBe(true);
    });

    it('matches sitePreferences variable dot access (sitePreferences.prefId)', () => {
        expect(isPreferenceAccessMatch('sitePreferences.enableSearch', 'enableSearch')).toBe(true);
    });

    it('matches customPrefs variable dot access (customPrefs.prefId)', () => {
        expect(isPreferenceAccessMatch('customPrefs.enableSearch', 'enableSearch')).toBe(true);
    });

    it('rejects non-custom variable dot access (order.enableSearch)', () => {
        expect(isPreferenceAccessMatch('order.enableSearch', 'enableSearch')).toBe(false);
    });
});

// ============================================================================
// getActivePreferencesFromMatrices
// ============================================================================

describe('getActivePreferencesFromMatrices', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('extracts unique preference IDs from a single matrix file', () => {
        const csvContent = [
            'preferenceId,defaultValue,site1,site2',
            'enableSearch,,X,',
            'maxResults,50,,X',
            'unusedPref,,,'
        ].join('\n');

        const filePath = path.join(tmpDir, 'matrix.csv');
        fs.writeFileSync(filePath, csvContent, 'utf-8');

        const result = getActivePreferencesFromMatrices([filePath]);

        expect(result).toBeInstanceOf(Set);
        expect(result.size).toBe(3);
        expect(result.has('enableSearch')).toBe(true);
        expect(result.has('maxResults')).toBe(true);
        expect(result.has('unusedPref')).toBe(true);
    });

    it('merges preferences from multiple matrix files', () => {
        const csv1 = 'preferenceId,defaultValue,site1\nprefA,,X\nprefB,,';
        const csv2 = 'preferenceId,defaultValue,site1\nprefB,,X\nprefC,,X';

        const file1 = path.join(tmpDir, 'matrix1.csv');
        const file2 = path.join(tmpDir, 'matrix2.csv');
        fs.writeFileSync(file1, csv1, 'utf-8');
        fs.writeFileSync(file2, csv2, 'utf-8');

        const result = getActivePreferencesFromMatrices([file1, file2]);

        expect(result.size).toBe(3);
        expect(result.has('prefA')).toBe(true);
        expect(result.has('prefB')).toBe(true);
        expect(result.has('prefC')).toBe(true);
    });

    it('handles empty files gracefully', () => {
        const filePath = path.join(tmpDir, 'empty.csv');
        fs.writeFileSync(filePath, '', 'utf-8');

        const result = getActivePreferencesFromMatrices([filePath]);
        expect(result.size).toBe(0);
    });

    it('handles header-only files', () => {
        const filePath = path.join(tmpDir, 'header-only.csv');
        fs.writeFileSync(filePath, 'preferenceId,defaultValue,site1', 'utf-8');

        const result = getActivePreferencesFromMatrices([filePath]);
        expect(result.size).toBe(0);
    });

    it('skips non-existent files without error', () => {
        const result = getActivePreferencesFromMatrices(['/nonexistent/file.csv']);
        expect(result.size).toBe(0);
    });

    it('returns empty set for empty input array', () => {
        const result = getActivePreferencesFromMatrices([]);
        expect(result.size).toBe(0);
    });

    it('strips quotes from CSV field values', () => {
        const csvContent = 'preferenceId,defaultValue\n"quotedPref","someDefault"';
        const filePath = path.join(tmpDir, 'quoted.csv');
        fs.writeFileSync(filePath, csvContent, 'utf-8');

        const result = getActivePreferencesFromMatrices([filePath]);
        expect(result.has('quotedPref')).toBe(true);
    });
});

// ============================================================================
// Helper: create a cartridge directory layout for integration tests
// ============================================================================

/**
 * Build a minimal cartridge directory tree inside tmpDir.
 * Returns the path to the repository root (parent of /cartridges).
 *
 * Structure:
 *   <tmpDir>/cartridges/<cartridgeName>/cartridge/scripts/<file>
 */
function createCartridgeFiles(tmpDir, cartridgeName, files) {
    const cartridgeScripts = path.join(
        tmpDir, 'cartridges', cartridgeName, 'cartridge', 'scripts'
    );
    fs.mkdirSync(cartridgeScripts, { recursive: true });

    for (const [fileName, content] of Object.entries(files)) {
        fs.writeFileSync(path.join(cartridgeScripts, fileName), content, 'utf-8');
    }

    return tmpDir; // repo root
}

/**
 * Write a cartridge comparison file that lists deprecated cartridges
 */
function createComparisonFile(tmpDir, deprecatedCartridges = []) {
    const content = [
        '--- Potentially Deprecated Cartridges ---',
        ...deprecatedCartridges.map(name => `  [X] ${name}`),
        '--- Active Cartridges ---',
        '  [✓] app_storefront_base'
    ].join('\n');
    const filePath = path.join(tmpDir, 'comparison.txt');
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
}

// ============================================================================
// findPreferenceUsage — single preference scanning
// ============================================================================

describe('findPreferenceUsage', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-usage-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
    });

    it('finds preference usage in cartridge files', async () => {
        createCartridgeFiles(tmpDir, 'app_custom', {
            'helper.js': 'const val = dw.system.Site.getCurrent().getCustomPreferenceValue("enableSearch");'
        });

        const result = await findPreferenceUsage('enableSearch', tmpDir, {
            comparisonFilePath: '/nonexistent/comparison.txt'
        });

        expect(result.preferenceId).toBe('enableSearch');
        expect(result.totalMatches).toBeGreaterThanOrEqual(1);
        expect(result.cartridges).toContain('app_custom');
    });

    it('returns zero matches when preference not found', async () => {
        createCartridgeFiles(tmpDir, 'app_custom', {
            'helper.js': 'const val = someOtherFunction();'
        });

        const result = await findPreferenceUsage('nonExistentPref', tmpDir, {
            comparisonFilePath: '/nonexistent/comparison.txt'
        });

        expect(result.totalMatches).toBe(0);
        expect(result.cartridges).toEqual([]);
    });

    it('finds matches in .isml files', async () => {
        const cartridgeDir = path.join(tmpDir, 'cartridges', 'app_storefront', 'cartridge', 'templates', 'default');
        fs.mkdirSync(cartridgeDir, { recursive: true });
        fs.writeFileSync(
            path.join(cartridgeDir, 'page.isml'),
            '<isif condition="${dw.system.Site.getCurrent().getCustomPreferenceValue(\'showBanner\')}">\n<div>Banner</div>\n</isif>',
            'utf-8'
        );

        const result = await findPreferenceUsage('showBanner', tmpDir, {
            comparisonFilePath: '/nonexistent/comparison.txt'
        });

        expect(result.totalMatches).toBeGreaterThanOrEqual(1);
        expect(result.cartridges).toContain('app_storefront');
    });

    it('skips deprecated cartridges', async () => {
        createCartridgeFiles(tmpDir, 'int_old_payment', {
            'payment.js': 'Site.current.preferences.custom.enablePayment'
        });
        createCartridgeFiles(tmpDir, 'app_custom', {
            'other.js': 'getCustomPreferenceValue("enablePayment")'
        });

        const comparisonFile = createComparisonFile(tmpDir, ['int_old_payment']);

        const result = await findPreferenceUsage('enablePayment', tmpDir, {
            comparisonFilePath: comparisonFile
        });

        // Only app_custom should appear (int_old_payment is deprecated)
        expect(result.cartridges).toContain('app_custom');
        expect(result.cartridges).not.toContain('int_old_payment');
    });

    it('skips node_modules and .git directories', async () => {
        // Create a file in node_modules
        const nodeModulesDir = path.join(tmpDir, 'node_modules', 'some-lib');
        fs.mkdirSync(nodeModulesDir, { recursive: true });
        fs.writeFileSync(
            path.join(nodeModulesDir, 'index.js'),
            'const enableFeature = true;',
            'utf-8'
        );

        // Create a .git directory file
        const gitDir = path.join(tmpDir, '.git', 'hooks');
        fs.mkdirSync(gitDir, { recursive: true });
        fs.writeFileSync(
            path.join(gitDir, 'pre-commit.js'),
            'const enableFeature = true;',
            'utf-8'
        );

        const result = await findPreferenceUsage('enableFeature', tmpDir, {
            comparisonFilePath: '/nonexistent/comparison.txt'
        });

        expect(result.totalMatches).toBe(0);
    });

    it('only scans allowed extensions', async () => {
        const cartridgeDir = path.join(tmpDir, 'cartridges', 'app_custom', 'cartridge', 'scripts');
        fs.mkdirSync(cartridgeDir, { recursive: true });

        // Allowed extension → should be scanned
        fs.writeFileSync(path.join(cartridgeDir, 'config.json'), '{"enableSearch": true}', 'utf-8');
        // Non-allowed extension → should be skipped
        fs.writeFileSync(path.join(cartridgeDir, 'image.png'), 'enableSearch', 'utf-8');

        const result = await findPreferenceUsage('enableSearch', tmpDir, {
            comparisonFilePath: '/nonexistent/comparison.txt'
        });

        expect(result.totalMatches).toBe(1);
    });

    it('logs scan details on first search', async () => {
        createCartridgeFiles(tmpDir, 'app_custom', { 'a.js': '"pref1"' });

        await findPreferenceUsage('pref1', tmpDir, {
            comparisonFilePath: '/nonexistent/comparison.txt',
            isFirstSearch: true
        });

        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('pref1'));
    });

    it('returns result with correct structure', async () => {
        createCartridgeFiles(tmpDir, 'app_custom', { 'a.js': '"testPref"' });

        const result = await findPreferenceUsage('testPref', tmpDir, {
            comparisonFilePath: '/nonexistent/comparison.txt'
        });

        expect(result).toHaveProperty('preferenceId', 'testPref');
        expect(result).toHaveProperty('repositoryPath', tmpDir);
        expect(result).toHaveProperty('deprecatedCartridgesCount');
        expect(result).toHaveProperty('totalMatches');
        expect(result).toHaveProperty('cartridges');
    });
});

// ============================================================================
// findAllActivePreferencesUsage — batch scanning
// ============================================================================

describe('findAllActivePreferencesUsage', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-all-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.clearAllMocks();
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
    });

    it('returns empty array when no matrix files found', async () => {
        findAllMatrixFiles.mockReturnValue([]);

        const result = await findAllActivePreferencesUsage(tmpDir);
        expect(result).toEqual([]);
    });

    it('scans cartridge files for all preferences from matrices', async () => {
        // Create matrix CSV
        const matrixCsv = 'preferenceId,defaultValue,site1\nenableSearch,,X\nshowBanner,,X';
        const matrixPath = path.join(tmpDir, 'matrix.csv');
        fs.writeFileSync(matrixPath, matrixCsv, 'utf-8');

        findAllMatrixFiles.mockReturnValue([{ matrixFile: matrixPath }]);
        ensureResultsDir.mockReturnValue(tmpDir);

        // Create cartridge with references to preferences
        createCartridgeFiles(tmpDir, 'app_custom', {
            'search.js': 'getCustomPreferenceValue("enableSearch")',
            'banner.js': 'Site.current.preferences.custom.showBanner'
        });

        const results = await findAllActivePreferencesUsage(tmpDir, {
            comparisonFilePath: '/nonexistent/comparison.txt'
        });

        expect(results).toHaveLength(2);

        const searchResult = results.find(r => r.preferenceId === 'enableSearch');
        expect(searchResult.cartridges).toContain('app_custom');

        const bannerResult = results.find(r => r.preferenceId === 'showBanner');
        expect(bannerResult.cartridges).toContain('app_custom');
    });

    it('accepts array of repository paths', async () => {
        const repo1 = path.join(tmpDir, 'repo1');
        const repo2 = path.join(tmpDir, 'repo2');

        createCartridgeFiles(repo1, 'cart_a', { 'a.js': '"prefA"' });
        createCartridgeFiles(repo2, 'cart_b', { 'b.js': '"prefA"' });

        const matrixCsv = 'preferenceId,defaultValue,site1\nprefA,,X';
        const matrixPath = path.join(tmpDir, 'matrix.csv');
        fs.writeFileSync(matrixPath, matrixCsv, 'utf-8');

        findAllMatrixFiles.mockReturnValue([{ matrixFile: matrixPath }]);
        ensureResultsDir.mockReturnValue(tmpDir);

        const results = await findAllActivePreferencesUsage([repo1, repo2], {
            comparisonFilePath: '/nonexistent/comparison.txt'
        });

        const prefAResult = results.find(r => r.preferenceId === 'prefA');
        expect(prefAResult.cartridges).toContain('cart_a');
        expect(prefAResult.cartridges).toContain('cart_b');
    });

    it('tags deprecated cartridge references appropriately', async () => {
        const matrixCsv = 'preferenceId,defaultValue,site1\nprefA,,X';
        const matrixPath = path.join(tmpDir, 'matrix.csv');
        fs.writeFileSync(matrixPath, matrixCsv, 'utf-8');

        const comparisonFile = createComparisonFile(tmpDir, ['int_old_lib']);

        createCartridgeFiles(tmpDir, 'int_old_lib', { 'old.js': '"prefA"' });
        createCartridgeFiles(tmpDir, 'app_new', { 'new.js': '"prefA"' });

        findAllMatrixFiles.mockReturnValue([{ matrixFile: matrixPath }]);
        ensureResultsDir.mockReturnValue(tmpDir);

        const results = await findAllActivePreferencesUsage(tmpDir, {
            comparisonFilePath: comparisonFile
        });

        const prefAResult = results.find(r => r.preferenceId === 'prefA');
        expect(prefAResult.activeCartridges).toContain('app_new');
        expect(prefAResult.deprecatedCartridges).toContain('int_old_lib');
        // The combined cartridges list should have the deprecated tag
        expect(prefAResult.cartridges).toContainEqual(
            expect.stringContaining('[possibly deprecated]')
        );
    });

    it('calls progress callback when provided', async () => {
        const matrixCsv = 'preferenceId,defaultValue,site1\nprefA,,X';
        const matrixPath = path.join(tmpDir, 'matrix.csv');
        fs.writeFileSync(matrixPath, matrixCsv, 'utf-8');

        createCartridgeFiles(tmpDir, 'app_custom', { 'a.js': '"prefA"' });

        findAllMatrixFiles.mockReturnValue([{ matrixFile: matrixPath }]);
        ensureResultsDir.mockReturnValue(tmpDir);

        const progressCallback = vi.fn();

        await findAllActivePreferencesUsage(tmpDir, {
            comparisonFilePath: '/nonexistent/comparison.txt',
            progressCallback
        });

        // Progress callback should be called at start (0) and during scanning
        expect(progressCallback).toHaveBeenCalled();
        // First call should be (0, totalFiles)
        expect(progressCallback.mock.calls[0][0]).toBe(0);
    });

    it('identifies unused preferences (no cartridge references)', async () => {
        const matrixCsv = 'preferenceId,defaultValue,site1\nusedPref,,X\nunusedPref,,X';
        const matrixPath = path.join(tmpDir, 'matrix.csv');
        fs.writeFileSync(matrixPath, matrixCsv, 'utf-8');

        createCartridgeFiles(tmpDir, 'app_custom', {
            'helper.js': 'Site.current.preferences.custom["usedPref"]'
        });

        findAllMatrixFiles.mockReturnValue([{ matrixFile: matrixPath }]);
        ensureResultsDir.mockReturnValue(tmpDir);

        const results = await findAllActivePreferencesUsage(tmpDir, {
            comparisonFilePath: '/nonexistent/comparison.txt'
        });

        const usedResult = results.find(r => r.preferenceId === 'usedPref');
        const unusedResult = results.find(r => r.preferenceId === 'unusedPref');

        expect(usedResult.totalMatches).toBeGreaterThan(0);
        expect(unusedResult.totalMatches).toBe(0);
        expect(unusedResult.cartridges).toEqual([]);
    });
});
