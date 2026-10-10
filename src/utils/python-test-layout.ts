/**
 * Pytest vs unittest layout, read from the files that are actually present.
 * A pytest config wins. Otherwise `import unittest` in test modules selects
 * `python -m unittest discover`. A bare `test_*.py` with neither signal is
 * `loose` (the caller may confirm pytest). Sync and bounded so /goal can
 * propose a command without spawning a runner.
 */
import fs from 'node:fs';
import path from 'node:path';

export type PythonTestLayout = 'pytest' | 'unittest' | 'loose' | 'none';

export const UNITTEST_IMPORT = /(?:^|\n)\s*(?:import\s+unittest\b|from\s+unittest\b)/;

const PYTEST_CONFIG_FILES = ['pytest.ini', 'pytest.toml', 'conftest.py'] as const;
const PYTEST_TEXT_FILES = ['pyproject.toml', 'setup.cfg', 'tox.ini'] as const;
const SCAN_DIRS = ['', 'tests', 'test'] as const;
const MAX_FILES = 30;

function readText(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function isTestModule(name: string): boolean {
  return /^test_.+\.py$/.test(name) || /_test\.py$/.test(name) || name === 'tests.py';
}

function pytestSignal(root: string): boolean {
  for (const name of PYTEST_CONFIG_FILES) {
    if (fs.existsSync(path.join(root, name))) return true;
  }
  for (const name of PYTEST_TEXT_FILES) {
    const text = readText(path.join(root, name));
    if (text && /pytest/i.test(text)) return true;
  }
  return false;
}

function listTestModules(root: string): string[] {
  const files: string[] = [];
  for (const dir of SCAN_DIRS) {
    const abs = dir ? path.join(root, dir) : root;
    let names: string[] = [];
    try {
      names = fs.readdirSync(abs);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!isTestModule(name)) continue;
      files.push(path.join(abs, name));
      if (files.length >= MAX_FILES) return files;
    }
  }
  return files;
}

/** Which Python test command this tree supports, if any. */
export function pythonTestLayout(root: string): PythonTestLayout {
  if (pytestSignal(root)) return 'pytest';
  const modules = listTestModules(root);
  if (modules.length === 0) return 'none';
  for (const filePath of modules) {
    const text = readText(filePath);
    if (text && UNITTEST_IMPORT.test(text)) return 'unittest';
  }
  return 'loose';
}
