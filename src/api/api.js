import axios from 'axios';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { withLoadShedding, processBatch } from '../helpers/batch.js';
import { getSandboxConfig, getInstanceType } from '../config/helpers/helpers.js';

/**
 * Resolve instance type: use explicit value if provided, otherwise look it up from config.
 * @param {string} realm - Realm name
 * @param {string} [instanceType] - Optional explicit instance type
 * @returns {string} Resolved instance type
 * @private
 */
function resolveInstanceType(realm, instanceType) {
    return instanceType || getInstanceType(realm);
}
import { logError, logRateLimitCountdown } from '../scripts/loggingScript/log.js';
import { loadCachedBackup } from '../io/backupUtils.js';
import { getApiConfig, LOG_PREFIX } from '../config/constants.js';

/* eslint-disable no-undef */

// ============================================================================
// API REQUEST HELPERS
// Common patterns for OCAPI requests
// ============================================================================

/**
 * Build standard authorization headers for OCAPI requests
 * @param {string} token - OAuth bearer token
 * @param {string} [ifMatch] - Optional If-Match header for PATCH/PUT operations
 * @returns {Object} Headers object with authorization
 * @private
 */
function buildApiHeaders(token, ifMatch = null) {
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };
    if (ifMatch !== null) {
        headers['If-Match'] = ifMatch;
    }
    return headers;
}

/**
 * Transient error codes that justify an automatic retry
 * @type {string[]}
 * @private
 */
const RETRYABLE_CODES = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN'];

/**
 * Execute an async function with automatic retry on transient network errors.
 * Uses exponential back-off (1 s → 2 s → 4 s …).
 * @param {Function} fn - Async function to execute
 * @param {number} [maxRetries=2] - Maximum number of retries (0 = no retry)
 * @returns {Promise<*>} Result of fn()
 * @private
 */
async function withRetry(fn, maxRetries = 2) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            const code = error.code || error.cause?.code || '';
            const isRetryable = RETRYABLE_CODES.includes(code);

            if (!isRetryable || attempt >= maxRetries) {
                throw error;
            }

            const delay = 1000 * Math.pow(2, attempt);
            console.log(
                `${LOG_PREFIX.WARNING} ${code} on attempt ${attempt + 1} — `
                + `retrying in ${delay / 1000}s…`
            );
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

/**
 * Execute an OCAPI request method, using HTTP method override for logical PUT.
 * B2C Commerce blocks direct PUT for staging/production; using POST +
 * x-dw-http-method-override keeps calls portable across all environments.
 * @param {string} url - Request URL
 * @param {'patch'|'put'|'delete'} method - Logical HTTP method
 * @param {Object|null} payload - Request payload (if applicable)
 * @param {Object} headers - Request headers
 * @param {string} instanceType - Instance type (sandbox, development, staging, production).
 *   When 'sandbox' or 'development', uses direct PUT. When 'staging' or 'production',
 *   applies POST + x-dw-http-method-override workaround.
 * @returns {Promise<Object>} Axios response
 * @private
 */
async function executeOcapiWrite(url, method, payload, headers, instanceType) {
    // Staging / production block direct PUT – use POST + x-dw-http-method-override.
    // Development / sandbox accept direct PUT so the override is unnecessary.
    const needsOverride = ['staging', 'production'].includes(instanceType);

    return withRetry(async () => {
        const methodLower = method.toLowerCase();

        if (methodLower === 'put') {
            if (needsOverride) {
                const urlObj = new URL(url);
                urlObj.searchParams.set('method', 'PUT');

                const overrideHeaders = {
                    ...headers,
                    'x-dw-http-method-override': 'PUT',
                    'X-DW-HTTP-Method-Override': 'PUT'
                };

                const hasPayload = payload !== null && payload !== undefined;
                const body = hasPayload ? payload : '';

                if (!hasPayload) {
                    overrideHeaders['Content-Length'] = '0';
                }

                return axios.post(urlObj.toString(), body, { headers: overrideHeaders });
            }

            // Direct PUT for development / sandbox
            const config = { headers };
            if (payload === null || payload === undefined) {
                return axios.put(url, '', { ...config, headers: { ...headers, 'Content-Length': '0' } });
            }
            return axios.put(url, payload, config);
        }

        if (methodLower === 'patch') {
            return axios.patch(url, payload, { headers });
        }

        if (methodLower === 'delete') {
            return axios.delete(url, { headers });
        }

        throw new Error(`Unsupported write method: ${method}`);
    });
}

