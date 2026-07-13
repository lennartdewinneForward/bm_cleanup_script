import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
    isMetaFileEmpty,
    stripCustomPrefix,
    getRealmMetaDir,
    getCoreMetaDir,
    scanSitesForRemainingPreferences,
    buildMetaCleanupPlan,
    executeMetaCleanupPlan,
    formatCleanupPlan,
    formatExecutionResults,
    formatSitesScanResults
} from '../../../src/commands/meta/helpers/metaFileCleanup.js';
import {
    findLatestMetadataFile
} from '../../../src/io/codeScanner.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('../../../src/config/helpers/helpers.js', () => ({
    getSandboxConfig: vi.fn((realm) => ({
        hostname: `${realm.toLowerCase()}.example.com`,
        instanceType: 'development',
        siteTemplatesPath: `sites/site_template_${realm.toLowerCase()}`
    })),
    getCoreSiteTemplatePath: vi.fn(() => 'sites/site_template')
}));

vi.mock('../../../src/scripts/loggingScript/log.js', () => ({
    logError: vi.fn()
}));

vi.mock('../../../src/io/codeScanner.js', () => ({
    findLatestMetadataFile: vi.fn(() => null)
}));

// ============================================================================
// Helpers
// ============================================================================

let tmpDir;

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pref-meta-cleanup-'));
}

function buildMetaXml({ definitions = [], groupAssignments = [], groupId = 'TestGroup' } = {}) {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<metadata xmlns="http://www.demandware.com/xml/impex/metadata/2006-10-31">\n'
        + '    <type-extension type-id="SitePreferences">\n';

    if (definitions.length > 0) {
        xml += '        <custom-attribute-definitions>\n';
        for (const id of definitions) {
            xml += `            <attribute-definition attribute-id="${id}">\n`
                + `                <display-name xml:lang="x-default">${id}</display-name>\n`
                + '                <type>string</type>\n'
                + '            </attribute-definition>\n';
        }
        xml += '        </custom-attribute-definitions>\n';
    }

    if (groupAssignments.length > 0) {
        xml += '        <group-definitions>\n'
            + `            <attribute-group group-id="${groupId}">\n`
            + `                <display-name xml:lang="x-default">${groupId}</display-name>\n`;
        for (const id of groupAssignments) {
            xml += `                <attribute attribute-id="${id}"/>\n`;
        }
        xml += '            </attribute-group>\n'
            + '        </group-definitions>\n';
    }

    xml += '    </type-extension>\n</metadata>\n';
    return xml;
}

function buildBmBackupXml(attributeIds, typeId = 'SitePreferences') {
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<metadata xmlns="http://www.demandware.com/xml/impex/metadata/2006-10-31">\n'
        + `    <type-extension type-id="${typeId}">\n`
        + '        <custom-attribute-definitions>\n';
    for (const id of attributeIds) {
        xml += `            <attribute-definition attribute-id="${id}">\n`
            + '                <type>string</type>\n'
            + '            </attribute-definition>\n';
    }
    xml += '        </custom-attribute-definitions>\n'
        + '    </type-extension>\n</metadata>\n';
    return xml;
}

function writeMetaFile(dir, filename, content) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, 'utf-8');
}

function writeTempBmBackup(attributeIds, typeId = 'SitePreferences') {
    const bmDir = path.join(tmpDir, '_bm_backups');
    fs.mkdirSync(bmDir, { recursive: true });
    const bmPath = path.join(bmDir, 'backup.xml');
    fs.writeFileSync(bmPath, buildBmBackupXml(attributeIds, typeId), 'utf-8');
    return bmPath;
}

