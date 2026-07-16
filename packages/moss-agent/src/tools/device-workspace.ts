
















import type { Tool, ToolContext } from '../core/tools/tool-types.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { runProcess, ProcessError } from '../utils/run-process.js';
import { wrapAsMoss, ErrorCode } from '../errors.js';
import type { DeviceSshConfig } from './device-ssh.js';
import { buildSshCommand, runSsh, sshBinFor, shellEscape, sshFailureToError } from './ssh-utils.js';
import type { DeviceConnectionHealth } from './device-connection-health.js';
import type { DeviceSshExecutor } from './device-ssh-session.js';


export const BOARD_REPLACED_TOOL_NAMES = [
  'exec',
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'search_files',
  'search_code',
  'move_file',
] as const;





export const BOARD_SUSPENDED_TOOL_NAMES = [
  'apply_patch',
  'exec_background',
  'exec_logs',
  'exec_stop',
] as const;

export interface BoardWorkspaceOptions {
  
  runProcessImpl?: typeof runProcess;
  sshExecutor?: DeviceSshExecutor;
}

interface BoardRunOptions {
  timeout: number;
  ctx?: ToolContext;
  runner: typeof runProcess;
  maxBuffer?: number;
  
  allowNonZeroExit?: boolean;
  health?: DeviceConnectionHealth;
  operation?: string;
  sshExecutor?: DeviceSshExecutor;
}

interface BoardRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const WRITE_LIMIT_BYTES = 256_000;

function isTransportFailure(config: DeviceSshConfig, err: ProcessError): boolean {
  
  
  
  return err.exitCode === 255 || (Boolean(config.password) && err.exitCode === 5);
}

async function boardRun(
  config: DeviceSshConfig,
  remoteCmd: string,
  opts: BoardRunOptions
): Promise<BoardRunResult> {
  const operation = opts.operation ?? 'board command';
  await opts.health?.beforeOperation(operation);
  const sshArgs = buildSshCommand(config, remoteCmd, 5);
  try {
    const result = opts.sshExecutor
      ? await opts.sshExecutor.run(remoteCmd, {
          timeout: opts.timeout,
          maxBuffer: opts.maxBuffer ?? 5 * 1024 * 1024,
          signal: opts.ctx?.abortSignal,
        })
      : await runSsh(config, sshArgs, {
          timeout: opts.timeout,
          maxBuffer: opts.maxBuffer ?? 5 * 1024 * 1024,
          signal: opts.ctx?.abortSignal,
          runner: opts.runner,
        });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  } catch (err) {
    await opts.health?.handleFailure(err, {
      operation,
      abortSignal: opts.ctx?.abortSignal,
    });
    if (err instanceof ProcessError && err.timedOut) {
      throw new Error(
        `Board command timed out after ${Math.round(opts.timeout / 1000)}s. ` +
          `Raise the limit with timeout_ms (e.g. timeout_ms: ${opts.timeout * 4}) for long commands like colcon build or apt install.`
      );
    }
    if (err instanceof ProcessError && opts.allowNonZeroExit && !isTransportFailure(config, err)) {
      return { stdout: err.stdout, stderr: err.stderr, exitCode: err.exitCode };
    }
    const sshError = sshFailureToError(err, sshBinFor(config));
    if (sshError) throw sshError;
    throw wrapAsMoss(err, ErrorCode.TOOL_EXECUTION_FAILED, {
      hint: 'Check SSH connectivity to the board',
      recoverable: true,
    });
  }
}