/**
 * Fetch data from an API endpoint with pagination support
 * @param {string} baseUrl - Base URL for pagination requests
 * @param {string} token - OAuth bearer token
 * @param {number} batchSize - Items per page (default 200)
 * @returns {Promise<Array>} All fetched items
 * @private
 */
async function paginatedApiFetch(baseUrl, token, batchSize = 200, progressCallback = null) {
    const allItems = [];
    const headers = buildApiHeaders(token);
    let start = 0;
    let total = 0;

    do {
        const url = `${baseUrl}?start=${start}&count=${batchSize}`;
        const response = await axios.get(url, { headers });

        const items = response.data.data || [];
        total = response.data.total || items.length;

        allItems.push(...items);
        start += items.length;

        // Call progress callback if provided
        if (progressCallback && total > 0) {
            progressCallback(allItems.length, total);
        }

        if (items.length === 0 || allItems.length >= total) {
            break;
        }
    } while (allItems.length < total);

    return allItems;
}

// ============================================================================
// OAUTH AUTHENTICATION
// Handle OAuth token generation for OCAPI access
// ============================================================================

/**
 * Obtain OAuth 2.0 access token for OCAPI requests
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {Object} sandbox - Sandbox configuration object
 * @returns {Promise<string>} OAuth bearer token
 */