beforeEach(() => {
    tmpDir = makeTmpDir();
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

// ============================================================================
// Tests — Pure utility functions
// ============================================================================

describe('stripCustomPrefix', () => {
    it('strips c_ prefix', () => {
        expect(stripCustomPrefix('c_enableApplePay')).toBe('enableApplePay');
    });

    it('returns id unchanged if no c_ prefix', () => {
        expect(stripCustomPrefix('enableApplePay')).toBe('enableApplePay');
    });

    it('handles empty string', () => {
        expect(stripCustomPrefix('')).toBe('');
    });
});

describe('isMetaFileEmpty', () => {
    it('returns true for XML with no definitions or assignments', () => {
        const xml = '<?xml version="1.0"?>\n<metadata>\n</metadata>';
        expect(isMetaFileEmpty(xml)).toBe(true);
    });

    it('returns false when attribute-definition exists', () => {
        const xml = buildMetaXml({ definitions: ['testAttr'] });
        expect(isMetaFileEmpty(xml)).toBe(false);
    });

    it('returns false when group assignment exists', () => {
        const xml = buildMetaXml({ groupAssignments: ['testAttr'] });
        expect(isMetaFileEmpty(xml)).toBe(false);
    });

    it('returns true for empty string', () => {
        expect(isMetaFileEmpty('')).toBe(true);
    });
});

describe('getRealmMetaDir', () => {
    it('returns path joining repo, site template, and meta', () => {
        const result = getRealmMetaDir('/repo', 'sites/site_template_eu05');
        expect(result).toBe(path.join('/repo', 'sites/site_template_eu05', 'meta'));
    });
});

describe('getCoreMetaDir', () => {
    it('returns path using coreSiteTemplatePath from config', () => {
        const result = getCoreMetaDir('/repo');
        expect(result).toBe(path.join('/repo', 'sites/site_template', 'meta'));
    });
});

// ============================================================================
// Tests — scanSitesForRemainingPreferences
// ============================================================================

describe('scanSitesForRemainingPreferences', () => {
    it('returns empty results when no preference IDs given', () => {
        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: []
        });
        expect(result.scannedFiles).toBe(0);
        expect(result.checkedPreferences).toBe(0);
        expect(result.matchesByPreference.size).toBe(0);
    });

    it('finds preferences in XML files under sites/', () => {
        const sitesDir = path.join(tmpDir, 'sites', 'site_template_eu05');
        fs.mkdirSync(sitesDir, { recursive: true });
        const xml = '<preferences><attribute attribute-id="enableApplePay"/></preferences>';
        fs.writeFileSync(path.join(sitesDir, 'prefs.xml'), xml, 'utf-8');

        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: ['c_enableApplePay']
        });

        expect(result.scannedFiles).toBe(1);
        expect(result.checkedPreferences).toBe(1);
        expect(result.matchesByPreference.has('enableApplePay')).toBe(true);
        expect(result.matchesByPreference.get('enableApplePay')).toHaveLength(1);
    });

    it('returns no matches when preference not found', () => {
        const sitesDir = path.join(tmpDir, 'sites');
        fs.mkdirSync(sitesDir, { recursive: true });
        const xml = '<preferences><attribute attribute-id="somethingElse"/></preferences>';
        fs.writeFileSync(path.join(sitesDir, 'prefs.xml'), xml, 'utf-8');

        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: ['c_enableApplePay']
        });

        expect(result.matchesByPreference.size).toBe(0);
    });

    it('deduplicates preference IDs', () => {
        const sitesDir = path.join(tmpDir, 'sites');
        fs.mkdirSync(sitesDir, { recursive: true });

        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: ['c_myPref', 'myPref', 'c_myPref']
        });

        expect(result.checkedPreferences).toBe(1);
    });

    it('handles missing sites/ directory', () => {
        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: ['c_test']
        });
        expect(result.scannedFiles).toBe(0);
    });
});

// ============================================================================
// Tests — buildMetaCleanupPlan
// ============================================================================

