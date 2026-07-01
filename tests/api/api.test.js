import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('axios', () => {
    const mockAxios = {
        get: vi.fn(),
        post: vi.fn(),
        put: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn()
    };
    return { default: mockAxios };
});

vi.mock('../../src/helpers/batch.js', () => ({
    withLoadShedding: vi.fn(async (fn) => fn()),
    processBatch: vi.fn(async (items, fn) => {
        const results = [];
        for (const item of items) {
            results.push(await fn(item));
        }
        return results;
    })
}));

vi.mock('../../src/config/helpers/helpers.js', () => ({
    getSandboxConfig: vi.fn((realm) => ({
        hostname: `${realm.toLowerCase()}.sandbox.example.com`,
        clientId: 'test-client-id',
        clientSecret: 'test-client-secret',
        instanceType: 'development'
    })),
    getInstanceType: vi.fn(() => 'development')
}));

vi.mock('../../src/scripts/loggingScript/log.js', () => ({
    logError: vi.fn(),
    logRateLimitCountdown: vi.fn()
}));

vi.mock('../../src/io/backupUtils.js', () => ({
    loadCachedBackup: vi.fn()
}));

vi.mock('../../src/config/constants.js', () => ({
    getApiConfig: vi.fn(() => ({
        batchSize: 5,
        batchDelayMs: 0
    })),
    LOG_PREFIX: {
        WARNING: '[WARN]',
        INFO: '[INFO]',
        ERROR: '[ERROR]'
    }
}));

import axios from 'axios';
import { withLoadShedding, processBatch } from '../../src/helpers/batch.js';
import { getSandboxConfig, getInstanceType } from '../../src/config/helpers/helpers.js';
import { logError } from '../../src/scripts/loggingScript/log.js';
import { loadCachedBackup } from '../../src/io/backupUtils.js';

import {
    getOAuthToken,
    triggerJobExecution,
    getJobExecutionStatus,
    downloadWebdavFile,
    getAllSites,
    getSiteById,
    getSitePreferences,
    getAttributeDefinitionById,
    updateAttributeDefinitionById,
    patchAttributeDefinitionById,
    putAttributeDefinitionById,
    deleteAttributeDefinitionById,
    getAttributeGroups,
    getAttributeGroupById,
    createOrUpdateAttributeGroup,
    assignAttributeToGroup,
    getSitePreferencesGroup,
    patchSitePreferencesGroup
} from '../../src/api/api.js';

let tmpDir;

beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
});

afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

// ============================================================================
// getOAuthToken
// ============================================================================

describe('getOAuthToken', () => {
    it('returns access token on success', async () => {
        axios.post.mockResolvedValue({
            data: { access_token: 'mock-token-123' }
        });

        const token = await getOAuthToken({
            clientId: 'my-client',
            clientSecret: 'my-secret'
        });

        expect(token).toBe('mock-token-123');
        expect(axios.post).toHaveBeenCalledWith(
            'https://account.demandware.com/dwsso/oauth2/access_token',
            expect.any(String),
            expect.objectContaining({
                headers: expect.objectContaining({
                    'Content-Type': 'application/x-www-form-urlencoded'
                })
            })
        );
    });

    it('uses withLoadShedding for rate limit handling', async () => {
        axios.post.mockResolvedValue({
            data: { access_token: 'token' }
        });

        await getOAuthToken({ clientId: 'c', clientSecret: 's' });

        expect(withLoadShedding).toHaveBeenCalled();
    });
});

// ============================================================================
// triggerJobExecution
// ============================================================================

describe('triggerJobExecution', () => {
    it('triggers job and returns response data', async () => {
        axios.post.mockResolvedValueOnce({
            data: { access_token: 'token' }
        });
        axios.post.mockResolvedValueOnce({
            data: { execution_id: 'exec-1', status: 'PENDING' }
        });

        const result = await triggerJobExecution('backup-job', 'EU05');

        expect(result).toEqual({ execution_id: 'exec-1', status: 'PENDING' });
    });

    it('returns null on failure', async () => {
        axios.post.mockResolvedValueOnce({
            data: { access_token: 'token' }
        });
        axios.post.mockRejectedValueOnce(new Error('Job trigger failed'));

        const result = await triggerJobExecution('bad-job', 'EU05');

        expect(result).toBeNull();
        expect(logError).toHaveBeenCalled();
    });
});