export async function getOAuthToken(sandbox, progressInfo = null) {
    const tokenUrl = 'https://account.demandware.com/dwsso/oauth2/access_token';
    const credentials = Buffer.from(`${sandbox.clientId}:${sandbox.clientSecret}`).toString('base64');

    return withLoadShedding(
        async () => {
            const response = await axios.post(
                tokenUrl,
                new URLSearchParams({
                    grant_type: 'client_credentials'
                }).toString(),
                {
                    headers: {
                        'Authorization': `Basic ${credentials}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }
            );
            return response.data.access_token;
        },
        {
            maxRetries: 3,
            onRetry: (attempt, delay) => {
                if (progressInfo?.display && progressInfo?.hostname) {
                    const seconds = Math.ceil(delay / 1000);
                    progressInfo.display.setStepMessage(
                        progressInfo.hostname,
                        progressInfo.stepKey || 'fetch',
                        `Auth rate limited, retry ${attempt}/3 in ${seconds}s`,
                        'warn'
                    );
                    setTimeout(() => {
                        if (progressInfo?.display && progressInfo?.hostname) {
                            progressInfo.display.clearStepMessage(
                                progressInfo.hostname,
                                progressInfo.stepKey || 'fetch'
                            );
                        }
                    }, delay);
                } else {
                    logRateLimitCountdown(delay, attempt);
                }
            }
        }
    );
}

// ============================================================================
// JOB EXECUTION
// Trigger and poll SFCC job executions
// ============================================================================

/**
 * Trigger a job execution in Business Manager
 * @param {string} jobId - Job ID
 * @param {string} realm - Realm name
 * @param {string} ocapiVersion - OCAPI version (e.g., "v25_6")
 * @returns {Promise<Object|null>} Job execution response
 */
export async function triggerJobExecution(jobId, realm, ocapiVersion = 'v25_6') {
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox);
        const url = `https://${sandbox.hostname}/s/-/dw/data/${ocapiVersion}/jobs/${encodeURIComponent(jobId)}/executions`;
        const headers = buildApiHeaders(token);
        const response = await axios.post(url, {}, { headers });
        return response.data;
    } catch (error) {
        logError(`Failed to trigger job ${jobId} on ${realm}: ${error.response?.status || ''} ${error.response?.data?.message || error.message}`);
        return null;
    }
}

/**
 * Get status of a job execution
 * @param {string} jobId - Job ID
 * @param {string} executionId - Job execution ID
 * @param {string} realm - Realm name
 * @param {string} ocapiVersion - OCAPI version (e.g., "v25_6")
 * @returns {Promise<Object|null>} Job execution status
 */
export async function getJobExecutionStatus(jobId, executionId, realm, ocapiVersion = 'v25_6') {
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox);
        const url = `https://${sandbox.hostname}/s/-/dw/data/${ocapiVersion}/jobs/${encodeURIComponent(jobId)}/executions/${encodeURIComponent(executionId)}`;
        const headers = buildApiHeaders(token);
        const response = await axios.get(url, { headers });
        return response.data;
    } catch (error) {
        logError(`Failed to fetch job status for ${jobId}: ${error.response?.data?.message || error.message}`);
        return null;
    }
}

/**
 * Download file from WebDAV
 * @param {Object} webdavConfig - WebDAV config
 * @param {string} outputDir - Local output directory
 * @param {string} [outputFileName] - Override the downloaded file name (avoids collisions in parallel)
 * @returns {Promise<string|null>} Local file path
 */
export async function downloadWebdavFile(webdavConfig, outputDir, outputFileName = null) {
    try {
        const { hostname, username, password, filePath } = webdavConfig;
        if (!hostname || !filePath) {
            throw new Error('WebDAV hostname and file path are required');
        }
        if (!username || !password) {
            throw new Error('WebDAV username and password are required');
        }

        const url = `https://${hostname}${filePath}`;
        const fileName = outputFileName || path.basename(filePath);
        const outputPath = path.join(outputDir, fileName);

        await fsPromises.mkdir(outputDir, { recursive: true });

        const response = await axios.get(url, {
            auth: { username, password },
            responseType: 'stream',
            validateStatus: (status) => status >= 200 && status < 300
        });

        await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(outputPath);
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Verify the file was actually written
        const stat = await fsPromises.stat(outputPath);
        if (stat.size === 0) {
            throw new Error('Downloaded file is empty (0 bytes)');
        }

        return outputPath;
    } catch (error) {
        logError(`Failed to download WebDAV file: ${error.message}`);
        return null;
    }
}

// ============================================================================
// SITE MANAGEMENT
// Retrieve and manage SFCC site configurations
// ============================================================================

/**
 * Fetch all sites configured in the SFCC instance
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {Object} sandbox - Sandbox configuration object
 * @returns {Promise<Array>} Array of site objects
 */
export async function getAllSites(realm, progressInfo = null) {
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox, progressInfo);
        const url = `https://${sandbox.hostname}/s/-/dw/data/v19_5/sites`;
        const headers = buildApiHeaders(token);
        const response = await axios.get(url, { headers });
        const sites = response.data.data || [];
        console.log(`Found ${sites.length} sites`);
        return sites;
    } catch (error) {
        logError(`Failed to fetch sites: ${error.response?.data?.message || error.message}`);
        return [];
    }
}

/**
 * Retrieve detailed configuration for a specific site
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} siteId - Site identifier
 * @param {Object} sandbox - Sandbox configuration object
 * @returns {Promise<Object|null>} Site object with full configuration
 */
export async function getSiteById(siteId, realm, progressInfo = null) {
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox, progressInfo);
        const url = `https://${sandbox.hostname}/s/-/dw/data/v19_5/sites/${encodeURIComponent(siteId)}`;
        const headers = buildApiHeaders(token);
        const response = await axios.get(url, { headers });
        return response.data;
    } catch (error) {
        logError(`Failed to fetch site ${siteId}: ${error.response?.data?.message || error.message}`);
        return null;
    }
}

