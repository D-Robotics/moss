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
              // 豁免（随 Phase 5 收紧）：
              //   llm/llm-provider           —— 端口，长期合法
              //   llm/llm-error-classifier   —— T5.1 移除
              regex: '\\.\\./core/(?!llm/llm-provider|llm/llm-error-classifier)',
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
              // 豁免：background-completion 的 exec 注册表依赖
              // （T3.3 将 tracker 移入 core/loop 后，其读取 background-exec
              //  进程注册表/状态队列的 import 仍留在 tools，待后续归位）。
              regex: '\\.\\./\\.\\./tools/(?!background-exec|background-completion-state)',
              message: 'core 只依赖 contracts/provider/context；src/tools 具体工具实现禁止',
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
