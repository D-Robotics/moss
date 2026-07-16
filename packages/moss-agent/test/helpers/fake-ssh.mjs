import fs from 'node:fs/promises';
import path from 'node:path';

export async function installFakeSsh(binDir, options = {}) {
  const scriptPath = path.join(binDir, 'fake-ssh.mjs');
  const config = {
    callsFile: options.callsFile,
    responses: options.responses ?? [],
    defaultExitCode: options.defaultExitCode ?? 0,
    defaultStdout: options.defaultStdout ?? '',
    defaultStderr: options.defaultStderr ?? '',
  };
  const script = `#!/usr/bin/env node
import fs from 'node:fs';
const config = ${JSON.stringify(config)};
const line = process.argv.slice(2).join(' ');
if (config.callsFile) fs.appendFileSync(config.callsFile, line + '\\n');
const response = config.responses.find((candidate) => line.includes(candidate.includes));
const stdout = response?.stdout ?? config.defaultStdout;
const stderr = response?.stderr ?? config.defaultStderr;
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exit(response?.exitCode ?? config.defaultExitCode ?? 0);
`;
  await fs.writeFile(scriptPath, script, { mode: 0o755 });
  if (process.platform === 'win32') {
    await fs.writeFile(
      path.join(binDir, 'ssh.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0fake-ssh.mjs" %*\r\n`,
    );
  } else {
    await fs.copyFile(scriptPath, path.join(binDir, 'ssh'));
    await fs.chmod(path.join(binDir, 'ssh'), 0o755);
  }
}