// ============================================================================
// PREFERENCE ATTRIBUTES
// Retrieve system object attribute definitions
// ============================================================================

/**
 * Fetch detailed attribute definitions with progress tracking
 * @param {Array} allAttributes - Basic attribute list
 * @param {string} objectType - Object type
 * @param {string} realm - Realm name
 * @param {Object} sandbox - Sandbox configuration
 * @param {Function} [progressCallback] - Optional callback(currentCount, totalCount) for batch progress
 * @param {Object} [progressInfo] - Optional {display, hostname} for rate limit warnings
 * @returns {Promise<Array>} Detailed attribute definitions
 */
async function fetchDetailedAttributes(
    allAttributes, objectType, realm, sandbox,
    progressCallback = null, progressInfo = null
) {
    console.log('\nFetching full details with default values (parallel batches)...');
    const startTime = Date.now();
    const apiConfig = getApiConfig();
    let processedCount = 0;

    const detailedAttributes = await withLoadShedding(
        async () => {
            return await processBatch(
                allAttributes,
                async (attr) => {
                    const detailProgressInfo = progressInfo
                        ? { ...progressInfo, stepKey: 'details' }
                        : null;
                    const result = await getAttributeDefinitionById(objectType, attr.id, realm, detailProgressInfo);
                    processedCount += 1;
                    if (progressCallback) {
                        progressCallback(processedCount, allAttributes.length);
                    }
                    return result;
                },
                apiConfig.batchSize,
                null,
                apiConfig.batchDelayMs
            );
        },
        {
            maxRetries: 2,
            onRetry: (attempt, delay) => {
                if (progressInfo?.display && progressInfo?.hostname) {
                    const seconds = Math.ceil(delay / 1000);
                    progressInfo.display.setStepMessage(
                        progressInfo.hostname,
                        'details',
                        `Rate limited, retry ${attempt}/2 in ${seconds}s`,
                        'warn'
                    );
                    setTimeout(() => {
                        if (progressInfo?.display && progressInfo?.hostname) {
                            progressInfo.display.clearStepMessage(progressInfo.hostname, 'details');
                        }
                    }, delay);
                } else {
                    logRateLimitCountdown(delay, attempt, `batch of ${allAttributes.length} attributes`);
                }
            }
        }
    );

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`Completed fetching ${detailedAttributes.length} attributes with full details (${duration}s)`);

    return detailedAttributes;
}

/**
 * Fetch all attribute definitions for a system object type with pagination
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} objectType - SFCC system object type (e.g., "SitePreferences")
 * @param {string} realm - Realm name
 * @param {boolean} includeDefaults - If true, fetch each attribute individually to get default_value
 * @param {boolean} [useCachedBackup] - If true, use cached backup; if false, fetch fresh; if undefined, always fetch
 * @param {Function} [progressCallback] - Optional callback(currentCount, totalCount) for pagination progress
 * @param {Function} [detailProgressCallback] - Optional callback(currentCount, totalCount) for detail fetch progress
 * @param {Object} [progressInfo] - Optional {display, hostname} for rate limit warnings
 * @returns {Promise<Array>} Array of attribute definition objects
 */
