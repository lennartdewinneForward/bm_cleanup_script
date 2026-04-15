/**
 * Custom Object Blacklist CLI Commands
 * Manage the CO type blacklist (add, remove, list).
 * Uses the shared createListCommands factory.
 */

import { createListCommands } from '../../setup/helpers/listCommands.js';
import {
    addToBlacklist,
    removeFromBlacklist,
    listBlacklist
} from '../helpers/customObjectBlacklistHelper.js';

/**
 * Register CO blacklist management commands.
 * @param {import('commander').Command} program - Commander.js program instance
 */
export const registerCOBlacklistCommands = createListCommands({
    listName: 'co-blacklist',
    helpers: {
        addToList: addToBlacklist,
        removeFromList: removeFromBlacklist,
        listEntries: listBlacklist
    },
    descriptions: {
        add: 'Add a CO type pattern to the blacklist (protected from move/deletion)',
        remove: 'Remove a CO type pattern from the blacklist',
        list: 'Show all blacklisted CO type patterns'
    },
    emptyMessage: 'CO blacklist is empty. No custom object types are protected.',
    emptyHint: 'Use "add-to-co-blacklist" to add entries.',
    headerTitle: 'CUSTOM OBJECT BLACKLIST',
    wildcardExample: 'Workflow*',
    regexExample: '(Workflow|Radial).*'
});
