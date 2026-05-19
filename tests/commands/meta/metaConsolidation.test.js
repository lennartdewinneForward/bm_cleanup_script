import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
    buildConsolidatedMetaFileName,
    removeOtherXmlFiles,
    formatConsolidationResults,
    downloadRealmMetaBackup,
    consolidateMetaFiles,
    extractTypeExtension,
    extractBlock,
    parseAttributeDefinitions,
    parseGroupDefinitions,
    dedent,
    indentBlock,
    itemsInAtLeast,
    buildOutputXml,
    parseRealmMetaXml,
    mergeMetaFiles
} from '../../../src/commands/meta/helpers/metaConsolidation.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('../../../src/helpers/backupJob.js', () => ({
    refreshMetadataBackupForRealm: vi.fn()
}));

vi.mock('../../../src/config/helpers/helpers.js', () => ({
    getSandboxConfig: vi.fn((realm) => ({
        hostname: `${realm.toLowerCase()}.example.com`,
        instanceType: 'development',
        siteTemplatesPath: `sites/site_template_${realm.toLowerCase()}`
    })),
    getWebdavConfig: vi.fn((realm) => ({
        name: realm,
        hostname: `${realm.toLowerCase()}.example.com`
    }))
}));

// Re-export getRealmMetaDir from metaFileCleanup — it's imported by metaConsolidation
vi.mock('../../../src/commands/meta/helpers/metaFileCleanup.js', () => ({
    getRealmMetaDir: vi.fn((repoPath, siteTemplatesPath) =>
        path.join(repoPath, siteTemplatesPath, 'meta')
    )
}));

import { refreshMetadataBackupForRealm } from '../../../src/helpers/backupJob.js';

// ============================================================================
// buildConsolidatedMetaFileName
// ============================================================================

describe('buildConsolidatedMetaFileName', () => {
    it('creates filename from hostname', () => {
        const result = buildConsolidatedMetaFileName('eu05-realm.example.com');
        expect(result).toBe('eu05-realm.example.com_meta_data.xml');
    });

    it('sanitizes special characters', () => {
        const result = buildConsolidatedMetaFileName('host/with:special@chars');
        expect(result).toBe('host-with-special-chars_meta_data.xml');
    });

    it('handles empty/null input', () => {
        expect(buildConsolidatedMetaFileName(null)).toBe('unknown_meta_data.xml');
        expect(buildConsolidatedMetaFileName(undefined)).toBe('unknown_meta_data.xml');
        expect(buildConsolidatedMetaFileName('')).toBe('unknown_meta_data.xml');
    });

    it('preserves alphanumeric, dots, and hyphens', () => {
        const result = buildConsolidatedMetaFileName('my-host.123');
        expect(result).toBe('my-host.123_meta_data.xml');
    });
});

// ============================================================================
// removeOtherXmlFiles
// ============================================================================

