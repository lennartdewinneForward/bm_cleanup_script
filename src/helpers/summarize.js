import { getSiteById, getSitePreferencesGroup } from '../api/api.js';
import { processBatch } from './batch.js';
import { startTimer } from './timer.js';
import { IDENTIFIERS } from '../config/constants.js';

// ============================================================================
// PREFERENCE DATA HELPERS
// ============================================================================

/**
 * Normalize a preference ID by removing SFCC custom attribute prefix
 * @param {string} id - Preference ID that may have "c_" prefix
 * @returns {string} Normalized ID without "c_" prefix
 */
export function normalizeId(id) {
    return id?.startsWith(IDENTIFIERS.CUSTOM_ATTRIBUTE_PREFIX) ? id.substring(2) : id;
}

/**
 * Check if an object key represents actual preference data
 * @param {string} key - Object key to check
 * @returns {boolean} true if key represents preference data, false if metadata
 */
export function isValueKey(key) {
    return !['_v', '_type', 'link', 'site'].includes(key);
}

// ============================================================================
// HELPER FUNCTIONS
// Utility functions for preference processing
// ============================================================================

/**
 * Check if a value is a placeholder or type descriptor that should be ignored
 * @param {string} val - String value to check
 * @returns {boolean} True if value is a placeholder/descriptor
 * @private
 */
function isPlaceholder(val) {
    const lower = String(val).toLowerCase();
    return lower === 'object_attribute_value_definition' || lower === 'null' || lower === '[object object]';
}

/**
 * Extract meaningful value from primitive or object, filtering placeholders
 * @param {*} val - Value to extract (string, number, boolean, or object)
 * @returns {string|null} Extracted value or null if placeholder/invalid
 * @private
 */
function extractMeaningfulValue(val) {
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        return isPlaceholder(val) ? null : String(val);
    }

    if (typeof val === 'object' && val !== null) {
        // Try value property first
        if ('value' in val && val.value !== undefined && val.value !== null) {
            return isPlaceholder(val.value) ? null : String(val.value);
        }
        // Try id property for enum values
        if ('id' in val && val.id !== undefined && val.id !== null) {
            return isPlaceholder(val.id) ? null : String(val.id);
        }
        // Try first non-metadata property
        for (const key in val) {
            if (!['_type', '_resource_state', 'value', 'id', 'position'].includes(key) &&
                val[key] !== undefined && val[key] !== null) {
                const extracted = String(val[key]);
                return isPlaceholder(extracted) ? null : extracted;
            }
        }
    }

    return null;
}

/**
 * Build normalized preference metadata map from OCAPI attribute definitions
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {Array} attributeDefinitions - Array of OCAPI attribute definition objects
 * @returns {Object} Map of preference metadata keyed by attribute ID
 */
export function buildMeta(attributeDefinitions) {
    return attributeDefinitions.reduce((acc, def) => {
        const id = def.id || def.attribute_id || def.attributeId;
        const defaultValue = extractDefaultValue(def);

        acc[id] = {
            id,
            type: def.value_type || def.type,
            description: def.description || def.name || null,
            group: def.group_id || def.groupId || null,
            defaultValue
        };
        return acc;
    }, {});
}

/**
 * Extract and normalize default value from attribute definition
 * Handles various formats: string, number, boolean, object with value property
 * @param {Object} def - Attribute definition object
 * @returns {string|null} Normalized default value or null if none found
 */
function extractDefaultValue(def) {
    const val = def.default_value !== undefined ? def.default_value : (def.default ?? null);
    return val === null ? null : extractMeaningfulValue(val);
}


// ============================================================================
// SITE AND GROUP PROCESSING
// Fetch and aggregate preference values across sites and groups
// ============================================================================

/**
 * Build usage rows from group preference responses for a single site
 * @param {string} siteId - Site identifier
 * @param {string} cartridges - Cartridge path for the site
 * @param {Array} groupSummaries - Group objects
 * @param {Array} groupResponses - API responses for each group
 * @param {Object} preferenceMeta - Preference metadata map
 * @returns {Array} Array of usage rows for this site
 * @private
 */
