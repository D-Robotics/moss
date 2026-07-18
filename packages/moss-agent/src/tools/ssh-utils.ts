import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { DeviceSshConfig } from './device-ssh.js';
import { ProcessError, runProcess, type RunProcessResult } from '../utils/run-process.js';
import { safeChildEnv } from '../utils/safe-child-env.js';

export function shellEscape(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}









export function expandHomePath(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function isMissingExecutableError(err: unknown, executable: string): boolean {
  const e = err as { code?: unknown; path?: unknown; syscall?: unknown };
  if (e?.code !== 'ENOENT') return false;
  const path = typeof e.path === 'string' ? e.path : '';
  return !path || path === executable;
}

export function formatMissingSshExecutable(executable: string): string {
  if (executable === 'sshpass') {
    return process.platform === 'win32'
      ? 'Required SSH helper "sshpass" was not found. sshpass is not standard on Windows; use key-based auth with MOSS_DEVICE_KEY, install sshpass in WSL, or run Moss from an environment that provides sshpass.'
      : 'Required SSH helper "sshpass" was not found. Install sshpass, or use key-based auth with MOSS_DEVICE_KEY.';
  }
  return process.platform === 'win32'
    ? 'Required SSH executable "ssh" was not found. Install the OpenSSH Client optional feature in Windows, or install it with winget, then retry.'
    : 'Required SSH executable "ssh" was not found. Install OpenSSH client, then retry.';
}

export function missingSshExecutableProcessError(
  err: unknown,
  executable: string
): ProcessError | null {
  if (!isMissingExecutableError(err, executable)) return null;
  return new ProcessError(127, '', formatMissingSshExecutable(executable));
}











export function sshFailureToError(err: unknown, executable: string): Error | null {
  const missingExecutable = missingSshExecutableProcessError(err, executable);
  if (missingExecutable) return new Error(missingExecutable.stderr);
  if (err instanceof ProcessError) {
    const output = [err.stdout, err.stderr].filter(Boolean).join('\n').trim();
    return new Error(output || err.message);
  }
  return null;
}

export function buildSshCommand(
  config: DeviceSshConfig,
  remoteCmd: string,
  connectTimeout = 10
): string[] {
  const user = config.user || 'root';
  const port = config.port || 22;
  const parts = ['-o', 'StrictHostKeyChecking=no', '-o', `ConnectTimeout=${connectTimeout}`];

  if (config.keyPath) {
    
    
    
    parts.push('-i', expandHomePath(config.keyPath));
  }

  
  
  
  
  
  
  
  
  parts.push('-p', String(port), `${user}@${config.host}`, remoteCmd);
  return parts;
}







export const SSH_PASSWORD_ENV_VAR = 'MOSS_SSH_PASSWORD';


const PASSWORD_AUTH_SSH_OPTS = [
  '-o',
  'PreferredAuthentications=password,keyboard-interactive',
  '-o',
  'NumberOfPasswordPrompts=1',
  '-o',
  'PubkeyAuthentication=no',
];


export interface SshInvocation {
  bin: string;
  args: string[];
  
  env: Record<string, string>;
  




  askpass?: string;
}

export interface ResolveSshInvocationOptions {
  
  platform?: NodeJS.Platform;
  
  sshpassAvailable?: boolean;
  
  askpassPath?: string;
  







  headless?: boolean;
}

let sshpassAvailableCache: boolean | undefined;


function detectSshpass(): boolean {
  if (sshpassAvailableCache !== undefined) return sshpassAvailableCache;
  try {
    const res = spawnSync('sshpass', ['-h'], { stdio: 'ignore', windowsHide: true });
    
    
    sshpassAvailableCache = !res.error;
  } catch {
    sshpassAvailableCache = false;
  }
  return sshpassAvailableCache;
}






















export function resolveSshInvocation(
  config: DeviceSshConfig,
  sshArgs: string[],
  opts: ResolveSshInvocationOptions = {}
): SshInvocation {
  const sshExecutable = config.sshExecutable ?? 'ssh';
  const sshArgsPrefix = config.sshArgsPrefix ?? [];
  if (!config.password) {
    return { bin: sshExecutable, args: [...sshArgsPrefix, ...sshArgs], env: {} };
  }

  const platform = opts.platform ?? process.platform;
  const sshpassAvailable = opts.sshpassAvailable ?? (platform !== 'win32' && detectSshpass());
  
  
  
  
  
  
  const headless = opts.headless ?? !process.stdin.isTTY;

  
  
  if (sshExecutable === 'ssh' && platform !== 'win32' && sshpassAvailable && !headless) {
    return {
      bin: 'sshpass',
      args: ['-e', 'ssh', ...sshArgs],
      env: { SSHPASS: config.password },
    };
  }

  
  const askpass =
    opts.askpassPath ??
    path.join(
      os.tmpdir(),
      `moss-askpass-${process.pid}-${Date.now()}${platform === 'win32' ? '.cmd' : '.sh'}`
    );
  return {
    bin: sshExecutable,
    args: [...sshArgsPrefix, ...PASSWORD_AUTH_SSH_OPTS, ...sshArgs],
    env: {
      [SSH_PASSWORD_ENV_VAR]: config.password,
      SSH_ASKPASS: askpass,
      SSH_ASKPASS_REQUIRE: 'force',
      
      
      DISPLAY: process.env.DISPLAY || ':0',
    },
    askpass,
  };
}


function askpassScript(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    
    
    return `@echo off\r\necho %${SSH_PASSWORD_ENV_VAR}%\r\n`;
  }
  return `#!/bin/sh\nprintf '%s\\n' "$${SSH_PASSWORD_ENV_VAR}"\n`;
}














export async function runSsh(
  config: DeviceSshConfig,
  sshArgs: string[],
  runOpts: {
    timeout?: number;
    maxBuffer?: number;
    signal?: AbortSignal;
    
    runner?: typeof runProcess;
    




    resolveOpts?: ResolveSshInvocationOptions;
  } = {}
): Promise<RunProcessResult> {
  const runner = runOpts.runner ?? runProcess;
  const invocation = resolveSshInvocation(config, sshArgs, runOpts.resolveOpts);
  const platform = runOpts.resolveOpts?.platform ?? process.platform;

  if (invocation.askpass) {
    fs.writeFileSync(invocation.askpass, askpassScript(platform), { mode: 0o700 });
  }
  try {
    return await runner(invocation.bin, {
      args: invocation.args,
      timeout: runOpts.timeout,
      maxBuffer: runOpts.maxBuffer,
      signal: runOpts.signal,
      env: safeChildEnv(invocation.env),
    });
  } finally {
    if (invocation.askpass) {
      try {
        fs.unlinkSync(invocation.askpass);
      } catch {
        
      }
    }
  }
}







export function sshBinFor(config: DeviceSshConfig): string {
  return resolveSshInvocation(config, []).bin;
}
