import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('child_process', () => ({
    execSync: vi.fn()
}));

vi.mock('../../../src/commands/meta/helpers/gitHelper.js', () => ({
    getChangedFiles: vi.fn(() => ({ added: [], modified: [], deleted: [] }))
}));

vi.mock('../../../src/config/constants.js', () => ({
    LOG_PREFIX: { INFO: '✓', WARNING: '⚠', ERROR: '✗' },
    IDENTIFIERS: { ALL_REALMS: 'ALL_REALMS', SITE_PREFERENCES: 'SitePreferences', CUSTOM_ATTRIBUTE_PREFIX: 'c_' },
    DIRECTORIES: { RESULTS: 'results', BACKUP_DOWNLOADS: 'backup_downloads' }
}));

vi.mock('../../../src/config/helpers/helpers.js', () => ({
    getSandboxConfig: vi.fn((realm) => ({
        siteTemplatesPath: `sites/site_template_${realm.toLowerCase()}`
    })),
    getRealmsByInstanceType: vi.fn(() => ['EU05', 'APAC']),
    getCoreSiteTemplatePath: vi.fn(() => 'sites/site_template')
}));

vi.mock('../../../src/commands/setup/helpers/blacklistHelper.js', () => ({
    loadBlacklist: vi.fn(() => ({ blacklist: [] })),
    isBlacklisted: vi.fn(() => false)
}));

vi.mock('../../../src/commands/meta/helpers/metaFileCleanup.js', () => ({
    stripCustomPrefix: vi.fn(id => id.startsWith('c_') ? id.slice(2) : id),
    getRealmMetaDir: vi.fn((_repo, tplPath) => path.join('/mock/repo', tplPath, 'meta')),
    getCoreMetaDir: vi.fn(() => '/mock/repo/sites/site_template/meta'),
    extractSitePreferencesBlock: vi.fn(content => content),
    listSitePrefMetaFiles: vi.fn(() => [])
}));

vi.mock('../../../src/scripts/loggingScript/log.js', () => ({
    logError: vi.fn()
}));

import { execSync } from 'child_process';
import { getChangedFiles } from '../../../src/commands/meta/helpers/gitHelper.js';
import { loadBlacklist, isBlacklisted } from '../../../src/commands/setup/helpers/blacklistHelper.js';
import { listSitePrefMetaFiles } from '../../../src/commands/meta/helpers/metaFileCleanup.js';
import {
    validateMetaChanges,
    formatValidationReport,
    fixXmlIndentation
} from '../../../src/commands/meta/helpers/metaChangeValidator.js';

let tmpDir;

