import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    normalizeId,
    isValueKey,
    buildMeta,
    buildAttributeMatrix,
    processSitesAndGroups
} from '../../src/helpers/summarize.js';

vi.mock('../../src/api/api.js', () => ({
    getSiteById: vi.fn(),
    getSitePreferencesGroup: vi.fn()
}));

vi.mock('../../src/helpers/batch.js', () => ({
    processBatch: vi.fn()
}));

vi.mock('../../src/helpers/timer.js', () => ({
    startTimer: vi.fn(() => ({ stop: () => '1.2s' }))
}));

import { getSiteById, getSitePreferencesGroup } from '../../src/api/api.js';
import { processBatch } from '../../src/helpers/batch.js';

// ============================================================================
// normalizeId
// ============================================================================

describe('normalizeId', () => {
    it('strips c_ prefix from custom attribute IDs', () => {
        expect(normalizeId('c_myPreference')).toBe('myPreference');
    });

    it('leaves non-prefixed IDs unchanged', () => {
        expect(normalizeId('myPreference')).toBe('myPreference');
    });

    it('only strips leading c_ (not mid-string)', () => {
        expect(normalizeId('some_c_value')).toBe('some_c_value');
    });

    it('handles null/undefined gracefully', () => {
        expect(normalizeId(null)).toBeNull();
        expect(normalizeId(undefined)).toBeUndefined();
    });

    it('handles empty string', () => {
        expect(normalizeId('')).toBe('');
    });
});

// ============================================================================
// isValueKey
// ============================================================================

describe('isValueKey', () => {
    it('returns false for metadata keys', () => {
        expect(isValueKey('_v')).toBe(false);
        expect(isValueKey('_type')).toBe(false);
        expect(isValueKey('link')).toBe(false);
        expect(isValueKey('site')).toBe(false);
    });

    it('returns true for preference data keys', () => {
        expect(isValueKey('enableFeatureX')).toBe(true);
        expect(isValueKey('defaultCurrency')).toBe(true);
        expect(isValueKey('c_myPref')).toBe(true);
    });
});

// ============================================================================
// buildMeta
// ============================================================================

describe('buildMeta', () => {
    it('produces correct metadata map from full OCAPI definitions', () => {
        const definitions = [
            {
                id: 'enableSearch',
                value_type: 'boolean',
                description: 'Enable search feature',
                group_id: 'SearchSettings',
                default_value: 'true'
            },
            {
                id: 'maxResults',
                value_type: 'int',
                description: 'Maximum results',
                group_id: 'SearchSettings',
                default_value: 50
            }
        ];

        const meta = buildMeta(definitions);

        expect(meta).toHaveProperty('enableSearch');
        expect(meta.enableSearch).toEqual({
            id: 'enableSearch',
            type: 'boolean',
            description: 'Enable search feature',
            group: 'SearchSettings',
            defaultValue: 'true'
        });

        expect(meta.maxResults).toEqual({
            id: 'maxResults',
            type: 'int',
            description: 'Maximum results',
            group: 'SearchSettings',
            defaultValue: '50'
        });
    });

    it('handles missing fields gracefully (partial definitions)', () => {
        const definitions = [
            { id: 'orphanPref' }
        ];

        const meta = buildMeta(definitions);

        expect(meta.orphanPref).toEqual({
            id: 'orphanPref',
            type: undefined,
            description: null,
            group: null,
            defaultValue: null
        });
    });

    it('extracts default values from object format', () => {
        const definitions = [
            {
                id: 'colorPref',
                value_type: 'string',
                default_value: { value: 'red' }
            }
        ];

        const meta = buildMeta(definitions);
        expect(meta.colorPref.defaultValue).toBe('red');
    });

    it('uses attribute_id as fallback for id', () => {
        const definitions = [
            { attribute_id: 'fallbackId', value_type: 'string' }
        ];

        const meta = buildMeta(definitions);
        expect(meta).toHaveProperty('fallbackId');
        expect(meta.fallbackId.id).toBe('fallbackId');
    });

    it('filters out placeholder default values', () => {
        const definitions = [
            { id: 'placeholderPref', default_value: 'null' },
            { id: 'objectPlaceholder', default_value: '[object Object]' }
        ];

        const meta = buildMeta(definitions);
        expect(meta.placeholderPref.defaultValue).toBeNull();
        expect(meta.objectPlaceholder.defaultValue).toBeNull();
    });

    it('returns empty map for empty input', () => {
        expect(buildMeta([])).toEqual({});
    });
});