function buildSiteUsageRows(siteId, cartridges, groupSummaries, groupResponses, preferenceMeta) {
    const rows = [];

    for (let i = 0; i < groupSummaries.length; i++) {
        const group = groupSummaries[i];
        const sitePrefs = groupResponses[i];
        const usedPreferenceIds = Object.keys(sitePrefs || {}).filter(isValueKey);

        for (const prefId of usedPreferenceIds) {
            const rawVal = sitePrefs[prefId];
            // Only include if value is not null, undefined, or empty string
            if (rawVal === null || rawVal === undefined || rawVal === '') continue;

            const normalizedPrefId = normalizeId(prefId);
            const safeVal = typeof rawVal === 'object' ? JSON.stringify(rawVal) : String(rawVal);
            const meta = preferenceMeta[normalizedPrefId] || {};
            rows.push({
                siteId,
                cartridges,
                groupId: group.groupId,
                preferenceId: normalizedPrefId,
                hasValue: true,
                value: safeVal,
                defaultValue: meta.defaultValue ?? '',
                description: meta.description ?? ''
            });
        }
    }

    return rows;
}

/**
 * Process all sites and attribute groups to build comprehensive usage data
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {Array} sitesToProcess - Array of site objects
 * @param {Array} groupSummaries - Array of group objects
 * @param {string} realm - Realm name
 * @param {Object} answers - User input containing instanceType field
 * @param {Object} preferenceMeta - Preference metadata map
 * @param {Function} [progressCallback] - Optional callback(currentSite, totalSites) for progress tracking
 * @returns {Promise<Object>} Object with usageRows and siteSummaries
 */
export async function processSitesAndGroups(
    sitesToProcess, groupSummaries, realm, answers, preferenceMeta, progressCallback = null, progressInfo = null
) {
    const usageRows = [];
    const siteSummaries = [];

    for (let siteIndex = 0; siteIndex < sitesToProcess.length; siteIndex++) {
        const site = sitesToProcess[siteIndex];
        const siteId = site.id || site.site_id || site.siteId;
        if (!siteId) continue;

        // Report progress before processing site
        if (progressCallback) {
            progressCallback(siteIndex, sitesToProcess.length);
        }

        console.log(`\n[${siteIndex + 1}/${sitesToProcess.length}] Processing site: ${siteId}`);

        const siteDetail = await getSiteById(siteId, realm, progressInfo);
        const cartridges = siteDetail?.cartridges || siteDetail?.cartridgesPath || siteDetail?.cartridges_path || '';

        console.log(`  - Fetching preference values across ${groupSummaries.length} group(s) in batches...`);
        const groupTimer = startTimer();

        // Fetch groups in parallel batches
        const groupResponses = await processBatch(
            groupSummaries,
            (group) => getSitePreferencesGroup(siteId, group.groupId, answers.instanceType, realm, progressInfo),
            20, // Process 20 groups in parallel
            null,
            200 // 200ms delay between batches
        );

        console.log(`  - Groups fetched in ${groupTimer.stop()}`);

        // Process fetched group data to extract attribute values
        const siteRows = buildSiteUsageRows(siteId, cartridges, groupSummaries, groupResponses, preferenceMeta);
        usageRows.push(...siteRows);

        // Build group values summary
        const groupValues = groupSummaries.map((group, i) => ({
            groupId: group.groupId,
            usedPreferenceIds: Object.keys(groupResponses[i] || {}).filter(isValueKey),
            values: groupResponses[i]
        }));

        console.log(`  ✓ Site ${siteId} complete (${siteRows.length} attributes found)`);
        siteSummaries.push({ siteId, cartridges, groups: groupValues });
    }

    // Report final progress
    if (progressCallback) {
        progressCallback(sitesToProcess.length, sitesToProcess.length);
    }

    return { usageRows, siteSummaries };
}


// ============================================================================
// ATTRIBUTE MATRIX GENERATION
// Create cross-reference matrix of all attributes across all sites
// ============================================================================

/**
 * Build boolean matrix showing which attributes are used on which sites
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {Array<string>} allAttrIds - Complete list of all attribute IDs
 * @param {Array<string>} allSiteIds - Complete list of all site IDs
 * @param {Array} usageRows - Usage rows containing actual values
 * @param {Object} attributeMeta - Attribute metadata including default values
 * @returns {Array} Array of attribute matrix objects with sites mapping
 */
export function buildAttributeMatrix(
    allAttrIds,
    allSiteIds,
    usageRows,
    attributeMeta
) {
    // Initialize matrix with all attributes having false for all sites
    const attributeMatrix = allAttrIds.map(attrId => {
        const siteValues = {};
        for (const siteId of allSiteIds) {
            siteValues[siteId] = false;
        }
        return {
            preferenceId: attrId,
            defaultValue: attributeMeta[attrId]?.defaultValue || '',
            sites: siteValues
        };
    });

    // Mark hasValue=true for attributes that have explicit values
    for (const row of usageRows) {
        const attrEntry = attributeMatrix.find(p => p.preferenceId === row.preferenceId);
        if (attrEntry) {
            attrEntry.sites[row.siteId] = true;
        }
    }

    return attributeMatrix;
}
