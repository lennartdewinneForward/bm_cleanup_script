import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logError } from '../../scripts/loggingScript/log.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Default configuration structure with all base properties.
 * Used when creating a new config or backfilling missing properties.
 * @private
 */
const DEFAULT_CONFIG = {
    coreSiteTemplatePath: 'sites/site_template',
    coreSiteDemoPath: 'sites/site_demo',
    validation: {
        ignoreBmCartridges: true
    },
    realms: [],
    backup: {
        jobId: 'site preferences - BACKUP',
        pollIntervalMs: 5000,
        timeoutMs: 600000,
        ocapiVersion: 'v25_6',
        webdavUsername: '',
        webdavPassword: '',
        webdavFilePath: '/on/demandware.servlet/webdav/Sites/Impex/src/meta_data_backup.xml',
        outputDir: './backup_downloads'
    }
};

/**
 * Load configuration from config.json file.
 * Creates a default config if the file does not exist.
 * Backfills any missing top-level properties from defaults on every load.
 * @returns {Object} Parsed configuration object
 * @private
 */
function loadConfig() {
    const configPath = path.resolve(__dirname, '../config.json');

    if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

        // Backfill missing top-level properties from defaults
        let patched = false;
        for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
            if (!(key in config)) {
                config[key] = JSON.parse(JSON.stringify(value));
                patched = true;
            } else if (typeof value === 'object' && !Array.isArray(value)) {
                // Backfill missing nested properties (one level deep)
                for (const [subKey, subValue] of Object.entries(value)) {
                    if (!(subKey in config[key])) {
                        config[key][subKey] = JSON.parse(JSON.stringify(subValue));
                        patched = true;
                    }
                }
            }
        }

        if (patched) {
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        }

        return config;
    } catch (error) {
        logError(`Failed to load config.json: ${error.message}`);
        throw error;
    }
}

/**
 * Save configuration to config.json file
 * @param {Object} config - Configuration object to save
 * @private
 */