// ============================================================================
// buildAttributeMatrix
// ============================================================================

describe('buildAttributeMatrix', () => {
    const allPrefIds = ['prefA', 'prefB', 'prefC'];
    const allSiteIds = ['site1', 'site2'];
    const preferenceMeta = {
        prefA: { defaultValue: 'yes' },
        prefB: { defaultValue: null },
        prefC: { defaultValue: '' }
    };

    it('marks correct sites as true based on usage rows', () => {
        const usageRows = [
            { preferenceId: 'prefA', siteId: 'site1', hasValue: true },
            { preferenceId: 'prefA', siteId: 'site2', hasValue: true },
            { preferenceId: 'prefB', siteId: 'site2', hasValue: true }
        ];

        const matrix = buildAttributeMatrix(allPrefIds, allSiteIds, usageRows, preferenceMeta);

        expect(matrix[0].preferenceId).toBe('prefA');
        expect(matrix[0].sites.site1).toBe(true);
        expect(matrix[0].sites.site2).toBe(true);

        expect(matrix[1].preferenceId).toBe('prefB');
        expect(matrix[1].sites.site1).toBe(false);
        expect(matrix[1].sites.site2).toBe(true);
    });

    it('preferences with no usage rows have all sites false', () => {
        const matrix = buildAttributeMatrix(allPrefIds, allSiteIds, [], preferenceMeta);

        for (const pref of matrix) {
            for (const siteId of allSiteIds) {
                expect(pref.sites[siteId]).toBe(false);
            }
        }
    });

    it('includes defaultValue from preferenceMeta', () => {
        const matrix = buildAttributeMatrix(allPrefIds, allSiteIds, [], preferenceMeta);

        expect(matrix[0].defaultValue).toBe('yes');
        expect(matrix[1].defaultValue).toBe('');
        expect(matrix[2].defaultValue).toBe('');
    });

    it('returns one entry per preference ID', () => {
        const matrix = buildAttributeMatrix(allPrefIds, allSiteIds, [], preferenceMeta);
        expect(matrix).toHaveLength(3);
        expect(matrix.map(m => m.preferenceId)).toEqual(['prefA', 'prefB', 'prefC']);
    });

    it('ignores usageRows for unknown preference IDs', () => {
        const usageRows = [
            { preferenceId: 'unknownPref', siteId: 'site1', hasValue: true }
        ];

        const matrix = buildAttributeMatrix(allPrefIds, allSiteIds, usageRows, preferenceMeta);

        // All preferences should remain false for all sites
        for (const pref of matrix) {
            for (const siteId of allSiteIds) {
                expect(pref.sites[siteId]).toBe(false);
            }
        }
    });

    it('handles preferences with no matching meta (empty defaultValue)', () => {
        const ids = ['prefX'];
        const meta = {}; // no meta for prefX

        const matrix = buildAttributeMatrix(ids, ['site1'], [], meta);

        expect(matrix[0].defaultValue).toBe('');
    });

    it('handles multiple usageRows for same preference across different sites', () => {
        const ids = ['prefA'];
        const sites = ['site1', 'site2', 'site3'];
        const usageRows = [
            { preferenceId: 'prefA', siteId: 'site1', hasValue: true },
            { preferenceId: 'prefA', siteId: 'site3', hasValue: true }
        ];

        const matrix = buildAttributeMatrix(ids, sites, usageRows, preferenceMeta);

        expect(matrix[0].sites.site1).toBe(true);
        expect(matrix[0].sites.site2).toBe(false);
        expect(matrix[0].sites.site3).toBe(true);
    });

    it('handles empty site list', () => {
        const matrix = buildAttributeMatrix(['prefA'], [], [], preferenceMeta);

        expect(matrix).toHaveLength(1);
        expect(matrix[0].sites).toEqual({});
    });
});

// ============================================================================
// buildMeta – extended edge cases
// ============================================================================

