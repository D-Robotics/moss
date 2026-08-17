import path from 'node:path';
import type { MossAgent } from '../core/agent/moss-agent.js';
import { startMossWebServer } from '../web-ui/web-server.js';
import { runAcpStdioServer } from './acp-server.js';
import type { ParsedCliArgs } from './args.js';
import { resolveConfigDir } from './config.js';

/** Run a long-lived host transport after the CLI agent has been fully composed. @internal */
export async function runCliHostCommand(
  agent: MossAgent,
  args: Pick<ParsedCliArgs, 'command' | 'commandArgs'>,
  quiet: boolean
): Promise<boolean> {
  if (args.command !== 'agent' && args.command !== 'web') return false;
  const abort = new AbortController();
  const onSigInt = () => abort.abort();
  process.on('SIGINT', onSigInt);
  try {
    if (args.command === 'agent') {
      const mode = args.commandArgs[0];
      if (mode && mode !== 'stdio') {
        console.error(
          `[agent] unsupported mode "${mode}". Supported: stdio (default). Usage: moss agent [stdio].`
        );
        process.exitCode = 2;
        return true;
      }
      if (!quiet)
        console.error('[agent] ACP stdio server ready (NDJSON JSON-RPC on stdin/stdout).');
      await runAcpStdioServer(agent, { abortSignal: abort.signal });
      return true;
    }

    const rawPort = args.commandArgs[0];
    const port = rawPort === undefined ? 3080 : Number(rawPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      console.error('[web] port must be an integer from 0 to 65535. Usage: moss web [port].');
      process.exitCode = 2;
      return true;
    }
    const taskRunFile = agent.config.workspaceDir
      ? path.join(agent.config.workspaceDir, '.moss', 'task-runs.jsonl')
      : undefined;
    const web = await startMossWebServer(agent, {
      port,
      abortSignal: abort.signal,
      taskRunFile,
      configDir: resolveConfigDir(),
    });
    console.error(`[web] Moss is ready at ${web.url}`);
    console.error('[web] Press Ctrl+C to stop. Provider credentials stay in this process.');
    await new Promise<void>((resolve) =>
      abort.signal.addEventListener('abort', () => resolve(), { once: true })
    );
    await web.close().catch(() => {});
    return true;
  } finally {
    process.off('SIGINT', onSigInt);
  }
}
