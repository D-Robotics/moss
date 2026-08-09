import fs from 'node:fs';
import path from 'node:path';

const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts)$/;
const SOURCE_ROOTS = ['packages/moss/src', 'packages/moss-agent/src'];

function normalizePath(relativePath) {
  return relativePath.replaceAll(path.sep, '/');
}

function walkSource(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSource(absolute, out);
    else if (entry.isFile() && SOURCE_EXTENSION.test(entry.name)) out.push(absolute);
  }
  return out;
}

export function countPhysicalLines(body) {
  if (body.length === 0) return 0;
  const lines = body.split(/\r?\n/).length;
  return /\r?\n$/.test(body) ? lines - 1 : lines;
}

function validCeiling(value) {
  return Number.isInteger(value) && value > 0;
}

export function findMaintainabilityViolations(repoRoot, config) {
  const findings = [];
  const newFileMaxLines = config.newFileMaxLines;
  const legacyFiles = config.legacyFiles ?? {};
  const exceptions = config.exceptions ?? {};

  if (!validCeiling(newFileMaxLines)) {
    return ['maintainability baseline: newFileMaxLines must be a positive integer'];
  }

  const sourceFiles = new Map();
  for (const sourceRoot of SOURCE_ROOTS) {
    for (const absolute of walkSource(path.join(repoRoot, sourceRoot))) {
      const relative = normalizePath(path.relative(repoRoot, absolute));
      sourceFiles.set(relative, countPhysicalLines(fs.readFileSync(absolute, 'utf8')));
    }
  }

  for (const [relative, entry] of Object.entries(legacyFiles)) {
    if (exceptions[relative]) {
      findings.push(`${relative}: source cannot be both a legacy baseline and an exception`);
    }
    if (
      !validCeiling(entry?.maxLines) ||
      typeof entry?.reason !== 'string' ||
      !entry.reason.trim()
    ) {
      findings.push(`${relative}: legacy baseline requires positive maxLines and a reason`);
      continue;
    }
    if (!sourceFiles.has(relative)) {
      findings.push(`${relative}: stale legacy baseline entry; source file does not exist`);
    }
  }

  for (const [relative, entry] of Object.entries(exceptions)) {
    if (
      !validCeiling(entry?.maxLines) ||
      typeof entry?.owner !== 'string' ||
      !entry.owner.trim() ||
      typeof entry?.reason !== 'string' ||
      !entry.reason.trim()
    ) {
      findings.push(`${relative}: exception requires positive maxLines, owner, and reason`);
      continue;
    }
    if (!sourceFiles.has(relative)) {
      findings.push(`${relative}: stale maintainability exception; source file does not exist`);
    }
  }

  for (const [relative, lineCount] of sourceFiles) {
    const exception = exceptions[relative];
    if (exception) {
      if (validCeiling(exception.maxLines) && lineCount > exception.maxLines) {
        findings.push(
          `${relative}: excepted source grew from ceiling ${exception.maxLines} to ${lineCount} lines`
        );
      } else if (validCeiling(exception.maxLines) && lineCount < exception.maxLines) {
        findings.push(
          `${relative}: exception ceiling is stale at ${exception.maxLines}; lower it to ${lineCount} lines`
        );
      }
      continue;
    }

    const legacy = legacyFiles[relative];
    if (legacy) {
      if (!validCeiling(legacy.maxLines)) continue;
      if (lineCount > legacy.maxLines) {
        findings.push(
          `${relative}: legacy source grew from ceiling ${legacy.maxLines} to ${lineCount} lines`
        );
      } else if (lineCount < legacy.maxLines) {
        findings.push(
          `${relative}: legacy baseline is stale at ${legacy.maxLines}; lower it to ${lineCount} lines`
        );
      }
      continue;
    }

    if (lineCount > newFileMaxLines) {
      findings.push(
        `${relative}: source has ${lineCount} lines, exceeding new-file ceiling ${newFileMaxLines}; split it or add a reviewed exception`
      );
    }
  }

  return findings;
}