function saveConfig(config) {
    const configPath = path.resolve(__dirname, '../config.json');
    try {
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (error) {
        logError(`Failed to save config.json: ${error.message}`);
        throw error;
    }
}

/**
 * Find realm configuration by name
 * @param {string} realmName - Realm name to find
 * @param {Object} config - Configuration object
 * @returns {Object|null} Realm configuration or null if not found
 * @private
 */
function findRealmInConfig(realmName, config) {
    return config.realms.find(r => r.name === realmName) || null;
}

/**
 * Retrieve sandbox configuration for a specific realm
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} realmName - Name of the realm to retrieve
 * @returns {Object} Sandbox configuration object
 */
export function getSandboxConfig(realmName) {
    const config = loadConfig();
    const realm = findRealmInConfig(realmName, config);
    if (!realm) {
        throw new Error(`Realm '${realmName}' not found in config.json`);
    }
    return realm;
}

/**
 * Retrieve full realm configuration for a specific realm
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} realmName - Name of the realm to retrieve
 * @returns {Object} Full realm configuration object
 */
export function getRealmConfig(realmName) {
    return getSandboxConfig(realmName);
}

/**
 * Get list of all configured realm names
 * See .github/instructions/function-reference.md for detailed documentation
 * @returns {string[]} Array of realm names
 */
export function getAvailableRealms() {
    const config = loadConfig();
    return config.realms.map(r => r.name);
}

/**
 * Get the core site template path from config.
 * Falls back to 'sites/site_template' if not configured.
 * @returns {string} Relative path to the core site template directory
 */
export function getCoreSiteTemplatePath() {
    const config = loadConfig();
    return config.coreSiteTemplatePath || 'sites/site_template';
}

/**
 * Get the core site demo path from config.
 * Falls back to 'sites/site_demo' if not configured.
 * @returns {string} Relative path to the core site demo directory
 */
export function getCoreSiteDemoPath() {
    const config = loadConfig();
    return config.coreSiteDemoPath || 'sites/site_demo';
}

/**
 * Get the instance type for a specific realm
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} realmName - Name of the realm
 * @returns {string} Instance type (sandbox, development, staging, production)
 */
export function getInstanceType(realmName) {
    const config = loadConfig();
    const realm = findRealmInConfig(realmName, config);
    if (!realm) {
        throw new Error(`Realm '${realmName}' not found in config.json`);
    }
    return realm.instanceType || 'sandbox';
}

/**
 * Get all realms for a specific instance type
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} instanceType - Instance type (sandbox, development, staging, production)
 * @returns {string[]} Array of realm names for the given instance type
 */
export function getRealmsByInstanceType(instanceType) {
    const config = loadConfig();
    return config.realms
        .filter(r => r.instanceType === instanceType)
        .map(r => r.name);
}

/**
 * Get validation configuration settings
 * See .github/instructions/function-reference.md for detailed documentation
 * @returns {Object} Validation configuration object
 */
export function getValidationConfig() {
    const config = loadConfig();
    return config.validation || { ignoreBmCartridges: true };
}

/**
 * Get backup job configuration settings
 * @returns {Object} Backup configuration
 */
export function getBackupConfig() {
    const config = loadConfig();
    const backup = config.backup || {};

    return {
        jobId: backup.jobId || 'site preferences - BACKUP',
        pollIntervalMs: backup.pollIntervalMs || 5000,
        timeoutMs: backup.timeoutMs || 10 * 60 * 1000,
        ocapiVersion: backup.ocapiVersion || 'v25_6',
        webdavFilePath: backup.webdavFilePath || '/on/demandware.servlet/webdav/Sites/Impex/src/meta_data_backup.zip',
        outputDir: backup.outputDir || './backup_downloads'
    };
}

/**
 * Get WebDAV configuration for a realm
 * @param {string} realmName - Name of the realm
 * @returns {Object} WebDAV configuration
 */
export function getWebdavConfig(realmName) {
    const config = loadConfig();
    const realm = findRealmInConfig(realmName, config);

    if (!realm) {
        throw new Error(`Realm '${realmName}' not found in config.json`);
    }

    const backup = config.backup || {};

    return {
        name: realm.name,
        hostname: realm.hostname,
        username: backup.webdavUsername || '',
        password: backup.webdavPassword || '',
        filePath: backup.webdavFilePath || ''
    };
}

/**
 * Extract realm name from a hostname URL
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} hostname - Full hostname URL
 * @returns {string} Extracted realm name or "realm" as fallback
 */
export function deriveRealm(hostname) {
    return String(hostname || '').split('.')[0] || 'realm';
}

/**
 * Add a new realm configuration to config.json
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} name - Unique identifier for the realm
 * @param {string} hostname - Full hostname of the sandbox
 * @param {string} clientId - OCAPI client ID
 * @param {string} clientSecret - OCAPI client secret
 * @param {string} [siteTemplatesPath] - Optional path to site templates directory
 * @param {string} [instanceType] - Instance type (sandbox, development, staging, production)
 * @returns {boolean} true if realm was added successfully
 */
export function addRealmToConfig(name, hostname, clientId, clientSecret, siteTemplatesPath = '', instanceType = 'sandbox') {
    try {
        const config = loadConfig();

        if (findRealmInConfig(name, config)) {
            console.error(`Realm '${name}' already exists in config.json`);
            return false;
        }

        const newRealm = {
            name,
            hostname,
            clientId,
            clientSecret,
            instanceType
        };

        if (siteTemplatesPath && siteTemplatesPath.trim() !== '') {
            newRealm.siteTemplatesPath = siteTemplatesPath.trim();
        }

        config.realms.push(newRealm);
        saveConfig(config);
        console.log(`Realm '${name}' added to config.json`);
        return true;
    } catch (error) {
        logError(`Failed to add realm to config: ${error.message}`);
        return false;
    }
}

/**
 * Remove a realm configuration from config.json
 * See .github/instructions/function-reference.md for detailed documentation
 * @param {string} realmName - Name of the realm to remove
 * @returns {Promise<boolean>} true if realm was removed successfully
 */
export async function removeRealmFromConfig(realmName) {
    try {
        const config = loadConfig();

        if (!findRealmInConfig(realmName, config)) {
            console.error(`Realm '${realmName}' not found in config.json`);
            return false;
        }

        config.realms = config.realms.filter(r => r.name !== realmName);
        saveConfig(config);
        console.log(`Realm '${realmName}' removed from config.json`);
        return true;
    } catch (error) {
        logError(`Failed to remove realm from config: ${error.message}`);
        return false;
    }
}

export {
    loadConfig,
    saveConfig,
    findRealmInConfig
};
