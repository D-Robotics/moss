import js from '@eslint/js';
import tsdoc from 'eslint-plugin-tsdoc';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const tsRuntimeFiles = ['packages/*/src/**/*.ts'];
const repositoryScriptFiles = [
  '*.mjs',
  'benchmarks/**/*.mjs',
  'scripts/**/*.mjs',
  'packages/*/scripts/**/*.mjs',
  'packages/create-moss-app/*.mjs',
];
const testFiles = ['packages/*/test/**/*.mjs', 'scripts/test/**/*.mjs'];
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
      'external/**',
      'openspec/**',
      'packages/moss-agent/assets/**',
      'packages/moss-agent/src/run-observer/**',
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
    files: [
      'packages/moss-agent/test/cli-tui-noise.spec.mjs',
      'packages/moss-agent/test/loop-first-chunk-hard-timeout.spec.mjs',
    ],
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
    plugins: { tsdoc },
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
      'tsdoc/syntax': 'error',
      'no-constant-condition': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  }
);