// ============================================================================
// getJobExecutionStatus
// ============================================================================

describe('getJobExecutionStatus', () => {
    it('returns job status on success', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({
            data: { execution_id: 'exec-1', status: 'OK' }
        });

        const result = await getJobExecutionStatus('backup-job', 'exec-1', 'EU05');

        expect(result).toEqual({ execution_id: 'exec-1', status: 'OK' });
    });

    it('returns null on failure', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockRejectedValue(new Error('Status check failed'));

        const result = await getJobExecutionStatus('bad-job', 'exec-1', 'EU05');

        expect(result).toBeNull();
    });
});

// ============================================================================
// downloadWebdavFile
// ============================================================================

describe('downloadWebdavFile', () => {
    it('throws error when hostname is missing', async () => {
        const result = await downloadWebdavFile(
            { hostname: '', filePath: '/path' },
            tmpDir,
            null,
            'EU05'
        );

        expect(result).toBeNull();
        expect(logError).toHaveBeenCalledWith(
            expect.stringContaining('WebDAV hostname and file path are required')
        );
    });

    it('returns null when realm is missing', async () => {
        const result = await downloadWebdavFile(
            { hostname: 'host.com', filePath: '/path' },
            tmpDir
        );

        expect(result).toBeNull();
        expect(logError).toHaveBeenCalledWith(
            expect.stringContaining('Realm is required for WebDAV authentication')
        );
    });

    it('downloads file and returns path on success', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'mock-token' } });
        const mockData = {
            pipe: vi.fn((writer) => {
                writer.write('file content');
                writer.end();
            })
        };
        axios.get.mockResolvedValue({
            data: mockData
        });

        const result = await downloadWebdavFile(
            { hostname: 'host.com', filePath: '/webdav/test.xml' },
            tmpDir,
            null,
            'EU05'
        );

        expect(result).toContain('test.xml');
        const fileExists = fs.existsSync(result);
        expect(fileExists).toBe(true);
    });

    it('uses custom output filename when provided', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'mock-token' } });
        const mockData = {
            pipe: vi.fn((writer) => {
                writer.write('file content');
                writer.end();
            })
        };
        axios.get.mockResolvedValue({
            data: mockData
        });

        const result = await downloadWebdavFile(
            { hostname: 'host.com', filePath: '/webdav/original.xml' },
            tmpDir,
            'custom_name.xml',
            'EU05'
        );

        expect(result).toContain('custom_name.xml');
    });

    it('returns null when downloaded file is empty', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'mock-token' } });
        const mockData = {
            pipe: vi.fn((writer) => {
                // Write nothing — create empty file
                writer.end();
            })
        };
        axios.get.mockResolvedValue({
            data: mockData
        });

        const result = await downloadWebdavFile(
            { hostname: 'host.com', filePath: '/webdav/empty.xml' },
            tmpDir,
            null,
            'EU05'
        );

        expect(result).toBeNull();
        expect(logError).toHaveBeenCalledWith(
            expect.stringContaining('Downloaded file is empty')
        );
    });
});

// ============================================================================
// getAllSites
// ============================================================================

describe('getAllSites', () => {
    it('returns array of sites on success', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({
            data: { data: [{ id: 'site1' }, { id: 'site2' }] }
        });

        const result = await getAllSites('EU05');

        expect(result).toHaveLength(2);
        expect(result[0].id).toBe('site1');
    });

    it('returns empty array on failure', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockRejectedValue(new Error('Network error'));

        const result = await getAllSites('EU05');

        expect(result).toEqual([]);
        expect(logError).toHaveBeenCalled();
    });

    it('returns empty array when response has no data', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({ data: {} });

        const result = await getAllSites('EU05');

        expect(result).toEqual([]);
    });
});

// ============================================================================
// getSiteById
// ============================================================================