describe('removeOtherXmlFiles', () => {
    let tmpDir;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidation-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('removes XML files except the one to keep', () => {
        fs.writeFileSync(path.join(tmpDir, 'keep.xml'), '<xml/>', 'utf-8');
        fs.writeFileSync(path.join(tmpDir, 'remove1.xml'), '<xml/>', 'utf-8');
        fs.writeFileSync(path.join(tmpDir, 'remove2.xml'), '<xml/>', 'utf-8');

        const result = removeOtherXmlFiles(tmpDir, 'keep.xml');

        expect(result.kept).toEqual(['keep.xml']);
        expect(result.removed).toHaveLength(2);
        expect(result.removed).toContain('remove1.xml');
        expect(result.removed).toContain('remove2.xml');

        expect(fs.existsSync(path.join(tmpDir, 'keep.xml'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'remove1.xml'))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, 'remove2.xml'))).toBe(false);
    });

    it('does not remove non-XML files', () => {
        fs.writeFileSync(path.join(tmpDir, 'keep.xml'), '<xml/>', 'utf-8');
        fs.writeFileSync(path.join(tmpDir, 'readme.txt'), 'text', 'utf-8');
        fs.writeFileSync(path.join(tmpDir, 'config.json'), '{}', 'utf-8');

        const result = removeOtherXmlFiles(tmpDir, 'keep.xml');

        expect(result.removed).toEqual([]);
        expect(fs.existsSync(path.join(tmpDir, 'readme.txt'))).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, 'config.json'))).toBe(true);
    });

    it('does not remove directories even if named .xml', () => {
        fs.writeFileSync(path.join(tmpDir, 'keep.xml'), '<xml/>', 'utf-8');
        fs.mkdirSync(path.join(tmpDir, 'subdir.xml'));

        const result = removeOtherXmlFiles(tmpDir, 'keep.xml');

        expect(result.removed).toEqual([]);
        expect(fs.existsSync(path.join(tmpDir, 'subdir.xml'))).toBe(true);
    });

    it('handles empty directory', () => {
        const result = removeOtherXmlFiles(tmpDir, 'keep.xml');

        expect(result.removed).toEqual([]);
        expect(result.kept).toEqual(['keep.xml']);
    });

    it('handles case when keep file is not present', () => {
        fs.writeFileSync(path.join(tmpDir, 'other.xml'), '<xml/>', 'utf-8');

        const result = removeOtherXmlFiles(tmpDir, 'keep.xml');

        expect(result.removed).toHaveLength(1);
        expect(result.removed).toContain('other.xml');
    });
});

// ============================================================================
// formatConsolidationResults
// ============================================================================

describe('formatConsolidationResults', () => {
    it('formats successful results with metaFiles array', () => {
        const input = {
            results: [
                { ok: true, realm: 'EU05', metaFiles: ['meta.core.xml', 'meta.EU05.xml'], removed: ['old1.xml', 'old2.xml'] }
            ],
            successCount: 1,
            failCount: 0
        };

        const output = formatConsolidationResults(input);

        expect(output).toContain('EU05');
        expect(output).toContain('meta.core.xml, meta.EU05.xml');
        expect(output).toContain('2 old file(s) removed');
        expect(output).toContain('1 succeeded, 0 failed');
    });

    it('formats successful results with legacy metaFile string', () => {
        const input = {
            results: [
                { ok: true, realm: 'EU05', metaFile: 'host_meta_data.xml', removed: [] }
            ],
            successCount: 1,
            failCount: 0
        };

        const output = formatConsolidationResults(input);

        expect(output).toContain('EU05');
        expect(output).toContain('host_meta_data.xml');
        expect(output).toContain('0 old file(s) removed');
    });

    it('formats failed results', () => {
        const input = {
            results: [
                { ok: false, realm: 'APAC', reason: 'No config found' }
            ],
            successCount: 0,
            failCount: 1
        };

        const output = formatConsolidationResults(input);

        expect(output).toContain('APAC');
        expect(output).toContain('No config found');
        expect(output).toContain('0 succeeded, 1 failed');
    });

    it('formats mixed results', () => {
        const input = {
            results: [
                { ok: true, realm: 'EU05', metaFiles: ['meta.core.xml'], removed: [] },
                { ok: false, realm: 'GB', reason: 'Meta dir not found' }
            ],
            successCount: 1,
            failCount: 1
        };

        const output = formatConsolidationResults(input);

        expect(output).toContain('EU05');
        expect(output).toContain('GB');
        expect(output).toContain('1 succeeded, 1 failed');
    });

    it('displays core attribute count when provided', () => {
        const input = {
            results: [
                { ok: true, realm: 'EU05', metaFiles: ['meta.core.xml'], removed: [] }
            ],
            successCount: 1,
            failCount: 0,
            coreAttributeCount: 42
        };

        const output = formatConsolidationResults(input);

        expect(output).toContain('Core attributes (shared): 42');
    });
});

// ============================================================================
// downloadRealmMetaBackup
// ============================================================================

