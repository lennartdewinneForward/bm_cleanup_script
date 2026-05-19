import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock config helpers — buildMetaCleanupPlan depends on getSandboxConfig
// and getCoreSiteTemplatePath to locate meta directories
vi.mock('../../../src/config/helpers/helpers.js', () => ({
    getSandboxConfig: vi.fn(),
    getCoreSiteTemplatePath: vi.fn(() => 'sites/site_template')
}));

vi.mock('../../../src/scripts/loggingScript/log.js', () => ({
    logError: vi.fn()
}));

vi.mock('../../../src/io/codeScanner.js', () => ({
    findLatestMetadataFile: vi.fn(() => null),
    parseSitePreferencesFromMetadata: vi.fn(() => new Set())
}));

import {
    isMetaFileEmpty,
    stripCustomPrefix,
    buildMetaCleanupPlan,
    executeMetaCleanupPlan,
    formatCleanupPlan,
    formatExecutionResults,
    formatSitesScanResults,
    formatPreferenceValueResults,
    scanSitesForRemainingPreferences,
    removePreferenceValuesFromSites,
    getRealmMetaDir,
    getCoreMetaDir,
    enrichRegionalGroups
} from '../../../src/commands/meta/helpers/metaFileCleanup.js';
import { getSandboxConfig } from '../../../src/config/helpers/helpers.js';

// ============================================================================
// Helper: create a minimal SitePreferences meta XML file
// ============================================================================

function createMetaXml(attributeIds, { groupId = 'TestGroup' } = {}) {
    const defs = attributeIds.map(id =>
        `            <attribute-definition attribute-id="${id}">\n`
        + `                <display-name xml:lang="x-default">${id}</display-name>\n`
        + `                <type>string</type>\n`
        + '            </attribute-definition>'
    ).join('\n');

    const grpRefs = attributeIds.map(id =>
        `                <attribute attribute-id="${id}"/>`
    ).join('\n');

    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<metadata xmlns="http://www.demandware.com/xml/impex/metadata/2006-10-31">\n'
        + '    <type-extension type-id="SitePreferences">\n'
        + '        <custom-attribute-definitions>\n'
        + defs + '\n'
        + '        </custom-attribute-definitions>\n'
        + '        <group-definitions>\n'
        + `            <attribute-group group-id="${groupId}">\n`
        + `                <display-name xml:lang="x-default">${groupId}</display-name>\n`
        + grpRefs + '\n'
        + '            </attribute-group>\n'
        + '        </group-definitions>\n'
        + '    </type-extension>\n'
        + '</metadata>\n';
}

function createPreferencesXml(preferences) {
    const entries = preferences.map(({ id, value }) => {
        if (value === undefined) {
            return `    <preference preference-id="${id}"/>`;
        }
        return `    <preference preference-id="${id}">${value}</preference>`;
    }).join('\n');

    return '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<preferences>\n'
        + entries + '\n'
        + '</preferences>\n';
}

// ============================================================================
// stripCustomPrefix
// ============================================================================

describe('stripCustomPrefix', () => {
    it('strips c_ prefix', () => {
        expect(stripCustomPrefix('c_enableFeature')).toBe('enableFeature');
    });

    it('returns unchanged string without c_ prefix', () => {
        expect(stripCustomPrefix('enableFeature')).toBe('enableFeature');
    });

    it('handles empty string', () => {
        expect(stripCustomPrefix('')).toBe('');
    });

    it('only strips leading c_ not embedded', () => {
        expect(stripCustomPrefix('my_c_pref')).toBe('my_c_pref');
    });
});

// ============================================================================
// isMetaFileEmpty
// ============================================================================

describe('isMetaFileEmpty', () => {
    it('returns true for XML with no definitions or assignments', () => {
        const xml = '<?xml version="1.0"?>\n<metadata>\n<type-extension type-id="SitePreferences">\n</type-extension>\n</metadata>';
        expect(isMetaFileEmpty(xml)).toBe(true);
    });

    it('returns false when attribute definitions exist', () => {
        const xml = '<attribute-definition attribute-id="test">...</attribute-definition>';
        expect(isMetaFileEmpty(xml)).toBe(false);
    });

    it('returns false when group assignments exist', () => {
        const xml = '<attribute attribute-id="test"/>';
        expect(isMetaFileEmpty(xml)).toBe(false);
    });

    it('returns true for empty string', () => {
        expect(isMetaFileEmpty('')).toBe(true);
    });
});

// ============================================================================
// getRealmMetaDir / getCoreMetaDir
// ============================================================================

describe('getRealmMetaDir', () => {
    it('joins repo path with site template path and meta', () => {
        const result = getRealmMetaDir('/repo', 'sites/site_template_eu');
        expect(result).toBe(path.join('/repo', 'sites/site_template_eu', 'meta'));
    });
});

describe('getCoreMetaDir', () => {
    it('uses getCoreSiteTemplatePath from config', () => {
        const result = getCoreMetaDir('/repo');
        expect(result).toBe(path.join('/repo', 'sites/site_template', 'meta'));
    });
});

// ============================================================================
// scanSitesForRemainingPreferences
// ============================================================================

describe('scanSitesForRemainingPreferences', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-scan-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns empty results for no preference IDs', () => {
        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: []
        });

        expect(result.scannedFiles).toBe(0);
        expect(result.checkedPreferences).toBe(0);
        expect(result.matchesByPreference.size).toBe(0);
    });

    it('finds preferences in XML files under sites/', () => {
        const sitesDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(sitesDir, { recursive: true });

        const xml = createMetaXml(['enableSearch', 'maxResults']);
        fs.writeFileSync(path.join(sitesDir, 'meta.xml'), xml, 'utf-8');

        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: ['c_enableSearch', 'c_nonExistent']
        });

        expect(result.scannedFiles).toBe(1);
        expect(result.checkedPreferences).toBe(2);
        expect(result.matchesByPreference.has('enableSearch')).toBe(true);
        expect(result.matchesByPreference.has('nonExistent')).toBe(false);
    });

    it('strips c_ prefix before scanning', () => {
        const sitesDir = path.join(tmpDir, 'sites');
        fs.mkdirSync(sitesDir, { recursive: true });

        const xml = '<attribute attribute-id="myPref"/>';
        fs.writeFileSync(path.join(sitesDir, 'test.xml'), xml, 'utf-8');

        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: ['c_myPref']
        });

        expect(result.matchesByPreference.has('myPref')).toBe(true);
    });

    it('deduplicates preference IDs', () => {
        const sitesDir = path.join(tmpDir, 'sites');
        fs.mkdirSync(sitesDir, { recursive: true });
        fs.writeFileSync(path.join(sitesDir, 'test.xml'), '<attribute attribute-id="dup"/>', 'utf-8');

        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: ['c_dup', 'dup', 'c_dup']
        });

        expect(result.checkedPreferences).toBe(1);
    });

    it('handles non-existent sites directory', () => {
        const result = scanSitesForRemainingPreferences({
            repoPath: path.join(tmpDir, 'nonexistent'),
            preferenceIds: ['c_test']
        });

        expect(result.scannedFiles).toBe(0);
    });
});

// ============================================================================
// removePreferenceValuesFromSites
// ============================================================================

describe('removePreferenceValuesFromSites', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-pref-val-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
    });

    it('returns empty results for no preference IDs', () => {
        const result = removePreferenceValuesFromSites({
            repoPath: tmpDir,
            preferenceIds: []
        });

        expect(result.totalRemoved).toBe(0);
        expect(result.filesModified).toEqual([]);
    });

    it('removes preference values from preferences.xml files', () => {
        const siteDir = path.join(tmpDir, 'sites', 'site1');
        fs.mkdirSync(siteDir, { recursive: true });

        const prefXml = createPreferencesXml([
            { id: 'keepPref', value: 'keepValue' },
            { id: 'removePref', value: 'removeValue' },
            { id: 'anotherKeep', value: 'stays' }
        ]);
        fs.writeFileSync(path.join(siteDir, 'preferences.xml'), prefXml, 'utf-8');

        const result = removePreferenceValuesFromSites({
            repoPath: tmpDir,
            preferenceIds: ['c_removePref']
        });

        expect(result.totalRemoved).toBe(1);
        expect(result.filesModified).toHaveLength(1);

        // Verify the file was actually modified
        const content = fs.readFileSync(path.join(siteDir, 'preferences.xml'), 'utf-8');
        expect(content).not.toContain('removePref');
        expect(content).toContain('keepPref');
        expect(content).toContain('anotherKeep');
    });

    it('removes self-closing preference tags', () => {
        const siteDir = path.join(tmpDir, 'sites', 'site1');
        fs.mkdirSync(siteDir, { recursive: true });

        const prefXml = createPreferencesXml([
            { id: 'selfClose' },
            { id: 'keep', value: 'val' }
        ]);
        fs.writeFileSync(path.join(siteDir, 'preferences.xml'), prefXml, 'utf-8');

        const result = removePreferenceValuesFromSites({
            repoPath: tmpDir,
            preferenceIds: ['selfClose']
        });

        expect(result.totalRemoved).toBe(1);
    });

    it('does not modify files in dry-run mode', () => {
        const siteDir = path.join(tmpDir, 'sites', 'site1');
        fs.mkdirSync(siteDir, { recursive: true });

        const prefXml = createPreferencesXml([
            { id: 'removePref', value: 'removeValue' }
        ]);
        fs.writeFileSync(path.join(siteDir, 'preferences.xml'), prefXml, 'utf-8');

        const result = removePreferenceValuesFromSites({
            repoPath: tmpDir,
            preferenceIds: ['removePref'],
            dryRun: true
        });

        expect(result.totalRemoved).toBe(1);

        // File should be untouched
        const content = fs.readFileSync(path.join(siteDir, 'preferences.xml'), 'utf-8');
        expect(content).toContain('removePref');
    });

    it('scans across multiple site directories', () => {
        for (const site of ['site1', 'site2']) {
            const siteDir = path.join(tmpDir, 'sites', site);
            fs.mkdirSync(siteDir, { recursive: true });

            const prefXml = createPreferencesXml([
                { id: 'sharedPref', value: `value_${site}` }
            ]);
            fs.writeFileSync(path.join(siteDir, 'preferences.xml'), prefXml, 'utf-8');
        }

        const result = removePreferenceValuesFromSites({
            repoPath: tmpDir,
            preferenceIds: ['sharedPref']
        });

        expect(result.totalRemoved).toBe(2);
        expect(result.filesModified).toHaveLength(2);
    });
});

