/**
 * Custom Attributes Prompts
 *
 * Inquirer prompt definitions for custom attributes commands.
 */

/**
 * Multi-select prompt to choose which type-ids to analyze
 * Includes a "Check all" option at the top for convenience
 * @param {Array<string>} typeIds - Array of available type-ids
 * @returns {Array<Object>} Inquirer prompt definition
 */
export const selectTypeIdsPrompt = (typeIds) => {
    const choices = [
        { name: '→ Check all type-ids', value: '__checkAll__', checked: false },
        { name: '─'.repeat(40), value: '__separator__', disabled: true },
        ...typeIds.map(id => ({ name: `  ${id}`, value: id, checked: false }))
    ];

    return [
        {
            type: 'checkbox',
            name: 'selectedTypeIds',
            message: 'Select type-ids to analyze for custom attributes:',
            choices,
            validate: (input) => {
                const actualSelections = input.filter(v => v !== '__separator__');
                return actualSelections.length > 0 ? true : 'Select at least one type-id';
            }
        }
    ];
};

/**
 * Post-process the multi-select response to handle "Check all" logic
 * If user selected "__checkAll__", expand it to all type-ids
 * Also filters out the separator line
 * @param {Array<string>} selectedValues - Selected values from checkbox prompt
 * @param {Array<string>} allTypeIds - Full array of available type-ids
 * @returns {Array<string>} Processed array with all actual type-ids
 */
export function processTypeIdSelection(selectedValues, allTypeIds) {
    // Filter out separator and invalid values
    const validSelections = selectedValues.filter(v => v !== '__separator__');

    if (validSelections.includes('__checkAll__')) {
        return allTypeIds;
    }
    return validSelections;
}
