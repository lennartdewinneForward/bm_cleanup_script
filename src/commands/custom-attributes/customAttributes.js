import { analyzeCustomAttributes } from './actions/analyzeCustomAttributes.js';

// ============================================================================
// CUSTOM ATTRIBUTES COMMANDS REGISTRATION
// Register all custom attributes-related commands with the CLI program
// ============================================================================

export function registerCustomAttributesCommands(program) {

    program
        .command('analyze-custom-attributes')
        .description('Analyze custom attribute definitions vs code usage across realms')
        .action(analyzeCustomAttributes);
}