describe('getSiteById', () => {
    it('returns site object on success', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({
            data: { id: 'mySite', display_name: 'My Site' }
        });

        const result = await getSiteById('mySite', 'EU05');

        expect(result).toEqual({ id: 'mySite', display_name: 'My Site' });
    });

    it('returns null on failure', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockRejectedValue(new Error('Not found'));

        const result = await getSiteById('badSite', 'EU05');

        expect(result).toBeNull();
    });
});

// ============================================================================
// getSitePreferences
// ============================================================================

describe('getSitePreferences', () => {
    it('returns basic attribute list when includeDefaults is false', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        // paginatedApiFetch uses axios.get internally
        axios.get.mockResolvedValue({
            data: { data: [{ id: 'c_pref1' }, { id: 'c_pref2' }], total: 2 }
        });

        const result = await getSitePreferences('SitePreferences', 'EU05', false);

        expect(result).toHaveLength(2);
    });

    it('returns empty array on failure', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockRejectedValue(new Error('API failure'));

        const result = await getSitePreferences('SitePreferences', 'EU05');

        expect(result).toEqual([]);
    });

    it('uses cached backup when useCachedBackup is true and cache exists', async () => {
        const cachedData = [{ id: 'c_cached1' }, { id: 'c_cached2' }];
        loadCachedBackup.mockResolvedValue(cachedData);

        const result = await getSitePreferences(
            'SitePreferences', 'EU05', true, true
        );

        expect(result).toEqual(cachedData);
        expect(axios.post).not.toHaveBeenCalled();
    });

    it('falls through to API when cache requested but not available', async () => {
        loadCachedBackup.mockResolvedValue(null);
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({
            data: { data: [{ id: 'c_fresh' }], total: 1 }
        });

        const result = await getSitePreferences(
            'SitePreferences', 'EU05', true, true
        );

        // Should have fetched from API since cache was null
        expect(axios.post).toHaveBeenCalled();
    });

    it('fetches detailed attributes when includeDefaults is true', async () => {
        loadCachedBackup.mockResolvedValue(null);
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        // First call: paginated fetch returns basic list
        axios.get
            .mockResolvedValueOnce({
                data: { data: [{ id: 'c_pref1' }], total: 1 }
            })
            // Second call: getAttributeDefinitionById for detailed fetch
            .mockResolvedValueOnce({
                data: { id: 'c_pref1', default_value: 'val' }
            });

        const result = await getSitePreferences(
            'SitePreferences', 'EU05', true, false
        );

        expect(result).toHaveLength(1);
    });
});

// ============================================================================
// getAttributeDefinitionById
// ============================================================================

describe('getAttributeDefinitionById', () => {
    it('returns attribute definition on success', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({
            data: { id: 'c_myPref', type: 'string', default_value: 'test' }
        });

        const result = await getAttributeDefinitionById(
            'SitePreferences', 'c_myPref', 'EU05'
        );

        expect(result).toEqual({ id: 'c_myPref', type: 'string', default_value: 'test' });
    });

    it('returns null and logs error on failure', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockRejectedValue(new Error('Not found'));

        const result = await getAttributeDefinitionById(
            'SitePreferences', 'c_missing', 'EU05'
        );

        expect(result).toBeNull();
        expect(logError).toHaveBeenCalled();
    });

    it('suppresses error logging when silent is true', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockRejectedValue(new Error('Not found'));

        const result = await getAttributeDefinitionById(
            'SitePreferences', 'c_missing', 'EU05', null, { silent: true }
        );

        expect(result).toBeNull();
        expect(logError).not.toHaveBeenCalled();
    });
});

// ============================================================================
// updateAttributeDefinitionById
// ============================================================================

