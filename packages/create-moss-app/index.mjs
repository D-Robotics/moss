#!/usr/bin/env node

/**
 * create-moss-app — scaffold a new Moss agent project from zero to running.
 *
 * **Responsibility**
 * Scaffolding only: generates a project directory, writes template files, and
 * runs `npm install`. It does NOT own the agent runtime — that is @rdk-moss/agent.
 *
 * **Key concepts**
 * - Templates: "minimal" (default) and "openai" are the built-in starting points.
 *   Each template declares which API key env var the user must set and which
 *   @rdk-moss/agent version to depend on.
 * - Version pinning: when run from inside the moss monorepo, the scaffolded
 *   project uses local workspace versions; otherwise it pins to the latest
 *   published @rdk-moss/agent release.
 * - Package name: derived from the target directory name, normalized to a valid
 *   npm package name (lowercase, hyphens).
 *
 * **Dependency direction**
 * create-moss-app → @rdk-moss/agent (runtime) → @rdk-moss/core (contracts)
 * This file must not import from @rdk-moss/agent or @rdk-moss/core directly;
 * only Node.js built-ins are allowed here.
 *
 * **Usage**
 *   npm create moss-app my-agent
 *   npx create-moss-app my-agent
 *   npx create-moss-app my-agent --template openai
 *   npx create-moss-app my-agent --skip-install
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Offline fallback ONLY — the latest PUBLISHED version is queried from npm at
// scaffold time (see mossVersionRange). These hardcoded ranges must be kept on
// a published version; a stale range still resolves (caret allows same-major
// bumps), so they age gracefully until the next release refresh.
const FALLBACK_VERSION_RANGE = {
  '@rdk-moss/core': '^0.6.0',
  '@rdk-moss/agent': '^0.5.1',
};
const DEFAULT_MOSS_VERSION_RANGE = FALLBACK_VERSION_RANGE['@rdk-moss/core'];

/**
 * Query npm for the latest PUBLISHED version of a package. Returns null if
 * offline or the package is unknown. Used so the scaffolded project's
 * `npm install` always resolves — the local workspace version may be an
 * unpublished release candidate (e.g. 0.4.2 bumped locally but not yet on
 * npm), and writing that into a user's package.json breaks their install.
 */
function latestPublishedVersion(packageName) {
  try {
    const result = spawnSync('npm', ['view', packageName, 'version'], {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['pipe', 'pipe', 'pipe'],
      // npm is a .cmd shim on Windows. The command and package names here are
      // internal constants, so using the platform shell does not expose user
      // input to shell parsing.
      shell: process.platform === 'win32',
    });
    if (result.status === 0) {
      const v = result.stdout.trim();
      if (v && /^\d+\.\d+\.\d+/.test(v)) return v;
    }
  } catch {
    // offline or npm unavailable — fall through to the hardcoded fallback
  }
  return null;
}

function mossVersionRange(packageName) {
  // Prefer the latest published version so the user's `npm install` resolves.
  const published = latestPublishedVersion(packageName);
  if (published) return `^${published}`;
  // Offline fallback: a hardcoded published range (NOT the local workspace
  // version, which may be unpublished). Stale but still installable.
  return FALLBACK_VERSION_RANGE[packageName] ?? DEFAULT_MOSS_VERSION_RANGE;
}

function toPackageName(name) {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'moss-agent';
}

