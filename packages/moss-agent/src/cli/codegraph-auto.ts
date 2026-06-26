/**
 * CodeGraph 自动检测、初始化与注册 —— 默认行为：当 `codegraph` 二进制文件在
 * PATH 上时，自动在工作区中构建 `.codegraph/` 索引并启动 MCP 服务器。
 *
 * 这样 moss 无需手动配置即可使 CodeGraph 相关的结构感知工具
 * （codegraph_search、codegraph_callers 等）可用。
 *
 * 环境变量：
 *  - `MOSS_CODEGRAPH_ENABLED=0` 禁用自动检测与初始化（完全 opt-out）
 *  - `MOSS_CODEGRAPH_CMD` 覆盖 codegraph 命令路径
 *  - `MOSS_CODEGRAPH_AUTO_INIT=0` 仅禁用自动 init，索引存在时仍启动（部分 opt-out）
 */
import { runProcess } from '../utils/run-process.js';
import { connectMcpServers, type McpConnection, type McpConfig } from '../mcp/index.js';
import path from 'node:path';
import fs from 'node:fs';

export interface CodeGraphAutoResult {
  /** 已建立的 MCP 连接（已注册工具），检测失败时为空。 */
  connections: McpConnection[];
  /** 用户可操作的消息（仅在交互模式下展示）。 */
  notice?: string;
}

/** `MOSS_CODEGRAPH_CMD` 环境变量覆盖默认命令（用于测试或非标准安装）。惰性读取以支持运行时环境变量变更。 */
function getCodegraphCmd(): string {
  return process.env.MOSS_CODEGRAPH_CMD || 'codegraph';
}

/**
 * 全局 opt-out：`MOSS_CODEGRAPH_ENABLED=0` 完全禁用 CodeGraph 自动检测。
 * `MOSS_CODEGRAPH_AUTO_INIT=0` 仅在索引不存在时跳过自动 init。
 */
const CODEGRAPH_ENABLED = process.env.MOSS_CODEGRAPH_ENABLED !== '0';
const CODEGRAPH_AUTO_INIT = process.env.MOSS_CODEGRAPH_AUTO_INIT !== '0';
/** 自动 init 超时（避免阻塞启动），之后启动 serve 的超时由 connectMcpServers 管理。 */
const CODEGRAPH_INIT_TIMEOUT_MS = 30_000;

/** 检查 `codegraph` 是否在 PATH 上（平台无关，非阻塞）。 */
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

/**
 * 自动在工作区中初始化 `.codegraph/` 索引（`codegraph init -i`）。
 * 仅在二进制可用且 opt-in 时调用；失败静默回退到未初始化状态。
 *
 * @returns true 如果初始化成功（`.codegraph/` 现在存在且为目录）
 */
async function autoInitCodeGraph(workspaceDir: string): Promise<boolean> {
  const codegraphDir = path.join(workspaceDir, '.codegraph');
  if (fs.existsSync(codegraphDir) && fs.statSync(codegraphDir).isDirectory()) {
    return true; // 已存在，无需重新初始化
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

/**
 * 自动检测 CodeGraph 并注册其工具。
 *
 * 默认检测逻辑（当 `MOSS_CODEGRAPH_ENABLED != 0` 时）：
 * 1. 检查 codegraph 二进制是否在 PATH 上。
 * 2. 如果 `.codegraph/` 存在 → 直接启动 serve。
 * 3. 如果 `.codegraph/` 不存在且在交互模式 → 自动 `codegraph init -i` 然后启动 serve。
 * 4. 如果 `.codegraph/` 不存在且非交互模式 → 仅返回 notice（不阻塞非交互管道）。
 *
 * 退出方式：
 *  - `MOSS_CODEGRAPH_ENABLED=0` → 完全不检测 CodeGraph
 *  - `MOSS_CODEGRAPH_AUTO_INIT=0` → 不自动 init，仅在索引已存在时启动
 *
 * @param workspaceDir — 工作区根目录（`.codegraph/` 的搜索位置）
 * @param interactive — 是否在交互模式下运行（影响是否自动 init）
 */
export async function autoRegisterCodeGraphTools(
  workspaceDir: string,
  interactive: boolean,
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
      // 初始化成功，继续启动 serve
    } else {
      const notice = CODEGRAPH_AUTO_INIT
        ? `CodeGraph is available. Run \`${getCodegraphCmd()} init -i\` in this workspace to build the structural index for faster code navigation.`
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