describe('buildMeta – edge cases', () => {
    it('extracts default from object with id property (enum-type)', () => {
        const definitions = [
            { id: 'enumPref', default_value: { id: 'optionA' } }
        ];

        const meta = buildMeta(definitions);
        expect(meta.enumPref.defaultValue).toBe('optionA');
    });

    it('extracts default from boolean value', () => {
        const definitions = [
            { id: 'boolPref', default_value: false }
        ];

        const meta = buildMeta(definitions);
        expect(meta.boolPref.defaultValue).toBe('false');
    });

    it('extracts default from numeric zero', () => {
        const definitions = [
            { id: 'zeroPref', default_value: 0 }
        ];

        const meta = buildMeta(definitions);
        expect(meta.zeroPref.defaultValue).toBe('0');
    });

    it('falls back to "default" property when default_value is undefined', () => {
        const definitions = [
            { id: 'fallbackDefault', default: 'fallbackValue' }
        ];

        const meta = buildMeta(definitions);
        expect(meta.fallbackDefault.defaultValue).toBe('fallbackValue');
    });

    it('prefers default_value over default property', () => {
        const definitions = [
            { id: 'bothDefaults', default_value: 'primary', default: 'secondary' }
        ];

        const meta = buildMeta(definitions);
        expect(meta.bothDefaults.defaultValue).toBe('primary');
    });

    it('filters placeholder "object_attribute_value_definition"', () => {
        const definitions = [
            { id: 'oavd', default_value: 'object_attribute_value_definition' }
        ];

        const meta = buildMeta(definitions);
        expect(meta.oavd.defaultValue).toBeNull();
    });

    it('filters placeholder regardless of case', () => {
        const definitions = [
            { id: 'upper', default_value: 'NULL' },
            { id: 'mixed', default_value: '[Object Object]' }
        ];

        const meta = buildMeta(definitions);
        expect(meta.upper.defaultValue).toBeNull();
        expect(meta.mixed.defaultValue).toBeNull();
    });

    it('extracts value from object with non-standard properties', () => {
        const definitions = [
            { id: 'customObj', default_value: { someKey: 'someValue' } }
        ];

        const meta = buildMeta(definitions);
        expect(meta.customObj.defaultValue).toBe('someValue');
    });

    it('returns null for object with only metadata properties', () => {
        const definitions = [
            { id: 'metaOnly', default_value: { _type: 'string', _resource_state: 'active' } }
        ];

        const meta = buildMeta(definitions);
        expect(meta.metaOnly.defaultValue).toBeNull();
    });

    it('uses type as fallback for value_type', () => {
        const definitions = [
            { id: 'typeFallback', type: 'set_of_string' }
        ];

        const meta = buildMeta(definitions);
        expect(meta.typeFallback.type).toBe('set_of_string');
    });

    it('uses name as fallback for description', () => {
        const definitions = [
            { id: 'nameFallback', name: 'My Pref Name' }
        ];

        const meta = buildMeta(definitions);
        expect(meta.nameFallback.description).toBe('My Pref Name');
    });

    it('uses groupId (camelCase) as fallback for group_id', () => {
        const definitions = [
            { id: 'groupFallback', groupId: 'MyGroup' }
        ];

        const meta = buildMeta(definitions);
        expect(meta.groupFallback.group).toBe('MyGroup');
    });

    it('uses attributeId (camelCase) as fallback for id', () => {
        const definitions = [
            { attributeId: 'camelId', value_type: 'int' }
        ];

        const meta = buildMeta(definitions);
        expect(meta).toHaveProperty('camelId');
        expect(meta.camelId.id).toBe('camelId');
    });

    it('handles multiple definitions and preserves all entries', () => {
        const definitions = [
            { id: 'pref1', value_type: 'string', default_value: 'v1' },
            { id: 'pref2', value_type: 'boolean', default_value: true },
            { id: 'pref3', value_type: 'int', default_value: 42 },
            { id: 'pref4', value_type: 'enum_of_string', default_value: { id: 'opt1' } },
            { id: 'pref5' }
        ];

        const meta = buildMeta(definitions);

        expect(Object.keys(meta)).toHaveLength(5);
        expect(meta.pref1.defaultValue).toBe('v1');
        expect(meta.pref2.defaultValue).toBe('true');
        expect(meta.pref3.defaultValue).toBe('42');
        expect(meta.pref4.defaultValue).toBe('opt1');
        expect(meta.pref5.defaultValue).toBeNull();
    });

    it('returns null for object default_value where value is null', () => {
        const definitions = [
            { id: 'nullObj', default_value: { value: null } }
        ];

        const meta = buildMeta(definitions);
        expect(meta.nullObj.defaultValue).toBeNull();
    });

    it('returns null for null default_value', () => {
        const definitions = [
            { id: 'nullDirect', default_value: null }
        ];

        const meta = buildMeta(definitions);
        expect(meta.nullDirect.defaultValue).toBeNull();
    });
});