export async function getSitePreferences(
    objectType,
    realm,
    includeDefaults = false,
    useCachedBackup = undefined,
    progressCallback = null,
    detailProgressCallback = null,
    progressInfo = null
) {
    try {
        const sandbox = getSandboxConfig(realm);

        // Try to use cached backup if requested and available
        if (includeDefaults && useCachedBackup === true) {
            const cachedAttributes = await loadCachedBackup(realm, sandbox.instanceType, objectType);
            if (cachedAttributes) {
                console.log(`\n✓ Using cached backup for ${realm} (skipping API fetch).\n`);
                return cachedAttributes;
            }
            // If cache requested but not available, fall through to fetch
            console.log(`\n⚠ Cached backup not found for ${realm}, fetching fresh data...\n`);
        }

        // Fetch basic attribute list
        const startTime = Date.now();
        const token = await getOAuthToken(sandbox, progressInfo);
        const baseUrl = `https://${sandbox.hostname}/s/-/dw/data/v19_5/system_object_definitions/${objectType}/attribute_definitions`;
        const allAttributes = await paginatedApiFetch(baseUrl, token, 200, progressCallback);

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`Found ${allAttributes.length} total attributes for ${objectType} (${duration}s)`);

        // Return basic list if defaults not needed
        if (!includeDefaults) {
            return allAttributes;
        }

        // Fetch detailed attributes with default values
        const detailedAttributes = await fetchDetailedAttributes(
            allAttributes,
            objectType,
            realm,
            sandbox,
            detailProgressCallback,
            progressInfo
        );

        return detailedAttributes;
    } catch (error) {
        logError(`Failed to fetch site preferences: ${error.response?.data?.message || error.message}`);
        return [];
    }
}

/**
 * Fetch a single attribute definition by ID
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} objectType - SFCC system object type (e.g., "SitePreferences")
 * @param {string} attributeId - Attribute ID to retrieve
 * @param {Object} sandbox - Sandbox configuration object
 * @param {Object} [progressInfo] - Optional progress tracking info
 * @param {Object} [options] - Optional settings
 * @param {boolean} [options.silent] - Suppress error logging (e.g. when 404 is expected)
 * @returns {Promise<Object|null>} Single attribute definition object with full details including default_value
 */
export async function getAttributeDefinitionById(
    objectType, attributeId, realm, progressInfo = null, { silent = false } = {}
) {
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox, progressInfo);
        const url = `https://${sandbox.hostname}/s/-/dw/data/v25_6/system_object_definitions/${objectType}/attribute_definitions/${encodeURIComponent(attributeId)}`;
        const headers = buildApiHeaders(token);
        const response = await axios.get(url, { headers });
        return response.data;
    } catch (error) {
        if (!silent) {
            logError(
                `Failed to fetch attribute ${attributeId}: `
                + `${error.response?.data?.message || error.message}`
            );
        }
        return null;
    }
}

/**
 * Update/modify an attribute definition by ID with specified HTTP method
 * @param {string} objectType - SFCC system object type (e.g., "SitePreferences")
 * @param {string} attributeId - Attribute ID to update/delete
 * @param {string} method - HTTP method: 'patch' | 'put' | 'delete'
 * @param {Object} [payload] - Request payload (optional for delete method)
 * @param {string} realm - Realm name
 * @returns {Promise<Object|boolean|null>} Response data or boolean for delete
 */
export async function updateAttributeDefinitionById(
    objectType, attributeId, method, payload, realm, instanceType = null
) {
    const methodLower = method.toLowerCase();
    const resolved = resolveInstanceType(realm, instanceType);
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox);
        const url = `https://${sandbox.hostname}/s/-/dw/data/v25_6/system_object_definitions/${objectType}/attribute_definitions/${encodeURIComponent(attributeId)}`;

        let response;
        switch (methodLower) {
        case 'patch':
        case 'put': {
            // For PATCH/PUT, try to fetch the current attribute to get its ETag (for updates)
            // silent: true because a 404 is expected when creating a new attribute via PUT
            const currentAttr = await getAttributeDefinitionById(
                objectType, attributeId, realm, null, { silent: true }
            );
            let headers;
            if (currentAttr && currentAttr._resource_state) {
                // Attribute exists - use ETag for update
                headers = buildApiHeaders(token, currentAttr._resource_state);
            } else {
                // Attribute doesn't exist - create without ETag (for PUT creation)
                headers = buildApiHeaders(token);
            }
            response = await executeOcapiWrite(url, methodLower, payload, headers, resolved);
            return response.data;
        }
        case 'delete': {
            const headers = buildApiHeaders(token);
            await executeOcapiWrite(url, methodLower, null, headers, resolved);
            return true;
        }
        default:
            logError(`Unsupported method: ${method}. Use 'patch', 'put', or 'delete'.`);
            return null;
        }
    } catch (error) {
        const status = error.response?.status;
        const sandbox = getSandboxConfig(realm);

        if (status === 403) {
            console.log(
                `${LOG_PREFIX.WARNING} Permission denied for ${method.toUpperCase()} attribute ${attributeId}`
                + ` in realm ${realm}.`
            );
            console.log(
                `${LOG_PREFIX.WARNING} Client for host ${sandbox.hostname} must allow `
                + 'PUT and POST on /system_object_definitions/*/attribute_definitions/* '
                + '(POST is required for method override).'
            );
            return methodLower === 'delete' ? false : null;
        }

        logError(`Failed to ${method} attribute ${attributeId}: ${error.response?.data?.message || error.message}`);
        console.error('Full error response:', error.response?.data || error);
        return methodLower === 'delete' ? false : null;
    }
}