describe('updateAttributeDefinitionById', () => {
    it('handles PATCH with existing attribute ETag', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        // First GET returns existing attribute with resource state
        axios.get.mockResolvedValue({
            data: { id: 'c_pref', _resource_state: 'etag-123' }
        });
        axios.patch.mockResolvedValue({
            data: { id: 'c_pref', updated: true }
        });

        const result = await updateAttributeDefinitionById(
            'SitePreferences', 'c_pref', 'patch', { type: 'int' }, 'EU05'
        );

        expect(result).toEqual({ id: 'c_pref', updated: true });
    });

    it('handles DELETE method', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.delete.mockResolvedValue({ status: 204 });

        const result = await updateAttributeDefinitionById(
            'SitePreferences', 'c_pref', 'delete', null, 'EU05'
        );

        expect(result).toBe(true);
    });

    it('returns null for unsupported method', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });

        const result = await updateAttributeDefinitionById(
            'SitePreferences', 'c_pref', 'OPTIONS', null, 'EU05'
        );

        expect(result).toBeNull();
    });

    it('returns false for delete on 403 permission error', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        const error = new Error('Forbidden');
        error.response = { status: 403, data: { message: 'Access denied' } };
        axios.delete.mockRejectedValue(error);

        const result = await updateAttributeDefinitionById(
            'SitePreferences', 'c_pref', 'delete', null, 'EU05'
        );

        expect(result).toBe(false);
    });

    it('returns null for PATCH on 403 permission error', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({
            data: { id: 'c_pref', _resource_state: 'etag-123' }
        });
        const error = new Error('Forbidden');
        error.response = { status: 403, data: { message: 'Access denied' } };
        axios.patch.mockRejectedValue(error);

        const result = await updateAttributeDefinitionById(
            'SitePreferences', 'c_pref', 'PATCH', { type: 'int' }, 'EU05'
        );

        expect(result).toBeNull();
    });

    it('handles PUT without existing attribute (no ETag)', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        // getAttributeDefinitionById returns null (attribute doesn't exist)
        axios.get.mockRejectedValue(new Error('Not found'));
        axios.put.mockResolvedValue({
            data: { id: 'c_new_pref', type: 'string' }
        });

        const result = await updateAttributeDefinitionById(
            'SitePreferences', 'c_new_pref', 'put', { type: 'string' }, 'EU05'
        );

        expect(result).toEqual({ id: 'c_new_pref', type: 'string' });
    });

    it('returns false for delete on generic error', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.delete.mockRejectedValue(new Error('Network error'));

        const result = await updateAttributeDefinitionById(
            'SitePreferences', 'c_pref', 'delete', null, 'EU05'
        );

        expect(result).toBe(false);
    });
});

// ============================================================================
// patchAttributeDefinitionById
// ============================================================================

describe('patchAttributeDefinitionById', () => {
    it('delegates to updateAttributeDefinitionById with PATCH method', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({
            data: { id: 'c_pref', _resource_state: 'etag' }
        });
        axios.patch.mockResolvedValue({
            data: { id: 'c_pref', patched: true }
        });

        const result = await patchAttributeDefinitionById(
            'SitePreferences', 'c_pref', { type: 'int' }, 'EU05'
        );

        expect(result).toEqual({ id: 'c_pref', patched: true });
    });
});

// ============================================================================
// putAttributeDefinitionById
// ============================================================================

describe('putAttributeDefinitionById', () => {
    it('delegates to updateAttributeDefinitionById with PUT method', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({
            data: { id: 'c_pref', _resource_state: 'etag' }
        });
        axios.put.mockResolvedValue({
            data: { id: 'c_pref', replaced: true }
        });

        const result = await putAttributeDefinitionById(
            'SitePreferences', 'c_pref', { type: 'int' }, 'EU05'
        );

        expect(result).toEqual({ id: 'c_pref', replaced: true });
    });
});

// ============================================================================
// deleteAttributeDefinitionById
// ============================================================================

describe('deleteAttributeDefinitionById', () => {
    it('delegates to updateAttributeDefinitionById with DELETE method', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.delete.mockResolvedValue({ status: 204 });

        const result = await deleteAttributeDefinitionById(
            'SitePreferences', 'c_pref', 'EU05'
        );

        expect(result).toBe(true);
    });
});

// ============================================================================
// getAttributeGroups
// ============================================================================

describe('getAttributeGroups', () => {
    it('returns attribute groups on success', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({
            data: {
                data: [{ id: 'group1' }, { id: 'group2' }],
                total: 2
            }
        });

        const result = await getAttributeGroups('SitePreferences', 'EU05');

        expect(result).toHaveLength(2);
    });

    it('returns empty array on failure', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockRejectedValue(new Error('API error'));

        const result = await getAttributeGroups('SitePreferences', 'EU05');

        expect(result).toEqual([]);
    });
});

