/**
 * Custom Object Whitelist CLI Commands
 * Manage the CO type whitelist (add, remove, list).
 * Uses the shared createListCommands factory.
 */

import { createListCommands } from '../../setup/helpers/listCommands.js';
import {
    addToWhitelist,
    removeFromWhitelist,
    listWhitelist
} from '../helpers/customObjectWhitelistHelper.js';

/**
 * Register CO whitelist management commands.
 * @param {import('commander').Command} program - Commander.js program instance
 */
export const registerCOWhitelistCommands = createListCommands({
    listName: 'co-whitelist',
    helpers: {
        addToList: addToWhitelist,
        removeFromList: removeFromWhitelist,
        listEntries: listWhitelist
    },
    descriptions: {
        add: 'Add a CO type pattern to the whitelist (only these will be analyzed)',
        remove: 'Remove a CO type pattern from the whitelist',
        list: 'Show all whitelisted CO type patterns'
    },
    emptyMessage: 'CO whitelist is empty. All custom object types are eligible for analysis.',
    emptyHint: 'Use "add-to-co-whitelist" to restrict analysis to specific types.',
    headerTitle: 'CUSTOM OBJECT WHITELIST',
    wildcardExample: 'Newsletter*',
    regexExample: '(Newsletter|Coupon).*'
});
