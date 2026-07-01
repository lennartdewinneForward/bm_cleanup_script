import { LOG_PREFIX } from '../../../config/constants.js';

/**
 * Validate realm selection and return list to process
 * @param {Array<string>} realmsToProcess - List of realms from selection
 * @returns {boolean} True if realms are valid, false otherwise
 */
export function validateRealmsSelection(realmsToProcess) {
    if (!realmsToProcess || realmsToProcess.length === 0) {
        console.log(`${LOG_PREFIX.WARNING} No realms found for the selected scope.`);
        return false;
    }
    return true;
}