function withLineNumbers(text: string, startLine = 1): string {
  const lines = text.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(startLine + i).padStart(width)}\t${line}`).join('\n');
}

function b64(content: string): string {
  return Buffer.from(content, 'utf-8').toString('base64');
}





export function buildBoardWriteCommand(remotePath: string, content: string): string {
  const target = shellEscape(remotePath);
  const tmp = shellEscape(`${remotePath}.moss-tmp`);
  return (
    `mkdir -p "$(dirname ${target})" && ` +
    `printf '%s' ${shellEscape(b64(content))} | base64 -d > ${tmp} && ` +
    `mv -- ${tmp} ${target} && wc -c < ${target}`
  );
}


export const BOARD_MV_OK = '__MOSS_MV_OK__';
export const BOARD_MV_SRC_MISSING = '__MOSS_MV_SRC_MISSING__';
export const BOARD_MV_DEST_EXISTS = '__MOSS_MV_DEST_EXISTS__';

export function createBoardWorkspaceTools(
  config: DeviceSshConfig,
  options: BoardWorkspaceOptions = {},
  health?: DeviceConnectionHealth
): Tool[] {
  const runner = options.runProcessImpl ?? runProcess;
  const board = `${config.user || 'root'}@${config.host}`;
  const runBoard = (
    remoteCmd: string,
    opts: Omit<BoardRunOptions, 'health'>
  ): Promise<BoardRunResult> =>
    boardRun(config, remoteCmd, { ...opts, health, sshExecutor: options.sshExecutor });

  async function readRemoteFile(remotePath: string, ctx?: ToolContext): Promise<string> {
    const result = await runBoard(`cat -- ${shellEscape(remotePath)}`, {
      timeout: 20_000,
      ctx,
      runner,
      allowNonZeroExit: false,
    });
    return result.stdout;
  }

  async function writeRemoteFile(
    remotePath: string,
    content: string,
    ctx?: ToolContext
  ): Promise<number> {
    const expected = Buffer.byteLength(content, 'utf-8');
    if (expected > WRITE_LIMIT_BYTES) {
      throw new Error(
        `Content is ${expected} bytes; board write_file is capped at ${WRITE_LIMIT_BYTES}. Use exec with scp/rsync for large files.`
      );
    }
    const result = await runBoard(buildBoardWriteCommand(remotePath, content), {
      timeout: 30_000,
      ctx,
      runner,
      allowNonZeroExit: false,
    });
    const written = Number.parseInt(result.stdout.trim(), 10);
    if (!Number.isInteger(written) || written !== expected) {
      let errorMsg = `Write verification failed for ${remotePath}: expected ${expected} bytes, board reports ${result.stdout.trim() || '(nothing)'}.`;
      errorMsg += `\n\nDiagnostic steps:\n` +
        `  1. Check disk space: exec with "df -h / | head -2"\n` +
        `  2. Check file permissions: exec with "ls -l $(dirname ${remotePath})"\n` +
        `  3. For large files, use exec + scp/rsync instead of write_file`;

      if (result.stderr) {
        errorMsg += `\n\nBoard error:\n${result.stderr.trim()}`;
      }

      throw new Error(errorMsg);
    }
    return written;
  }

  const execBoard: Tool = {
    name: 'exec',
    description:
      `Execute a shell command ON THE CONNECTED BOARD (${board}) via SSH — board mode is active, this is not the host PC shell. ` +
      'Returns stdout + stderr. Each call is a fresh SSH session: `cd` does not persist, use absolute paths. ' +
      'For long-running processes use nohup ... & (there is no exec_background on the board). ' +
      'Local host execution is unavailable until /disconnect.',
    metadata: {
      sideEffectClass: 'device_mutation',
      planMode: 'requires_user_confirmation',
    },
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to execute on the board' },
        timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
      },
      required: ['command'],
    },
    async execute(input, ctx) {
      const timeoutMs = Number(input.timeout_ms) || 30_000;
      const safetyCheck = isCommandDangerous(input.command);
      if (safetyCheck.blocked) {
        return `Command blocked: ${safetyCheck.reason}`;
      }
      const result = await runBoard(input.command, {
        timeout: timeoutMs,
        ctx,
        runner,
        maxBuffer: 10 * 1024 * 1024,
        allowNonZeroExit: true,
      });
      if (result.exitCode !== 0) {
        const stdoutTrim = result.stdout.trim();
        const stderrTrim = result.stderr.trim();
        let output = `Command failed (exit ${result.exitCode})`;

        // Always separate stdout and stderr for better diagnostics
        if (stdoutTrim) {
          output += `\n[STDOUT]\n${stdoutTrim}`;
        }
        if (stderrTrim) {
          output += `\n[STDERR]\n${stderrTrim}`;
        }
        if (!stdoutTrim && !stderrTrim) {
          output += '\n(no output)';
        }

        // Add diagnostic hints for common exit codes
        if (result.exitCode === 1) {
          output += '\n\nHint: Exit 1 often means permission error or missing file. Try: ls -l <path>';
        } else if (result.exitCode === 126) {
          output += '\n\nHint: Exit 126 means permission denied. Check file permissions: ls -l <path>';
        } else if (result.exitCode === 127) {
          output += '\n\nHint: Exit 127 means command not found. Check the command name and PATH.';
        }

        return output;
      }
      const stderrRaw = result.stderr.trim();
      const stderrFmt = stderrRaw ? `[STDERR]\n${stderrRaw}` : '';
      const stdoutFmt = result.stdout.trim() || '(no output)';
      return stderrFmt ? `${stdoutFmt}\n\n${stderrFmt}` : stdoutFmt;
    },
  };

  const readFileBoard: Tool = {
    name: 'read_file',
    description:
      `Read a file FROM THE CONNECTED BOARD (${board}) — board mode is active. Paths are board paths (absolute, or relative to the SSH user's home). ` +
      'For large files pass `offset` (1-based start line) and/or `limit` (line count). ' +
      'Lines are prefixed with line numbers and a tab — never copy these prefixes into edit_file/write_file content.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path on the board' },
        offset: { type: 'number', description: '1-based line number to start reading from' },
        limit: { type: 'number', description: 'Maximum number of lines to read from `offset`' },
      },
      required: ['path'],
    },
    async execute(input, ctx) {
      const content = await readRemoteFile(input.path, ctx);
      const hasRange = input.offset !== undefined || input.limit !== undefined;
      if (hasRange) {
        const lines = content.split('\n');
        const start = Math.max(1, Math.floor(Number(input.offset) || 1));
        const count =
          input.limit !== undefined ? Math.max(0, Math.floor(Number(input.limit))) : lines.length;
        const slice = lines.slice(start - 1, start - 1 + count);
        const end = Math.min(lines.length, start - 1 + count);
        let body = slice.join('\n');
        let note = '';
        if (body.length > 100_000) {
          note = `\n\n[... truncated range, total ${body.length} chars]`;
          body = body.slice(0, 100_000);
        }
        return `[lines ${start}-${end} of ${lines.length}]\n${withLineNumbers(body, start)}${note}`;
      }
      if (content.length > 100_000) {
        return (
          withLineNumbers(content.slice(0, 100_000)) +
          `\n\n[... truncated, total ${content.length} chars — pass offset/limit to page through the rest]`
        );
      }
      return withLineNumbers(content);
    },
  };

  const writeFileBoard: Tool = {
    name: 'write_file',
    description:
      `Write content to a file ON THE CONNECTED BOARD (${board}) — board mode is active. Creates parent directories. ` +
      `Atomic (tmp + mv) and verified by byte count. Capped at ${WRITE_LIMIT_BYTES} bytes — use exec + scp for larger files.`,
    metadata: {
      sideEffectClass: 'device_mutation',
      planMode: 'requires_user_confirmation',
    },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path on the board' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
    async execute(input, ctx) {
      const written = await writeRemoteFile(input.path, String(input.content ?? ''), ctx);
      return `Successfully wrote ${written} bytes to ${input.path} on ${board} (verified).`;
    },
  };

  const editFileBoard: Tool = {
    name: 'edit_file',
    description:
      `Make a precise in-place edit to a file ON THE CONNECTED BOARD (${board}) by replacing an exact string — board mode is active. ` +
      '`old_string` must match EXACTLY and be unique unless `replace_all` is true. ' +
      "Never include read_file's line-number prefixes. The write-back is atomic and byte-count verified.",
    metadata: {
      sideEffectClass: 'device_mutation',
      planMode: 'requires_user_confirmation',
    },
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path on the board' },
        old_string: {
          type: 'string',
          description: 'Exact text to replace — must be unique unless replace_all is set',
        },
        new_string: {
          type: 'string',
          description: 'Replacement text (use "" to delete the matched text)',
        },
        replace_all: { type: 'boolean', description: 'Replace every occurrence (default false)' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(input, ctx) {
      const oldStr = String(input.old_string ?? '');
      const newStr = String(input.new_string ?? '');
      if (oldStr === '') {
        return 'Error: old_string is empty. To create or fully replace a file, use write_file instead.';
      }
      const content = await readRemoteFile(input.path, ctx);
      let occurrences = 0;
      for (
        let pos = content.indexOf(oldStr);
        pos !== -1;
        pos = content.indexOf(oldStr, pos + oldStr.length)
      ) {
        occurrences += 1;
      }
      if (occurrences === 0) {
        return `Error: old_string not found in ${input.path} on the board. Re-read the file and match the exact text.`;
      }
      if (occurrences > 1 && !input.replace_all) {
        return (
          `Error: old_string is not unique in ${input.path} (${occurrences} matches). ` +
          'Add more surrounding context, or pass replace_all: true.'
        );
      }
      const updated = input.replace_all
        ? content.split(oldStr).join(newStr)
        : content.replace(oldStr, newStr);
      await writeRemoteFile(input.path, updated, ctx);
      const label =
        input.replace_all && occurrences > 1 ? `${occurrences} occurrences` : '1 occurrence';
      return `Edited ${input.path} on ${board} (replaced ${label}, write verified).`;
    },
  };

  const listDirectoryBoard: Tool = {
    name: 'list_directory',
    description: `List files and directories ON THE CONNECTED BOARD (${board}) — board mode is active. Directories end with '/'.`,
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: "Directory path on the board (default: SSH user's home)",
        },
      },
    },
    async execute(input, ctx) {
      const dir = input.path || '.';
      const result = await runBoard(`ls -1Ap -- ${shellEscape(dir)}`, {
        timeout: 15_000,
        ctx,
        runner,
        allowNonZeroExit: false,
      });
      return result.stdout.trim() || '(empty directory)';
    },
  };

  const searchFilesBoard: Tool = {
    name: 'search_files',
    description: `Find files by name pattern ON THE CONNECTED BOARD (${board}) — board mode is active. Uses find -name/-path; returns up to 100 paths.`,
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description:
            'Filename glob (e.g. "*.launch.py"); patterns containing "/" match the whole path',
        },
        path: { type: 'string', description: "Directory to search in (default: SSH user's home)" },
      },
      required: ['pattern'],
    },
    async execute(input, ctx) {
      const dir = input.path || '.';
      const pattern = String(input.pattern);
      const matcher = pattern.includes('/')
        ? `-path ${shellEscape(pattern.startsWith('*') ? pattern : `*${pattern}`)}`
        : `-name ${shellEscape(pattern)}`;
      const result = await runBoard(
        `find ${shellEscape(dir)} ${matcher} 2>/dev/null | head -100`,
        { timeout: 20_000, ctx, runner, allowNonZeroExit: true }
      );
      const out = result.stdout.trim();
      return out || 'No files found';
    },
  };

  const searchCodeBoard: Tool = {
    name: 'search_code',
    description:
      `Search file contents by pattern ON THE CONNECTED BOARD (${board}) — board mode is active. ` +
      'Uses grep -rn (extended regex, case-insensitive). Returns matching lines as path:line:text. ' +
      'Example pattern: "^\\s*(TODO|FIXME)" to find comments, or "def main" for exact text.',
    metadata: { sideEffectClass: 'readonly', planMode: 'allow' },
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Extended regex pattern (grep -E syntax). Examples: "error|Error", "^class ", "TODO"',
        },
        path: {
          type: 'string',
          description: "Directory to search within (default: SSH user's home)",
        },
        fileTypes: {
          type: 'string',
          description:
            'Comma-separated file extensions to filter by (e.g. ".py,.yaml,.json"). Omit the leading dot; use ".cpp,.c" for C/C++.',
        },
        maxResults: {
          type: 'number',
          description: 'Max matching lines to return (default 50, max 200)',
        },
      },
      required: ['pattern'],
    },
    async execute(input, ctx) {
      const maxResults = Math.min(Number(input.maxResults) || 50, 200);
      const dir = input.path || '.';

      // Validate fileTypes format
      const exts = input.fileTypes
        ? String(input.fileTypes)
            .split(',')
            .map((e) => e.trim().replace(/^\./, ''))
            .filter((e) => {
              if (!e) return false;
              if (!/^[a-zA-Z0-9_]+$/.test(e)) return false;
              return true;
            })
        : [];

      if (input.fileTypes && exts.length === 0) {
        return `Error: Invalid fileTypes format. Use comma-separated extensions without leading dots, e.g. "py,yaml,json".\n` +
          `You provided: "${input.fileTypes}"`;
      }

      const includes = exts
        .map((ext) => `--include=${shellEscape(`*.${ext}`)}`)
        .join(' ');

      const cmd = `grep -rEni ${includes} -- ${shellEscape(String(input.pattern))} ${shellEscape(dir)} 2>/dev/null | head -${maxResults}`;
      const result = await runBoard(cmd, {
        timeout: 30_000,
        ctx,
        runner,
        allowNonZeroExit: true,
      });
      const out = result.stdout.trim();
      if (out) return out;



      if (result.exitCode <= 1) return 'No matches found';
      throw new Error(
        `search_code failed on the board (exit ${result.exitCode}): ${result.stderr.trim() || '(no stderr)'}`
      );
    },
  };

  const moveFileBoard: Tool = {
    name: 'move_file',
    description: `Move or rename a file or directory ON THE CONNECTED BOARD (${board}) — board mode is active. Outcome is marker-verified.`,
    metadata: {
      sideEffectClass: 'device_mutation',
      planMode: 'requires_user_confirmation',
    },
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Existing path on the board' },
        destination: { type: 'string', description: 'New path on the board' },
        overwrite: {
          type: 'boolean',
          description: 'Overwrite destination if it exists (default false)',
        },
      },
      required: ['source', 'destination'],
    },
    async execute(input, ctx) {
      const src = shellEscape(input.source);
      const dest = shellEscape(input.destination);
      const overwriteGuard = input.overwrite ? 'false' : `[ -e ${dest} ]`;
      const cmd =
        `if [ ! -e ${src} ]; then echo ${BOARD_MV_SRC_MISSING}; ` +
        `elif ${overwriteGuard}; then echo ${BOARD_MV_DEST_EXISTS}; ` +
        `else mkdir -p "$(dirname ${dest})" && mv -- ${src} ${dest} && echo ${BOARD_MV_OK}; fi`;
      const result = await runBoard(cmd, {
        timeout: 20_000,
        ctx,
        runner,
        allowNonZeroExit: false,
      });
      const out = result.stdout.trim();
      if (out.includes(BOARD_MV_SRC_MISSING))
        return `Error: source does not exist on the board: ${input.source}`;
      if (out.includes(BOARD_MV_DEST_EXISTS)) {
        return `Error: destination already exists on the board: ${input.destination} (pass overwrite=true to replace)`;
      }
      if (out.includes(BOARD_MV_OK))
        return `Moved ${input.source} -> ${input.destination} on ${board} (verified).`;
      throw new Error(
        `move_file could not verify the outcome (unexpected output): ${out || '(no output)'}`
      );
    },
  };

  return [
    execBoard,
    readFileBoard,
    writeFileBoard,
    editFileBoard,
    listDirectoryBoard,
    searchFilesBoard,
    searchCodeBoard,
    moveFileBoard,
  ];
}
