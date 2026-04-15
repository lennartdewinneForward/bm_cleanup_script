/**
 * Custom Object Blacklist Helper
 * Manages a blacklist of CO type IDs that should never be moved or deleted.
 * Thin wrapper over the shared createListHelper factory.
 *
 * @module customObjectBlacklistHelper
 */

import { createListHelper } from '../../setup/helpers/blackAndWhiteListHelper.js';

const helper = createListHelper({
    listType: 'blacklist',
    configFileName: 'customobject_blacklist.json',
    filterMode: 'exclude'
});

/**
 * Load the CO blacklist configuration from disk.
 * @returns {Object} Parsed blacklist object with { description, blacklist: [] }
 */
export const loadBlacklist = helper.loadList;

/**
 * Save the CO blacklist configuration to disk.
 * @param {Object} config - Blacklist config object with { description, blacklist }
 */
export const saveBlacklist = helper.saveList;

/**
 * Check if a CO type ID is blacklisted.
 * @param {string} typeId - The CO type ID to check
 * @param {Array|null} [blacklistEntries] - Optional pre-loaded entries
 * @param {string|null} [realm] - Optional realm to scope the check
 * @returns {boolean} True if blacklisted
 */
export const isBlacklisted = helper.isInList;

/**
 * Filter an array of CO type IDs, removing any that are blacklisted.
 * @param {string[]} typeIds - Array of CO type IDs to filter
 * @param {Array|null} [blacklistEntries] - Optional pre-loaded blacklist entries
 * @param {string|null} [realm] - Optional realm to scope the filter
 * @returns {{ allowed: string[], blocked: string[] }}
 */
export const filterBlacklisted = helper.filterByList;

/**
 * Add a new entry to the CO blacklist.
 * @param {Object} entry - Entry to add { pattern|id, type, reason, realms? }
 * @returns {boolean} True if added (false if duplicate)
 */
export const addToBlacklist = helper.addToList;

/**
 * Remove an entry from the CO blacklist by its pattern/id value.
 * @param {string} value - The pattern or ID to remove
 * @returns {boolean} True if removed (false if not found)
 */
export const removeFromBlacklist = helper.removeFromList;

/**
 * Get all CO blacklist entries for display.
 * @returns {Array<Object>} Array of blacklist entries
 */
export const listBlacklist = helper.listEntries;
