/**
 * Custom Object Prompts
 *
 * Inquirer prompt definitions for custom object commands.
 */

export const confirmMovePrompt = (count) => ([
    {
        type: 'confirm',
        name: 'confirm',
        message: `Move ${count} custom object type(s) from core to realm-specific folders?`,
        default: false
    }
]);

export const confirmDryRunMovePrompt = (count) => ([
    {
        type: 'confirm',
        name: 'confirm',
        message: `Preview move of ${count} custom object type(s)? (dry-run, no changes)`,
        default: true
    }
]);

export const selectCustomObjectTypesPrompt = (typeIds) => ([
    {
        type: 'checkbox',
        name: 'selectedTypes',
        message: 'Select custom object types to move:',
        choices: typeIds.map(id => ({ name: id, value: id, checked: true })),
        validate: (input) => input.length > 0 ? true : 'Select at least one type'
    }
]);

export const selectUnusedTypesForDeletionPrompt = (typeIds) => ([
    {
        type: 'checkbox',
        name: 'selectedTypes',
        message: 'Select unused custom object types to delete from repo:',
        choices: typeIds.map(id => ({ name: id, value: id, checked: true })),
        validate: (input) => input.length > 0 ? true : 'Select at least one type'
    }
]);

export const confirmDeletePrompt = (count) => ([
    {
        type: 'confirm',
        name: 'confirm',
        message: `Delete ${count} unused custom object type(s) and their records from the repo?`,
        default: false
    }
]);