beforeEach(() => {
    vi.resetAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-validator-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    // Restore default implementations after reset
    loadBlacklist.mockReturnValue({ blacklist: [] });
    isBlacklisted.mockReturnValue(false);
    getChangedFiles.mockReturnValue({ added: [], modified: [], deleted: [] });
    listSitePrefMetaFiles.mockReturnValue([]);
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

// ============================================================================
// validateMetaChanges
// ============================================================================

describe('validateMetaChanges', () => {
    it('returns clean report when no files changed', () => {
        const report = validateMetaChanges({
            repoPath: tmpDir,
            instanceType: 'development',
            realmPreferenceMap: new Map()
        });

        expect(report.removedAttributes.total).toBe(0);
        expect(report.removedAttributes.unapproved).toEqual([]);
        expect(report.blacklistViolations).toEqual([]);
    });

    it('marks removed attributes as approved when in realmPreferenceMap', () => {
        const xmlPath = path.join(tmpDir, 'meta.system.sitepreference.test.xml');
        fs.writeFileSync(xmlPath, '<metadata></metadata>', 'utf-8');

        getChangedFiles.mockReturnValue({
            added: [], modified: ['meta.system.sitepreference.test.xml'], deleted: []
        });
        listSitePrefMetaFiles.mockReturnValue([xmlPath]);

        // Simulate git diff: only prefA was removed
        execSync.mockReturnValue(
            '--- a/meta.system.sitepreference.test.xml\n'
            + '+++ b/meta.system.sitepreference.test.xml\n'
            + '-    <attribute-definition attribute-id="prefA" type="string">\n'
        );

        const report = validateMetaChanges({
            repoPath: tmpDir,
            instanceType: 'development',
            realmPreferenceMap: new Map([['EU05', ['c_prefA']]])
        });

        expect(report.removedAttributes.total).toBe(1);
        expect(report.removedAttributes.approved).toBe(1);
        expect(report.removedAttributes.unapproved).toEqual([]);
    });

    it('flags unapproved removals when attribute not in realmPreferenceMap', () => {
        const xmlPath = path.join(tmpDir, 'meta.system.sitepreference.test.xml');
        fs.writeFileSync(xmlPath, '<metadata></metadata>', 'utf-8');

        getChangedFiles.mockReturnValue({
            added: [], modified: ['meta.system.sitepreference.test.xml'], deleted: []
        });
        listSitePrefMetaFiles.mockReturnValue([xmlPath]);

        execSync.mockReturnValue(
            '-    <attribute-definition attribute-id="unknownPref" type="string">\n'
        );

        const report = validateMetaChanges({
            repoPath: tmpDir,
            instanceType: 'development',
            realmPreferenceMap: new Map([['EU05', ['c_prefA']]])
        });

        expect(report.removedAttributes.unapproved).toHaveLength(1);
        expect(report.removedAttributes.unapproved[0].attributeId).toBe('unknownPref');
    });

    it('excludes reformatted attributes from removed count (tabs to spaces)', () => {
        // This is the key scenario: fixXmlIndentation changes tabs to spaces,
        // causing git diff to show the old tabbed line as '-' and new spaced line as '+'.
        // parseRemovedAttributeIds should NOT count these as removals.
        const xmlPath = path.join(tmpDir, 'meta.system.sitepreference.adyen.xml');
        fs.writeFileSync(xmlPath, '<metadata></metadata>', 'utf-8');

        getChangedFiles.mockReturnValue({
            added: [], modified: ['meta.system.sitepreference.adyen.xml'], deleted: []
        });
        listSitePrefMetaFiles.mockReturnValue([xmlPath]);

        // Simulate diff where prefA was truly removed, but Adyen_ClientKey was just reformatted
        execSync.mockReturnValue([
            '--- a/meta.system.sitepreference.adyen.xml',
            '+++ b/meta.system.sitepreference.adyen.xml',
            '-\t\t<attribute-definition attribute-id="prefA" type="string">',
            '-\t\t</attribute-definition>',
            '-\t\t<attribute-definition attribute-id="Adyen_ClientKey" type="string">',
            '+        <attribute-definition attribute-id="Adyen_ClientKey" type="string">'
        ].join('\n'));

        const report = validateMetaChanges({
            repoPath: tmpDir,
            instanceType: 'development',
            realmPreferenceMap: new Map([['EU05', ['c_prefA']]])
        });

        // prefA appears only in '-' lines → truly removed → approved
        expect(report.removedAttributes.total).toBe(1);
        expect(report.removedAttributes.approved).toBe(1);
        // Adyen_ClientKey appears in both '-' and '+' lines → reformatted, not removed
        expect(report.removedAttributes.unapproved).toEqual([]);
    });

    it('detects blacklist violations on truly removed attributes', () => {
        const xmlPath = path.join(tmpDir, 'meta.system.sitepreference.adyen.xml');
        fs.writeFileSync(xmlPath, '<metadata></metadata>', 'utf-8');

        getChangedFiles.mockReturnValue({
            added: [], modified: ['meta.system.sitepreference.adyen.xml'], deleted: []
        });
        listSitePrefMetaFiles.mockReturnValue([xmlPath]);

        isBlacklisted.mockReturnValue(true);

        // Attribute truly removed (only in '-' lines)
        execSync.mockReturnValue(
            '-    <attribute-definition attribute-id="Adyen_ClientKey" type="string">\n'
        );

        const report = validateMetaChanges({
            repoPath: tmpDir,
            instanceType: 'development',
            realmPreferenceMap: new Map()
        });

        expect(report.blacklistViolations).toHaveLength(1);
        expect(report.blacklistViolations[0].attributeId).toBe('Adyen_ClientKey');
    });

    it('does not flag blacklist violations for reformatted attributes', () => {
        const xmlPath = path.join(tmpDir, 'meta.system.sitepreference.adyen.xml');
        fs.writeFileSync(xmlPath, '<metadata></metadata>', 'utf-8');

        getChangedFiles.mockReturnValue({
            added: [], modified: ['meta.system.sitepreference.adyen.xml'], deleted: []
        });
        listSitePrefMetaFiles.mockReturnValue([xmlPath]);

        isBlacklisted.mockReturnValue(true);

        // Attribute reformatted (appears in both '-' and '+' lines)
        execSync.mockReturnValue([
            '-\t<attribute-definition attribute-id="Adyen_ClientKey" type="string">',
            '+    <attribute-definition attribute-id="Adyen_ClientKey" type="string">'
        ].join('\n'));

        const report = validateMetaChanges({
            repoPath: tmpDir,
            instanceType: 'development',
            realmPreferenceMap: new Map()
        });

        expect(report.removedAttributes.total).toBe(0);
        expect(report.blacklistViolations).toEqual([]);
    });

    it('handles mix of removed, reformatted, and approved attributes', () => {
        const xmlPath = path.join(tmpDir, 'meta.system.sitepreference.mixed.xml');
        fs.writeFileSync(xmlPath, '<metadata></metadata>', 'utf-8');

        getChangedFiles.mockReturnValue({
            added: [], modified: ['meta.system.sitepreference.mixed.xml'], deleted: []
        });
        listSitePrefMetaFiles.mockReturnValue([xmlPath]);

        // Mix: prefA truly removed (approved), prefB truly removed (unapproved),
        // prefC reformatted (should be excluded)
        execSync.mockReturnValue([
            '-    <attribute-definition attribute-id="prefA" type="string">',
            '-    <attribute-definition attribute-id="prefB" type="string">',
            '-\t<attribute-definition attribute-id="prefC" type="string">',
            '+    <attribute-definition attribute-id="prefC" type="string">'
        ].join('\n'));

        const report = validateMetaChanges({
            repoPath: tmpDir,
            instanceType: 'development',
            realmPreferenceMap: new Map([['EU05', ['c_prefA']]])
        });

        expect(report.removedAttributes.total).toBe(2);
        expect(report.removedAttributes.approved).toBe(1);
        expect(report.removedAttributes.unapproved).toHaveLength(1);
        expect(report.removedAttributes.unapproved[0].attributeId).toBe('prefB');
    });
});

// ============================================================================
// formatValidationReport
// ============================================================================

describe('formatValidationReport', () => {
    it('returns a string containing the report', () => {
        const report = {
            removedAttributes: { total: 5, approved: 5, unapproved: [] },
            blacklistViolations: [],
            createdFiles: { total: 2, valid: 2, issues: [] },
            modifiedFiles: [],
            summary: 'test summary'
        };

        const output = formatValidationReport(report);
        expect(typeof output).toBe('string');
        expect(output).toContain('test summary');
    });
});

// ============================================================================
// fixXmlIndentation
// ============================================================================

describe('fixXmlIndentation', () => {
    it('replaces tabs with spaces in changed XML files', () => {
        const xmlContent = '\t\t<attribute-definition attribute-id="test">\n\t\t</attribute-definition>';
        const xmlPath = path.join(tmpDir, 'meta', 'test.xml');
        fs.mkdirSync(path.join(tmpDir, 'meta'), { recursive: true });
        fs.writeFileSync(xmlPath, xmlContent, 'utf-8');

        getChangedFiles.mockReturnValue({
            added: [], modified: ['meta/test.xml'], deleted: []
        });

        const result = fixXmlIndentation(tmpDir);

        expect(result.fixed).toContain('meta/test.xml');
        const fixed = fs.readFileSync(xmlPath, 'utf-8');
        expect(fixed).not.toContain('\t');
        expect(fixed).toContain('        <attribute-definition');
    });

    it('skips files with no tabs', () => {
        const xmlContent = '    <attribute-definition attribute-id="test"/>';
        const xmlPath = path.join(tmpDir, 'meta', 'clean.xml');
        fs.mkdirSync(path.join(tmpDir, 'meta'), { recursive: true });
        fs.writeFileSync(xmlPath, xmlContent, 'utf-8');

        getChangedFiles.mockReturnValue({
            added: [], modified: ['meta/clean.xml'], deleted: []
        });

        const result = fixXmlIndentation(tmpDir);

        expect(result.fixed).toHaveLength(0);
    });
});
