import fs from 'fs';
import path from 'path';
import { parseString } from 'xml2js';
import { ensureResultsDir } from './util.js';
import { SEPARATOR, LOG_PREFIX, FILE_PATTERNS } from '../config/constants.js';
import { logError } from '../scripts/loggingScript/log.js';

/**
 * Find all site.xml files in a site templates directory
 * @param {string} repoPath - Path to the repository
 * @param {string} siteTemplatesPath - Relative path to site templates (e.g., "sites/site_template_bcwr080")
 * @returns {Promise<Array<Object>>} Array of site.xml file information
 */

/**
 * Extract cartridges from custom-cartridges XML element
 * @param {*} customCartridges - The custom-cartridges element from parsed XML
 * @returns {Object} Object with cartridges array and cartridgePath string
 * @private
 */
function extractCartridgesFromXml(customCartridges) {
    const cartridges = [];
    let cartridgePath = '';

    // Check if it's a string (colon-separated list)
    if (typeof customCartridges === 'string') {
        cartridgePath = customCartridges;
        cartridges.push(
            ...customCartridges
                .split(':')
                .map(c => c.trim())
                .filter(c => c.length > 0)
        );
    }
    // Check if it contains cartridge elements
    else if (customCartridges.cartridge) {
        const cartridgeElements = Array.isArray(customCartridges.cartridge)
            ? customCartridges.cartridge
            : [customCartridges.cartridge];

        for (const cart of cartridgeElements) {
            if (typeof cart === 'string') {
                cartridges.push(cart.trim());
            } else if (cart._) {
                cartridges.push(cart._.trim());
            }
        }
        cartridgePath = cartridges.join(':');
    }

    return { cartridges, cartridgePath };
}

/**
 * Find all site.xml files in a site templates directory
 * @param {string} repoPath - Path to the repository
 * @param {string} siteTemplatesPath - Relative path to site templates (e.g., "sites/site_template_bcwr080")
 * @returns {Promise<Array<Object>>} Array of site.xml file information
 */