// ============================================================================
// buildMetaCleanupPlan
// ============================================================================

describe('buildMetaCleanupPlan', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-plan-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});

        getSandboxConfig.mockImplementation((realm) => ({
            siteTemplatesPath: `sites/site_template_${realm.toLowerCase()}`
        }));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
        vi.restoreAllMocks();
    });

    it('creates remove actions for realm-specific meta files', () => {
        // Set up realm meta directory with a file containing the attribute
        const realmMetaDir = path.join(tmpDir, 'sites', 'site_template_eu05', 'meta');
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(realmMetaDir, { recursive: true });
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const realmXml = createMetaXml(['enableFeature']);
        fs.writeFileSync(path.join(realmMetaDir, 'meta.xml'), realmXml, 'utf-8');

        const realmPreferenceMap = new Map([
            ['EU05', ['c_enableFeature']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05']);

        const removeActions = plan.actions.filter(a => a.type === 'remove');
        expect(removeActions.length).toBeGreaterThanOrEqual(1);
        expect(removeActions[0].attributeId).toBe('enableFeature');
        expect(removeActions[0].realm).toBe('EU05');
    });

    it('removes from core when deleted from all realms', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const coreXml = createMetaXml(['sharedPref']);
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        // Both realms have empty meta dirs
        for (const realm of ['eu05', 'apac']) {
            const realmMetaDir = path.join(tmpDir, 'sites', `site_template_${realm}`, 'meta');
            fs.mkdirSync(realmMetaDir, { recursive: true });
        }

        const realmPreferenceMap = new Map([
            ['EU05', ['c_sharedPref']],
            ['APAC', ['c_sharedPref']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05', 'APAC']);

        const coreRemoves = plan.actions.filter(a => a.realm === 'CORE' && a.type === 'remove');
        expect(coreRemoves.length).toBe(1);
        expect(coreRemoves[0].attributeId).toBe('sharedPref');
    });

    it('creates move-to-realm actions when only some realms delete', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const coreXml = createMetaXml(['partialPref']);
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        // Create empty realm meta dirs
        for (const realm of ['eu05', 'apac']) {
            const realmMetaDir = path.join(tmpDir, 'sites', `site_template_${realm}`, 'meta');
            fs.mkdirSync(realmMetaDir, { recursive: true });
        }

        // Only EU05 deletes it — APAC still needs it
        const realmPreferenceMap = new Map([
            ['EU05', ['c_partialPref']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05', 'APAC']);

        const createActions = plan.actions.filter(a => a.type === 'create-realm-file');
        expect(createActions.length).toBe(1);
        expect(createActions[0].realm).toBe('APAC');
        expect(createActions[0].attributeId).toBe('partialPref');

        // Should also remove from core
        const coreRemoves = plan.actions.filter(a => a.realm === 'CORE' && a.type === 'remove');
        expect(coreRemoves.length).toBe(1);
    });

    it('skips cross-realm move logic when crossRealm option is true', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const coreXml = createMetaXml(['crossRealmPref']);
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        for (const realm of ['eu05', 'apac']) {
            const realmMetaDir = path.join(tmpDir, 'sites', `site_template_${realm}`, 'meta');
            fs.mkdirSync(realmMetaDir, { recursive: true });
        }

        // Only EU05 listed but crossRealm=true means treat as "all"
        const realmPreferenceMap = new Map([
            ['EU05', ['c_crossRealmPref']]
        ]);

        const plan = buildMetaCleanupPlan(
            tmpDir, realmPreferenceMap, ['EU05', 'APAC'], { crossRealm: true }
        );

        // No create-realm-file actions — just straight removal
        const createActions = plan.actions.filter(a => a.type === 'create-realm-file');
        expect(createActions).toEqual([]);

        const coreRemoves = plan.actions.filter(a => a.realm === 'CORE' && a.type === 'remove');
        expect(coreRemoves.length).toBe(1);
    });

    it('reports attributes not found in any meta file', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const realmMetaDir = path.join(tmpDir, 'sites', 'site_template_eu05', 'meta');
        fs.mkdirSync(realmMetaDir, { recursive: true });

        const realmPreferenceMap = new Map([
            ['EU05', ['c_ghostPref']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05']);

        expect(plan.skipped).toContain('ghostPref');
        expect(plan.warnings.length).toBeGreaterThan(0);
    });
});

// ============================================================================
// executeMetaCleanupPlan
// ============================================================================

describe('executeMetaCleanupPlan', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-exec-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
    });

    it('removes attribute definitions and group assignments from files', () => {
        const metaDir = path.join(tmpDir, 'meta');
        fs.mkdirSync(metaDir, { recursive: true });

        const xml = createMetaXml(['keepMe', 'removeMe']);
        const filePath = path.join(metaDir, 'meta.xml');
        fs.writeFileSync(filePath, xml, 'utf-8');

        const plan = {
            actions: [
                {
                    type: 'remove',
                    attributeId: 'removeMe',
                    filePath,
                    realm: 'EU05',
                    reason: 'test removal'
                }
            ],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan);

        expect(result.filesModified).toHaveLength(1);
        expect(result.errors).toEqual([]);

        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).not.toContain('removeMe');
        expect(content).toContain('keepMe');
    });

    it('deletes empty files after removing all attributes', () => {
        const metaDir = path.join(tmpDir, 'meta');
        fs.mkdirSync(metaDir, { recursive: true });

        const xml = createMetaXml(['onlyAttr']);
        const filePath = path.join(metaDir, 'meta.xml');
        fs.writeFileSync(filePath, xml, 'utf-8');

        const plan = {
            actions: [
                {
                    type: 'remove',
                    attributeId: 'onlyAttr',
                    filePath,
                    realm: 'EU05',
                    reason: 'remove last attr'
                }
            ],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan);

        expect(result.filesDeleted).toHaveLength(1);
        expect(fs.existsSync(filePath)).toBe(false);
    });

    it('does not modify files in dry-run mode', () => {
        const metaDir = path.join(tmpDir, 'meta');
        fs.mkdirSync(metaDir, { recursive: true });

        const xml = createMetaXml(['dryRunAttr']);
        const filePath = path.join(metaDir, 'meta.xml');
        fs.writeFileSync(filePath, xml, 'utf-8');

        const plan = {
            actions: [
                {
                    type: 'remove',
                    attributeId: 'dryRunAttr',
                    filePath,
                    realm: 'EU05',
                    reason: 'dry run test'
                }
            ],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan, { dryRun: true });

        expect(result.filesModified).toEqual([]);
        expect(result.filesDeleted).toEqual([]);

        // File should be untouched
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('dryRunAttr');
    });

    it('handles create-realm-file actions', () => {
        const coreDir = path.join(tmpDir, 'core', 'meta');
        const realmDir = path.join(tmpDir, 'realm', 'meta');
        fs.mkdirSync(coreDir, { recursive: true });
        fs.mkdirSync(realmDir, { recursive: true });

        const coreXml = createMetaXml(['movePref']);
        const coreFilePath = path.join(coreDir, 'meta.xml');
        fs.writeFileSync(coreFilePath, coreXml, 'utf-8');

        const targetFilePath = path.join(realmDir, 'meta.xml');

        const plan = {
            actions: [
                {
                    type: 'create-realm-file',
                    attributeId: 'movePref',
                    filePath: coreFilePath,
                    targetFilePath,
                    realm: 'APAC',
                    reason: 'move to remaining realm'
                }
            ],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan);

        expect(result.filesCreated).toHaveLength(1);
        expect(fs.existsSync(targetFilePath)).toBe(true);

        const content = fs.readFileSync(targetFilePath, 'utf-8');
        expect(content).toContain('movePref');
    });

    it('creates realm file with only the moved attribute — no extra group refs', () => {
        const coreDir = path.join(tmpDir, 'core', 'meta');
        const realmDir = path.join(tmpDir, 'realm', 'meta');
        fs.mkdirSync(coreDir, { recursive: true });
        fs.mkdirSync(realmDir, { recursive: true });

        // Core file has MULTIPLE attributes in the same group
        const coreXml = createMetaXml(['keepAttr', 'deleteAttrA', 'deleteAttrB']);
        const coreFilePath = path.join(coreDir, 'meta.xml');
        fs.writeFileSync(coreFilePath, coreXml, 'utf-8');

        const targetFilePath = path.join(realmDir, 'meta.xml');

        const plan = {
            actions: [{
                type: 'create-realm-file',
                attributeId: 'keepAttr',
                filePath: coreFilePath,
                targetFilePath,
                realm: 'APAC',
                reason: 'move to remaining realm'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan);

        expect(result.filesCreated).toHaveLength(1);
        const content = fs.readFileSync(targetFilePath, 'utf-8');

        // Should contain ONLY the moved attribute's definition
        expect(content).toContain('attribute-id="keepAttr"');

        // Should NOT contain the other attributes' definitions or group refs
        expect(content).not.toContain('deleteAttrA');
        expect(content).not.toContain('deleteAttrB');

        // Group should still reference the kept attribute
        const groupAssignmentMatches = content.match(/<attribute\s+attribute-id="keepAttr"\s*\/>/g);
        expect(groupAssignmentMatches).toHaveLength(1);

        // Valid XML structure
        expect(content).toContain('<custom-attribute-definitions>');
        expect(content).toContain('<group-definitions>');
        expect(content).toContain('group-id="TestGroup"');
    });

    it('processes multiple removes on the same file efficiently', () => {
        const metaDir = path.join(tmpDir, 'meta');
        fs.mkdirSync(metaDir, { recursive: true });

        const xml = createMetaXml(['attrA', 'attrB', 'attrC']);
        const filePath = path.join(metaDir, 'meta.xml');
        fs.writeFileSync(filePath, xml, 'utf-8');

        const plan = {
            actions: [
                { type: 'remove', attributeId: 'attrA', filePath, realm: 'EU05', reason: 'remove A' },
                { type: 'remove', attributeId: 'attrC', filePath, realm: 'EU05', reason: 'remove C' }
            ],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan);

        expect(result.filesModified).toHaveLength(1);

        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).not.toContain('attrA');
        expect(content).toContain('attrB');
        expect(content).not.toContain('attrC');
    });
});

// ============================================================================
// formatCleanupPlan
// ============================================================================

describe('formatCleanupPlan', () => {
    it('formats a plan with actions', () => {
        const plan = {
            actions: [
                {
                    type: 'remove',
                    attributeId: 'testAttr',
                    filePath: '/repo/meta/test.xml',
                    realm: 'EU05',
                    reason: 'Deleted from all'
                }
            ],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: '/repo'
        };

        const output = formatCleanupPlan(plan);

        expect(output).toContain('META FILE CLEANUP PLAN');
        expect(output).toContain('Actions: 1');
        expect(output).toContain('testAttr');
        expect(output).toContain('EU05');
    });

    it('includes skipped and warning sections', () => {
        const plan = {
            actions: [],
            warnings: ['someAttr: not found anywhere'],
            skipped: ['someAttr'],
            realmPreferenceMap: new Map(),
            repoPath: '/repo'
        };

        const output = formatCleanupPlan(plan);

        expect(output).toContain('SKIPPED');
        expect(output).toContain('someAttr');
        expect(output).toContain('WARNINGS');
    });

    it('formats create actions', () => {
        const plan = {
            actions: [{
                type: 'create-realm-file',
                attributeId: 'movePref',
                filePath: '/repo/core/meta.xml',
                targetFilePath: '/repo/realm/meta.xml',
                realm: 'APAC',
                reason: 'Copy to APAC'
            }],
            warnings: [],
            skipped: [],
            realmPreferenceMap: new Map(),
            repoPath: '/repo'
        };

        const output = formatCleanupPlan(plan);

        expect(output).toContain('CREATE realm files');
        expect(output).toContain('APAC');
        expect(output).toContain('movePref');
    });
});

// ============================================================================
// formatExecutionResults
// ============================================================================

describe('formatExecutionResults', () => {
    it('formats results with all sections', () => {
        const results = {
            filesModified: ['/repo/meta/a.xml'],
            filesDeleted: ['/repo/meta/b.xml'],
            filesCreated: ['/repo/realm/c.xml'],
            errors: []
        };

        const output = formatExecutionResults(results);

        expect(output).toContain('META FILE CLEANUP RESULTS');
        expect(output).toContain('Files modified: 1');
        expect(output).toContain('Files deleted:  1');
        expect(output).toContain('Files created:  1');
        expect(output).toContain('Errors:         0');
    });

    it('formats errors when present', () => {
        const results = {
            filesModified: [],
            filesDeleted: [],
            filesCreated: [],
            errors: [{
                action: { attributeId: 'failedAttr' },
                error: new Error('FS write failed')
            }]
        };

        const output = formatExecutionResults(results);

        expect(output).toContain('failedAttr');
        expect(output).toContain('FS write failed');
    });
});

// ============================================================================
// formatSitesScanResults
// ============================================================================

describe('formatSitesScanResults', () => {
    it('shows PASS when no preferences found', () => {
        const results = {
            sitesDir: '/repo/sites',
            scannedFiles: 10,
            checkedPreferences: 5,
            matchesByPreference: new Map()
        };

        const output = formatSitesScanResults(results);

        expect(output).toContain('PASS');
        expect(output).toContain('Preferences still found: 0');
    });

    it('shows FAIL with details when preferences remain', () => {
        const matches = new Map([
            ['enableSearch', ['sites/site1/meta.xml', 'sites/site2/meta.xml']]
        ]);

        const results = {
            sitesDir: '/repo/sites',
            scannedFiles: 10,
            checkedPreferences: 5,
            matchesByPreference: matches
        };

        const output = formatSitesScanResults(results);

        expect(output).toContain('FAIL');
        expect(output).toContain('enableSearch');
        expect(output).toContain('2 file(s)');
    });
});

// ============================================================================
// formatPreferenceValueResults
// ============================================================================

describe('formatPreferenceValueResults', () => {
    it('shows success message when no values removed', () => {
        const results = { filesModified: [], totalRemoved: 0, details: [] };
        const output = formatPreferenceValueResults(results);

        expect(output).toContain('No orphaned preference values found');
    });

    it('shows details when values were removed', () => {
        const results = {
            filesModified: ['sites/site1/preferences.xml'],
            totalRemoved: 2,
            details: [{
                file: 'sites/site1/preferences.xml',
                removed: ['enableSearch', 'maxResults']
            }]
        };

        const output = formatPreferenceValueResults(results);

        expect(output).toContain('Files modified: 1');
        expect(output).toContain('Total preference values removed: 2');
        expect(output).toContain('enableSearch');
        expect(output).toContain('maxResults');
    });
});

// ============================================================================
// XML OUTPUT CORRECTNESS — attribute definition removal
// Verifies that removeAttributeFromXml (exercised through executeMetaCleanupPlan)
// produces valid XML with ONLY the target attributes removed.
// ============================================================================

describe('XML output correctness — attribute definition removal', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-xml-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
    });

    it('removes only the targeted attribute, preserving others intact', () => {
        const metaDir = path.join(tmpDir, 'meta');
        fs.mkdirSync(metaDir, { recursive: true });

        const xml = createMetaXml(['keepFirst', 'removeTarget', 'keepLast']);
        const filePath = path.join(metaDir, 'meta.xml');
        fs.writeFileSync(filePath, xml, 'utf-8');

        const plan = {
            actions: [{
                type: 'remove', attributeId: 'removeTarget',
                filePath, realm: 'EU05', reason: 'test'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        executeMetaCleanupPlan(plan);

        const result = fs.readFileSync(filePath, 'utf-8');
        expect(result).toContain('attribute-id="keepFirst"');
        expect(result).toContain('attribute-id="keepLast"');
        expect(result).not.toContain('removeTarget');
        // Verify both definition and group assignment were removed
        expect(result).not.toContain('<attribute-definition attribute-id="removeTarget"');
        expect(result).not.toContain('<attribute attribute-id="removeTarget"');
    });

    it('removes attribute with complex nested XML elements', () => {
        const metaDir = path.join(tmpDir, 'meta');
        fs.mkdirSync(metaDir, { recursive: true });

        const complexXml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://www.demandware.com/xml/impex/metadata/2006-10-31">
    <type-extension type-id="SitePreferences">
        <custom-attribute-definitions>
            <attribute-definition attribute-id="simpleAttr">
                <display-name xml:lang="x-default">Simple</display-name>
                <type>string</type>
            </attribute-definition>
            <attribute-definition attribute-id="complexAttr">
                <display-name xml:lang="x-default">Complex</display-name>
                <display-name xml:lang="de-DE">Komplex</display-name>
                <description xml:lang="x-default">A complex attribute with many properties</description>
                <type>enum-of-string</type>
                <mandatory-flag>false</mandatory-flag>
                <externally-managed-flag>false</externally-managed-flag>
                <value-definitions>
                    <value-definition>
                        <display xml:lang="x-default">Option A</display>
                        <value>optionA</value>
                    </value-definition>
                    <value-definition>
                        <display xml:lang="x-default">Option B</display>
                        <value>optionB</value>
                    </value-definition>
                </value-definitions>
            </attribute-definition>
        </custom-attribute-definitions>
        <group-definitions>
            <attribute-group group-id="TestGroup">
                <display-name xml:lang="x-default">TestGroup</display-name>
                <attribute attribute-id="simpleAttr"/>
                <attribute attribute-id="complexAttr"/>
            </attribute-group>
        </group-definitions>
    </type-extension>
</metadata>
`;
        const filePath = path.join(metaDir, 'meta.xml');
        fs.writeFileSync(filePath, complexXml, 'utf-8');

        const plan = {
            actions: [{
                type: 'remove', attributeId: 'complexAttr',
                filePath, realm: 'EU05', reason: 'remove complex'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        executeMetaCleanupPlan(plan);

        const result = fs.readFileSync(filePath, 'utf-8');
        // Complex attribute fully removed
        expect(result).not.toContain('complexAttr');
        expect(result).not.toContain('enum-of-string');
        expect(result).not.toContain('value-definitions');
        expect(result).not.toContain('Option A');
        // Simple attribute preserved
        expect(result).toContain('attribute-id="simpleAttr"');
        expect(result).toContain('<type>string</type>');
        // Structure still valid
        expect(result).toContain('</custom-attribute-definitions>');
        expect(result).toContain('</group-definitions>');
        expect(result).toContain('</metadata>');
    });

    it('preserves XML declaration and namespace after removal', () => {
        const metaDir = path.join(tmpDir, 'meta');
        fs.mkdirSync(metaDir, { recursive: true });

        const xml = createMetaXml(['onlyAttr', 'keepAttr']);
        const filePath = path.join(metaDir, 'meta.xml');
        fs.writeFileSync(filePath, xml, 'utf-8');

        const plan = {
            actions: [{
                type: 'remove', attributeId: 'onlyAttr',
                filePath, realm: 'EU05', reason: 'test'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        executeMetaCleanupPlan(plan);

        const result = fs.readFileSync(filePath, 'utf-8');
        expect(result).toContain('<?xml version="1.0" encoding="UTF-8"?>');
        expect(result).toContain('demandware.com/xml/impex/metadata');
        expect(result).toContain('type-id="SitePreferences"');
    });

    it('handles attribute IDs with regex special characters', () => {
        const metaDir = path.join(tmpDir, 'meta');
        fs.mkdirSync(metaDir, { recursive: true });

        // Build XML manually with a tricky attribute ID
        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://www.demandware.com/xml/impex/metadata/2006-10-31">
    <type-extension type-id="SitePreferences">
        <custom-attribute-definitions>
            <attribute-definition attribute-id="test.attr+name">
                <display-name xml:lang="x-default">Test</display-name>
                <type>string</type>
            </attribute-definition>
            <attribute-definition attribute-id="normalAttr">
                <display-name xml:lang="x-default">Normal</display-name>
                <type>string</type>
            </attribute-definition>
        </custom-attribute-definitions>
        <group-definitions>
            <attribute-group group-id="G1">
                <display-name xml:lang="x-default">G1</display-name>
                <attribute attribute-id="test.attr+name"/>
                <attribute attribute-id="normalAttr"/>
            </attribute-group>
        </group-definitions>
    </type-extension>
</metadata>
`;
        const filePath = path.join(metaDir, 'meta.xml');
        fs.writeFileSync(filePath, xml, 'utf-8');

        const plan = {
            actions: [{
                type: 'remove', attributeId: 'test.attr+name',
                filePath, realm: 'EU05', reason: 'special chars'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        executeMetaCleanupPlan(plan);

        const result = fs.readFileSync(filePath, 'utf-8');
        expect(result).not.toContain('test.attr+name');
        expect(result).toContain('normalAttr');
    });
});

// ============================================================================
// XML OUTPUT CORRECTNESS — preference value removal
// Verifies that removePreferenceValue correctly handles all XML formats
// ============================================================================

describe('XML output correctness — preference value removal', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-prefval-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
    });

    it('removes multi-line preference values with nested elements', () => {
        const siteDir = path.join(tmpDir, 'sites', 'site1');
        fs.mkdirSync(siteDir, { recursive: true });

        const prefXml = `<?xml version="1.0" encoding="UTF-8"?>
<preferences>
    <preference preference-id="keepMe">simpleValue</preference>
    <preference preference-id="removeMultiLine">
        <value>line1</value>
        <value>line2</value>
    </preference>
    <preference preference-id="alsoKeep">another</preference>
</preferences>
`;
        fs.writeFileSync(path.join(siteDir, 'preferences.xml'), prefXml, 'utf-8');

        const result = removePreferenceValuesFromSites({
            repoPath: tmpDir,
            preferenceIds: ['removeMultiLine']
        });

        expect(result.totalRemoved).toBe(1);
        const content = fs.readFileSync(path.join(siteDir, 'preferences.xml'), 'utf-8');
        expect(content).not.toContain('removeMultiLine');
        expect(content).toContain('keepMe');
        expect(content).toContain('alsoKeep');
    });

    it('removes multiple preferences from the same file', () => {
        const siteDir = path.join(tmpDir, 'sites', 'site1');
        fs.mkdirSync(siteDir, { recursive: true });

        const prefXml = createPreferencesXml([
            { id: 'removeA', value: 'valA' },
            { id: 'keepB', value: 'valB' },
            { id: 'removeC', value: 'valC' },
            { id: 'keepD', value: 'valD' }
        ]);
        fs.writeFileSync(path.join(siteDir, 'preferences.xml'), prefXml, 'utf-8');

        const result = removePreferenceValuesFromSites({
            repoPath: tmpDir,
            preferenceIds: ['removeA', 'c_removeC']
        });

        expect(result.totalRemoved).toBe(2);
        const content = fs.readFileSync(path.join(siteDir, 'preferences.xml'), 'utf-8');
        expect(content).not.toContain('removeA');
        expect(content).not.toContain('removeC');
        expect(content).toContain('keepB');
        expect(content).toContain('keepD');
    });

    it('handles non-existent sites directory gracefully', () => {
        const result = removePreferenceValuesFromSites({
            repoPath: path.join(tmpDir, 'nonexistent'),
            preferenceIds: ['c_anything']
        });

        expect(result.totalRemoved).toBe(0);
        expect(result.filesModified).toEqual([]);
    });

    it('scans nested subdirectories under sites/', () => {
        // Create deeply nested site structure
        const deepDir = path.join(tmpDir, 'sites', 'region', 'site_a');
        fs.mkdirSync(deepDir, { recursive: true });

        const prefXml = createPreferencesXml([
            { id: 'deepPref', value: 'nestedVal' }
        ]);
        fs.writeFileSync(path.join(deepDir, 'preferences.xml'), prefXml, 'utf-8');

        const result = removePreferenceValuesFromSites({
            repoPath: tmpDir,
            preferenceIds: ['deepPref']
        });

        expect(result.totalRemoved).toBe(1);
    });
});

// ============================================================================
// executeMetaCleanupPlan — error handling and edge cases
// ============================================================================

describe('executeMetaCleanupPlan — error handling', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-exec-err-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
    });

    it('skips remove action when file does not exist', () => {
        const plan = {
            actions: [{
                type: 'remove', attributeId: 'ghost',
                filePath: path.join(tmpDir, 'nonexistent.xml'),
                realm: 'EU05', reason: 'test missing file'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan);

        expect(result.filesModified).toEqual([]);
        expect(result.filesDeleted).toEqual([]);
        expect(result.errors).toEqual([]);
    });

    it('skips file when attribute is not found in content (no matching IDs)', () => {
        const metaDir = path.join(tmpDir, 'meta');
        fs.mkdirSync(metaDir, { recursive: true });

        const xml = createMetaXml(['existingAttr']);
        const filePath = path.join(metaDir, 'meta.xml');
        fs.writeFileSync(filePath, xml, 'utf-8');

        const plan = {
            actions: [{
                type: 'remove', attributeId: 'nonExistentAttr',
                filePath, realm: 'EU05', reason: 'not in file'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan);

        // File should not be modified since nothing was removed
        expect(result.filesModified).toEqual([]);
        expect(result.filesDeleted).toEqual([]);
        // File content should be unchanged
        const content = fs.readFileSync(filePath, 'utf-8');
        expect(content).toContain('existingAttr');
    });

    it('does not create files in dry-run mode for create-realm-file actions', () => {
        const coreDir = path.join(tmpDir, 'core', 'meta');
        const realmDir = path.join(tmpDir, 'realm', 'meta');
        fs.mkdirSync(coreDir, { recursive: true });
        fs.mkdirSync(realmDir, { recursive: true });

        const coreXml = createMetaXml(['dryRunPref']);
        const coreFilePath = path.join(coreDir, 'meta.xml');
        fs.writeFileSync(coreFilePath, coreXml, 'utf-8');

        const targetFilePath = path.join(realmDir, 'meta.xml');

        const plan = {
            actions: [{
                type: 'create-realm-file', attributeId: 'dryRunPref',
                filePath: coreFilePath, targetFilePath,
                realm: 'APAC', reason: 'dry run test'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan, { dryRun: true });

        expect(result.filesCreated).toEqual([]);
        expect(fs.existsSync(targetFilePath)).toBe(false);
    });

    it('does not delete empty files in dry-run mode', () => {
        const metaDir = path.join(tmpDir, 'meta');
        fs.mkdirSync(metaDir, { recursive: true });

        const xml = createMetaXml(['soleAttr']);
        const filePath = path.join(metaDir, 'meta.xml');
        fs.writeFileSync(filePath, xml, 'utf-8');

        const plan = {
            actions: [{
                type: 'remove', attributeId: 'soleAttr',
                filePath, realm: 'EU05', reason: 'should not delete in dry-run'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan, { dryRun: true });

        expect(result.filesDeleted).toEqual([]);
        expect(result.filesModified).toEqual([]);
        // File still exists with original content
        expect(fs.existsSync(filePath)).toBe(true);
        expect(fs.readFileSync(filePath, 'utf-8')).toContain('soleAttr');
    });

    it('handles mixed create + remove plan in correct order', () => {
        const coreDir = path.join(tmpDir, 'core', 'meta');
        const realmDir = path.join(tmpDir, 'realm', 'meta');
        fs.mkdirSync(coreDir, { recursive: true });
        fs.mkdirSync(realmDir, { recursive: true });

        const coreXml = createMetaXml(['movedAttr', 'otherAttr']);
        const coreFilePath = path.join(coreDir, 'meta.xml');
        fs.writeFileSync(coreFilePath, coreXml, 'utf-8');

        const targetFilePath = path.join(realmDir, 'meta.xml');

        const plan = {
            actions: [
                {
                    type: 'create-realm-file', attributeId: 'movedAttr',
                    filePath: coreFilePath, targetFilePath,
                    realm: 'APAC', reason: 'copy before removing from core'
                },
                {
                    type: 'remove', attributeId: 'movedAttr',
                    filePath: coreFilePath, realm: 'CORE',
                    reason: 'remove from core after copy'
                }
            ],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan);

        // Realm file was created with the attribute
        expect(result.filesCreated).toHaveLength(1);
        const realmContent = fs.readFileSync(targetFilePath, 'utf-8');
        expect(realmContent).toContain('movedAttr');

        // Core file was modified (movedAttr removed, otherAttr remains)
        expect(result.filesModified).toHaveLength(1);
        const coreContent = fs.readFileSync(coreFilePath, 'utf-8');
        expect(coreContent).not.toContain('movedAttr');
        expect(coreContent).toContain('otherAttr');
    });
});

// ============================================================================
// executeMetaCleanupPlan — create-realm-file append to existing file
// Tests the appendAttributeToExistingFile path (uncovered until now)
// ============================================================================

describe('executeMetaCleanupPlan — append to existing realm file', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-append-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
    });

    it('appends attribute definition and group assignment into existing realm file', () => {
        const coreDir = path.join(tmpDir, 'core', 'meta');
        const realmDir = path.join(tmpDir, 'realm', 'meta');
        fs.mkdirSync(coreDir, { recursive: true });
        fs.mkdirSync(realmDir, { recursive: true });

        // Core file has the attribute to copy
        const coreXml = createMetaXml(['newAttr', 'otherCoreAttr']);
        fs.writeFileSync(path.join(coreDir, 'meta.xml'), coreXml, 'utf-8');

        // Target realm file already exists with a different attribute
        const existingRealmXml = createMetaXml(['existingRealmAttr']);
        const targetFilePath = path.join(realmDir, 'meta.xml');
        fs.writeFileSync(targetFilePath, existingRealmXml, 'utf-8');

        const plan = {
            actions: [{
                type: 'create-realm-file', attributeId: 'newAttr',
                filePath: path.join(coreDir, 'meta.xml'),
                targetFilePath,
                realm: 'APAC', reason: 'append to existing'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan);

        expect(result.filesCreated).toHaveLength(1);
        const content = fs.readFileSync(targetFilePath, 'utf-8');
        // Both old and new attributes should be present
        expect(content).toContain('attribute-id="existingRealmAttr"');
        expect(content).toContain('attribute-id="newAttr"');
        // The other core attribute should NOT be copied
        expect(content).not.toContain('otherCoreAttr');
        // XML structure should be valid
        expect(content).toContain('</custom-attribute-definitions>');
        expect(content).toContain('</attribute-group>');
    });

    it('appends multiple attributes from separate create actions', () => {
        const coreDir = path.join(tmpDir, 'core', 'meta');
        const realmDir = path.join(tmpDir, 'realm', 'meta');
        fs.mkdirSync(coreDir, { recursive: true });
        fs.mkdirSync(realmDir, { recursive: true });

        const coreXml = createMetaXml(['attrX', 'attrY', 'attrZ']);
        const coreFilePath = path.join(coreDir, 'meta.xml');
        fs.writeFileSync(coreFilePath, coreXml, 'utf-8');

        // Existing realm file
        const existingRealmXml = createMetaXml(['realmOriginal']);
        const targetFilePath = path.join(realmDir, 'meta.xml');
        fs.writeFileSync(targetFilePath, existingRealmXml, 'utf-8');

        const plan = {
            actions: [
                {
                    type: 'create-realm-file', attributeId: 'attrX',
                    filePath: coreFilePath, targetFilePath,
                    realm: 'APAC', reason: 'copy X'
                },
                {
                    type: 'create-realm-file', attributeId: 'attrY',
                    filePath: coreFilePath, targetFilePath,
                    realm: 'APAC', reason: 'copy Y'
                }
            ],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        const result = executeMetaCleanupPlan(plan);

        const content = fs.readFileSync(targetFilePath, 'utf-8');
        expect(content).toContain('attribute-id="realmOriginal"');
        expect(content).toContain('attribute-id="attrX"');
        expect(content).toContain('attribute-id="attrY"');
        expect(content).not.toContain('attrZ');
    });
});

// ============================================================================
// executeMetaCleanupPlan — create-realm-file with fallback group
// Tests the path where extractContainingGroup returns null
// ============================================================================

describe('executeMetaCleanupPlan — create-realm-file fallback paths', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-fallback-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
    });

    it('creates file with "Migrated" group when no containing group block found', () => {
        const coreDir = path.join(tmpDir, 'core', 'meta');
        const realmDir = path.join(tmpDir, 'realm', 'meta');
        fs.mkdirSync(coreDir, { recursive: true });
        fs.mkdirSync(realmDir, { recursive: true });

        // Create a core file where attribution is in group but the group
        // structure doesn't match the extractContainingGroup pattern
        // (no group assignment at all — only definition exists)
        const coreXml = `<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://www.demandware.com/xml/impex/metadata/2006-10-31">
    <type-extension type-id="SitePreferences">
        <custom-attribute-definitions>
            <attribute-definition attribute-id="orphanAttr">
                <display-name xml:lang="x-default">Orphan</display-name>
                <type>string</type>
            </attribute-definition>
        </custom-attribute-definitions>
    </type-extension>
</metadata>
`;
        const coreFilePath = path.join(coreDir, 'meta.xml');
        fs.writeFileSync(coreFilePath, coreXml, 'utf-8');

        const targetFilePath = path.join(realmDir, 'meta.xml');

        const plan = {
            actions: [{
                type: 'create-realm-file', attributeId: 'orphanAttr',
                filePath: coreFilePath, targetFilePath,
                realm: 'APAC', reason: 'no group block'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        executeMetaCleanupPlan(plan);

        const content = fs.readFileSync(targetFilePath, 'utf-8');
        // Should have the definition
        expect(content).toContain('attribute-id="orphanAttr"');
        // Should NOT have a Migrated group since there's no group assignment to extract
        expect(content).toContain('</type-extension>');
        expect(content).toContain('</metadata>');
    });

    it('creates meta directory if it does not exist', () => {
        const coreDir = path.join(tmpDir, 'core', 'meta');
        fs.mkdirSync(coreDir, { recursive: true });

        const coreXml = createMetaXml(['newRealmAttr']);
        const coreFilePath = path.join(coreDir, 'meta.xml');
        fs.writeFileSync(coreFilePath, coreXml, 'utf-8');

        // Target directory does NOT exist yet
        const targetFilePath = path.join(tmpDir, 'new-realm', 'meta', 'meta.xml');

        const plan = {
            actions: [{
                type: 'create-realm-file', attributeId: 'newRealmAttr',
                filePath: coreFilePath, targetFilePath,
                realm: 'APAC', reason: 'create dir'
            }],
            warnings: [], skipped: [],
            realmPreferenceMap: new Map(), repoPath: tmpDir
        };

        executeMetaCleanupPlan(plan);

        expect(fs.existsSync(targetFilePath)).toBe(true);
        const content = fs.readFileSync(targetFilePath, 'utf-8');
        expect(content).toContain('newRealmAttr');
    });
});

// ============================================================================
// buildMetaCleanupPlan — additional branch coverage
// ============================================================================

describe('buildMetaCleanupPlan — additional scenarios', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-plan2-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});

        getSandboxConfig.mockImplementation((realm) => ({
            siteTemplatesPath: `sites/site_template_${realm.toLowerCase()}`
        }));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
        vi.restoreAllMocks();
    });

    it('skips create-realm-file when remaining realm already has the attribute', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const realmMetaDirEU = path.join(tmpDir, 'sites', 'site_template_eu05', 'meta');
        const realmMetaDirAPAC = path.join(tmpDir, 'sites', 'site_template_apac', 'meta');
        fs.mkdirSync(realmMetaDirEU, { recursive: true });
        fs.mkdirSync(realmMetaDirAPAC, { recursive: true });

        // Core has the attribute
        const coreXml = createMetaXml(['partialPref']);
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        // APAC already has it in its own realm folder
        const apacXml = createMetaXml(['partialPref']);
        fs.writeFileSync(path.join(realmMetaDirAPAC, 'meta.xml'), apacXml, 'utf-8');

        // Only EU05 deletes — APAC still needs it, but already has it
        const realmPreferenceMap = new Map([
            ['EU05', ['c_partialPref']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05', 'APAC']);

        // No create-realm-file needed since APAC already has the attribute
        const createActions = plan.actions.filter(a => a.type === 'create-realm-file');
        expect(createActions).toEqual([]);

        // But should still remove from core
        const coreRemoves = plan.actions.filter(a => a.realm === 'CORE');
        expect(coreRemoves.length).toBe(1);
    });

    it('handles multiple attributes across multiple realms', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        for (const realm of ['eu05', 'apac', 'pna']) {
            const realmMetaDir = path.join(tmpDir, 'sites', `site_template_${realm}`, 'meta');
            fs.mkdirSync(realmMetaDir, { recursive: true });
        }

        // Core has multiple attributes
        const coreXml = createMetaXml(['sharedA', 'sharedB', 'sharedC']);
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        // EU05 realm has its own attributes
        const euXml = createMetaXml(['realmOnlyA']);
        fs.writeFileSync(
            path.join(tmpDir, 'sites', 'site_template_eu05', 'meta', 'meta.xml'),
            euXml, 'utf-8'
        );

        const realmPreferenceMap = new Map([
            ['EU05', ['c_sharedA', 'c_sharedB', 'c_realmOnlyA']],
            ['APAC', ['c_sharedA', 'c_sharedB']],
            ['PNA', ['c_sharedA', 'c_sharedB']]
        ]);

        const plan = buildMetaCleanupPlan(
            tmpDir, realmPreferenceMap, ['EU05', 'APAC', 'PNA']
        );

        // sharedA and sharedB deleted from ALL realms → remove from core
        const coreSARemove = plan.actions.filter(
            a => a.attributeId === 'sharedA' && a.realm === 'CORE'
        );
        const coreSBRemove = plan.actions.filter(
            a => a.attributeId === 'sharedB' && a.realm === 'CORE'
        );
        expect(coreSARemove.length).toBe(1);
        expect(coreSBRemove.length).toBe(1);

        // sharedC NOT deleted → should remain in core
        const coresCRemove = plan.actions.filter(a => a.attributeId === 'sharedC');
        expect(coresCRemove).toEqual([]);

        // realmOnlyA only in EU05 realm → remove from EU05
        const euRealmRemove = plan.actions.filter(
            a => a.attributeId === 'realmOnlyA' && a.realm === 'EU05'
        );
        expect(euRealmRemove.length).toBe(1);
    });

    it('handles attribute in both realm and core files (removes from both)', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        const realmMetaDir = path.join(tmpDir, 'sites', 'site_template_eu05', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });
        fs.mkdirSync(realmMetaDir, { recursive: true });

        // Same attribute in both core and realm
        const xml = createMetaXml(['duplicated']);
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), xml, 'utf-8');
        fs.writeFileSync(path.join(realmMetaDir, 'meta.xml'), xml, 'utf-8');

        const realmPreferenceMap = new Map([
            ['EU05', ['c_duplicated']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05']);

        // Should remove from both realm AND core
        const realmRemove = plan.actions.filter(a => a.realm === 'EU05');
        const coreRemove = plan.actions.filter(a => a.realm === 'CORE');
        expect(realmRemove.length).toBe(1);
        expect(coreRemove.length).toBe(1);
    });

    it('handles non-xml files in meta directory (ignores them)', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        const realmMetaDir = path.join(tmpDir, 'sites', 'site_template_eu05', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });
        fs.mkdirSync(realmMetaDir, { recursive: true });

        // Write a non-XML file alongside the meta XML
        fs.writeFileSync(
            path.join(coreMetaDir, 'readme.txt'),
            'This is not XML', 'utf-8'
        );
        // Write XML without SitePreferences type-extension
        fs.writeFileSync(
            path.join(coreMetaDir, 'other.xml'),
            '<metadata><type-extension type-id="OtherObject"></type-extension></metadata>',
            'utf-8'
        );

        const realmPreferenceMap = new Map([
            ['EU05', ['c_testAttr']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05']);

        // Should skip testAttr since no SitePreferences meta file contains it
        expect(plan.skipped).toContain('testAttr');
    });
});

// ============================================================================
// buildMetaCleanupPlan — shared directory handling
// ============================================================================

describe('buildMetaCleanupPlan — shared directories', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-shared-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
        vi.restoreAllMocks();
    });

    it('does NOT remove from shared directory when a remaining realm uses it', () => {
        // EU05 and GB share the same siteTemplatesPath
        getSandboxConfig.mockImplementation((realm) => {
            if (realm === 'EU05' || realm === 'GB') {
                return { siteTemplatesPath: 'sites/site_template_eu' };
            }
            return { siteTemplatesPath: `sites/site_template_${realm.toLowerCase()}` };
        });

        const sharedMetaDir = path.join(tmpDir, 'sites', 'site_template_eu', 'meta');
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(sharedMetaDir, { recursive: true });
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const xml = createMetaXml(['euOnlyAttr']);
        fs.writeFileSync(path.join(sharedMetaDir, 'meta.xml'), xml, 'utf-8');

        // GB wants to delete euOnlyAttr, but EU05 does NOT
        const realmPreferenceMap = new Map([
            ['GB', ['c_euOnlyAttr']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05', 'GB']);

        // Should NOT create any remove actions — EU05 still needs the attribute
        // in the shared directory
        const removeActions = plan.actions.filter(a => a.type === 'remove');
        expect(removeActions).toEqual([]);
    });

    it('removes from shared directory when ALL sharing realms want deletion', () => {
        getSandboxConfig.mockImplementation((realm) => {
            if (realm === 'EU05' || realm === 'GB') {
                return { siteTemplatesPath: 'sites/site_template_eu' };
            }
            return { siteTemplatesPath: `sites/site_template_${realm.toLowerCase()}` };
        });

        const sharedMetaDir = path.join(tmpDir, 'sites', 'site_template_eu', 'meta');
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(sharedMetaDir, { recursive: true });
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const xml = createMetaXml(['sharedAttr']);
        fs.writeFileSync(path.join(sharedMetaDir, 'meta.xml'), xml, 'utf-8');

        // Both EU05 and GB want to delete sharedAttr
        const realmPreferenceMap = new Map([
            ['EU05', ['c_sharedAttr']],
            ['GB', ['c_sharedAttr']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05', 'GB']);

        // Should remove — both sharing realms agree
        const removeActions = plan.actions.filter(a => a.type === 'remove');
        expect(removeActions.length).toBe(1);
        expect(removeActions[0].attributeId).toBe('sharedAttr');
    });

    it('deduplicates remove actions for shared directories', () => {
        getSandboxConfig.mockImplementation((realm) => {
            if (realm === 'EU05' || realm === 'GB') {
                return { siteTemplatesPath: 'sites/site_template_eu' };
            }
            return { siteTemplatesPath: `sites/site_template_${realm.toLowerCase()}` };
        });

        const sharedMetaDir = path.join(tmpDir, 'sites', 'site_template_eu', 'meta');
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(sharedMetaDir, { recursive: true });
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const xml = createMetaXml(['dupAttr']);
        fs.writeFileSync(path.join(sharedMetaDir, 'meta.xml'), xml, 'utf-8');

        // Both realms want to delete — should produce only ONE remove action
        const realmPreferenceMap = new Map([
            ['EU05', ['c_dupAttr']],
            ['GB', ['c_dupAttr']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05', 'GB']);

        const removeActions = plan.actions.filter(
            a => a.type === 'remove' && a.attributeId === 'dupAttr'
        );
        // Only one remove action for the physical file, not two
        expect(removeActions.length).toBe(1);
    });

    it('deduplicates create-realm-file for remaining realms sharing a directory', () => {
        // EU05 and GB share the same siteTemplatesPath
        getSandboxConfig.mockImplementation((realm) => {
            if (realm === 'EU05' || realm === 'GB') {
                return { siteTemplatesPath: 'sites/site_template_eu' };
            }
            return { siteTemplatesPath: `sites/site_template_${realm.toLowerCase()}` };
        });

        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        const sharedMetaDir = path.join(tmpDir, 'sites', 'site_template_eu', 'meta');
        const apacMetaDir = path.join(tmpDir, 'sites', 'site_template_apac', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });
        fs.mkdirSync(sharedMetaDir, { recursive: true });
        fs.mkdirSync(apacMetaDir, { recursive: true });

        const coreXml = createMetaXml(['coreAttr']);
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        // APAC deletes coreAttr; EU05 and GB (sharing dir) don't
        const realmPreferenceMap = new Map([
            ['APAC', ['c_coreAttr']]
        ]);

        const plan = buildMetaCleanupPlan(
            tmpDir, realmPreferenceMap, ['EU05', 'GB', 'APAC']
        );

        // Should create only ONE realm file for the shared EU05/GB directory
        const createActions = plan.actions.filter(a => a.type === 'create-realm-file');
        expect(createActions.length).toBe(1);
        expect(createActions[0].targetFilePath).toContain('site_template_eu');

        // Should also remove from core
        const coreRemoves = plan.actions.filter(a => a.realm === 'CORE');
        expect(coreRemoves.length).toBe(1);
    });

    it('mixed scenario: shared dir + separate dir + core attribute', () => {
        // EU05 and GB share; APAC and PNA are separate
        getSandboxConfig.mockImplementation((realm) => {
            if (realm === 'EU05' || realm === 'GB') {
                return { siteTemplatesPath: 'sites/site_template_eu' };
            }
            return { siteTemplatesPath: `sites/site_template_${realm.toLowerCase()}` };
        });

        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        const sharedMetaDir = path.join(tmpDir, 'sites', 'site_template_eu', 'meta');
        const apacMetaDir = path.join(tmpDir, 'sites', 'site_template_apac', 'meta');
        const pnaMetaDir = path.join(tmpDir, 'sites', 'site_template_pna', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });
        fs.mkdirSync(sharedMetaDir, { recursive: true });
        fs.mkdirSync(apacMetaDir, { recursive: true });
        fs.mkdirSync(pnaMetaDir, { recursive: true });

        // Attribute only in EU/GB shared dir
        const euXml = createMetaXml(['euOnlyAttr']);
        fs.writeFileSync(path.join(sharedMetaDir, 'meta.xml'), euXml, 'utf-8');

        // APAC, GB, PNA want to delete euOnlyAttr but EU05 does NOT
        const realmPreferenceMap = new Map([
            ['APAC', ['c_euOnlyAttr']],
            ['GB', ['c_euOnlyAttr']],
            ['PNA', ['c_euOnlyAttr']]
        ]);

        const plan = buildMetaCleanupPlan(
            tmpDir, realmPreferenceMap, ['EU05', 'GB', 'APAC', 'PNA']
        );

        // Shared dir has EU05 (remaining) → do NOT remove
        const removeActions = plan.actions.filter(a => a.type === 'remove');
        expect(removeActions).toEqual([]);

        // Attribute not in core → no create-realm-file needed
        const createActions = plan.actions.filter(a => a.type === 'create-realm-file');
        expect(createActions).toEqual([]);
    });
});

// ============================================================================
// scanSitesForRemainingPreferences — additional coverage
// ============================================================================

describe('scanSitesForRemainingPreferences — additional scenarios', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-scan2-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('matches preference-id pattern in addition to attribute-id', () => {
        const sitesDir = path.join(tmpDir, 'sites', 'site1');
        fs.mkdirSync(sitesDir, { recursive: true });

        // This XML uses preference-id (not attribute-id)
        const prefXml = `<preferences>
    <preference preference-id="matchThisPref">value</preference>
</preferences>`;
        fs.writeFileSync(path.join(sitesDir, 'preferences.xml'), prefXml, 'utf-8');

        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: ['c_matchThisPref']
        });

        expect(result.matchesByPreference.has('matchThisPref')).toBe(true);
    });

    it('handles non-array preferenceIds gracefully', () => {
        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: null
        });

        expect(result.checkedPreferences).toBe(0);
        expect(result.matchesByPreference.size).toBe(0);
    });

    it('returns repo-relative paths in matches', () => {
        const sitesDir = path.join(tmpDir, 'sites', 'region', 'siteA');
        fs.mkdirSync(sitesDir, { recursive: true });

        fs.writeFileSync(
            path.join(sitesDir, 'meta.xml'),
            '<attribute attribute-id="foundHere"/>',
            'utf-8'
        );

        const result = scanSitesForRemainingPreferences({
            repoPath: tmpDir,
            preferenceIds: ['foundHere']
        });

        const files = result.matchesByPreference.get('foundHere');
        expect(files).toHaveLength(1);
        // Path should be relative to repoPath, not absolute
        expect(files[0]).not.toContain(tmpDir);
        expect(files[0]).toContain('sites');
    });
});

// ============================================================================
// formatSitesScanResults — overflow (>5 files) coverage
// ============================================================================

describe('formatSitesScanResults — overflow display', () => {
    it('truncates file list and shows count when more than 5 files match', () => {
        const matches = new Map([
            ['overflowPref', [
                'sites/site1/meta.xml',
                'sites/site2/meta.xml',
                'sites/site3/meta.xml',
                'sites/site4/meta.xml',
                'sites/site5/meta.xml',
                'sites/site6/meta.xml',
                'sites/site7/meta.xml'
            ]]
        ]);

        const results = {
            sitesDir: '/repo/sites',
            scannedFiles: 20,
            checkedPreferences: 1,
            matchesByPreference: matches
        };

        const output = formatSitesScanResults(results);

        expect(output).toContain('overflowPref');
        expect(output).toContain('7 file(s)');
        expect(output).toContain('... and 2 more');
        // Should show first 5 files
        expect(output).toContain('site1');
        expect(output).toContain('site5');
    });
});

// ============================================================================
// End-to-end: buildMetaCleanupPlan + executeMetaCleanupPlan
// Simulates the full cleanup workflow to verify output files are correct
// ============================================================================

describe('End-to-end meta cleanup workflow', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-e2e-'));
        vi.spyOn(console, 'log').mockImplementation(() => {});

        getSandboxConfig.mockImplementation((realm) => ({
            siteTemplatesPath: `sites/site_template_${realm.toLowerCase()}`
        }));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        console.log.mockRestore();
        vi.restoreAllMocks();
    });

    it('full workflow: plan → execute → verify files for single-realm deletion', () => {
        // Setup: core has 3 attributes, realm has 1 attribute
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        const realmMetaDir = path.join(tmpDir, 'sites', 'site_template_eu05', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });
        fs.mkdirSync(realmMetaDir, { recursive: true });

        const coreXml = createMetaXml(['coreKeep', 'coreDel', 'coreAlsoDel']);
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        const realmXml = createMetaXml(['realmDel']);
        fs.writeFileSync(path.join(realmMetaDir, 'meta.xml'), realmXml, 'utf-8');

        // Plan: delete coreDel, coreAlsoDel, and realmDel from EU05 (only realm)
        const realmPreferenceMap = new Map([
            ['EU05', ['c_coreDel', 'c_coreAlsoDel', 'c_realmDel']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05']);

        // Execute
        const result = executeMetaCleanupPlan(plan);
        expect(result.errors).toEqual([]);

        // Verify core file: coreKeep remains, coreDel and coreAlsoDel removed
        const coreContent = fs.readFileSync(
            path.join(coreMetaDir, 'meta.xml'), 'utf-8'
        );
        expect(coreContent).toContain('coreKeep');
        expect(coreContent).not.toContain('coreDel');
        expect(coreContent).not.toContain('coreAlsoDel');

        // Verify realm file: deleted (only attribute was removed)
        expect(fs.existsSync(path.join(realmMetaDir, 'meta.xml'))).toBe(false);
    });

    it('full workflow: partial realm deletion moves attribute to remaining realms', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        for (const realm of ['eu05', 'apac']) {
            const realmMetaDir = path.join(tmpDir, 'sites', `site_template_${realm}`, 'meta');
            fs.mkdirSync(realmMetaDir, { recursive: true });
        }

        // Core has attribute that EU05 wants to delete but APAC still needs
        const coreXml = createMetaXml(['splitPref', 'bothDelete']);
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        // EU05 deletes splitPref; both delete bothDelete
        const realmPreferenceMap = new Map([
            ['EU05', ['c_splitPref', 'c_bothDelete']],
            ['APAC', ['c_bothDelete']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, ['EU05', 'APAC']);
        const result = executeMetaCleanupPlan(plan);
        expect(result.errors).toEqual([]);

        // APAC should have received splitPref in a new realm file
        const apacMetaPath = path.join(
            tmpDir, 'sites', 'site_template_apac', 'meta', 'meta.xml'
        );
        expect(fs.existsSync(apacMetaPath)).toBe(true);
        const apacContent = fs.readFileSync(apacMetaPath, 'utf-8');
        expect(apacContent).toContain('attribute-id="splitPref"');
        // The attribute definition for bothDelete should NOT be in the APAC file
        // (only splitPref's definition was extracted)
        expect(apacContent).not.toContain(
            '<attribute-definition attribute-id="bothDelete"'
        );

        // Core file should be deleted (both splitPref and bothDelete removed,
        // leaving it empty — the executor deletes empty meta files)
        expect(fs.existsSync(path.join(coreMetaDir, 'meta.xml'))).toBe(false);
    });

    it('full workflow: cross-realm mode removes from core without moving', () => {
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        for (const realm of ['eu05', 'apac']) {
            const realmMetaDir = path.join(tmpDir, 'sites', `site_template_${realm}`, 'meta');
            fs.mkdirSync(realmMetaDir, { recursive: true });
        }

        const coreXml = createMetaXml(['crossRealmAttr', 'keepThis']);
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        // Only EU05 listed but crossRealm=true treats it as all
        const realmPreferenceMap = new Map([
            ['EU05', ['c_crossRealmAttr']]
        ]);

        const plan = buildMetaCleanupPlan(
            tmpDir, realmPreferenceMap, ['EU05', 'APAC'], { crossRealm: true }
        );
        const result = executeMetaCleanupPlan(plan);
        expect(result.errors).toEqual([]);

        // No file created in APAC
        const apacMetaPath = path.join(
            tmpDir, 'sites', 'site_template_apac', 'meta', 'meta.xml'
        );
        expect(fs.existsSync(apacMetaPath)).toBe(false);

        // Core file modified: crossRealmAttr removed, keepThis preserved
        const coreContent = fs.readFileSync(
            path.join(coreMetaDir, 'meta.xml'), 'utf-8'
        );
        expect(coreContent).not.toContain('crossRealmAttr');
        expect(coreContent).toContain('keepThis');
    });

    it('P1+P2 deleted from all realms, P5 realm-specific moved to remaining realm', () => {
        // Scenario:
        //   SimpleUnusedAttribute (P1) — all 4 realms delete → removed from core
        //   ThisTestAttribute     (P2) — all 4 realms delete → removed from core
        //   EUOnlyAttribute       (P5) — APAC/GB/PNA delete, EU05 keeps
        //     → moved from core to EU05 realm meta so it survives deployment
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const allRealms = ['EU05', 'APAC', 'GB', 'PNA'];

        for (const realm of allRealms) {
            const realmMetaDir = path.join(
                tmpDir, 'sites', `site_template_${realm.toLowerCase()}`, 'meta'
            );
            fs.mkdirSync(realmMetaDir, { recursive: true });
        }

        // Core meta file has all 3 attributes
        const coreXml = createMetaXml(
            ['SimpleUnusedAttribute', 'ThisTestAttribute', 'EUOnlyAttribute']
        );
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        // Build realmPreferenceMap as the deletion files would produce:
        //   EU05  deletes P1+P2 only (EUOnlyAttribute is NOT a candidate for EU05)
        //   APAC  deletes P1+P2+P5
        //   GB    deletes P1+P2+P5
        //   PNA   deletes P1+P2+P5
        const realmPreferenceMap = new Map([
            ['EU05', ['c_SimpleUnusedAttribute', 'c_ThisTestAttribute']],
            ['APAC', ['c_SimpleUnusedAttribute', 'c_ThisTestAttribute', 'c_EUOnlyAttribute']],
            ['GB', ['c_SimpleUnusedAttribute', 'c_ThisTestAttribute', 'c_EUOnlyAttribute']],
            ['PNA', ['c_SimpleUnusedAttribute', 'c_ThisTestAttribute', 'c_EUOnlyAttribute']]
        ]);

        // ---- Plan phase ----
        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, allRealms);

        // P1 (SimpleUnusedAttribute): deleted from ALL → core remove
        const p1CoreRemoves = plan.actions.filter(
            a => a.attributeId === 'SimpleUnusedAttribute' && a.realm === 'CORE'
        );
        expect(p1CoreRemoves).toHaveLength(1);
        expect(p1CoreRemoves[0].type).toBe('remove');

        // P2 (ThisTestAttribute): deleted from ALL → core remove
        const p2CoreRemoves = plan.actions.filter(
            a => a.attributeId === 'ThisTestAttribute' && a.realm === 'CORE'
        );
        expect(p2CoreRemoves).toHaveLength(1);
        expect(p2CoreRemoves[0].type).toBe('remove');

        // P5 (EUOnlyAttribute): deleted from APAC/GB/PNA but NOT EU05
        //   → create-realm-file to copy to EU05, then remove from core
        const p5CreateActions = plan.actions.filter(
            a => a.attributeId === 'EUOnlyAttribute' && a.type === 'create-realm-file'
        );
        expect(p5CreateActions).toHaveLength(1);
        expect(p5CreateActions[0].realm).toBe('EU05');

        const p5CoreRemoves = plan.actions.filter(
            a => a.attributeId === 'EUOnlyAttribute' && a.realm === 'CORE'
        );
        expect(p5CoreRemoves).toHaveLength(1);
        expect(p5CoreRemoves[0].type).toBe('remove');

        // No create-realm-file for APAC/GB/PNA (they are deleting it)
        const nonEu05Creates = plan.actions.filter(
            a => a.attributeId === 'EUOnlyAttribute'
                && a.type === 'create-realm-file'
                && a.realm !== 'EU05'
        );
        expect(nonEu05Creates).toEqual([]);

        // ---- Execute phase ----
        const result = executeMetaCleanupPlan(plan);
        expect(result.errors).toEqual([]);

        // Core meta file should be deleted (all 3 attributes removed → empty)
        expect(fs.existsSync(path.join(coreMetaDir, 'meta.xml'))).toBe(false);

        // EU05 realm should now contain EUOnlyAttribute (moved from core)
        const eu05MetaPath = path.join(
            tmpDir, 'sites', 'site_template_eu05', 'meta', 'meta.xml'
        );
        expect(fs.existsSync(eu05MetaPath)).toBe(true);
        const eu05Content = fs.readFileSync(eu05MetaPath, 'utf-8');
        expect(eu05Content).toContain('attribute-id="EUOnlyAttribute"');

        // EU05 realm file should NOT contain the deleted P1/P2 attributes
        expect(eu05Content).not.toContain('SimpleUnusedAttribute');
        expect(eu05Content).not.toContain('ThisTestAttribute');

        // APAC/GB/PNA should NOT have any new meta files created
        for (const realm of ['apac', 'gb', 'pna']) {
            const realmMetaPath = path.join(
                tmpDir, 'sites', `site_template_${realm}`, 'meta', 'meta.xml'
            );
            expect(fs.existsSync(realmMetaPath)).toBe(false);
        }
    });

    it('P5 realm-specific attribute skips create when realm already has it', () => {
        // Same scenario but EU05 already has EUOnlyAttribute in its realm meta
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const allRealms = ['EU05', 'APAC'];

        for (const realm of allRealms) {
            const realmMetaDir = path.join(
                tmpDir, 'sites', `site_template_${realm.toLowerCase()}`, 'meta'
            );
            fs.mkdirSync(realmMetaDir, { recursive: true });
        }

        const coreXml = createMetaXml(['EUOnlyAttribute']);
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        // EU05 already has the attribute in its own realm folder
        const eu05Xml = createMetaXml(['EUOnlyAttribute']);
        fs.writeFileSync(
            path.join(tmpDir, 'sites', 'site_template_eu05', 'meta', 'meta.xml'),
            eu05Xml, 'utf-8'
        );

        // Only APAC deletes — EU05 keeps
        const realmPreferenceMap = new Map([
            ['APAC', ['c_EUOnlyAttribute']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, allRealms);

        // No create-realm-file needed — EU05 already has it
        const createActions = plan.actions.filter(a => a.type === 'create-realm-file');
        expect(createActions).toEqual([]);

        // Should still remove from core
        const coreRemoves = plan.actions.filter(a => a.realm === 'CORE');
        expect(coreRemoves).toHaveLength(1);

        // Execute and verify EU05 file is untouched
        const result = executeMetaCleanupPlan(plan);
        expect(result.errors).toEqual([]);

        const eu05Content = fs.readFileSync(
            path.join(tmpDir, 'sites', 'site_template_eu05', 'meta', 'meta.xml'),
            'utf-8'
        );
        expect(eu05Content).toContain('attribute-id="EUOnlyAttribute"');
    });

    it('multiple P5 attributes route to different remaining realms', () => {
        // EUOnlyAttribute: active on EU05 only → APAC/PNA delete, move to EU05
        // APACOnlyAttribute: active on APAC only → EU05/PNA delete, move to APAC
        const coreMetaDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreMetaDir, { recursive: true });

        const allRealms = ['EU05', 'APAC', 'PNA'];

        for (const realm of allRealms) {
            const realmMetaDir = path.join(
                tmpDir, 'sites', `site_template_${realm.toLowerCase()}`, 'meta'
            );
            fs.mkdirSync(realmMetaDir, { recursive: true });
        }

        const coreXml = createMetaXml(
            ['EUOnlyAttribute', 'APACOnlyAttribute', 'GlobalDelete']
        );
        fs.writeFileSync(path.join(coreMetaDir, 'meta.xml'), coreXml, 'utf-8');

        const realmPreferenceMap = new Map([
            ['EU05', ['c_APACOnlyAttribute', 'c_GlobalDelete']],
            ['APAC', ['c_EUOnlyAttribute', 'c_GlobalDelete']],
            ['PNA', ['c_EUOnlyAttribute', 'c_APACOnlyAttribute', 'c_GlobalDelete']]
        ]);

        const plan = buildMetaCleanupPlan(tmpDir, realmPreferenceMap, allRealms);
        const result = executeMetaCleanupPlan(plan);
        expect(result.errors).toEqual([]);

        // EU05 should have EUOnlyAttribute
        const eu05Path = path.join(
            tmpDir, 'sites', 'site_template_eu05', 'meta', 'meta.xml'
        );
        expect(fs.existsSync(eu05Path)).toBe(true);
        const eu05Content = fs.readFileSync(eu05Path, 'utf-8');
        expect(eu05Content).toContain('attribute-id="EUOnlyAttribute"');
        expect(eu05Content).not.toContain('APACOnlyAttribute');
        expect(eu05Content).not.toContain('GlobalDelete');

        // APAC should have APACOnlyAttribute
        const apacPath = path.join(
            tmpDir, 'sites', 'site_template_apac', 'meta', 'meta.xml'
        );
        expect(fs.existsSync(apacPath)).toBe(true);
        const apacContent = fs.readFileSync(apacPath, 'utf-8');
        expect(apacContent).toContain('attribute-id="APACOnlyAttribute"');
        expect(apacContent).not.toContain('EUOnlyAttribute');
        expect(apacContent).not.toContain('GlobalDelete');

        // PNA should have NO new meta file (it deletes everything)
        const pnaPath = path.join(
            tmpDir, 'sites', 'site_template_pna', 'meta', 'meta.xml'
        );
        expect(fs.existsSync(pnaPath)).toBe(false);

        // Core should be deleted (all attributes either removed or moved out)
        expect(fs.existsSync(path.join(coreMetaDir, 'meta.xml'))).toBe(false);
    });
});

// ============================================================================
// enrichRegionalGroups
// ============================================================================

describe('enrichRegionalGroups', () => {
    let tmpDir;
    let logSpy;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enrich-'));
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

        // Setup mock configs
        getSandboxConfig.mockImplementation((realm) => {
            if (realm === 'EU05') {
                return { siteTemplatesPath: 'sites/site_template_eu' };
            }
            if (realm === 'APAC') {
                return { siteTemplatesPath: 'sites/site_template_apac' };
            }
            return null;
        });
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        logSpy.mockRestore();
    });

    function setupCoreDir(attributeIds, groupId = 'SharedGroup') {
        const coreDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreDir, { recursive: true });
        fs.writeFileSync(
            path.join(coreDir, 'meta.core.xml'),
            createMetaXml(attributeIds, { groupId }),
            'utf-8'
        );
        return coreDir;
    }

    function setupRealmDir(realmTemplate, attributeIds, groupId = 'SharedGroup') {
        const realmDir = path.join(tmpDir, realmTemplate, 'meta');
        fs.mkdirSync(realmDir, { recursive: true });
        fs.writeFileSync(
            path.join(realmDir, 'meta.EU05.xml'),
            createMetaXml(attributeIds, { groupId }),
            'utf-8'
        );
        return realmDir;
    }

    it('adds missing core group references to regional files', () => {
        // Core has SharedGroup with [coreA, coreB, coreC]
        setupCoreDir(['coreA', 'coreB', 'coreC']);

        // Regional has SharedGroup with [uniqueEU] only
        const realmDir = setupRealmDir('sites/site_template_eu', ['uniqueEU']);

        const result = enrichRegionalGroups({ repoPath: tmpDir, realmList: ['EU05'] });

        expect(result.enriched.length).toBe(1);
        expect(result.enriched[0].realm).toBe('EU05');
        expect(result.enriched[0].added).toBe(3);

        const updatedContent = fs.readFileSync(
            path.join(realmDir, 'meta.EU05.xml'), 'utf-8'
        );
        expect(updatedContent).toContain('<attribute attribute-id="coreA"/>');
        expect(updatedContent).toContain('<attribute attribute-id="coreB"/>');
        expect(updatedContent).toContain('<attribute attribute-id="coreC"/>');
        expect(updatedContent).toContain('<attribute attribute-id="uniqueEU"/>');
    });

    it('does not duplicate existing attribute references', () => {
        // Core has SharedGroup with [coreA, coreB]
        setupCoreDir(['coreA', 'coreB']);

        // Regional already has coreA + uniqueEU
        const realmDir = setupRealmDir('sites/site_template_eu', ['coreA', 'uniqueEU']);

        const result = enrichRegionalGroups({ repoPath: tmpDir, realmList: ['EU05'] });

        expect(result.enriched.length).toBe(1);
        expect(result.enriched[0].added).toBe(1); // Only coreB added

        const updatedContent = fs.readFileSync(
            path.join(realmDir, 'meta.EU05.xml'), 'utf-8'
        );
        // Count occurrences of coreA — should appear exactly once
        const coreAMatches = updatedContent.match(/attribute-id="coreA"/g);
        expect(coreAMatches.length).toBe(2); // 1 definition + 1 group ref
    });

    it('skips when regional file has no matching groups', () => {
        // Core has SharedGroup with [coreA]
        setupCoreDir(['coreA'], 'SharedGroup');

        // Regional has a DIFFERENT group
        const realmDir = setupRealmDir('sites/site_template_eu', ['uniqueEU'], 'DifferentGroup');

        const result = enrichRegionalGroups({ repoPath: tmpDir, realmList: ['EU05'] });

        expect(result.enriched.length).toBe(0);
    });

    it('returns empty when no core files exist', () => {
        // No core directory
        const coreDir = path.join(tmpDir, 'sites', 'site_template', 'meta');
        fs.mkdirSync(coreDir, { recursive: true });

        setupRealmDir('sites/site_template_eu', ['uniqueEU']);

        const result = enrichRegionalGroups({ repoPath: tmpDir, realmList: ['EU05'] });

        expect(result.enriched.length).toBe(0);
    });

    it('skips realms with no config', () => {
        setupCoreDir(['coreA']);

        const result = enrichRegionalGroups({ repoPath: tmpDir, realmList: ['UNKNOWN'] });

        expect(result.skipped).toContain('UNKNOWN');
        expect(result.enriched.length).toBe(0);
    });

    it('skips meta.core.xml in realm directories', () => {
        // Core has SharedGroup with [coreA, coreB]
        setupCoreDir(['coreA', 'coreB']);

        // Realm directory also has a meta.core.xml (from consolidation) — should not be modified
        const realmDir = path.join(tmpDir, 'sites', 'site_template_eu', 'meta');
        fs.mkdirSync(realmDir, { recursive: true });
        fs.writeFileSync(
            path.join(realmDir, 'meta.core.xml'),
            createMetaXml(['coreA', 'coreB'], { groupId: 'SharedGroup' }),
            'utf-8'
        );
        // Regional file with only uniqueEU in the same SharedGroup
        fs.writeFileSync(
            path.join(realmDir, 'meta.EU05.xml'),
            createMetaXml(['uniqueEU'], { groupId: 'SharedGroup' }),
            'utf-8'
        );

        const result = enrichRegionalGroups({ repoPath: tmpDir, realmList: ['EU05'] });

        // meta.core.xml should not be modified (only meta.EU05.xml)
        expect(result.enriched.length).toBe(1);
        expect(result.enriched[0].file).toBe('meta.EU05.xml');
    });

    it('preserves correct indentation for added attribute references', () => {
        // Core has SharedGroup with [coreA, coreB]
        setupCoreDir(['coreA', 'coreB']);

        // Regional has SharedGroup with [uniqueEU]
        const realmDir = setupRealmDir('sites/site_template_eu', ['uniqueEU']);

        enrichRegionalGroups({ repoPath: tmpDir, realmList: ['EU05'] });

        const updatedContent = fs.readFileSync(
            path.join(realmDir, 'meta.EU05.xml'), 'utf-8'
        );

        // All attribute refs in the group should have the same indentation
        const attrLines = updatedContent
            .split('\n')
            .filter(line => line.includes('<attribute attribute-id='));

        const indents = attrLines.map(line => line.match(/^(\s*)/)[1]);
        const uniqueIndents = new Set(indents);

        // All attribute lines should share the same indentation
        expect(uniqueIndents.size).toBe(1);

        // Opening and closing attribute-group tags must have matching indentation
        const lines = updatedContent.split('\n');
        const openLine = lines.find(l => l.includes('<attribute-group'));
        const closeLine = lines.find(l => l.includes('</attribute-group>'));
        const openIndent = openLine.match(/^(\s*)/)[1];
        const closeIndent = closeLine.match(/^(\s*)/)[1];
        expect(closeIndent).toBe(openIndent);
    });
});