function shellQuotePath(value) {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

const TEMPLATES = {
  minimal: {
    description: 'Minimal Moss agent with Anthropic API key support (default)',
    primaryApiKeyEnv: 'ANTHROPIC_API_KEY',
    fallbackApiKeyEnv: 'MOSS_API_KEY',
    files: {
      'index.ts': `import { MossAgent, InMemorySessionStore, AnthropicLLMProvider } from '@rdk-moss/agent';

const API_KEY = process.env.ANTHROPIC_API_KEY || process.env.MOSS_API_KEY || '';
const MODEL = process.env.ANTHROPIC_MODEL || process.env.MOSS_MODEL || 'claude-sonnet-4-20250514';

if (!API_KEY) {
  console.error('No API key found. Set ANTHROPIC_API_KEY (or MOSS_API_KEY) to your Anthropic key, then run again.');
  process.exit(1);
}

const provider = new AnthropicLLMProvider({ apiKey: API_KEY });

const agent = new MossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  model: MODEL,
});

// Load MCP servers from mcp.json (copy mcp.json.example to mcp.json and edit)
// import { loadMcpConfig, connectMcpServers } from '@rdk-moss/agent';
// const config = loadMcpConfig('./mcp.json');
// if (config) {
//   const connections = await connectMcpServers(config);
//   for (const conn of connections) {
//     for (const tool of conn.tools) {
//       agent.tools.register(tool);
//     }
//   }
// }

// Print only AFTER the call succeeds, so the line reflects what actually happened.
const result = await agent.chat('demo', 'Hello! What can you help me with?');
console.log(\`[\${MODEL}] Agent:\`, result.response);
`,
    },
  },
  openai: {
    description: 'Agent with OpenAI-compatible provider',
    primaryApiKeyEnv: 'OPENAI_API_KEY',
    fallbackApiKeyEnv: 'MOSS_API_KEY',
    files: {
      'index.ts': `import { MossAgent, InMemorySessionStore, OpenAILLMProvider } from '@rdk-moss/agent';

const API_KEY = process.env.OPENAI_API_KEY || process.env.MOSS_API_KEY || '';
const BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const MODEL = process.env.MOSS_MODEL || 'gpt-4o';

if (!API_KEY) {
  console.error('No API key found. Set OPENAI_API_KEY (or MOSS_API_KEY), then run again.');
  process.exit(1);
}

const provider = new OpenAILLMProvider({ apiKey: API_KEY, baseUrl: BASE_URL });

const agent = new MossAgent({
  llmProvider: provider,
  sessionStore: new InMemorySessionStore(),
  model: MODEL,
});

// Print only AFTER the call succeeds, so the line reflects what actually happened.
const result = await agent.chat('demo', 'Hello! What can you help me with?');
console.log(\`[\${MODEL}] Agent:\`, result.response);
`,
    },
  },
};

const COMMON_FILES = {
  'mcp.json.example': `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed/dir"],
      "env": {}
    }
  }
}
`,
};

function printUsage() {
  console.log(`
  create-moss-app <project-name> [--template <name>] [--skip-install]

  Templates:
    minimal   ${TEMPLATES.minimal.description}
    openai    ${TEMPLATES.openai.description}

  Examples:
    npx create-moss-app my-agent
    npx create-moss-app my-agent --template openai
    npx create-moss-app my-agent --skip-install
    npm create moss-app my-agent
`);
}

// Check Node.js version before doing anything else — a version mismatch produces
// confusing errors deep in the scaffolding rather than a clear message.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 16)) {
  console.error(
    `create-moss-app requires Node.js >= 22.16.0, but you are running ${process.version}.`
  );
  console.error('Please upgrade Node.js: https://nodejs.org/en/download');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
  printUsage();
  process.exit(0);
}

// Reject unknown flags loudly instead of silently ignoring them — a typo'd flag
// must not produce a project that quietly drops the user's intent.
const KNOWN_FLAGS = new Set(['--template', '--skip-install', '--help', '-h']);
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith('-')) continue;
  if (!KNOWN_FLAGS.has(a)) {
    console.error(`Unknown option: ${a}`);
    console.error(`Known options: ${[...KNOWN_FLAGS].join(', ')}`);
    process.exit(1);
  }
  if (a === '--template') {
    const value = args[i + 1];
    if (!value || value.startsWith('-')) {
      console.error('--template requires a value (e.g. --template openai)');
      process.exit(1);
    }
    i++; // skip the consumed value
  }
}

const projectArg = args[0];
const templateIdx = args.indexOf('--template');
const templateName = templateIdx !== -1 ? args[templateIdx + 1] : 'minimal';
const skipInstall = args.includes('--skip-install');

if (!projectArg || projectArg.startsWith('-')) {
  console.error('Please provide a project name.');
  printUsage();
  process.exit(1);
}

const template = TEMPLATES[templateName];
if (!template) {
  console.error(`Unknown template: ${templateName}`);
  console.error(`Available: ${Object.keys(TEMPLATES).join(', ')}`);
  process.exit(1);
}

const targetDir = path.resolve(process.cwd(), projectArg);
const projectDirName = path.basename(targetDir);
const projectName = toPackageName(projectDirName);
const cdTarget = shellQuotePath(path.relative(process.cwd(), targetDir) || '.');

if (fs.existsSync(targetDir)) {
  console.error(`Directory '${targetDir}' already exists.`);
  process.exit(1);
}

