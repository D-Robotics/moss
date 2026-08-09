import { runProcess } from '../utils/run-process.js';
import { connectMcpServers, type McpConnection, type McpConfig } from '../mcp/index.js';
import path from 'node:path';
import fs from 'node:fs';

export interface CodeGraphAutoResult {
  connections: McpConnection[];

  notice?: string;
}

function getCodegraphCmd(): string {
  return process.env.MOSS_CODEGRAPH_CMD || 'codegraph';
}

const CODEGRAPH_ENABLED = process.env.MOSS_CODEGRAPH_ENABLED !== '0';
const CODEGRAPH_AUTO_INIT = process.env.MOSS_CODEGRAPH_AUTO_INIT !== '0';

const CODEGRAPH_INIT_TIMEOUT_MS = 30_000;

async function codegraphOnPath(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      await runProcess('where', { args: [getCodegraphCmd()], timeout: 3000 });
    } else {
      await runProcess('which', { args: [getCodegraphCmd()], timeout: 3000 });
    }
    return true;
  } catch {
    return false;
  }
}

async function autoInitCodeGraph(workspaceDir: string): Promise<boolean> {
  const codegraphDir = path.join(workspaceDir, '.codegraph');
  if (fs.existsSync(codegraphDir) && fs.statSync(codegraphDir).isDirectory()) {
    return true;
  }
  try {
    await runProcess(getCodegraphCmd(), {
      args: ['init', '-i'],
      cwd: workspaceDir,
      timeout: CODEGRAPH_INIT_TIMEOUT_MS,
    });
    return fs.existsSync(codegraphDir) && fs.statSync(codegraphDir).isDirectory();
  } catch {
    return false;
  }
}

export async function autoRegisterCodeGraphTools(
  workspaceDir: string,
  interactive: boolean
): Promise<CodeGraphAutoResult> {
  if (!CODEGRAPH_ENABLED) {
    return { connections: [] };
  }

  if (!(await codegraphOnPath())) return { connections: [] };

  const codegraphDir = path.join(workspaceDir, '.codegraph');
  const indexExists = fs.existsSync(codegraphDir) && fs.statSync(codegraphDir).isDirectory();

  if (!indexExists) {
    if (interactive && CODEGRAPH_AUTO_INIT) {
      const initOk = await autoInitCodeGraph(workspaceDir);
      if (!initOk) {
        return {
          connections: [],
          notice: `CodeGraph is available but auto-init failed. Run \`${getCodegraphCmd()} init -i\` manually in this workspace.`,
        };
      }
    } else {
      const notice = CODEGRAPH_AUTO_INIT
        ? `CodeGraph is available. Run \`${getCodegraphCmd()} init -i\` in this workspace to build the structural index for faster code navigation. (Set MOSS_CODEGRAPH_ENABLED=0 to disable.)`
        : undefined;
      return { connections: [], notice };
    }
  }

  const config: McpConfig = {
    mcpServers: {
      codegraph: {
        command: getCodegraphCmd(),
        args: ['serve'],
        cwd: workspaceDir,
        // Structural queries (codegraph_trace / codegraph_impact) on large
        // repos can exceed the MCP default 30s request timeout and surface as
        // opaque connection errors. Give codegraph a more generous budget.
        requestTimeoutMs: 120_000,
      },
    },
  };

  try {
    const connections = await connectMcpServers(config);
    return { connections };
  } catch {
    return { connections: [] };
  }
}