export async function findSiteXmlFiles(repoPath, siteTemplatesPath) {
    const siteXmlFiles = [];
    const fullSiteTemplatesPath = path.join(repoPath, siteTemplatesPath);
    const sitesDir = path.join(fullSiteTemplatesPath, 'sites');

    if (!fs.existsSync(fullSiteTemplatesPath)) {
        console.log(`[!] Site templates path not found: ${fullSiteTemplatesPath}`);
        return siteXmlFiles;
    }

    if (!fs.existsSync(sitesDir)) {
        console.log(`[!] Sites directory not found: ${sitesDir}`);
        return siteXmlFiles;
    }

    // Read all site locale directories
    const siteLocales = fs.readdirSync(sitesDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

    for (const localeDir of siteLocales) {
        const siteXmlPath = path.join(sitesDir, localeDir.name, 'site.xml');

        if (fs.existsSync(siteXmlPath)) {
            siteXmlFiles.push({
                siteLocale: localeDir.name,
                filePath: siteXmlPath,
                relativePath: path.relative(repoPath, siteXmlPath)
            });
        }
    }

    return siteXmlFiles;
}

/**
 * Parse site.xml and extract cartridge path
 * @param {string} siteXmlPath - Full path to site.xml file
 * @returns {Promise<Object>} Parsed site data including cartridges
 */
export async function parseSiteXml(siteXmlPath) {
    return new Promise((resolve, reject) => {
        const xmlContent = fs.readFileSync(siteXmlPath, 'utf-8');

        parseString(xmlContent, (err, result) => {
            if (err) {
                reject(err);
                return;
            }

            try {
                const site = result.site;
                const siteId = site.$?.['site-id'] || 'Unknown';
                const customCartridges = site['custom-cartridges']?.[0];
                const { cartridges, cartridgePath } = customCartridges
                    ? extractCartridgesFromXml(customCartridges)
                    : { cartridges: [], cartridgePath: '' };

                resolve({
                    siteId,
                    cartridgePath,
                    cartridges,
                    raw: result
                });
            } catch (parseError) {
                reject(parseError);
            }
        });
    });
}

/**
 * Compare site.xml cartridges with live SFCC cartridges
 * @param {Array<string>} xmlCartridges - Cartridges from site.xml
 * @param {Array<string>} liveCartridges - Cartridges from SFCC API
 * @returns {Object} Comparison result
 */
export function compareSiteXmlWithLive(xmlCartridges, liveCartridges) {
    const xmlSet = new Set(xmlCartridges);
    const liveSet = new Set(liveCartridges);
    const matching = xmlCartridges.filter(c => liveSet.has(c));
    const onlyInXml = xmlCartridges.filter(c => !liveSet.has(c));
    const onlyInLive = liveCartridges.filter(c => !xmlSet.has(c));
    const isMatch = onlyInXml.length === 0 && onlyInLive.length === 0;

    return {
        matching,
        onlyInXml,
        onlyInLive,
        isMatch,
        xmlCount: xmlCartridges.length,
        liveCount: liveCartridges.length
    };
}

/**
 * Format site.xml comparison results for display
 * @param {string} siteId - Site identifier
 * @param {Object} comparison - Comparison result from compareSiteXmlWithLive
 * @param {string} xmlFilePath - Path to site.xml file
 * @returns {string} Formatted display string
 */

/**
 * Write validation results to file with error handling
 * @param {string} filePath - Absolute path to output file
 * @param {string} content - File content to write
 * @private
 */
function writeSiteXmlValidationFile(filePath, content) {
    try {
        fs.writeFileSync(filePath, content, 'utf-8');
        console.log(`Site XML validation report written to ${filePath}`);
    } catch (error) {
        logError(`Failed to write site XML validation report ${filePath}: ${error.message}`);
        throw error;
    }
}
export function formatSiteXmlComparison(siteId, comparison, xmlFilePath) {
    const lines = [];
    const status = comparison.isMatch ? '[OK] MATCH' : '[X] MISMATCH';

    lines.push(`\n=== Site: ${siteId} ===`);
    lines.push(`XML File: ${xmlFilePath}`);
    lines.push(`Status: ${status}`);
    lines.push(`XML Cartridges: ${comparison.xmlCount} | Live Cartridges: ${comparison.liveCount}`);

    if (!comparison.isMatch) {
        if (comparison.onlyInXml.length > 0) {
            lines.push(`\n[!] In XML but NOT on live (${comparison.onlyInXml.length}):`);
            for (const c of comparison.onlyInXml) {
                lines.push(`    - ${c}`);
            }
        }

        if (comparison.onlyInLive.length > 0) {
            lines.push(`\n[!] On live but NOT in XML (${comparison.onlyInLive.length}):`);
            for (const c of comparison.onlyInLive) {
                lines.push(`    - ${c}`);
            }
        }
    }

    return lines.join('\n') + '\n';
}

/**
 * Parse multiple site.xml files and compare each against live SFCC cartridge paths
 * @param {Array<Object>} siteXmlFiles - Array of site.xml file objects with filePath, relativePath
 * @param {Object} liveSitesMap - Map of siteId → cartridges array from live SFCC
 * @returns {Promise<Array<Object>>} Array of comparison results per site
 */
export async function parseAndCompareSiteXmls(siteXmlFiles, liveSitesMap) {
    const comparisons = [];

    for (const xmlFile of siteXmlFiles) {
        try {
            const xmlData = await parseSiteXml(xmlFile.filePath);
            console.log(`[${xmlData.siteId}] Parsed ${xmlFile.relativePath}`);

            if (!liveSitesMap[xmlData.siteId]) {
                console.log(`  ${LOG_PREFIX.WARNING} Site "${xmlData.siteId}" not found on live SFCC`);
                continue;
            }

            const comparison = compareSiteXmlWithLive(
                xmlData.cartridges,
                liveSitesMap[xmlData.siteId]
            );

            comparisons.push({
                siteId: xmlData.siteId,
                xmlFile: xmlFile.relativePath,
                comparison
            });

            const status = comparison.isMatch
                ? `${LOG_PREFIX.INFO} Match`
                : `${LOG_PREFIX.ERROR} Mismatch`;
            console.log(`  ${status}`);
        } catch (error) {
            console.log(`  ${LOG_PREFIX.ERROR} Error parsing ${xmlFile.relativePath}: ${error.message}`);
        }
    }

    return comparisons;
}

/**
 * Export site.xml comparison results to file
 * @param {Array<Object>} comparisons - Array of comparison results
 * @param {string} realm - Realm name
 * @returns {Promise<string>} Path to written file
 */
export async function exportSiteXmlComparison(comparisons, realm) {
    const resultsDir = ensureResultsDir(realm);
    const filePath = path.join(resultsDir, `${realm}${FILE_PATTERNS.SITE_XML_VALIDATION}`);
    const matchCount = comparisons.filter(c => c.comparison.isMatch).length;
    const mismatchCount = comparisons.length - matchCount;

    const lines = [
        SEPARATOR,
        'SITE.XML VALIDATION REPORT',
        SEPARATOR
    ];

    for (const comp of comparisons) {
        lines.push(formatSiteXmlComparison(comp.siteId, comp.comparison, comp.xmlFile));
    }

    lines.push(SEPARATOR);
    lines.push('SUMMARY');
    lines.push(SEPARATOR);
    lines.push(`Total Sites Validated: ${comparisons.length}`);
    lines.push(`Matching: ${matchCount}`);
    lines.push(`Mismatched: ${mismatchCount}`);

    const content = lines.join('\n');

    writeSiteXmlValidationFile(filePath, content);

    return filePath;
}

/**
 * Parse XML content into JavaScript object
 * @param {string} xmlContent - Raw XML content
 * @returns {Promise<Object>} Parsed XML object
 * @private
 */
async function parseXmlContent(xmlContent) {
    return new Promise((resolve, reject) => {
        parseString(xmlContent, (err, result) => {
            if (err) reject(err);
            else resolve(result);
        });
    });
}

/**
 * Extract attribute groups from parsed meta.xml structure
 * @param {Object} parsedXml - Parsed XML object
 * @returns {Array<Object>} Array of attribute groups with their attributes
 * @private
 */
function extractAttributeGroupsFromMeta(parsedXml) {
    const groups = [];

    try {
        // Navigate XML structure: metadata > type-extension > group-definitions > attribute-group
        const metadata = parsedXml.metadata;
        if (!metadata || !metadata['type-extension']) {
            return groups;
        }

        const typeExtension = Array.isArray(metadata['type-extension'])
            ? metadata['type-extension'][0]
            : metadata['type-extension'];

        groups.push(...extractAttributeGroupsFromTypeExtension(typeExtension));
    } catch (error) {
        logError(`Failed to extract attribute groups from XML: ${error.message}`);
    }

    return groups;
}

/**
 * Extract attribute groups from a single type-extension node
 * @param {Object} typeExtension - Parsed XML type-extension node
 * @returns {Array<Object>} Array of attribute groups
 * @private
 */
function extractAttributeGroupsFromTypeExtension(typeExtension) {
    const groups = [];

    if (!typeExtension || !typeExtension['group-definitions']) {
        return groups;
    }

    const groupDefinitions = typeExtension['group-definitions'][0];
    if (!groupDefinitions || !groupDefinitions['attribute-group']) {
        return groups;
    }

    const attributeGroups = Array.isArray(groupDefinitions['attribute-group'])
        ? groupDefinitions['attribute-group']
        : [groupDefinitions['attribute-group']];

    for (const group of attributeGroups) {
        const groupId = group.$?.['group-id'];
        const groupDisplayName = group['display-name']?.[0]?.['_'] || groupId;

        const attributes = Array.isArray(group.attribute)
            ? group.attribute
            : (group.attribute ? [group.attribute] : []);

        const attributeIds = attributes
            .map(attr => attr.$?.['attribute-id'])
            .filter(id => id)
            .map(id => id.replace(/^c_/, '')); // Normalize by removing c_ prefix

        if (groupId && attributeIds.length > 0) {
            groups.push({
                group_id: groupId,
                group_display_name: groupDisplayName,
                attributes: attributeIds
            });
        }
    }

    return groups;
}

/**
 * Read attribute group definitions for a specific type from a metadata backup XML
 * @param {string} metadataFilePath - Path to meta_data_backup.xml
 * @param {string} objectType - SFCC system object type (e.g., "SitePreferences")
 * @returns {Promise<Array<Object>>} Array of attribute groups
 */
export async function getAttributeGroupsFromMetadataFile(metadataFilePath, objectType) {
    if (!fs.existsSync(metadataFilePath)) {
        logError(`Metadata file not found: ${metadataFilePath}`);
        return [];
    }

    try {
        const xmlContent = fs.readFileSync(metadataFilePath, 'utf-8');
        const parsed = await parseXmlContent(xmlContent);
        const metadata = parsed.metadata;

        if (!metadata || !metadata['type-extension']) {
            logError('Metadata XML missing type-extension nodes');
            return [];
        }

        const typeExtensions = Array.isArray(metadata['type-extension'])
            ? metadata['type-extension']
            : [metadata['type-extension']];

        const matching = typeExtensions.filter(ext => ext.$?.['type-id'] === objectType);
        if (matching.length === 0) {
            logError(`No type-extension found for type-id '${objectType}' in metadata file`);
            return [];
        }

        const groups = [];
        for (const ext of matching) {
            groups.push(...extractAttributeGroupsFromTypeExtension(ext));
        }

        return groups;
    } catch (error) {
        logError(`Failed to parse metadata file: ${error.message}`);
        return [];
    }
}

/**
 * Get all meta.xml files from a repository's sites directory
 * @param {string} repoPath - Path to the repository
 * @returns {Array<{path: string, siteFolder: string}>} Array of meta file paths
 * @private
 */
function findMetaXmlFiles(repoPath) {
    const metaFiles = [];
    const sitesDir = path.join(repoPath, 'sites');

    if (!fs.existsSync(sitesDir)) {
        logError(`Sites directory not found: ${sitesDir}`);
        return metaFiles;
    }

    try {
        const siteSubdirs = fs.readdirSync(sitesDir, { withFileTypes: true })
            .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'));

        for (const subdir of siteSubdirs) {
            const metaDir = path.join(sitesDir, subdir.name, 'meta');

            if (!fs.existsSync(metaDir)) {
                continue;
            }

            const xmlFiles = fs.readdirSync(metaDir)
                .filter(file => file.endsWith('.xml'))
                .map(file => ({
                    path: path.join(metaDir, file),
                    siteFolder: subdir.name
                }));

            metaFiles.push(...xmlFiles);
        }
    } catch (error) {
        logError(`Error scanning sites directory ${sitesDir}: ${error.message}`);
    }

    return metaFiles;
}

/**
 * Fetch attribute group assignments from local meta.xml files
 * Returns same structure as OCAPI getAttributeGroups but from local files
 * @param {string} repoPath - Path to the repository
 * @param {Array<string>} attributeIds - Filter to only include these attribute IDs
 * @returns {Promise<Array<Object>>} Array of group objects with assigned attributes
 */
export async function fetchAttributeGroupsFromMeta(repoPath, attributeIds) {
    const attributeIdSet = new Set(attributeIds);
    const groupMap = new Map();
    const metaFiles = findMetaXmlFiles(repoPath);

    if (metaFiles.length === 0) {
        console.log('[!] No meta.xml files found in repository');
        return [];
    }

    console.log(`Scanning ${metaFiles.length} meta.xml file(s) for attribute group assignments...`);

    for (const { path: metaFilePath, siteFolder } of metaFiles) {
        try {
            const xmlContent = fs.readFileSync(metaFilePath, 'utf-8');
            const parsed = await parseXmlContent(xmlContent);
            const groups = extractAttributeGroupsFromMeta(parsed);

            // Merge groups across files, collecting all attributes
            for (const group of groups) {
                const filteredAttributes = group.attributes.filter(id => attributeIdSet.has(id));

                if (filteredAttributes.length > 0) {
                    if (!groupMap.has(group.group_id)) {
                        groupMap.set(group.group_id, {
                            group_id: group.group_id,
                            group_display_name: group.group_display_name,
                            attributes: new Set()
                        });
                    }

                    const existingGroup = groupMap.get(group.group_id);
                    filteredAttributes.forEach(attr => existingGroup.attributes.add(attr));
                }
            }
        } catch (error) {
            logError(`Failed to parse ${path.basename(metaFilePath)} in ${siteFolder}: ${error.message}`);
            console.log(`   File: ${metaFilePath}`);
            console.log('   Skipping this file and continuing...');
        }
    }

    // Convert Map to array and Set to array
    const groupAssignments = Array.from(groupMap.values()).map(group => ({
        group_id: group.group_id,
        group_display_name: group.group_display_name,
        attributes: Array.from(group.attributes)
    }));

    console.log(`Found ${groupAssignments.length} group(s) with matching attributes`);

    return groupAssignments;
}

/**
 * Search for a specific attribute in meta.xml files and return which groups contain it
 * @param {string} repoPath - Path to the sibling repository
 * @param {string} attributeId - Attribute ID to search for
 * @returns {Promise<Array<Object>>} Array of results with file paths and group IDs
 */
export async function findAttributeInMetaFiles(repoPath, attributeId) {
    const results = [];
    const metaFiles = findMetaXmlFiles(repoPath);

    if (metaFiles.length === 0) {
        console.log('[!] No meta.xml files found in repository');
        return results;
    }

    for (const { path: metaFilePath, siteFolder } of metaFiles) {
        try {
            const xmlContent = fs.readFileSync(metaFilePath, 'utf-8');
            const parsed = await parseXmlContent(xmlContent);
            const groups = extractAttributeGroupsFromMeta(parsed);

            for (const group of groups) {
                const hasAttribute = group.attributes.includes(attributeId) ||
                                   group.attributes.includes(`c_${attributeId}`);

                if (hasAttribute) {
                    results.push({
                        filePath: metaFilePath,
                        relativePath: path.relative(repoPath, metaFilePath),
                        siteFolder,
                        groupId: group.group_id,
                        fileName: path.basename(metaFilePath)
                    });
                }
            }
        } catch (error) {
            logError(`Failed to parse ${path.basename(metaFilePath)} in ${siteFolder}: ${error.message}`);
            console.log(`   File: ${metaFilePath}`);
            console.log('   Skipping this file and continuing...');
        }
    }

    return results;
}

/**
 * Extract all type-ids (type-extension type-id attributes) from a metadata backup XML
 * Useful for discovering all object types defined in a metadata file
 * @param {string} metadataFilePath - Path to meta_data_backup.xml
 * @returns {Promise<Array<string>>} Array of type-id values (e.g., ["SitePreferences", "Order", "Basket"])
 */
export async function getAllTypeIdsFromMetadata(metadataFilePath) {
    if (!fs.existsSync(metadataFilePath)) {
        throw new Error(`Metadata file not found: ${metadataFilePath}`);
    }

    try {
        const xmlContent = fs.readFileSync(metadataFilePath, 'utf-8');
        const parsed = await parseXmlContent(xmlContent);
        const metadata = parsed.metadata;

        if (!metadata || !metadata['type-extension']) {
            return [];
        }

        const typeExtensions = Array.isArray(metadata['type-extension'])
            ? metadata['type-extension']
            : [metadata['type-extension']];

        const typeIds = typeExtensions
            .map(ext => ext.$?.['type-id'])
            .filter(id => id && typeof id === 'string')
            .sort();

        return typeIds;
    } catch (error) {
        throw new Error(`Failed to parse metadata file: ${error.message}`);
    }
}

/**
 * Parse the SitePreferences type-extension from metadata XML and return
 * raw attribute definitions (xml2js objects). Shared by both the filtered
 * and unfiltered extraction functions.
 * @param {string} metadataFilePath - Path to meta_data_backup.xml
 * @param {string} objectType - SFCC object type (e.g., "SitePreferences")
 * @returns {Promise<Array<Object>>} Raw xml2js attribute-definition nodes
 * @private
 */
async function parseRawAttributeDefinitions(metadataFilePath, objectType) {
    if (!fs.existsSync(metadataFilePath)) {
        throw new Error(`Metadata file not found: ${metadataFilePath}`);
    }

    const xmlContent = fs.readFileSync(metadataFilePath, 'utf-8');
    const parsed = await parseXmlContent(xmlContent);
    const metadata = parsed.metadata;

    if (!metadata || !metadata['type-extension']) {
        throw new Error('Metadata XML missing type-extension nodes');
    }

    const typeExtensions = Array.isArray(metadata['type-extension'])
        ? metadata['type-extension']
        : [metadata['type-extension']];

    const matching = typeExtensions.find(ext => ext.$?.['type-id'] === objectType);
    if (!matching) {
        throw new Error(`No type-extension found for type-id '${objectType}' in metadata file`);
    }

    let customAttrs = matching['custom-attribute-definitions'];
    if (!customAttrs) {
        return [];
    }

    if (Array.isArray(customAttrs)) {
        customAttrs = customAttrs[0];
    }

    if (!customAttrs || !customAttrs['attribute-definition']) {
        return [];
    }

    return Array.isArray(customAttrs['attribute-definition'])
        ? customAttrs['attribute-definition']
        : [customAttrs['attribute-definition']];
}

/**
 * Convert a raw xml2js attribute-definition node into an OCAPI-compatible object
 * @param {Object} attrDef - xml2js attribute-definition node
 * @returns {Object} OCAPI-compatible attribute definition
 * @private
 */
function convertXmlAttrDefToOcapi(attrDef) {
    const id = attrDef.$?.['attribute-id'];

    let descriptionObj = null;
    if (attrDef.description) {
        const descriptions = Array.isArray(attrDef.description)
            ? attrDef.description
            : [attrDef.description];
        descriptionObj = {};
        for (const descNode of descriptions) {
            if (!descNode) continue;
            const lang = descNode.$?.['xml:lang'] || 'default';
            const text = extractText(descNode);
            if (text) {
                descriptionObj[lang] = text;
            }
        }
        if (Object.keys(descriptionObj).length === 0) {
            descriptionObj = null;
        }
    }

    const definition = {
        id,
        display_name: extractDisplayName(attrDef),
        description: descriptionObj,
        value_type: mapXmlTypeToOcapiType(extractText(attrDef.type)),
        mandatory: extractBoolean(attrDef['mandatory-flag']),
        localizable: extractBoolean(attrDef['localizable-flag']),
        site_specific: false,
        visible: extractBoolean(attrDef['visible-flag']) ?? true,
        searchable: extractBoolean(attrDef['searchable-flag']) ?? false
    };

    const minLength = extractNumber(attrDef['min-length']);
    if (minLength !== null) definition.min_length = minLength;
    const maxLength = extractNumber(attrDef['max-length']);
    if (maxLength !== null) definition.max_length = maxLength;
    const minValue = extractNumber(attrDef['min-value']);
    if (minValue !== null) definition.min_value = minValue;
    const maxValue = extractNumber(attrDef['max-value']);
    if (maxValue !== null) definition.max_value = maxValue;
    const defaultValue = extractDefaultValue(attrDef['default-value'], definition.value_type);
    if (defaultValue !== null) definition.default_value = defaultValue;

    if (attrDef['value-definitions']) {
        definition.value_definitions = extractValueDefinitions(attrDef['value-definitions']);
    }

    return definition;
}

/**
 * Extract attribute definitions from metadata XML file (filtered by ID list)
 * @param {string} metadataFilePath - Path to meta_data_backup.xml
 * @param {string} objectType - SFCC object type (e.g., "SitePreferences")
 * @param {Array<string>} attributeIds - List of attribute IDs to extract
 * @returns {Promise<Array<Object>>} Array of attribute definition objects
 */
export async function getAttributeDefinitionsFromMetadata(metadataFilePath, objectType, attributeIds) {
    const attributeIdSet = new Set(attributeIds);

    try {
        const rawDefs = await parseRawAttributeDefinitions(metadataFilePath, objectType);
        const definitions = [];

        for (const attrDef of rawDefs) {
            const id = attrDef.$?.['attribute-id'];
            if (!id || !attributeIdSet.has(id)) {
                continue;
            }
            definitions.push(convertXmlAttrDefToOcapi(attrDef));
        }

        return definitions;
    } catch (error) {
        throw new Error(`Failed to parse metadata file: ${error.message}`);
    }
}

/**
 * Extract ALL attribute definitions from metadata XML file (no filtering).
 * Returns the same OCAPI-compatible format as getAttributeDefinitionsFromMetadata
 * but without requiring a pre-built ID list. This eliminates the need for
 * the paginated OCAPI attribute list endpoint + individual default value fetches.
 * @param {string} metadataFilePath - Path to meta_data_backup.xml
 * @param {string} objectType - SFCC object type (e.g., "SitePreferences")
 * @returns {Promise<Array<Object>>} Array of all attribute definition objects
 */
export async function getAllAttributeDefinitionsFromMetadata(metadataFilePath, objectType) {
    try {
        const rawDefs = await parseRawAttributeDefinitions(metadataFilePath, objectType);
        const definitions = [];

        for (const attrDef of rawDefs) {
            const id = attrDef.$?.['attribute-id'];
            if (!id) {
                continue;
            }
            definitions.push(convertXmlAttrDefToOcapi(attrDef));
        }

        return definitions;
    } catch (error) {
        throw new Error(`Failed to parse metadata file: ${error.message}`);
    }
}

/**
 * Extract display name from XML attribute definition
 * @param {Object} attrDef - XML attribute definition
 * @returns {string|null}
 * @private
 */
function extractDisplayName(attrDef) {
    if (!attrDef['display-name']) return null;
    const displayNames = Array.isArray(attrDef['display-name'])
        ? attrDef['display-name']
        : [attrDef['display-name']];

    // Extract text from each localized name
    const result = {};
    for (const nameNode of displayNames) {
        if (!nameNode) continue;
        const lang = nameNode.$?.['xml:lang'] || 'default';
        const text = nameNode._ || nameNode || '';
        result[lang] = text.trim();
    }

    return Object.keys(result).length > 0 ? result : null;
}

/**
 * Extract text content from XML node
 * Handles xml2js structure with _ (text) and $ (attributes)
 * @param {*} node - XML node
 * @returns {string|null}
 * @private
 */
function extractText(node) {
    if (!node) return null;
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return extractText(node[0]);
    // xml2js stores text content in _ property
    const text = node._ || node || null;
    // Remove xml2js artifacts and trim whitespace
    if (typeof text === 'string') {
        return text.trim() || null;
    }
    return null;
}

/**
 * Extract boolean from XML flag node
 * @param {*} node - XML node
 * @returns {boolean|null}
 * @private
 */
function extractBoolean(node) {
    const text = extractText(node);
    if (text === null) return null;
    return text === 'true' || text === true;
}

/**
 * Extract number from XML node
 * @param {*} node - XML node
 * @returns {number|null}
 * @private
 */
function extractNumber(node) {
    const text = extractText(node);
    if (text === null) return null;
    const num = Number(text);
    return isNaN(num) ? null : num;
}

/**
 * Extract default value from XML node
 * Returns typed object {value: <properlyTypedValue>} or null
 * @param {*} node - XML node
 * @param {string} valueType - OCAPI value type (string, int, double, boolean, etc)
 * @returns {Object|null}
 * @private
 */
function extractDefaultValue(node, valueType) {
    if (!node) return null;

    const defaultValues = Array.isArray(node) ? node : [node];
    let textValue = null;

    // Extract text from first default-value node
    for (const defNode of defaultValues) {
        if (!defNode) continue;
        textValue = extractText(defNode);
        if (textValue) break;
    }

    if (!textValue) return null;

    // Convert based on value type
    let typedValue = textValue;
    if (valueType === 'int' || valueType === 'integer') {
        typedValue = parseInt(textValue, 10);
    } else if (valueType === 'double' || valueType === 'decimal') {
        typedValue = parseFloat(textValue);
    } else if (valueType === 'boolean') {
        typedValue = textValue === 'true' || textValue === true;
    }
    // For string and other types, keep as-is

    return { value: typedValue };
}

/**
 * Extract value definitions (enum values) from XML
 * @param {Object} valueDefsNode - XML value-definitions node
 * @returns {Array<Object>}
 * @private
 */
function extractValueDefinitions(valueDefsNode) {
    if (!valueDefsNode || !valueDefsNode['value-definition']) return [];
    const valueDefs = Array.isArray(valueDefsNode['value-definition'])
        ? valueDefsNode['value-definition']
        : [valueDefsNode['value-definition']];

    return valueDefs.map((def, index) => ({
        id: def.$?.value || `value_${index}`,
        value: def.$?.value || null,
        display: extractDisplayName(def),
        position: extractNumber(def.position) ?? index
    }));
}

/**
 * Map XML type to OCAPI value_type
 * @param {string} xmlType - XML type string
 * @returns {string}
 * @private
 */
function mapXmlTypeToOcapiType(xmlType) {
    const typeMap = {
        'string': 'string',
        'text': 'text',
        'html': 'html',
        'number': 'number',
        'int': 'int',
        'double': 'double',
        'boolean': 'boolean',
        'date': 'date',
        'datetime': 'datetime',
        'email': 'email',
        'password': 'password',
        'set-of-string': 'set_of_string',
        'set-of-int': 'set_of_int',
        'set-of-double': 'set_of_double',
        'enum-of-string': 'enum_of_string',
        'enum-of-int': 'enum_of_int'
    };

    return typeMap[xmlType] || xmlType;
}
