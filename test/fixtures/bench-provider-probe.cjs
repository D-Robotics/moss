const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userProviderConfig = path.join(os.homedir(), '.qoder-cn', 'settings.json');
const originalRead = fs.readFileSync;

fs.readFileSync = function (file, ...args) {
  if (typeof file === 'string' && path.resolve(file) === path.resolve(userProviderConfig)) {
    process.stderr.write('UNEXPECTED_USER_PROVIDER_READ\n');
    throw new Error('synthetic provider read blocked');
  }
  return originalRead.call(this, file, ...args);
};

// Capture the synthetic config before any file write or benchmark execution.
fs.mkdirSync = () => undefined;
fs.mkdtempSync = () => path.join(os.tmpdir(), 'synthetic-bench-provider');
fs.writeFileSync = function (file, data) {
  if (path.basename(String(file)) !== 'config.json') {
    throw new Error('unexpected synthetic write');
  }
  const config = JSON.parse(String(data));
  process.stdout.write(
    JSON.stringify({
      modelMatches: config.model === process.env.EXPECT_MODEL,
      baseUrlMatches: config.baseUrl === process.env.EXPECT_BASE_URL,
      keyMatches: config.apiKey === process.env.MOSS_BENCH_API_KEY,
    })
  );
  process.exit(0);
};