/**
 * Patch (partial update) an attribute definition by ID
 * @param {string} objectType - SFCC system object type (e.g., "SitePreferences")
 * @param {string} attributeId - Attribute ID to update
 * @param {Object} payload - Partial update payload
 * @param {string} realm - Realm name
 * @returns {Promise<Object|null>} Updated attribute definition
 */
export async function patchAttributeDefinitionById(objectType, attributeId, payload, realm) {
    return updateAttributeDefinitionById(objectType, attributeId, 'patch', payload, realm);
}

/**
 * Replace (full update) an attribute definition by ID
 * @param {string} objectType - SFCC system object type (e.g., "SitePreferences")
 * @param {string} attributeId - Attribute ID to update
 * @param {Object} payload - Full update payload
 * @param {string} realm - Realm name
 * @returns {Promise<Object|null>} Updated attribute definition
 */
export async function putAttributeDefinitionById(objectType, attributeId, payload, realm) {
    return updateAttributeDefinitionById(objectType, attributeId, 'put', payload, realm);
}

/**
 * Delete an attribute definition by ID
 * @param {string} objectType - SFCC system object type (e.g., "SitePreferences")
 * @param {string} attributeId - Attribute ID to delete
 * @param {string} realm - Realm name
 * @returns {Promise<boolean>} True if deleted successfully
 */
export async function deleteAttributeDefinitionById(objectType, attributeId, realm) {
    return updateAttributeDefinitionById(objectType, attributeId, 'delete', null, realm);
}

// ============================================================================
// ATTRIBUTE GROUPS
// Manage attribute group definitions and membership
// ============================================================================

/**
 * Fetch all attribute groups for a system object type with pagination
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} objectType - SFCC system object type (e.g., "SitePreferences")
 * @param {Object} sandbox - Sandbox configuration object
 * @returns {Promise<Array>} Array of attribute group objects
 */
export async function getAttributeGroups(objectType, realm, progressCallback = null, progressInfo = null) {
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox, progressInfo);
        const baseUrl = `https://${sandbox.hostname}/s/-/dw/data/v25_6/system_object_definitions/${objectType}/attribute_groups`;
        const allGroups = await paginatedApiFetch(baseUrl, token, 200, progressCallback);
        console.log(`Found ${allGroups.length} total attribute groups for ${objectType}`);
        return allGroups;
    } catch (error) {
        logError(`Failed to fetch attribute groups: ${error.response?.data?.message || error.message}`);
        return [];
    }
}

/**
 * Fetch a single attribute group by ID with full details including attribute_definitions
 * @param {string} objectType - SFCC system object type (e.g., "SitePreferences")
 * @param {string} groupId - Attribute group ID to retrieve
 * @param {string} realm - Realm name
 * @returns {Promise<Object|null>} Attribute group object with full details
 */
