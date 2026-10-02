import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const tsRuntimeFiles = ['src/**/*.ts'];
const repositoryScriptFiles = ['*.mjs', 'scripts/**/*.mjs'];
const testFiles = ['test/**/*.mjs'];
const configurationFiles = ['eslint.config.mjs', '*.config.{js,mjs,cjs}'];

const nodeLanguageOptions = {
  ecmaVersion: 'latest',
  sourceType: 'module',
  globals: globals.node,
};

const javascriptRules = {
  ...js.configs.recommended.rules,
  'no-constant-condition': 'off',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    },
  ],
};

const testRules = {
  ...javascriptRules,
  'no-unused-vars': [
    'error',
    {
      args: 'none',
      caughtErrorsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/docs-api/**',
      '.codegraph/**',
      '.moss/**',
      '.tmp/**',
    ],
  },
  {
    name: 'moss/repository-scripts',
    files: repositoryScriptFiles,
    languageOptions: nodeLanguageOptions,
    rules: javascriptRules,
  },
  {
    name: 'moss/tests',
    files: testFiles,
    languageOptions: nodeLanguageOptions,
    rules: testRules,
  },
  {
    name: 'moss/intentional-test-fixtures',
    files: ['test/cli-tui-noise.spec.mjs', 'test/loop-first-chunk-hard-timeout.spec.mjs'],
    rules: {
      // These tests deliberately match raw ANSI bytes and model a generator
      // that stalls before its first yield.
      'no-control-regex': 'off',
      'require-yield': 'off',
    },
  },
  {
    name: 'moss/configuration',
    files: configurationFiles,
    languageOptions: nodeLanguageOptions,
    rules: javascriptRules,
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: tsRuntimeFiles,
  })),
  {
    name: 'moss/typescript-runtime',
    files: tsRuntimeFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          disallowTypeAnnotations: false,
          fixStyle: 'inline-type-imports',
          prefer: 'type-imports',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': ['error', { ignoreIIFE: true, ignoreVoid: true }],
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/switch-exhaustiveness-check': [
        'error',
        { considerDefaultExhaustiveForUnions: true },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'CatchClause TSAnyKeyword',
          message:
            'Catch values must remain unknown and be narrowed before use; catch (error: any) is forbidden.',
        },
      ],
      'no-constant-condition': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // ---- 架构边界：依赖只能指向内层（见 docs/superpowers/plans/2026-09-28-moss-clean-architecture-cleanup.md §0.3）
  {
    name: 'moss/boundary-root',
    files: ['src/errors.ts', 'src/logger.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '\\.', message: '根级 errors/logger 不得依赖任何模块' }] },
      ],
    },
  },
  {
    name: 'moss/boundary-contracts',
    files: ['src/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '\\.\\./(errors|logger|utils|safety|provider|context|core|tools|cli)',
              message: 'contracts 是共享内核，不得依赖上层模块',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-utils-safety',
    files: ['src/utils/**/*.ts', 'src/safety/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '\\.\\./(safety|provider|context|core|tools|cli)/',
              message: 'utils/safety 是底层，不得依赖上层模块',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-provider',
    files: ['src/provider/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 豁免：llm/llm-provider —— 端口，长期合法（T5.1 已移除 llm-error-classifier 豁免）
              regex: '\\.\\./core/(?!llm/llm-provider)',
              message: 'provider 只允许依赖 core/llm 端口；其余 core 依赖均为越界',
            },
            { regex: '\\.\\./cli/', message: 'provider 不得依赖 UI 层' },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-context',
    files: ['src/context/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '\\.\\./core/',
              message: 'context 不得依赖 core；共享类型走 contracts',
            },
            { regex: '\\.\\./cli/', message: 'context 不得依赖 UI 层' },
          ],
        },
      ],
    },
  },
  // core 的 tools 边界按文件深度拆两个块：`../` 段数与文件深度相同时才指向 src/tools
  // （core 内部管线 src/core/tools/ 用 `./tools/` 或 `../tools/` 到达，必须放行）。
  {
    name: 'moss/boundary-core-depth1',
    files: ['src/core/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '\\.\\./tools/',
              message: 'core 只依赖 contracts/provider/context；src/tools 具体工具实现禁止',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-core',
    files: ['src/core/*/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 后台完成的 tracker/注册表已归位到 core/tools（core 自有的工具管线），
              // core 对 src/tools（外层具体实现）的引用为硬边界。
              regex: '\\.\\./\\.\\./tools/',
              message: 'core 只依赖 contracts/provider/context；src/tools 具体工具实现禁止',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-device',
    files: ['src/device/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '\\.\\./(provider|context|core|tools|cli)/',
              message:
                'device 是设备能力层（与 provider/context 同级），不得依赖更外层模块；共享类型走 contracts',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-mcp',
    // v0.16 MCP 客户端端口（src/core/mcp）：只许依赖内层
    // (contracts/errors/logger/utils/safety/provider/context) 与 core 内部共享类型；
    // 禁止依赖 src/tools 具体工具实现、UI 层与 core 其他子系统。
    files: ['src/core/mcp/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '\\.\\./\\.\\./tools/',
              message: 'mcp 端口不得依赖 src/tools 具体工具实现（契约经 core/tools 类型）',
            },
            { regex: '\\.\\./\\.\\./cli/', message: 'mcp 端口不得依赖 UI 层' },
            {
              regex: '\\.\\./\\.\\./core/',
              message: 'mcp 端口不得依赖 core 其他子系统（agent/loop/session/subagent）',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-tools',
    files: ['src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '\\.\\./cli/',
              message: '工具层不得依赖 UI 层（交互能力经 core 端口注入）',
            },
          ],
        },
      ],
    },
  }
);