describe('buildMetaCleanupPlan', () => {
    it('returns skipped IDs when attribute not found in any meta file', () => {
        // No meta dirs exist, so nothing will be found
        const realmPrefMap = new Map([['EU05', ['c_missingAttr']]]);
        const plan = buildMetaCleanupPlan(tmpDir, realmPrefMap, ['EU05']);

        expect(plan.skipped).toContain('missingAttr');
        expect(plan.warnings.length).toBeGreaterThan(0);
    });

    it('creates remove action for realm-specific meta file', () => {
        // Create realm meta directory with an attribute
        const realmMetaDir = path.join(tmpDir, 'sites', 'site_template_eu05', 'meta');
        writeMetaFile(realmMetaDir, 'meta.xml', buildMetaXml({
            definitions: ['testPref'],
            groupAssignments: ['testPref']
        }));

        // Also create core meta dir (empty of this attribute)
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const realmPrefMap = new Map([['EU05', ['c_testPref']]]);
        const plan = buildMetaCleanupPlan(tmpDir, realmPrefMap, ['EU05']);

        const removeActions = plan.actions.filter(a => a.type === 'remove');
        expect(removeActions.length).toBeGreaterThanOrEqual(1);
        expect(removeActions[0].realm).toBe('EU05');
        expect(removeActions[0].attributeId).toBe('testPref');
    });

    it('removes from core when deleted from all realms', () => {
        // Only core meta has the attribute
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        writeMetaFile(coreMetaDir, 'meta.xml', buildMetaXml({
            definitions: ['sharedPref'],
            groupAssignments: ['sharedPref']
        }));

        const realmPrefMap = new Map([
            ['EU05', ['c_sharedPref']],
            ['APAC', ['c_sharedPref']]
        ]);
        const plan = buildMetaCleanupPlan(tmpDir, realmPrefMap, ['EU05', 'APAC']);

        const coreRemoves = plan.actions.filter(a => a.realm === 'CORE' && a.type === 'remove');
        expect(coreRemoves.length).toBeGreaterThanOrEqual(1);
    });

    it('creates realm file and removes from core when partially deleted', () => {
        // Core meta has the attribute, only EU05 wants to delete it
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        writeMetaFile(coreMetaDir, 'meta.xml', buildMetaXml({
            definitions: ['partialPref'],
            groupAssignments: ['partialPref']
        }));

        const realmPrefMap = new Map([['EU05', ['c_partialPref']]]);
        const plan = buildMetaCleanupPlan(tmpDir, realmPrefMap, ['EU05', 'APAC']);

        const createActions = plan.actions.filter(a => a.type === 'create-realm-file');
        expect(createActions.length).toBeGreaterThanOrEqual(1);
        expect(createActions[0].realm).toBe('APAC');

        const coreRemoves = plan.actions.filter(a => a.realm === 'CORE');
        expect(coreRemoves.length).toBeGreaterThanOrEqual(1);
    });

    it('skips create-realm-file when BM backup confirms attribute not on realm', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        writeMetaFile(coreMetaDir, 'meta.xml', buildMetaXml({
            definitions: ['realmOnlyPref'],
            groupAssignments: ['realmOnlyPref']
        }));

        // BM backup for APAC does NOT contain the attribute
        const bmPath = writeTempBmBackup(['someOtherPref', 'anotherPref']);
        findLatestMetadataFile.mockImplementation(() => bmPath);

        const realmPrefMap = new Map([['EU05', ['c_realmOnlyPref']]]);
        const plan = buildMetaCleanupPlan(tmpDir, realmPrefMap, ['EU05', 'APAC']);

        expect(findLatestMetadataFile).toHaveBeenCalledWith('APAC');

        const createActions = plan.actions.filter(a => a.type === 'create-realm-file');
        expect(createActions).toHaveLength(0);

        expect(plan.warnings).toEqual(
            expect.arrayContaining([
                expect.stringContaining('realmOnlyPref: skipped create for APAC')
            ])
        );

        // Core removal should still happen
        const coreRemoves = plan.actions.filter(a => a.realm === 'CORE');
        expect(coreRemoves.length).toBeGreaterThanOrEqual(1);
    });

    it('creates realm file when BM backup confirms attribute exists on realm', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        writeMetaFile(coreMetaDir, 'meta.xml', buildMetaXml({
            definitions: ['sharedPref'],
            groupAssignments: ['sharedPref']
        }));

        // BM backup for APAC contains the attribute
        const bmPath = writeTempBmBackup(['sharedPref', 'otherPref']);
        findLatestMetadataFile.mockReturnValue(bmPath);

        const realmPrefMap = new Map([['EU05', ['c_sharedPref']]]);
        const plan = buildMetaCleanupPlan(tmpDir, realmPrefMap, ['EU05', 'APAC']);

        const createActions = plan.actions.filter(a => a.type === 'create-realm-file');
        expect(createActions).toHaveLength(1);
        expect(createActions[0].realm).toBe('APAC');
    });

    it('assumes attribute needed when no BM backup available', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        writeMetaFile(coreMetaDir, 'meta.xml', buildMetaXml({
            definitions: ['noBackupPref'],
            groupAssignments: ['noBackupPref']
        }));

        // No backup available
        findLatestMetadataFile.mockReturnValue(null);

        const realmPrefMap = new Map([['EU05', ['c_noBackupPref']]]);
        const plan = buildMetaCleanupPlan(tmpDir, realmPrefMap, ['EU05', 'APAC']);

        // Should create realm file (assume needed when backup unavailable)
        const createActions = plan.actions.filter(a => a.type === 'create-realm-file');
        expect(createActions).toHaveLength(1);
        expect(createActions[0].realm).toBe('APAC');
    });
});