// ============================================================================
// getAttributeGroupById
// ============================================================================

describe('getAttributeGroupById', () => {
    it('returns attribute group details on success', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({
            data: { id: 'group1', attribute_definitions: [] }
        });

        const result = await getAttributeGroupById('SitePreferences', 'group1', 'EU05');

        expect(result).toEqual({ id: 'group1', attribute_definitions: [] });
    });

    it('returns null on failure', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockRejectedValue(new Error('Not found'));

        const result = await getAttributeGroupById('SitePreferences', 'missing', 'EU05');

        expect(result).toBeNull();
    });
});

// ============================================================================
// createOrUpdateAttributeGroup
// ============================================================================

describe('createOrUpdateAttributeGroup', () => {
    it('creates/updates group via PUT and returns response', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.put.mockResolvedValue({
            data: { id: 'group1', display_name: { default: 'Test' } }
        });

        const result = await createOrUpdateAttributeGroup(
            'SitePreferences',
            'group1',
            { display_name: { default: 'Test' } },
            'EU05'
        );

        expect(result).toEqual({ id: 'group1', display_name: { default: 'Test' } });
    });

    it('returns null on failure', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.put.mockRejectedValue(new Error('Create failed'));

        const result = await createOrUpdateAttributeGroup(
            'SitePreferences', 'group1', {}, 'EU05'
        );

        expect(result).toBeNull();
    });
});

// ============================================================================
// assignAttributeToGroup
// ============================================================================

describe('assignAttributeToGroup', () => {
    it('assigns attribute to group and returns response', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.put.mockResolvedValue({
            data: { id: 'c_pref', group: 'group1' }
        });

        const result = await assignAttributeToGroup(
            'SitePreferences', 'group1', 'c_pref', 'EU05'
        );

        expect(result).toEqual({ id: 'c_pref', group: 'group1' });
    });

    it('returns null on 403 permission error', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        const error = new Error('Forbidden');
        error.response = { status: 403, data: { message: 'Access denied' } };
        axios.put.mockRejectedValue(error);

        const result = await assignAttributeToGroup(
            'SitePreferences', 'group1', 'c_pref', 'EU05'
        );

        expect(result).toBeNull();
    });

    it('returns null on generic error', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.put.mockRejectedValue(new Error('Network error'));

        const result = await assignAttributeToGroup(
            'SitePreferences', 'group1', 'c_pref', 'EU05'
        );

        expect(result).toBeNull();
    });
});

// ============================================================================
// getSitePreferencesGroup
// ============================================================================

describe('getSitePreferencesGroup', () => {
    it('returns preference group values on success', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockResolvedValue({
            data: { c_enableFeature: true, c_maxRetries: 3 }
        });

        const result = await getSitePreferencesGroup(
            'mySite', 'GlobalPreferences', 'development', 'EU05'
        );

        expect(result).toEqual({ c_enableFeature: true, c_maxRetries: 3 });
    });

    it('returns null on failure', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.get.mockRejectedValue(new Error('Not found'));

        const result = await getSitePreferencesGroup(
            'mySite', 'missing', 'development', 'EU05'
        );

        expect(result).toBeNull();
    });
});

// ============================================================================
// patchSitePreferencesGroup
// ============================================================================

describe('patchSitePreferencesGroup', () => {
    it('patches preference values and returns response', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.patch.mockResolvedValue({
            data: { c_enableFeature: false }
        });

        const result = await patchSitePreferencesGroup(
            'mySite', 'GlobalPreferences', 'development',
            { c_enableFeature: false },
            'EU05'
        );

        expect(result).toEqual({ c_enableFeature: false });
    });

    it('returns null on failure', async () => {
        axios.post.mockResolvedValue({ data: { access_token: 'token' } });
        axios.patch.mockRejectedValue(new Error('Patch failed'));

        const result = await patchSitePreferencesGroup(
            'mySite', 'GlobalPreferences', 'development', {}, 'EU05'
        );

        expect(result).toBeNull();
    });
});
