/**
 * Preference Backup Helper
 * Utilities for loading and validating SFCC attribute backup files
 */

import fs from 'fs/promises';
import path from 'path';
import { DIRECTORIES, FILE_PATTERNS, BACKUP_CONFIG } from '../config/constants.js';

/**
 * Fields that are valid for creating new attribute definitions
 * All other fields are read-only or system-generated and must be excluded
 */
const CREATE_SAFE_FIELDS = [
    'id',
    'display_name',
    'description',
    'value_type',
    'mandatory',
    'localizable',
    'multi_value_type',
    'visible',
    'queryable',
    'searchable',
    'site_specific',
    'default_value',
    'min_length',
    'max_length',
    'min_value',
    'max_value',
    'value_definitions'
];

/**
 * Transform attribute definition into create-safe body
 * Strips out all read-only and system-generated fields
 * @param {Object} attributeDefinition - Full attribute definition from OCAPI
 * @returns {Object} Create-safe attribute definition
 */
export function buildCreateSafeBody(attributeDefinition) {
    const createSafeBody = {};

    for (const field of CREATE_SAFE_FIELDS) {
        if (attributeDefinition[field] !== undefined) {
            createSafeBody[field] = attributeDefinition[field];
        }
    }

    return createSafeBody;
}

/**
 * Check if a backup file exists and get its age in days
 * Finds the latest backup file (not just today's) and checks its age.
 * @param {string} realm - Realm name
 * @param {string} instanceType - Instance type
 * @param {string} objectType - Object type (e.g., "SitePreferences")
 * @returns {Promise<{exists: boolean, filePath: string, ageInDays: number, backup: Object}>} Backup file info
 */
export async function checkBackupFileAge(realm, instanceType, objectType) {
    const backupDir = path.join(process.cwd(), DIRECTORIES.BACKUP, instanceType);

    try {
        // Find all backup files for this realm and objectType
        const entries = await fs.readdir(backupDir);
        const backupPattern = `${realm}_${objectType}${FILE_PATTERNS.BACKUP_SUFFIX}`;
        const matchingFiles = entries
            .filter(f => f.startsWith(backupPattern) && f.endsWith('.json'))
            .sort()
            .reverse();

        if (matchingFiles.length === 0) {
            return {
                exists: false,
                filePath: null,
                ageInDays: null,
                backup: null
            };
        }

        // Use the latest backup file (first after reverse sort)
        const latestFilename = matchingFiles[0];
        const filePath = path.join(backupDir, latestFilename);

        const backup = await loadBackupFile(filePath);
        const backupDate = new Date(backup.backup_date);
        const now = new Date();
        const ageInDays = Math.floor((now - backupDate) / BACKUP_CONFIG.MS_PER_DAY);

        return {
            exists: true,
            filePath,
            ageInDays,
            backup
        };
    } catch {
        return {
            exists: false,
            filePath: null,
            ageInDays: null,
            backup: null
        };
    }
}

/**
 * Validate backup file structure
 * @param {string} backupFilePath - Path to backup file
 * @returns {Promise<Object>} Validated backup data
 */
export async function loadBackupFile(backupFilePath) {
    const content = await fs.readFile(backupFilePath, 'utf-8');
    const backup = JSON.parse(content);

    // Validate required fields
    const requiredFields = ['backup_date', 'realm', 'object_type', 'attributes', 'attribute_groups'];
    for (const field of requiredFields) {
        if (!backup[field]) {
            throw new Error(`Invalid backup file: missing required field '${field}'`);
        }
    }

    return backup;
}

/**
 * Check backup file status for multiple realms
 * @param {Array<string>} realms - List of realm names
 * @param {string} objectType - Object type (e.g., "SitePreferences")
 * @returns {Promise<Array<{realm: string, exists: boolean, ageInDays: number, filePath: string}>>}
 */
export async function checkBackupStatusForRealms(realms, objectType) {
    const { getSandboxConfig } = await import('../config/helpers/helpers.js');
    const results = [];

    for (const realm of realms) {
        const sandbox = getSandboxConfig(realm);
        const backupInfo = await checkBackupFileAge(realm, sandbox.instanceType, objectType);

        results.push({
            realm,
            exists: backupInfo.exists,
            ageInDays: backupInfo.ageInDays,
            filePath: backupInfo.filePath,
            tooOld: backupInfo.exists && backupInfo.ageInDays >= 14
        });
    }

    return results;
}

/**
 * Load backup file and return attributes
 * @param {string} realm - Realm name
 * @param {string} instanceType - Instance type
 * @param {string} objectType - Object type
 * @returns {Promise<Array|null>} Attributes array or null if not found
 */
export async function loadCachedBackup(realm, instanceType, objectType) {
    const backupInfo = await checkBackupFileAge(realm, instanceType, objectType);

    if (!backupInfo.exists) {
        return null;
    }

    return backupInfo.backup.attributes;
}