// ============================================================================
// Tests — executeMetaCleanupPlan
// ============================================================================

describe('executeMetaCleanupPlan', () => {
    it('returns empty results for plan with no actions', () => {
        const plan = {
            actions: [],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };
        const results = executeMetaCleanupPlan(plan);
        expect(results.filesModified).toEqual([]);
        expect(results.filesDeleted).toEqual([]);
        expect(results.filesCreated).toEqual([]);
        expect(results.errors).toEqual([]);
    });

    it('removes attribute from file in non-dry-run mode', () => {
        const metaDir = path.join(tmpDir, 'meta');
        const filePath = path.join(metaDir, 'meta.xml');
        writeMetaFile(metaDir, 'meta.xml', buildMetaXml({
            definitions: ['deleteMe', 'keepMe'],
            groupAssignments: ['deleteMe', 'keepMe']
        }));

        const plan = {
            actions: [{
                type: 'remove',
                attributeId: 'deleteMe',
                filePath,
                realm: 'EU05',
                reason: 'test'
            }],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };

        const results = executeMetaCleanupPlan(plan);
        expect(results.filesModified).toContain(filePath);

        const updatedContent = fs.readFileSync(filePath, 'utf-8');
        expect(updatedContent).not.toContain('deleteMe');
        expect(updatedContent).toContain('keepMe');
    });

    it('deletes file when all attributes removed', () => {
        const metaDir = path.join(tmpDir, 'meta');
        const filePath = path.join(metaDir, 'meta.xml');
        writeMetaFile(metaDir, 'meta.xml', buildMetaXml({
            definitions: ['onlyAttr'],
            groupAssignments: ['onlyAttr']
        }));

        const plan = {
            actions: [{
                type: 'remove',
                attributeId: 'onlyAttr',
                filePath,
                realm: 'EU05',
                reason: 'test'
            }],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };

        const results = executeMetaCleanupPlan(plan);
        expect(results.filesDeleted).toContain(filePath);
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it('does not modify files in dry-run mode', () => {
        const metaDir = path.join(tmpDir, 'meta');
        const filePath = path.join(metaDir, 'meta.xml');
        const originalContent = buildMetaXml({
            definitions: ['deleteMe'],
            groupAssignments: ['deleteMe']
        });
        writeMetaFile(metaDir, 'meta.xml', originalContent);

        const plan = {
            actions: [{
                type: 'remove',
                attributeId: 'deleteMe',
                filePath,
                realm: 'EU05',
                reason: 'test'
            }],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };

        const results = executeMetaCleanupPlan(plan, { dryRun: true });
        expect(results.filesModified).toEqual([]);
        expect(results.filesDeleted).toEqual([]);
        expect(fs.readFileSync(filePath, 'utf-8')).toBe(originalContent);
    });

    it('skips nonexistent files gracefully', () => {
        const plan = {
            actions: [{
                type: 'remove',
                attributeId: 'test',
                filePath: path.join(tmpDir, 'nonexistent.xml'),
                realm: 'EU05',
                reason: 'test'
            }],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };

        const results = executeMetaCleanupPlan(plan);
        expect(results.filesModified).toEqual([]);
        expect(results.errors).toEqual([]);
    });

    it('handles create-realm-file actions', () => {
        // Create a source core file
        const coreDir = path.join(tmpDir, 'core');
        const coreFilePath = path.join(coreDir, 'meta.xml');
        writeMetaFile(coreDir, 'meta.xml', buildMetaXml({
            definitions: ['myAttr'],
            groupAssignments: ['myAttr']
        }));

        const targetDir = path.join(tmpDir, 'realm_meta');
        const targetFilePath = path.join(targetDir, 'meta.xml');

        const plan = {
            actions: [{
                type: 'create-realm-file',
                attributeId: 'myAttr',
                filePath: coreFilePath,
                targetFilePath,
                realm: 'APAC',
                reason: 'test'
            }],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };

        const results = executeMetaCleanupPlan(plan);
        expect(results.filesCreated).toContain(targetFilePath);
        expect(fs.existsSync(targetFilePath)).toBe(true);

        const content = fs.readFileSync(targetFilePath, 'utf-8');
        expect(content).toContain('myAttr');
    });

    it('handles multiple remove actions on the same file', () => {
        const metaDir = path.join(tmpDir, 'meta');
        const filePath = path.join(metaDir, 'meta.xml');
        writeMetaFile(metaDir, 'meta.xml', buildMetaXml({
            definitions: ['attr1', 'attr2', 'attr3'],
            groupAssignments: ['attr1', 'attr2', 'attr3']
        }));

        const plan = {
            actions: [
                { type: 'remove', attributeId: 'attr1', filePath, realm: 'EU05', reason: 'test' },
                { type: 'remove', attributeId: 'attr2', filePath, realm: 'EU05', reason: 'test' }
            ],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };

        const results = executeMetaCleanupPlan(plan);
        expect(results.filesModified).toContain(filePath);

        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).not.toContain('attr1');
        expect(content).not.toContain('attr2');
        expect(content).toContain('attr3');
    });
});

// ============================================================================
// Tests — formatCleanupPlan
// ============================================================================

describe('formatCleanupPlan', () => {
    it('formats a plan with remove actions', () => {
        const plan = {
            actions: [
                { type: 'remove', attributeId: 'testAttr', filePath: '/repo/meta/test.xml', realm: 'EU05', reason: 'test' }
            ],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: '/repo'
        };

        const output = formatCleanupPlan(plan);
        expect(output).toContain('META FILE CLEANUP PLAN');
        expect(output).toContain('/repo');
        expect(output).toContain('Actions: 1');
        expect(output).toContain('REMOVE');
        expect(output).toContain('testAttr');
        expect(output).toContain('EU05');
    });

    it('formats a plan with create and remove actions', () => {
        const plan = {
            actions: [
                { type: 'create-realm-file', attributeId: 'pref1', filePath: '/core/meta.xml', targetFilePath: '/realm/meta.xml', realm: 'APAC', reason: 'copy' },
                { type: 'remove', attributeId: 'pref1', filePath: '/core/meta.xml', realm: 'CORE', reason: 'remove from core' }
            ],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: '/repo'
        };

        const output = formatCleanupPlan(plan);
        expect(output).toContain('CREATE realm files (1)');
        expect(output).toContain('REMOVE attributes (1)');
        expect(output).toContain('APAC');
    });

    it('formats skipped attributes', () => {
        const plan = {
            actions: [],
            warnings: [],
            skipped: ['missingAttr1', 'missingAttr2'],
            realmPreferenceMap: new Map(),
            repoPath: '/repo'
        };

        const output = formatCleanupPlan(plan);
        expect(output).toContain('SKIPPED');
        expect(output).toContain('missingAttr1');
        expect(output).toContain('missingAttr2');
    });

    it('formats warnings', () => {
        const plan = {
            actions: [],
            warnings: ['Something suspicious happened'],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: '/repo'
        };

        const output = formatCleanupPlan(plan);
        expect(output).toContain('WARNINGS');
        expect(output).toContain('Something suspicious happened');
    });

    it('formats empty plan', () => {
        const plan = {
            actions: [],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: '/repo'
        };

        const output = formatCleanupPlan(plan);
        expect(output).toContain('Actions: 0');
        expect(output).toContain('Warnings: 0');
        expect(output).toContain('Skipped (not found): 0');
    });
});

// ============================================================================
// Tests — formatExecutionResults
// ============================================================================

describe('formatExecutionResults', () => {
    it('formats results with modified files', () => {
        const output = formatExecutionResults({
            filesModified: ['/repo/meta/test.xml'],
            filesDeleted: [],
            filesCreated: [],
            errors: []
        });
        expect(output).toContain('META FILE CLEANUP RESULTS');
        expect(output).toContain('Files modified: 1');
        expect(output).toContain('test.xml');
    });

    it('formats results with deleted files', () => {
        const output = formatExecutionResults({
            filesModified: [],
            filesDeleted: ['/repo/meta/removed.xml'],
            filesCreated: [],
            errors: []
        });
        expect(output).toContain('Files deleted:  1');
        expect(output).toContain('removed.xml');
    });

    it('formats results with created files', () => {
        const output = formatExecutionResults({
            filesModified: [],
            filesDeleted: [],
            filesCreated: ['/repo/realm/meta.xml'],
            errors: []
        });
        expect(output).toContain('Files created:  1');
        expect(output).toContain('meta.xml');
    });

    it('formats errors', () => {
        const output = formatExecutionResults({
            filesModified: [],
            filesDeleted: [],
            filesCreated: [],
            errors: [{
                action: { attributeId: 'broken' },
                error: new Error('Permission denied')
            }]
        });
        expect(output).toContain('Errors:         1');
        expect(output).toContain('broken');
        expect(output).toContain('Permission denied');
    });

    it('formats empty results', () => {
        const output = formatExecutionResults({
            filesModified: [],
            filesDeleted: [],
            filesCreated: [],
            errors: []
        });
        expect(output).toContain('Files modified: 0');
        expect(output).toContain('Files deleted:  0');
        expect(output).toContain('Errors:         0');
    });
});

// ============================================================================
// Tests — formatSitesScanResults
// ============================================================================

describe('formatSitesScanResults', () => {
    it('formats clean results with no remaining preferences', () => {
        const output = formatSitesScanResults({
            sitesDir: '/repo/sites',
            scannedFiles: 10,
            checkedPreferences: 5,
            matchesByPreference: new Map()
        });
        expect(output).toContain('CROSS-REALM RESIDUAL SCAN');
        expect(output).toContain('XML files scanned: 10');
        expect(output).toContain('Preferences checked: 5');
        expect(output).toContain('Preferences still found: 0');
        expect(output).toContain('PASS');
    });

    it('formats results with remaining preferences', () => {
        const matches = new Map([
            ['testPref', ['sites/eu05/prefs.xml', 'sites/apac/prefs.xml']]
        ]);
        const output = formatSitesScanResults({
            sitesDir: '/repo/sites',
            scannedFiles: 20,
            checkedPreferences: 3,
            matchesByPreference: matches
        });
        expect(output).toContain('Preferences still found: 1');
        expect(output).toContain('FAIL');
        expect(output).toContain('testPref');
        expect(output).toContain('2 file(s)');
    });

    it('truncates long file lists to 5', () => {
        const files = Array.from({ length: 8 }, (_, i) => `sites/file${i}.xml`);
        const matches = new Map([['bigPref', files]]);
        const output = formatSitesScanResults({
            sitesDir: '/repo/sites',
            scannedFiles: 50,
            checkedPreferences: 1,
            matchesByPreference: matches
        });
        expect(output).toContain('and 3 more');
    });
});