// ============================================================================
// processSitesAndGroups
// ============================================================================

describe('processSitesAndGroups', () => {
    const preferenceMeta = {
        enableSearch: { defaultValue: 'true', description: 'Enable search' },
        maxResults: { defaultValue: '10', description: 'Max results' }
    };

    beforeEach(() => {
        vi.clearAllMocks();

        // Suppress console.log during tests
        vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    it('returns empty results for empty site list', async () => {
        const result = await processSitesAndGroups(
            [], // no sites
            [{ groupId: 'Group1' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        expect(result.usageRows).toEqual([]);
        expect(result.siteSummaries).toEqual([]);
    });

    it('processes a single site with one group', async () => {
        getSiteById.mockResolvedValue({ cartridges: 'app_custom:app_base' });
        processBatch.mockResolvedValue([
            { enableSearch: true, maxResults: 25, _v: '21.3', _type: 'Object' }
        ]);

        const result = await processSitesAndGroups(
            [{ id: 'MySite' }],
            [{ groupId: 'SearchSettings' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        // Should have rows for enableSearch and maxResults (both have values)
        expect(result.usageRows).toHaveLength(2);
        expect(result.usageRows[0].siteId).toBe('MySite');
        expect(result.usageRows[0].cartridges).toBe('app_custom:app_base');

        const prefIds = result.usageRows.map(r => r.preferenceId);
        expect(prefIds).toContain('enableSearch');
        expect(prefIds).toContain('maxResults');

        expect(result.siteSummaries).toHaveLength(1);
        expect(result.siteSummaries[0].siteId).toBe('MySite');
    });

    it('normalizes c_ prefix from preference IDs in usageRows', async () => {
        getSiteById.mockResolvedValue({ cartridges: 'app_custom' });
        processBatch.mockResolvedValue([
            { c_enableSearch: true }
        ]);

        const result = await processSitesAndGroups(
            [{ id: 'site1' }],
            [{ groupId: 'Group1' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        expect(result.usageRows[0].preferenceId).toBe('enableSearch');
    });

    it('skips null, undefined, and empty-string preference values', async () => {
        getSiteById.mockResolvedValue({ cartridges: '' });
        processBatch.mockResolvedValue([
            { prefNull: null, prefUndefined: undefined, prefEmpty: '', prefReal: 'value' }
        ]);

        const result = await processSitesAndGroups(
            [{ id: 'site1' }],
            [{ groupId: 'Group1' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        // Only prefReal should produce a usage row
        expect(result.usageRows).toHaveLength(1);
        expect(result.usageRows[0].preferenceId).toBe('prefReal');
    });

    it('processes multiple sites in sequence', async () => {
        getSiteById.mockResolvedValue({ cartridges: 'app_custom' });
        processBatch.mockResolvedValue([
            { searchEnabled: true }
        ]);

        const result = await processSitesAndGroups(
            [{ id: 'site1' }, { id: 'site2' }, { id: 'site3' }],
            [{ groupId: 'Group1' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        expect(result.usageRows).toHaveLength(3); // 1 pref × 3 sites
        expect(result.siteSummaries).toHaveLength(3);
        expect(getSiteById).toHaveBeenCalledTimes(3);
    });

    it('filters metadata keys (_v, _type, link, site) from responses', async () => {
        getSiteById.mockResolvedValue({ cartridges: '' });
        processBatch.mockResolvedValue([
            { _v: '21.3', _type: 'Object', link: '/prefs', site: 'MySite', realPref: 42 }
        ]);

        const result = await processSitesAndGroups(
            [{ id: 'site1' }],
            [{ groupId: 'Group1' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        expect(result.usageRows).toHaveLength(1);
        expect(result.usageRows[0].preferenceId).toBe('realPref');
    });

    it('serializes object values to JSON string', async () => {
        getSiteById.mockResolvedValue({ cartridges: '' });
        processBatch.mockResolvedValue([
            { complexPref: { value: 'test', _type: 'custom' } }
        ]);

        const result = await processSitesAndGroups(
            [{ id: 'site1' }],
            [{ groupId: 'Group1' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        expect(result.usageRows[0].value).toBe('{"value":"test","_type":"custom"}');
    });

    it('handles multiple groups per site', async () => {
        getSiteById.mockResolvedValue({ cartridges: '' });
        processBatch.mockResolvedValue([
            { prefA: 'valA' },
            { prefB: 'valB' },
            { prefC: 'valC' }
        ]);

        const result = await processSitesAndGroups(
            [{ id: 'site1' }],
            [{ groupId: 'G1' }, { groupId: 'G2' }, { groupId: 'G3' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        expect(result.usageRows).toHaveLength(3);

        const groupIds = result.usageRows.map(r => r.groupId);
        expect(groupIds).toEqual(['G1', 'G2', 'G3']);
    });

    it('skips sites without id/site_id/siteId', async () => {
        const result = await processSitesAndGroups(
            [{ name: 'no-id-site' }],
            [{ groupId: 'Group1' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        expect(result.usageRows).toEqual([]);
        expect(result.siteSummaries).toEqual([]);
        expect(getSiteById).not.toHaveBeenCalled();
    });

    it('accepts site_id and siteId as alternate ID fields', async () => {
        getSiteById.mockResolvedValue({ cartridges: '' });
        processBatch.mockResolvedValue([{ pref1: true }]);

        const result = await processSitesAndGroups(
            [{ site_id: 'fromSnakeCase' }, { siteId: 'fromCamelCase' }],
            [{ groupId: 'G1' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        expect(result.siteSummaries).toHaveLength(2);
        expect(result.siteSummaries[0].siteId).toBe('fromSnakeCase');
        expect(result.siteSummaries[1].siteId).toBe('fromCamelCase');
    });

    it('calls progressCallback with correct indices', async () => {
        getSiteById.mockResolvedValue({ cartridges: '' });
        processBatch.mockResolvedValue([{}]);
        const progressCallback = vi.fn();

        await processSitesAndGroups(
            [{ id: 'site1' }, { id: 'site2' }],
            [{ groupId: 'G1' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta,
            progressCallback
        );

        // Called before each site + final call
        expect(progressCallback).toHaveBeenCalledWith(0, 2);
        expect(progressCallback).toHaveBeenCalledWith(1, 2);
        expect(progressCallback).toHaveBeenCalledWith(2, 2); // final
    });

    it('includes group values in site summaries', async () => {
        getSiteById.mockResolvedValue({ cartridges: '' });
        processBatch.mockResolvedValue([
            { enableSearch: true, _v: '21.3' }
        ]);

        const result = await processSitesAndGroups(
            [{ id: 'site1' }],
            [{ groupId: 'SearchSettings' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        const groupSummary = result.siteSummaries[0].groups[0];
        expect(groupSummary.groupId).toBe('SearchSettings');
        expect(groupSummary.usedPreferenceIds).toContain('enableSearch');
        expect(groupSummary.usedPreferenceIds).not.toContain('_v');
    });

    it('uses cartridgesPath as fallback from site detail', async () => {
        getSiteById.mockResolvedValue({ cartridgesPath: 'path_cartridges' });
        processBatch.mockResolvedValue([{ pref1: 'val' }]);

        const result = await processSitesAndGroups(
            [{ id: 'site1' }],
            [{ groupId: 'G1' }],
            'EU05',
            { instanceType: 'development' },
            preferenceMeta
        );

        expect(result.usageRows[0].cartridges).toBe('path_cartridges');
        expect(result.siteSummaries[0].cartridges).toBe('path_cartridges');
    });
});
