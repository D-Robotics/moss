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

// Capture synthetic writes without creating files or launching a benchmark.
const captureSummary = process.env.CAPTURE_SUMMARY === '1';
const captureChild = process.env.CAPTURE_CHILD === '1';
let configMatches;
fs.mkdirSync = () => undefined;
fs.mkdtempSync = () => path.join(os.tmpdir(), 'synthetic-bench-provider');
if (captureSummary || captureChild) {
  fs.rmSync = () => undefined;
  const childProcess = require('node:child_process');
  childProcess.spawnSync = (command, args) => {
    if (command !== 'git' || args.join(' ') !== 'rev-parse --short HEAD') {
      throw new Error('unexpected synthetic child process');
    }
    return { status: 1 };
  };
  childProcess.spawn = (command, args) => {
    if (!captureChild) throw new Error('unexpected synthetic child process');
    const baseUrlIndex = args.indexOf('--base-url');
    process.stdout.write(
      `SYNTHETIC_CHILD ${JSON.stringify({
        configMatches,
        expectedExecutable: command === process.execPath,
        baseUrlMatches: baseUrlIndex >= 0 && args[baseUrlIndex + 1] === process.env.EXPECT_BASE_URL,
      })}\n`
    );
    process.exit(0);
  };
  require('node:module').syncBuiltinESMExports();
}
fs.writeFileSync = function (file, data) {
  const name = path.basename(String(file));
  if (name === 'config.json') {
    const config = JSON.parse(String(data));
    configMatches = {
      modelMatches: config.model === process.env.EXPECT_MODEL,
      baseUrlMatches: config.baseUrl === process.env.EXPECT_BASE_URL,
      keyMatches: config.apiKey === process.env.MOSS_BENCH_API_KEY,
    };
    if (captureSummary || captureChild) return;
    process.stdout.write(JSON.stringify(configMatches));
    process.exit(0);
  }
  if (captureSummary && name === 'summary.json') {
    const summary = JSON.parse(String(data));
    process.stdout.write(
      `SYNTHETIC_SUMMARY ${JSON.stringify({
        configMatches,
        baseUrlOmitted: summary.meta.baseUrl === '[omitted]',
        containsSecret: JSON.stringify(summary).includes('SYNTHETIC_SECRET'),
      })}\n`
    );
    process.exit(0);
  }
  throw new Error('unexpected synthetic write');
};
