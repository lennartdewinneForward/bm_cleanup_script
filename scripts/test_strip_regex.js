import fs from 'fs';
import { execSync } from 'child_process';

// Get the original core file content via git
const repo = 'c:\\Users\\dewinle\\Documents\\Puma\\HER_eCom_SFCC';
const coreContent = execSync(
    `git -C "${repo}" show HEAD:sites/site_template/meta/meta.system.sitepreference.maxQtyToBeAddedInCart.xml`,
    { encoding: 'utf-8' }
);

// Extract the group block (same logic as extractContainingGroup)
function extractContainingGroup(xmlContent, attributeId) {
    const escaped = attributeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        '([ \\t]*<attribute-group[^>]*>[\\s\\S]*?'
        + `<attribute\\s+attribute-id="${escaped}"\\s*/>`
        + '[\\s\\S]*?</attribute-group>)',
        'i'
    );
    const match = xmlContent.match(pattern);
    return match ? match[1] : null;
}

// buildMinimalGroupBlock — same as in metaFileCleanup.js
function buildMinimalGroupBlock(fullGroupBlock, attributeId) {
    const stripped = fullGroupBlock.replace(
        /[ \t]*<attribute\s+attribute-id="[^"]+"\s*\/>[ \t]*\r?\n?/g,
        ''
    );
    return stripped.replace(
        /([ \t]*)<\/attribute-group>/,
        `$1    <attribute attribute-id="${attributeId}"/>\n$1</attribute-group>`
    );
}

const groupBlock = extractContainingGroup(coreContent, 'maxQtyToBeAddedInCart');
console.log('=== ORIGINAL GROUP (first 5 + last 5 lines) ===');
const origLines = groupBlock.split('\n');
console.log(origLines.slice(0, 5).join('\n'));
console.log('  ...');
console.log(origLines.slice(-5).join('\n'));
console.log(`Total lines: ${origLines.length}`);

const minimal = buildMinimalGroupBlock(groupBlock, 'maxQtyToBeAddedInCart');
console.log('\n=== MINIMAL GROUP ===');
console.log(minimal);

// Check for any remaining <attribute lines
const remaining = minimal.match(/<attribute\s+attribute-id="[^"]+"/g) || [];
console.log(`\nRemaining <attribute> refs: ${remaining.length}`);
remaining.forEach(m => console.log(`  ${m}`));

// Also check if allowedDomainLocales survives
if (minimal.includes('allowedDomainLocales')) {
    console.log('\n!!! BUG: allowedDomainLocales leaked through !!!');
} else {
    console.log('\nallowedDomainLocales correctly stripped');
}