describe('downloadRealmMetaBackup', () => {
    let logSpy;

    beforeEach(() => {
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns success with filePath when backup succeeds', async () => {
        refreshMetadataBackupForRealm.mockResolvedValue({
            ok: true,
            filePath: '/some/backup.xml'
        });

        const result = await downloadRealmMetaBackup({
            realm: 'EU05',
            instanceType: 'development'
        });

        expect(result.ok).toBe(true);
        expect(result.realm).toBe('EU05');
        expect(result.filePath).toBe('/some/backup.xml');
    });

    it('returns failure when backup job fails', async () => {
        refreshMetadataBackupForRealm.mockResolvedValue({
            ok: false,
            reason: 'Job timed out'
        });

        const result = await downloadRealmMetaBackup({
            realm: 'EU05',
            instanceType: 'development'
        });

        expect(result.ok).toBe(false);
        expect(result.realm).toBe('EU05');
        expect(result.reason).toContain('Job timed out');
    });

    it('passes forceJobExecution to backup function', async () => {
        refreshMetadataBackupForRealm.mockResolvedValue({
            ok: true,
            filePath: '/path/to/file.xml'
        });

        await downloadRealmMetaBackup({
            realm: 'APAC',
            instanceType: 'sandbox'
        });

        expect(refreshMetadataBackupForRealm).toHaveBeenCalledWith(
            'APAC', 'sandbox', { forceJobExecution: true }
        );
    });

    it('provides default reason when none given', async () => {
        refreshMetadataBackupForRealm.mockResolvedValue({ ok: false });

        const result = await downloadRealmMetaBackup({
            realm: 'GB',
            instanceType: 'development'
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe('Backup job failed');
    });
});

// ============================================================================
// consolidateMetaFiles
// ============================================================================

// Shared sample XML for tests that need valid SitePreferences content
function buildSampleXml(attributeIds, groupId = 'TestGroup') {
    const attrDefs = attributeIds.map(id =>
        `            <attribute-definition attribute-id="${id}">\n`
        + `                <display-name xml:lang="x-default">${id}</display-name>\n`
        + `                <type>string</type>\n`
        + `            </attribute-definition>`
    ).join('\n');

    const attrRefs = attributeIds.map(id =>
        `                <attribute attribute-id="${id}"/>`
    ).join('\n');

    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<metadata xmlns="http://www.demandware.com/xml/impex/metadata/2006-10-31">',
        '    <type-extension type-id="SitePreferences">',
        '        <custom-attribute-definitions>',
        attrDefs,
        '        </custom-attribute-definitions>',
        '        <group-definitions>',
        `            <attribute-group group-id="${groupId}">`,
        `                <display-name xml:lang="x-default">${groupId}</display-name>`,
        attrRefs,
        '            </attribute-group>',
        '        </group-definitions>',
        '    </type-extension>',
        '</metadata>'
    ].join('\n');
}

describe('consolidateMetaFiles', () => {
    let tmpDir;
    let logSpy;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consolidate-multi-'));
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    it('merges multiple realms into core + region files', async () => {
        // EU05 and APAC both share attrA/attrB; EU05 has unique attrC
        const eu05Meta = path.join(tmpDir, 'sites', 'site_template_eu05', 'meta');
        const apacMeta = path.join(tmpDir, 'sites', 'site_template_apac', 'meta');
        fs.mkdirSync(eu05Meta, { recursive: true });
        fs.mkdirSync(apacMeta, { recursive: true });

        const eu05Backup = path.join(tmpDir, 'eu05_backup.xml');
        const apacBackup = path.join(tmpDir, 'apac_backup.xml');
        fs.writeFileSync(eu05Backup, buildSampleXml(['attrA', 'attrB', 'attrC']), 'utf-8');
        fs.writeFileSync(apacBackup, buildSampleXml(['attrA', 'attrB']), 'utf-8');

        refreshMetadataBackupForRealm
            .mockResolvedValueOnce({ ok: true, filePath: eu05Backup })
            .mockResolvedValueOnce({ ok: true, filePath: apacBackup });

        const result = await consolidateMetaFiles({
            repoPath: tmpDir,
            realmList: ['EU05', 'APAC'],
            instanceType: 'development'
        });

        expect(result.successCount).toBe(2);
        expect(result.failCount).toBe(0);
        expect(result.coreAttributeCount).toBe(2);

        // Both realms should have meta.core.xml
        expect(fs.existsSync(path.join(eu05Meta, 'meta.core.xml'))).toBe(true);
        expect(fs.existsSync(path.join(apacMeta, 'meta.core.xml'))).toBe(true);

        // EU05 should have a region file for its unique attrC
        const eu05Result = result.results.find(r => r.realm === 'EU05');
        expect(eu05Result.metaFiles).toContain('meta.core.xml');
        expect(eu05Result.metaFiles).toContain('meta.EU05.xml');

        // APAC has no unique attributes -- only core
        const apacResult = result.results.find(r => r.realm === 'APAC');
        expect(apacResult.metaFiles).toContain('meta.core.xml');
        expect(apacResult.metaFiles).not.toContain('meta.APAC.xml');
    });

    it('falls back to single-file copy when only one realm downloads', async () => {
        const eu05Meta = path.join(tmpDir, 'sites', 'site_template_eu05', 'meta');
        fs.mkdirSync(eu05Meta, { recursive: true });

        const backupFile = path.join(tmpDir, 'backup.xml');
        fs.writeFileSync(backupFile, buildSampleXml(['attrA']), 'utf-8');

        // APAC has no meta dir -> fails before download
        refreshMetadataBackupForRealm.mockResolvedValue({
            ok: true, filePath: backupFile
        });

        const result = await consolidateMetaFiles({
            repoPath: tmpDir,
            realmList: ['EU05', 'APAC'],
            instanceType: 'development'
        });

        expect(result.coreAttributeCount).toBe(0);
        const eu05Result = result.results.find(r => r.realm === 'EU05');
        expect(eu05Result.ok).toBe(true);
        expect(eu05Result.metaFiles[0]).toContain('_meta_data.xml');
    });

    it('handles empty realm list', async () => {
        const result = await consolidateMetaFiles({
            repoPath: tmpDir,
            realmList: [],
            instanceType: 'development'
        });
        expect(result.results).toHaveLength(0);
        expect(result.successCount).toBe(0);
        expect(result.failCount).toBe(0);
    });

    it('reports failure when no config for realm', async () => {
        const { getSandboxConfig } = await import('../../../src/config/helpers/helpers.js');
        getSandboxConfig.mockReturnValueOnce(null);

        const result = await consolidateMetaFiles({
            repoPath: tmpDir,
            realmList: ['UNKNOWN'],
            instanceType: 'development'
        });

        expect(result.failCount).toBe(1);
        expect(result.results[0].reason).toContain('No config found');
    });
});

// ============================================================================
// XML PARSING UTILITIES
// ============================================================================

describe('extractTypeExtension', () => {
    it('extracts the SitePreferences type-extension block', () => {
        const xml = buildSampleXml(['attrA']);
        const block = extractTypeExtension(xml, 'SitePreferences');

        expect(block).toContain('<type-extension type-id="SitePreferences">');
        expect(block).toContain('</type-extension>');
        expect(block).toContain('attrA');
    });

    it('throws when type-id is not found', () => {
        const xml = buildSampleXml(['attrA']);
        expect(() => extractTypeExtension(xml, 'NoSuchType')).toThrow('Missing');
    });

    it('throws when tag is not closed', () => {
        const xml = '<type-extension type-id="SitePreferences">';
        expect(() => extractTypeExtension(xml, 'SitePreferences')).toThrow('Unclosed');
    });
});

describe('extractBlock', () => {
    it('extracts a named tag block', () => {
        const xml = '<root><custom-attribute-definitions>stuff</custom-attribute-definitions></root>';
        const block = extractBlock(xml, 'custom-attribute-definitions');

        expect(block).toBe('<custom-attribute-definitions>stuff</custom-attribute-definitions>');
    });

    it('returns null when tag is not found', () => {
        const result = extractBlock('<root></root>', 'nonexistent');
        expect(result).toBeNull();
    });
});

describe('parseAttributeDefinitions', () => {
    it('parses attribute definitions into a Map', () => {
        const block = [
            '<custom-attribute-definitions>',
            '  <attribute-definition attribute-id="prefA">',
            '    <display-name xml:lang="x-default">Pref A</display-name>',
            '    <type>string</type>',
            '  </attribute-definition>',
            '  <attribute-definition attribute-id="prefB">',
            '    <display-name xml:lang="x-default">Pref B</display-name>',
            '    <type>boolean</type>',
            '  </attribute-definition>',
            '</custom-attribute-definitions>'
        ].join('\n');

        const result = parseAttributeDefinitions(block);

        expect(result.size).toBe(2);
        expect(result.has('prefA')).toBe(true);
        expect(result.has('prefB')).toBe(true);
        expect(result.get('prefA')).toContain('Pref A');
    });

    it('handles self-closing attribute-definition tags', () => {
        const block = '<custom-attribute-definitions>'
            + '<attribute-definition attribute-id="simple"/>'
            + '</custom-attribute-definitions>';
        const result = parseAttributeDefinitions(block);

        expect(result.size).toBe(1);
        expect(result.has('simple')).toBe(true);
    });

    it('returns empty map for no definitions', () => {
        const block = '<custom-attribute-definitions></custom-attribute-definitions>';
        const result = parseAttributeDefinitions(block);
        expect(result.size).toBe(0);
    });
});

describe('parseGroupDefinitions', () => {
    it('parses group definitions with attributes', () => {
        const block = [
            '<group-definitions>',
            '  <attribute-group group-id="General">',
            '    <display-name xml:lang="x-default">General</display-name>',
            '    <attribute attribute-id="prefA"/>',
            '    <attribute attribute-id="prefB"/>',
            '  </attribute-group>',
            '</group-definitions>'
        ].join('\n');

        const result = parseGroupDefinitions(block);

        expect(result.size).toBe(1);
        expect(result.has('General')).toBe(true);
        expect(result.get('General').attributeIds).toEqual(new Set(['prefA', 'prefB']));
    });

    it('preserves non-attribute inner content', () => {
        const block = [
            '<group-definitions>',
            '  <attribute-group group-id="MyGroup">',
            '    <display-name xml:lang="x-default">My Group</display-name>',
            '    <description>Some description</description>',
            '    <attribute attribute-id="a1"/>',
            '  </attribute-group>',
            '</group-definitions>'
        ].join('\n');

        const result = parseGroupDefinitions(block);
        const group = result.get('MyGroup');

        expect(group.preservedInner).toContain('display-name');
        expect(group.preservedInner).toContain('description');
    });

    it('returns empty map for no groups', () => {
        const block = '<group-definitions></group-definitions>';
        const result = parseGroupDefinitions(block);
        expect(result.size).toBe(0);
    });
});

// ============================================================================
// STRING FORMATTING UTILITIES
// ============================================================================

describe('dedent', () => {
    it('removes common leading whitespace', () => {
        const input = '    line1\n    line2\n        line3';
        const result = dedent(input);
        expect(result).toBe('line1\nline2\n    line3');
    });

    it('handles empty string', () => {
        expect(dedent('')).toBe('');
        expect(dedent('   ')).toBe('');
    });

    it('trims leading/trailing blank lines', () => {
        const input = '\n\n    hello\n    world\n\n';
        const result = dedent(input);
        expect(result).toBe('hello\nworld');
    });
});

describe('indentBlock', () => {
    it('adds specified spaces to each line', () => {
        const input = 'line1\nline2';
        const result = indentBlock(input, 4);
        expect(result).toBe('    line1\n    line2');
    });

    it('handles zero indent', () => {
        expect(indentBlock('abc', 0)).toBe('abc');
    });
});

// ============================================================================
// MERGE ALGORITHM
// ============================================================================

describe('itemsInAtLeast', () => {
    it('finds items meeting the threshold', () => {
        const sets = [
            new Set(['a', 'b', 'c']),
            new Set(['b', 'c', 'd']),
            new Set(['c', 'd', 'e'])
        ];

        const result = itemsInAtLeast(sets, 2);

        expect(result).toEqual(new Set(['b', 'c', 'd']));
    });

    it('returns all items when threshold is 1', () => {
        const sets = [new Set(['a']), new Set(['b'])];
        const result = itemsInAtLeast(sets, 1);
        expect(result).toEqual(new Set(['a', 'b']));
    });

    it('returns empty set when nothing meets threshold', () => {
        const sets = [new Set(['a']), new Set(['b'])];
        const result = itemsInAtLeast(sets, 2);
        expect(result.size).toBe(0);
    });
});

describe('buildOutputXml', () => {
    it('builds valid XML from attributes and groups', () => {
        const parsed = [{
            realm: 'EU05',
            attributeDefinitions: new Map([
                ['prefA', '<attribute-definition attribute-id="prefA">\n<type>string</type>\n</attribute-definition>']
            ]),
            groups: new Map([
                ['TestGroup', {
                    startTag: '<attribute-group group-id="TestGroup">',
                    preservedInner: '<display-name xml:lang="x-default">Test</display-name>',
                    attributeIds: new Set(['prefA'])
                }]
            ])
        }];

        const xml = buildOutputXml(
            parsed,
            new Set(['prefA']),
            new Set(['TestGroup|||prefA'])
        );

        expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
        expect(xml).toContain('<type-extension type-id="SitePreferences">');
        expect(xml).toContain('attribute-id="prefA"');
        expect(xml).toContain('<attribute-group group-id="TestGroup">');
        expect(xml).toContain('<attribute attribute-id="prefA"/>');
    });
});

// ============================================================================
// parseRealmMetaXml
// ============================================================================

describe('parseRealmMetaXml', () => {
    it('parses a valid realm meta XML', () => {
        const xml = buildSampleXml(['attrA', 'attrB']);
        const result = parseRealmMetaXml(xml, 'EU05');

        expect(result.realm).toBe('EU05');
        expect(result.attributeDefinitions.size).toBe(2);
        expect(result.attributeDefinitions.has('attrA')).toBe(true);
        expect(result.groups.size).toBe(1);
        expect(result.groups.has('TestGroup')).toBe(true);
    });

    it('throws when SitePreferences type-extension is missing', () => {
        const xml = '<metadata><type-extension type-id="Other"></type-extension></metadata>';
        expect(() => parseRealmMetaXml(xml, 'EU05')).toThrow('Missing');
    });

    it('throws when custom-attribute-definitions is missing', () => {
        const xml = [
            '<metadata>',
            '<type-extension type-id="SitePreferences">',
            '<group-definitions></group-definitions>',
            '</type-extension>',
            '</metadata>'
        ].join('\n');
        expect(() => parseRealmMetaXml(xml, 'EU05')).toThrow('missing custom-attribute-definitions');
    });
});

// ============================================================================
// mergeMetaFiles
// ============================================================================

describe('mergeMetaFiles', () => {
    function parseSample(realm, attributeIds, groupId = 'SharedGroup') {
        const xml = buildSampleXml(attributeIds, groupId);
        return parseRealmMetaXml(xml, realm);
    }

    it('separates core and unique attributes', () => {
        const eu05 = parseSample('EU05', ['sharedA', 'sharedB', 'uniqueEU']);
        const apac = parseSample('APAC', ['sharedA', 'sharedB', 'uniqueAPAC']);

        const result = mergeMetaFiles({ parsedFiles: [eu05, apac], coreThreshold: 2 });

        expect(result.coreAttributeCount).toBe(2);
        expect(result.coreXml).toContain('sharedA');
        expect(result.coreXml).toContain('sharedB');
        expect(result.coreXml).not.toContain('uniqueEU');
        expect(result.coreXml).not.toContain('uniqueAPAC');

        expect(result.regionOutputs.size).toBe(2);
        expect(result.regionOutputs.get('EU05').xml).toContain('uniqueEU');
        expect(result.regionOutputs.get('APAC').xml).toContain('uniqueAPAC');
    });

    it('puts all attributes in core when all files share them', () => {
        const eu05 = parseSample('EU05', ['a', 'b']);
        const apac = parseSample('APAC', ['a', 'b']);

        const result = mergeMetaFiles({ parsedFiles: [eu05, apac], coreThreshold: 2 });

        expect(result.coreAttributeCount).toBe(2);
        expect(result.regionOutputs.size).toBe(0);
    });

    it('uses default threshold of 2', () => {
        const eu05 = parseSample('EU05', ['a', 'b']);
        const apac = parseSample('APAC', ['a', 'c']);

        const result = mergeMetaFiles({ parsedFiles: [eu05, apac] });

        expect(result.coreAttributeCount).toBe(1); // only 'a' is shared
        expect(result.regionOutputs.size).toBe(2);
    });

    it('handles single file -- all attributes unique', () => {
        const eu05 = parseSample('EU05', ['a', 'b']);

        const result = mergeMetaFiles({ parsedFiles: [eu05], coreThreshold: 2 });

        expect(result.coreAttributeCount).toBe(0);
        expect(result.regionOutputs.size).toBe(1);
        expect(result.regionOutputs.get('EU05').attributeCount).toBe(2);
    });

    it('regional group definitions include core attribute assignments', () => {
        const eu05 = parseSample('EU05', ['sharedA', 'sharedB', 'uniqueEU']);
        const apac = parseSample('APAC', ['sharedA', 'sharedB', 'uniqueAPAC']);

        const result = mergeMetaFiles({ parsedFiles: [eu05, apac], coreThreshold: 2 });

        const eu05Xml = result.regionOutputs.get('EU05').xml;
        const apacXml = result.regionOutputs.get('APAC').xml;

        // Regional files only define unique attributes (no core definitions)
        expect(eu05Xml).toContain('attribute-definition attribute-id="uniqueEU"');
        expect(eu05Xml).not.toContain('attribute-definition attribute-id="sharedA"');
        expect(eu05Xml).not.toContain('attribute-definition attribute-id="sharedB"');

        // But group assignments include ALL attributes (core + unique)
        // so the replace import does not strip core attributes from the group
        expect(eu05Xml).toContain('<attribute attribute-id="sharedA"/>');
        expect(eu05Xml).toContain('<attribute attribute-id="sharedB"/>');
        expect(eu05Xml).toContain('<attribute attribute-id="uniqueEU"/>');

        expect(apacXml).toContain('<attribute attribute-id="sharedA"/>');
        expect(apacXml).toContain('<attribute attribute-id="sharedB"/>');
        expect(apacXml).toContain('<attribute attribute-id="uniqueAPAC"/>');
    });

    it('regional groupPairCount includes core + unique pairs', () => {
        const eu05 = parseSample('EU05', ['sharedA', 'sharedB', 'uniqueEU']);
        const apac = parseSample('APAC', ['sharedA', 'sharedB', 'uniqueAPAC']);

        const result = mergeMetaFiles({ parsedFiles: [eu05, apac], coreThreshold: 2 });

        // Each region has 3 group pairs (2 core + 1 unique) in one group
        expect(result.regionOutputs.get('EU05').groupPairCount).toBe(3);
        expect(result.regionOutputs.get('APAC').groupPairCount).toBe(3);
    });
});