console.log(`\nCreating Moss project: ${projectDirName}`);
if (projectName !== projectDirName) console.log(`Package name: ${projectName}`);
console.log(`Template: ${templateName}\n`);

fs.mkdirSync(targetDir, { recursive: true });

const packageJson = {
  name: projectName,
  private: true,
  type: 'module',
  scripts: {
    start: 'tsx index.ts',
    typecheck:
      'tsc --noEmit --esModuleInterop --module ESNext --moduleResolution Bundler --target ES2022 --types node --strict --skipLibCheck index.ts',
  },
  dependencies: {
    '@rdk-moss/core': mossVersionRange('@rdk-moss/core'),
    '@rdk-moss/agent': mossVersionRange('@rdk-moss/agent'),
  },
  devDependencies: {
    '@types/node': '^22.13.10',
    tsx: '^4.19.3',
    typescript: '^5.7.3',
  },
};

fs.writeFileSync(path.join(targetDir, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');

for (const [filename, content] of Object.entries({ ...COMMON_FILES, ...template.files })) {
  fs.writeFileSync(path.join(targetDir, filename), content);
}

const readme = `# ${projectDirName}

A Moss agent project.

## Prerequisites

- Node.js 22.16 or newer
- Optional for device tools: OpenSSH Client (ssh) on the host
- Optional for password-based SSH: sshpass on Unix-like hosts, or WSL on Windows. Key-based auth with MOSS_DEVICE_KEY is recommended on Windows.

## Setup

\`\`\`sh
npm install
\`\`\`

## Run

Set your provider key and start the agent:

\`\`\`sh
${template.primaryApiKeyEnv}=your-key npm start
\`\`\`

Windows PowerShell:

\`\`\`powershell
$env:${template.primaryApiKeyEnv}="your-key"; npm start
\`\`\`

Windows cmd.exe:

\`\`\`bat
set ${template.primaryApiKeyEnv}=your-key && npm start
\`\`\`

Verify the build anytime: \`npm run typecheck\`.

The generated template also accepts \`${template.fallbackApiKeyEnv}\` as a compatibility fallback.

## MCP (Model Context Protocol)

MCP lets your agent use external tools (filesystem, databases, APIs) via standardized servers.

1. Copy the example config:
   \`\`\`sh
   cp mcp.json.example mcp.json
   \`\`\`

   Windows PowerShell:
   \`\`\`powershell
   Copy-Item mcp.json.example mcp.json
   \`\`\`

   Windows cmd.exe:
   \`\`\`bat
   copy mcp.json.example mcp.json
   \`\`\`
2. Edit \`mcp.json\` to point to your desired directories or services.
3. Uncomment the MCP loading code in \`index.ts\` to connect MCP servers and register their tools with your agent.

See the [MCP documentation](https://modelcontextprotocol.io) for available servers and configuration options.

## Learn More

- [Moss Documentation](https://github.com/D-Robotics/moss)
`;

fs.writeFileSync(path.join(targetDir, 'README.md'), readme);

console.log('  Created package.json');
console.log('  Created index.ts');
console.log('  Created mcp.json.example');
console.log('  Created README.md');

let needsInstall = skipInstall;
if (skipInstall) {
  console.log('\nSkipped dependency install.');
} else {
  try {
    console.log('\nInstalling dependencies...');
    execSync('npm install', { cwd: targetDir, stdio: 'inherit' });
  } catch {
    // Don't fake success: surface the failure and exit non-zero so a wrapping
    // script/CI notices, while still printing actionable next steps below.
    console.error(
      '\nnpm install failed. Run `npm install` in the project directory before starting.'
    );
    process.exitCode = 1;
    needsInstall = true;
  }
}

const keyVar = template.primaryApiKeyEnv;
const installStep = needsInstall ? '\n  npm install' : '';
console.log(`
Done! Next steps — set your provider key and run the agent:

  cd ${cdTarget}${installStep}
  ${keyVar}=your-key npm start

Windows PowerShell:

  cd ${cdTarget}${installStep}
  $env:${keyVar}="your-key"; npm start

Windows cmd.exe:

  cd ${cdTarget}${installStep}
  set ${keyVar}=your-key && npm start

No key yet? Get one from your provider, or see README.md (${keyVar} or MOSS_API_KEY).
Verify the build anytime:  npm run typecheck
`);
