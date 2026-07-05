/**
 * `soul.md` — file-based persona abstraction (moss's analogue of hermes's
 * soul.md). See `@rdk-moss/core` `MossSoul` and `docs/soul-md-design.md`.
 *
 * `resolveSoulIdentity` discovers a soul file (workspace `.moss/soul.md`, then
 * global `<configDir>/soul.md`), uses its body as the persona text, and appends
 * the non-overridable model-honesty footer. Falls back to the default
 * `buildMossCliIdentity` identity when no soul file is present (current
 * behavior, untouched).
 *
 * Markdown frontmatter (`---\nid: ...\nmode: replace|prepend\n---`) is parsed
 * minimally; the body after frontmatter is the persona text.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { MossSoul } from '@rdk-moss/core';
import { buildMossCliIdentity, buildModelHonestyFooter } from './identity.js';

export interface ResolveSoulOptions {
  /** Workspace dir — `.moss/soul.md` is read here. */
  workspaceDir?: string;
  /** Global config dir — `<configDir>/soul.md` is read here. */
  configDir?: string;
  /** Model id, forwarded to the identity / footer for the gateway-honesty line. */
  model?: string;
  /** Whether the bundled default gateway is in use. */
  usingBundledDefault?: boolean;
}

interface ParsedSoulFile {
  id: string;
  mode: 'replace' | 'prepend';
  body: string;
}

/**
 * Strip leading YAML frontmatter (`---\n…\n---\n`) if present and pull `id` /
 * `mode` from it. Body is the remainder, trimmed. Frontmatter is optional — a
 * plain-markdown soul with no frontmatter is fine (id falls back to a slug of
 * the file path).
 */
function parseSoulFile(raw: string, fallbackId: string): ParsedSoulFile {
  const text = raw.replace(/\r\n/g, '\n');
  const fmMatch = text.match(/^---\n([\s\S]*?)\n---\n?/);
  let id = fallbackId;
  let mode: 'replace' | 'prepend' = 'replace';
  let body = text;
  if (fmMatch) {
    body = text.slice(fmMatch[0].length);
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^id:\s*(.+?)\s*$/);
      if (m) id = m[1];
      const mm = line.match(/^mode:\s*(replace|prepend)\s*$/);
      if (mm) mode = mm[1] as 'replace' | 'prepend';
    }
  }
  return { id, mode, body: body.trim() };
}

function readSoulFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    return undefined;
  }
}

/**
 * Resolve the active soul and return the identity text to use as
 * `baseSystemPrompt`. Discovery: workspace `.moss/soul.md` → global
 * `<configDir>/soul.md` → default `buildMossCliIdentity`. A non-default soul
 * gets the non-overridable model-honesty footer appended; the default identity
 * already embeds it.
 */
export function resolveSoulIdentity(opts: ResolveSoulOptions = {}): string {
  const soul = resolveSoul(opts);
  if (soul.source === 'default') {
    return buildMossCliIdentity({ model: opts.model, usingBundledDefault: opts.usingBundledDefault });
  }
  const footer = buildModelHonestyFooter({ model: opts.model, usingBundledDefault: opts.usingBundledDefault });
  if (soul.mode === 'prepend') {
    return `${soul.identity}\n\n---\n\n${buildMossCliIdentity({ model: opts.model, usingBundledDefault: opts.usingBundledDefault })}\n\n---\n\n${footer}`;
  }
  return `${soul.identity}\n\n---\n\n${footer}`;
}

/** Resolve the active soul (without merging into a prompt string). Exported for `/soul` + `moss doctor`. */
export function resolveSoul(opts: ResolveSoulOptions = {}): MossSoul {
  const candidates: Array<{ path: string; source: 'workspace-file' | 'global-file'; fallbackId: string }> = [];
  if (opts.workspaceDir) {
    candidates.push({
      path: path.join(opts.workspaceDir, '.moss', 'soul.md'),
      source: 'workspace-file',
      fallbackId: 'workspace-soul',
    });
  }
  if (opts.configDir) {
    candidates.push({
      path: path.join(opts.configDir, 'soul.md'),
      source: 'global-file',
      fallbackId: 'global-soul',
    });
  }
  for (const c of candidates) {
    const raw = readSoulFile(c.path);
    if (raw && raw.trim()) {
      const parsed = parseSoulFile(raw, c.fallbackId);
      if (parsed.body) {
        return {
          id: parsed.id,
          identity: parsed.body,
          mode: parsed.mode,
          source: c.source,
        };
      }
    }
  }
  return {
    id: 'moss-default',
    identity: buildMossCliIdentity({ model: opts.model, usingBundledDefault: opts.usingBundledDefault }),
    source: 'default',
  };
}
