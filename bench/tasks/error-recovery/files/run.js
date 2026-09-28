import { readFileSync } from 'node:fs';

let settings;
try {
  settings = JSON.parse(readFileSync(new URL('./data/settings.json', import.meta.url), 'utf8'));
} catch {
  console.error('data/settings.json is missing or unreadable');
  process.exit(1);
}

if (
  settings.mode !== 'strict' ||
  !Number.isInteger(settings.limit) ||
  settings.limit < 1 ||
  settings.limit > 100
) {
  console.error('settings content does not satisfy the required shape');
  process.exit(1);
}

console.log(`OK mode=${settings.mode} limit=${settings.limit}`);