export async function getAttributeGroupById(objectType, groupId, realm) {
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox);
        const url = `https://${sandbox.hostname}/s/-/dw/data/v25_6/system_object_definitions/${objectType}/attribute_groups/${encodeURIComponent(groupId)}`;
        const headers = buildApiHeaders(token);
        const response = await axios.get(url, { headers });
        return response.data;
    } catch (error) {
        const status = error.response?.status;

        // 404 is expected when checking if a group exists — not an error
        if (status === 404) {
            return null;
        }

        const msg = error.response?.data?.message || error.message;
        logError(`Failed to fetch attribute group ${groupId}: ${msg}`);
        console.error('Full error response:', error.response?.data || error);
        return null;
    }
}

/**
 * Create or update an attribute group via PUT (idempotent)
 * @param {string} objectType - SFCC system object type (e.g., "SitePreferences")
 * @param {string} groupId - Attribute group ID to create/update
 * @param {Object} groupPayload - Group body (e.g., { display_name: { default: "..." } })
 * @param {string} realm - Realm name
 * @returns {Promise<Object|null>} Created/updated group object, or null on failure
 */
export async function createOrUpdateAttributeGroup(
    objectType, groupId, groupPayload, realm, instanceType = null
) {
    const resolved = resolveInstanceType(realm, instanceType);
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox);
        const url = `https://${sandbox.hostname}/s/-/dw/data/v25_6/system_object_definitions/${objectType}/attribute_groups/${encodeURIComponent(groupId)}`;
        const headers = buildApiHeaders(token);
        const response = await executeOcapiWrite(url, 'put', groupPayload, headers, resolved);
        return response?.data || true;
    } catch (error) {
        const msg = error.response?.data?.message || error.message;
        logError(`Failed to create/update attribute group ${groupId}: ${msg}`);
        console.error('Full error response:', error.response?.data || error);
        return null;
    }
}

/**
 * Assign an attribute definition to an attribute group
 * @param {string} objectType - SFCC system object type (e.g., "SitePreferences")
 * @param {string} groupId - Attribute group ID to assign to
 * @param {string} attributeId - Attribute definition ID to assign
 * @param {string} realm - Realm name
 * @returns {Promise<Object|boolean|null>} Assignment response, true on empty-success, or null on failure
 */
export async function assignAttributeToGroup(objectType, groupId, attributeId, realm, instanceType = null) {
    const resolved = resolveInstanceType(realm, instanceType);
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox);
        const url = `https://${sandbox.hostname}/s/-/dw/data/v25_6/system_object_definitions/${objectType}/attribute_groups/${encodeURIComponent(groupId)}/attribute_definitions/${encodeURIComponent(attributeId)}`;
        const headers = buildApiHeaders(token);
        const response = await executeOcapiWrite(url, 'put', null, headers, resolved);
        return response?.data || true;
    } catch (error) {
        const status = error.response?.status;
        const sandbox = getSandboxConfig(realm);
        const msg = error.response?.data?.message || error.message;

        if (status === 403) {
            console.log(
                `${LOG_PREFIX.WARNING} Permission denied assigning attribute ${attributeId} `
                + `to group ${groupId} in realm ${realm}.`
            );
            console.log(
                `${LOG_PREFIX.WARNING} Client for host ${sandbox.hostname} must allow `
                + 'PUT on /system_object_definitions/*/attribute_groups/*/attribute_definitions/*.'
            );
            return null;
        }

        // SFCC returns 400 (or 409) when the attribute is already assigned to the group.
        // The error message varies by SFCC version — may say "already", "is a member",
        // or use fault type "AttributeGroupAttributeDefinitionAlreadyExistException".
        // Treat any of these as success — the assignment exists, which is the desired state.
        const msgLower = msg?.toLowerCase() || '';
        const faultType = error.response?.data?.fault?.type || '';
        const isAlreadyAssigned = (status === 400 || status === 409)
            && (msgLower.includes('already')
                || msgLower.includes('is a member')
                || msgLower.includes('already exist')
                || msgLower.includes('member of')
                || faultType.toLowerCase().includes('alreadyexist')
                || faultType.toLowerCase().includes('attributegroupattributedefinition'));

        if (isAlreadyAssigned) {
            return true;
        }

        logError(`Failed to assign attribute ${attributeId} to group ${groupId}: ${msg}`);
        console.error('Full error response:', error.response?.data || error);
        return null;
    }
}

