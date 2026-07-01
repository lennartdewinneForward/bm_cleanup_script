/**
 * API and Processing Constants
 * Configurable values for different instance types and processing tasks
 */

/**
 * Log message prefixes for consistent console output
 */
export const LOG_PREFIX = {
    INFO: '✓',
    WARNING: '⚠',
    ERROR: '✗'
};

/**
 * Standard separator line for formatting output (80 characters)
 */
export const SEPARATOR = '='.repeat(80);

/**
 * API request configuration
 * Shared across all instance types
 */
export const API_CONFIG = {
    batchSize: 10,           // Number of items to process in parallel
    batchDelayMs: 2000,      // Delay (ms) between batch requests
    retryAttempts: 3,        // Number of retry attempts for rate-limited requests
    requestTimeoutMs: 30000  // Timeout for individual API requests
};

/**
 * File scanning configuration
 * Used for preference usage search and code scanning
 */
export const SCAN_CONFIG = {
    logProgressEvery: 200,        // Log progress after scanning N files
    maxConcurrentReads: 10        // Maximum concurrent file read operations
};

/**
 * Directory names used throughout the application
 */
export const DIRECTORIES = {
    BACKUP: 'backup',
    BACKUP_DOWNLOADS: 'backup_downloads',
    RESULTS: 'results',
    CARTRIDGES: 'cartridges'
};

/**
 * Special identifiers and default values
 */
export const IDENTIFIERS = {
    ALL_REALMS: 'ALL_REALMS',
    SITE_PREFERENCES: 'SitePreferences',
    CUSTOM_ATTRIBUTE_PREFIX: 'c_',
    ORDER: 'Order'
};

/**
 * Realm tag values used in deletion candidate files and parsing logic
 */
export const REALM_TAGS = {
    ALL: 'ALL'
};

/**
 * Deletion level options for remove-preferences command.
 * P1-P5 are cascading: selecting P3 includes P1+P2+P3.
 * Per-realm deletion files handle realm targeting automatically.
 */
export const DELETION_LEVELS = {
    P1: 'P1',
    P2: 'P2',
    P3: 'P3',
    P4: 'P4',
    P5: 'P5'
};

/**
 * Priority tier numeric ordering for cascading tier selection
 */
export const TIER_ORDER = { P1: 1, P2: 2, P3: 3, P4: 4, P5: 5 };

/**
 * Human-readable descriptions for each priority tier.
 */
export const TIER_DESCRIPTIONS = {
    P1: 'Safe to Delete — No code references, no values',
    P2: 'Likely Safe — No code references, has values',
    P3: 'Deprecated Code Only — No values',
    P4: 'Deprecated Code + Values',
    P5: 'Realm-Specific — Active code not on all realms'
};

/**
 * File naming patterns and suffixes
 */
export const FILE_PATTERNS = {
    PREFERENCES_MATRIX: '_preferences_matrix.csv',
    PREFERENCES_USAGE: '_preferences_usage.csv',
    UNUSED_PREFERENCES: '_unused_preferences.txt',
    PREFERENCES_FOR_DELETION: '_preferences_for_deletion.txt',
    PREFERENCES_COMBINED_REALMS: '_combined_realm_deletion_candidates.txt',
    PREFERENCES_CROSS_REALM: '_cross_realm_deletion_candidates.txt',
    CARTRIDGE_PREFERENCES: '_cartridge_preferences.txt',
    PREFERENCE_USAGE: '_preference_usage.txt',
    USED_PREFERENCES: '_used_preferences.txt',
    CARTRIDGE_COMPARISON: '_cartridge_comparison.txt',
    META_CLEANUP_LOGIC_TXT: 'Meta-cleanup-logic.txt',
    META_CLEANUP_LOGIC_JSON: 'Meta-cleanup-logic.json',
    SITE_CARTRIDGES_LIST: '_active_site_cartridges_list.csv',
    SITE_PREFERENCES_CSV: '_site_preferences.csv',
    SITE_XML_VALIDATION: '_site_xml_validation.txt',
    BACKUP_SUFFIX: '_backup_',
    PREFERENCE_REFERENCES: '_preference_references.json',
    ORPHAN_REPORT: '_orphan_report.txt',
    CUSTOM_ATTR_UNUSED: '_unused_custom_attributes.txt',
    CUSTOM_ATTR_USED: '_used_custom_attributes.txt',
    CUSTOM_ATTR_FOR_DELETION: '_custom_attributes_for_deletion.txt',
    CUSTOM_ATTR_COMBINED_REALMS: '_combined_realm_custom_attr_deletion_candidates.txt',
    CUSTOM_ATTR_CROSS_REALM: '_cross_realm_custom_attr_deletion_candidates.txt',
    CUSTOM_ATTR_REFERENCES: '_attribute_references.json',
    CUSTOM_ATTR_META_CLEANUP_LOGIC_JSON: '_Meta-cleanup-logic.json',
    CUSTOM_ATTR_META_CLEANUP_LOGIC_TXT: '_Meta-cleanup-logic.txt'
};

/**
 * Allowed file extensions for code scanning
 */
export const ALLOWED_EXTENSIONS = new Set([
    '.js',
    '.isml',
    '.ds',
    '.json',
    '.xml',
    '.properties',
    '.txt',
    '.html'
]);

/**
 * Directories to skip during code scanning
 */
export const SKIP_DIRECTORIES = new Set([
    'node_modules',
    'sites',
    'results',
    '.git',
    '.vscode'
]);

/**
 * Backup configuration
 */
export const BACKUP_CONFIG = {
    MAX_AGE_DAYS: 14,                    // Maximum age for reusing cached backups
    MS_PER_DAY: 1000 * 60 * 60 * 24     // Milliseconds in one day
};

/**
 * Number of progress steps per analysis path.
 * Used by RealmProgressDisplay to compute overall realm progress.
 *   OCAPI:    fetch -> details -> groups -> matrices -> export  (fallback when backup fails)
 *   METADATA: backup -> fetch -> groups -> matrices -> export   (default path)
 */
export const ANALYSIS_STEPS = Object.freeze({
    OCAPI: 5,
    METADATA: 5
});

/**
 * Default comparison file path for deprecated cartridges
 */
export const DEFAULT_COMPARISON_FILE = 'ALL_REALMS_cartridge_comparison.txt';

/**
 * Get API configuration
 * @returns {Object} API configuration
 */
export function getApiConfig() {
    return API_CONFIG;
}

/**
 * Get configuration value with fallback
 * @param {string} configKey - The configuration key (e.g., 'batchSize')
 * @param {*} defaultValue - Default value if not found
 * @returns {*} Configuration value
 */
export function getConfigValue(configKey, defaultValue) {
    return API_CONFIG[configKey] !== undefined ? API_CONFIG[configKey] : defaultValue;
}
