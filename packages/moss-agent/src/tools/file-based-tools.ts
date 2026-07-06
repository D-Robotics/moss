/**
 * File-based custom tools — `.moss/tools/<name>.tool.json`.
 *
 * Each file defines a tool that wraps a shell command with a JSON schema for
 * input validation. The command receives the validated input as JSON on stdin,
 * runs in the workspace directory, and its stdout is returned as the tool
 * result. This is the lightweight path for users who want a named, schema-
 * validated tool without writing an MCP server or embedding moss as a library.
 *
 * Example `.moss/tools/deploy.tool.json`:
 * ```json
 * {
 *   "name": "deploy_staging",
 *   "description": "Deploy the web app to staging. Pass confirm=true to proceed.",
 *   "command": "./scripts/deploy.sh",
 *   "inputSchema": {
 *     "type": "object",
 *     "properties": { "confirm": { "type": "boolean" } },
 *     "required": ["confirm"]
 *   },
 *   "sideEffect": "local_write",
 *   "planMode": "requires_user_confirmation"
 * }
 * ```
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Tool } from '../core/tools/tool-types.js';
import { runProcess } from '../utils/run-process.js';
import { isCommandDangerous } from '../safety/channel-safety.js';
import { errorMessage } from '../errors.js';

export interface FileBasedToolDefinition {
  name: string;
  description: string;
  /** Shell command to run. The validated JSON input is piped to stdin. */
  command: string;
  /** JSON Schema for the tool's input. */
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** Side-effect class: 'readonly' | 'local_write' | 'runtime_state'. Default: 'runtime_state'. */
  sideEffect?: 'readonly' | 'local_write' | 'runtime_state';
  /** Plan mode: 'allow' | 'requires_user_confirmation'. Default: 'requires_user_confirmation'. */
  planMode?: 'allow' | 'requires_user_confirmation';
  /** Max runtime in ms. Default: 120000. */
  timeoutMs?: number;
}

/**
 * Load all file-based tool definitions from `.moss/tools/*.tool.json` in the
 * workspace. Returns an empty array if the directory doesn't exist or no files
 * match. Malformed files are skipped with a warning (best-effort — a broken
 * tool file must not prevent moss from starting).
 */
export function loadFileBasedToolDefinitions(workspaceDir: string): FileBasedToolDefinition[] {
  const toolsDir = path.join(workspaceDir, '.moss', 'tools');
  if (!fs.existsSync(toolsDir)) return [];
  const defs: FileBasedToolDefinition[] = [];
  for (const file of fs.readdirSync(toolsDir)) {
    if (!file.endsWith('.tool.json')) continue;
    const filePath = path.join(toolsDir, file);
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (
        typeof raw.name === 'string' && raw.name.trim() &&
        typeof raw.description === 'string' &&
        typeof raw.command === 'string' && raw.command.trim() &&
        raw.inputSchema && typeof raw.inputSchema === 'object'
      ) {
        defs.push(raw as FileBasedToolDefinition);
      } else {
        console.error(`[moss:tools] skipping ${file}: missing required fields (name, description, command, inputSchema)`);
      }
    } catch (err) {
      console.error(`[moss:tools] skipping ${file}: ${errorMessage(err)}`);
    }
  }
  return defs;
}

/**
 * Create a Tool from a file-based definition. The tool runs the defined shell
 * command with the validated JSON input piped to stdin, and returns stdout.
 * `isCommandDangerous` is applied as a safety backstop.
 */
export function createFileBasedTool(def: FileBasedToolDefinition): Tool {
  const timeoutMs = def.timeoutMs ?? 120_000;
  return {
    name: def.name,
    description: def.description,
    metadata: {
      sideEffectClass: def.sideEffect ?? 'runtime_state',
      planMode: def.planMode ?? 'requires_user_confirmation',
    },
    inputSchema: def.inputSchema,
    async execute(input, ctx) {
      // Safety backstop: check the command (not the input) for dangerous patterns.
      const danger = isCommandDangerous(def.command);
      if (danger.blocked) {
        return `Command blocked: ${danger.reason}`;
      }
      try {
        const result = await runProcess(def.command, {
          args: [],
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024,
          signal: ctx.abortSignal,
          cwd: ctx.workspaceDir,
          stdin: JSON.stringify(input),
        });
        const out = result.stdout.trim();
        const err = result.stderr.trim();
        if (result.exitCode !== 0) {
          return `Command failed (exit ${result.exitCode}):\n${out || err || '(no output)'}`;
        }
        return out || '(no output)';
      } catch (err) {
        const anyErr = err as { stdout?: string; stderr?: string; exitCode?: number };
        if (anyErr.stdout !== undefined) {
          const out = (anyErr.stdout || '').trim();
          const e = (anyErr.stderr || '').trim();
          return `Command failed (exit ${anyErr.exitCode}):\n${out || e || '(no output)'}`;
        }
        return `Error running ${def.name}: ${errorMessage(err)}`;
      }
    },
  };
}

/**
 * Load and instantiate all file-based tools from `.moss/tools/`. Returns an
 * array of Tool instances ready to register.
 */
export function loadFileBasedTools(workspaceDir: string): Tool[] {
  return loadFileBasedToolDefinitions(workspaceDir).map(createFileBasedTool);
}