// ============================================================================
// PREFERENCE SEARCH
// Query and retrieve actual preference values from sites
// ============================================================================

/**
 * Get site preference values for a specific group on a specific site
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} siteId - Site identifier
 * @param {string} groupId - Attribute group identifier
 * @param {string} instanceType - Instance type for preference scope
 * @param {Object} sandbox - Sandbox configuration object
 * @returns {Promise<Object|null>} Preference group object with values
 */
export async function getSitePreferencesGroup(siteId, groupId, instanceType, realm, progressInfo = null) {
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox, progressInfo);
        const url = `https://${sandbox.hostname}/s/-/dw/data/v25_6/sites/${encodeURIComponent(siteId)}/site_preferences/preference_groups/${encodeURIComponent(groupId)}/${encodeURIComponent(instanceType)}`;
        const headers = buildApiHeaders(token);
        const response = await axios.get(url, { headers });
        return response.data;
    } catch (error) {
        const msg = error.response?.data?.message || error.message;
        logError(`Failed to fetch site preferences for group ${groupId}: ${msg}`);
        return null;
    }
}

/**
 * Patch site preference values for a specific group on a specific site
 * @param {string} siteId - Site identifier
 * @param {string} groupId - Attribute group identifier
 * @param {string} instanceType - Instance type for preference scope
 * @param {Object} payload - Preference values to update (e.g., {"c_myPref": "value"})
 * @param {string} realm - Realm name
 * @returns {Promise<Object|null>} Updated preference group object
 */
export async function patchSitePreferencesGroup(siteId, groupId, instanceType, payload, realm) {
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox);
        const url = `https://${sandbox.hostname}/s/-/dw/data/v25_6/sites/${encodeURIComponent(siteId)}/site_preferences/preference_groups/${encodeURIComponent(groupId)}/${encodeURIComponent(instanceType)}`;
        const headers = buildApiHeaders(token);
        const resolved = resolveInstanceType(realm, instanceType);
        const response = await executeOcapiWrite(url, 'patch', payload, headers, resolved);
        return response.data;
    } catch (error) {
        const msg = error.response?.data?.message || error.message;
        logError(`Failed to patch site preferences for group ${groupId}: ${msg}`);
        console.error('Full error response:', error.response?.data || error);
        return null;
    }
}

// ============================================================================
// CUSTOM OBJECTS
// Search custom object instances by type
// ============================================================================

/**
 * Check whether any custom object records exist for a given type.
 * Uses POST /custom_objects_search/{object_type} with count=1.
 * @param {string} objectType - Custom object type ID
 * @param {string} realm - Realm name
 * @returns {Promise<{ exists: boolean, total: number }>} Whether records exist and the total count
 */
export async function searchCustomObjects(objectType, realm) {
    try {
        const sandbox = getSandboxConfig(realm);
        const token = await getOAuthToken(sandbox);
        const url = `https://${sandbox.hostname}/s/-/dw/data/v25_6/custom_objects_search/${encodeURIComponent(objectType)}`;
        const headers = buildApiHeaders(token);
        const payload = {
            query: { match_all_query: {} },
            start: 0,
            count: 1
        };
        const response = await withRetry(() => axios.post(url, payload, { headers }));
        const total = response.data.total || 0;
        return { exists: total > 0, total };
    } catch (error) {
        const status = error.response?.status;
        // 404 means the type doesn't exist on the instance — no records
        if (status === 404) {
            return { exists: false, total: 0 };
        }
        logError(
            `Failed to search custom objects for type ${objectType}: `
            + `${error.response?.data?.message || error.message}`
        );
        return { exists: false, total: 0, error: true };
    }
}
