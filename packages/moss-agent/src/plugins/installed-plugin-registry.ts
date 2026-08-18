import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as lockfile from 'proper-lockfile';
import { ErrorCode, MossError, wrapAsMoss } from '../errors.js';
import {
  MOSS_WEB_SLOTS,
  type MossPlugin,
  type MossWebContribution,
} from '../core/plugins/plugin-host.js';
import { runProcess } from '../utils/run-process.js';
import { parseMossPluginConfigSchema } from './plugin-config-schema.js';
import { importDshPackage, inspectDshPackageCompatibility } from './dsh-bundle-compatibility.js';
import { createIsolatedMossPlugin } from './isolated-plugin-runtime.js';

const MANIFEST_NAME = 'moss.plugin.json';
const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[./-][a-z0-9]+)*$/;
const EXACT_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const OFFICIAL_SOURCE_PREFIX = 'official:';
const PLUGIN_SETUP_VALIDATION_TIMEOUT_MS = 15_000;
const REGISTRY_LOCK_STALE_MS = 5_000;

/** Runtime entry declared by a trusted plugin manifest. @beta */
export interface MossPluginRuntimeManifest {
  readonly module: string;
  readonly export?: string;
}

/** Browser contributions declared by a trusted plugin manifest. @beta */
export interface MossPluginWebManifest {
  readonly contributions: readonly MossWebContribution[];
}

/** Stable on-disk `moss.plugin.json` v1 contract. @beta */
export interface MossPluginManifestV1 {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly version: string;
  readonly runtime: MossPluginRuntimeManifest;
  readonly web?: MossPluginWebManifest;
  readonly configSchema?: string;
}

/** Persisted record for one explicitly installed plugin. @beta */
export interface InstalledMossPluginVersion {
  readonly version: string;
  readonly source: string;
  readonly root: string;
  readonly format?: 'moss-v1' | 'dsh-package-v1';
}

/** Persisted record for one explicitly installed plugin. @beta */
export interface InstalledMossPlugin {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly root: string;
  readonly enabled: boolean;
  readonly installedAt: string;
  /** Source contract used to load this entry. Missing means `moss-v1`. */
  readonly format?: 'moss-v1' | 'dsh-package-v1';
  /** Previous immutable npm generation retained for explicit rollback. */
  readonly lastGood?: InstalledMossPluginVersion;
}

/** Health result returned by `moss plugins doctor`. @beta */
export interface MossPluginDoctorResult {
  readonly id: string;
  readonly status: 'ok' | 'disabled' | 'error';
  readonly message: string;
}

/** Isolated result of loading enabled plugins. @beta */
export interface LoadedMossPlugins {
  readonly plugins: readonly MossPlugin[];
  readonly failures: readonly { id: string; message: string; recovered?: boolean }[];
}

interface InstalledPluginFile {
  readonly schemaVersion: 1;
  readonly plugins: readonly InstalledMossPlugin[];
}

/** Storage options for the trusted installed-plugin registry. @beta */
export interface InstalledPluginRegistryOptions {
  readonly configDir: string;
  /** Maximum isolated import/setup validation time. @defaultValue 15000 */
  readonly setupTimeoutMs?: number;
}

interface ResolvedPluginSource {
  readonly root: string;
  readonly discard?: () => Promise<void>;
}

function invalidManifest(message: string, cause?: unknown): MossError {
  return new MossError({ code: ErrorCode.USER_INPUT_INVALID, message, cause });
}

function diagnosticMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message && cause.message !== error.message) {
    return `${error.message}: ${cause.message}`;
  }
  return error.message;
}

function validateInstalledPlugin(value: unknown, index: number): InstalledMossPlugin {
  if (!value || typeof value !== 'object') {
    throw new Error(`plugins[${index}] must be an object`);
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== 'string' || !PLUGIN_ID_PATTERN.test(entry.id)) {
    throw new Error(`plugins[${index}].id is invalid`);
  }
  if (typeof entry.version !== 'string' || !EXACT_VERSION_PATTERN.test(entry.version)) {
    throw new Error(`plugins[${index}].version is invalid`);
  }
  for (const field of ['source', 'root', 'installedAt'] as const) {
    if (typeof entry[field] !== 'string' || !entry[field]) {
      throw new Error(`plugins[${index}].${field} is invalid`);
    }
  }
  if (typeof entry.enabled !== 'boolean') {
    throw new Error(`plugins[${index}].enabled is invalid`);
  }
  if (
    entry.format !== undefined &&
    entry.format !== 'moss-v1' &&
    entry.format !== 'dsh-package-v1'
  ) {
    throw new Error(`plugins[${index}].format is invalid`);
  }
  if (entry.lastGood !== undefined) {
    if (!entry.lastGood || typeof entry.lastGood !== 'object') {
      throw new Error(`plugins[${index}].lastGood is invalid`);
    }
    const previous = entry.lastGood as Record<string, unknown>;
    if (
      typeof previous.version !== 'string' ||
      !EXACT_VERSION_PATTERN.test(previous.version) ||
      typeof previous.source !== 'string' ||
      !previous.source ||
      typeof previous.root !== 'string' ||
      !previous.root ||
      (previous.format !== undefined &&
        previous.format !== 'moss-v1' &&
        previous.format !== 'dsh-package-v1')
    ) {
      throw new Error(`plugins[${index}].lastGood is invalid`);
    }
  }
  return entry as unknown as InstalledMossPlugin;
}

function validateRelativeModule(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.startsWith('./') || value.split(/[\\/]/).includes('..')) {
    throw invalidManifest(`${field} must be a relative path beginning with ./`);
  }
  return value;
}

function validateManifest(value: unknown, manifestPath: string): MossPluginManifestV1 {
  if (!value || typeof value !== 'object')
    throw invalidManifest(`${manifestPath} must be an object`);
  const data = value as Record<string, unknown>;
  if (data.schemaVersion !== 1) throw invalidManifest(`${manifestPath} requires schemaVersion 1`);
  if (typeof data.id !== 'string' || !PLUGIN_ID_PATTERN.test(data.id)) {
    throw invalidManifest(`${manifestPath} has an invalid plugin id`);
  }
  if (typeof data.version !== 'string' || !EXACT_VERSION_PATTERN.test(data.version)) {
    throw invalidManifest(`${manifestPath} requires an exact semantic version`);
  }
  if (!data.runtime || typeof data.runtime !== 'object') {
    throw invalidManifest(`${manifestPath} requires a runtime object`);
  }
  const runtime = data.runtime as Record<string, unknown>;
  validateRelativeModule(runtime.module, 'runtime.module');
  if (
    runtime.export !== undefined &&
    (typeof runtime.export !== 'string' || !runtime.export.trim())
  ) {
    throw invalidManifest('runtime.export must be a non-empty string');
  }
  if (data.configSchema !== undefined) validateRelativeModule(data.configSchema, 'configSchema');
  if (data.web !== undefined) {
    if (!data.web || typeof data.web !== 'object') throw invalidManifest('web must be an object');
    const contributions = (data.web as Record<string, unknown>).contributions;
    if (!Array.isArray(contributions)) throw invalidManifest('web.contributions must be an array');
    const contributionIds = new Set<string>();
    for (const contribution of contributions) {
      if (!contribution || typeof contribution !== 'object') {
        throw invalidManifest('each web contribution must be an object');
      }
      const item = contribution as Record<string, unknown>;
      if (typeof item.id !== 'string' || !item.id.trim()) {
        throw invalidManifest('web contribution id is required');
      }
      if (contributionIds.has(item.id)) {
        throw invalidManifest(`duplicate web contribution id: ${item.id}`);
      }
      contributionIds.add(item.id);
      if (!MOSS_WEB_SLOTS.includes(item.slot as (typeof MOSS_WEB_SLOTS)[number])) {
        throw invalidManifest(`unsupported web contribution slot: ${String(item.slot)}`);
      }
      validateRelativeModule(item.module, 'web contribution module');
    }
  }
  return data as unknown as MossPluginManifestV1;
}

async function resolveContainedPath(
  root: string,
  relative: string,
  field: string
): Promise<string> {
  const realRoot = await realpath(root);
  const target = await realpath(path.resolve(realRoot, relative));
  const fromRoot = path.relative(realRoot, target);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw invalidManifest(`${field} escapes plugin root`);
  }
  return target;
}

/** Read and validate a plugin manifest without executing plugin code. @beta */
export async function readMossPluginManifest(root: string): Promise<MossPluginManifestV1> {
  const manifestPath = path.join(root, MANIFEST_NAME);
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
    const manifest = validateManifest(parsed, manifestPath);
    await access(await resolveContainedPath(root, manifest.runtime.module, 'runtime.module'));
    for (const contribution of manifest.web?.contributions ?? []) {
      await access(
        await resolveContainedPath(root, contribution.module, 'web contribution module')
      );
    }
    if (manifest.configSchema) {
      const schemaPath = await resolveContainedPath(root, manifest.configSchema, 'configSchema');
      await access(schemaPath);
      parseMossPluginConfigSchema(JSON.parse(await readFile(schemaPath, 'utf8')), schemaPath);
    }
    return manifest;
  } catch (error) {
    if (error instanceof MossError) throw error;
    throw wrapAsMoss(error, ErrorCode.USER_INPUT_INVALID, {
      message: `unable to read ${manifestPath}`,
      context: { manifestPath },
    });
  }
}

function exactNpmPackageName(source: string): string | null {
  if (source.startsWith('@')) {
    const match = /^(@[^/]+\/[^@]+)@(.+)$/.exec(source);
    return match && EXACT_VERSION_PATTERN.test(match[2]) ? match[1] : null;
  }
  const match = /^([^@/]+)@(.+)$/.exec(source);
  return match && EXACT_VERSION_PATTERN.test(match[2]) ? match[1] : null;
}

function officialPluginRoot(source: string): string | undefined {
  if (!source.startsWith(OFFICIAL_SOURCE_PREFIX)) return undefined;
  const name = source.slice(OFFICIAL_SOURCE_PREFIX.length);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw invalidManifest(`invalid official plugin source: ${source}`);
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'assets', 'plugins', name);
}

async function assertInstalledIdentity(entry: InstalledMossPlugin): Promise<void> {
  if (entry.format === 'dsh-package-v1') {
    const report = await inspectDshPackageCompatibility(entry.root);
    if (!report.compatible || report.id !== entry.id || report.version !== entry.version) {
      throw invalidManifest(
        `installed plugin identity changed: expected ${entry.id}@${entry.version}, got ${report.id ?? 'invalid'}@${report.version ?? 'invalid'}`
      );
    }
    return;
  }
  const manifest = await readMossPluginManifest(entry.root);
  if (manifest.id !== entry.id || manifest.version !== entry.version) {
    throw invalidManifest(
      `installed plugin identity changed: expected ${entry.id}@${entry.version}, got ${manifest.id}@${manifest.version}`
    );
  }
}

/** Persistent registry for trusted local and npm Moss plugins. @beta */
export class InstalledPluginRegistry {
  private readonly registryDir: string;
  private readonly registryPath: string;
  private readonly npmRoot: string;
  private readonly npmRunner: typeof runProcess;
  private readonly setupTimeoutMs: number;

  constructor(options: InstalledPluginRegistryOptions) {
    this.registryDir = path.join(options.configDir, 'plugins');
    this.registryPath = path.join(this.registryDir, 'installed.json');
    this.npmRoot = path.join(this.registryDir, 'npm');
    this.npmRunner = runProcess;
    this.setupTimeoutMs = options.setupTimeoutMs ?? PLUGIN_SETUP_VALIDATION_TIMEOUT_MS;
    if (!Number.isFinite(this.setupTimeoutMs) || this.setupTimeoutMs <= 0) {
      throw invalidManifest('plugin setup timeout must be a positive finite number');
    }
  }

  async list(): Promise<readonly InstalledMossPlugin[]> {
    const file = await this.readRegistry();
    return Object.freeze([...file.plugins].sort((left, right) => left.id.localeCompare(right.id)));
  }

  async add(source: string): Promise<InstalledMossPlugin> {
    return this.mutate(async (assertLease) => {
      const candidate = await this.resolveSource(source);
      let committed = false;
      try {
        let id: string;
        let version: string;
        let format: InstalledMossPlugin['format'] = 'moss-v1';
        try {
          const manifest = await readMossPluginManifest(candidate.root);
          id = manifest.id;
          version = manifest.version;
        } catch (mossError) {
          try {
            await access(path.join(candidate.root, MANIFEST_NAME));
            throw mossError;
          } catch (manifestAccessError) {
            if (manifestAccessError === mossError) throw mossError;
          }
          const compatibility = await inspectDshPackageCompatibility(candidate.root);
          if (!compatibility.compatible || !compatibility.id || !compatibility.version) {
            throw invalidManifest(
              `source is neither a Moss plugin nor a compatible DSH package: ${compatibility.reasons.join('; ')}`,
              mossError
            );
          }
          id = compatibility.id;
          version = compatibility.version;
          format = 'dsh-package-v1';
        }
        const existing = (await this.readRegistry()).plugins;
        const previous = existing.find((entry) => entry.id === id);
        if (previous && !candidate.discard) {
          throw invalidManifest(`plugin already installed: ${id}`);
        }
        if (previous?.version === version) {
          throw invalidManifest(`plugin version already installed: ${id}@${version}`);
        }
        const entry: InstalledMossPlugin = {
          id,
          version,
          source,
          root: candidate.root,
          enabled: previous?.enabled ?? false,
          installedAt: new Date().toISOString(),
          format,
          ...(previous
            ? {
                lastGood: {
                  version: previous.version,
                  source: previous.source,
                  root: previous.root,
                  format: previous.format,
                },
              }
            : {}),
        };
        await assertInstalledIdentity(entry);
        await this.writeRegistry(
          previous
            ? existing.map((candidateEntry) => (candidateEntry.id === id ? entry : candidateEntry))
            : [...existing, entry],
          assertLease
        );
        committed = true;
        if (previous?.lastGood) {
          await this.purgeNpmRoot(previous.lastGood.root).catch(() => {});
        }
        return entry;
      } finally {
        if (!committed) await candidate.discard?.().catch(() => {});
      }
    });
  }

  async remove(id: string): Promise<void> {
    let removed: InstalledMossPlugin | undefined;
    await this.mutate(async (assertLease) => {
      const entries = (await this.readRegistry()).plugins;
      removed = entries.find((entry) => entry.id === id);
      if (!removed) throw invalidManifest(`plugin not installed: ${id}`);
      await this.writeRegistry(
        entries.filter((entry) => entry.id !== id),
        assertLease
      );
    });
    if (removed) await this.purgeRemovedPlugin(removed).catch(() => {});
  }

  async enable(id: string): Promise<void> {
    await this.setEnabled(id, true);
  }

  async disable(id: string): Promise<void> {
    await this.setEnabled(id, false);
  }

  /** Restore the previous immutable npm generation after candidate activation fails. @beta */
  async rollback(id: string): Promise<InstalledMossPlugin> {
    let failed: InstalledMossPlugin | undefined;
    const restored = await this.mutate(async (assertLease) => {
      const entries = (await this.readRegistry()).plugins;
      const current = entries.find((entry) => entry.id === id);
      if (!current?.lastGood) throw invalidManifest(`plugin has no last-good generation: ${id}`);
      failed = current;
      const replacement: InstalledMossPlugin = {
        id: current.id,
        ...current.lastGood,
        enabled: current.enabled,
        installedAt: current.installedAt,
      };
      await this.writeRegistry(
        entries.map((entry) => (entry.id === id ? replacement : entry)),
        assertLease
      );
      return replacement;
    });
    if (failed) await this.purgeNpmRoot(failed.root).catch(() => {});
    return restored;
  }

  async loadEnabled(): Promise<LoadedMossPlugins> {
    const plugins: MossPlugin[] = [];
    const failures: Array<{ id: string; message: string; recovered?: boolean }> = [];
    for (const entry of await this.list()) {
      if (!entry.enabled) continue;
      try {
        plugins.push(await this.load(entry));
      } catch (error) {
        const candidateMessage = error instanceof Error ? error.message : String(error);
        if (entry.lastGood) {
          try {
            const restored = await this.rollback(entry.id);
            plugins.push(await this.load(restored));
            failures.push({
              id: entry.id,
              message: `candidate ${entry.version} failed and last-good ${restored.version} was restored: ${candidateMessage}`,
              recovered: true,
            });
            continue;
          } catch (recoveryError) {
            failures.push({
              id: entry.id,
              message: `candidate failed (${candidateMessage}); last-good recovery failed (${diagnosticMessage(recoveryError)})`,
            });
            continue;
          }
        }
        failures.push({ id: entry.id, message: candidateMessage });
      }
    }
    return { plugins: Object.freeze(plugins), failures: Object.freeze(failures) };
  }

  async doctor(): Promise<readonly MossPluginDoctorResult[]> {
    const results: MossPluginDoctorResult[] = [];
    for (const entry of await this.list()) {
      try {
        await assertInstalledIdentity(entry);
        results.push({
          id: entry.id,
          status: entry.enabled ? 'ok' : 'disabled',
          message: entry.enabled
            ? `${entry.version} passed static validation`
            : `${entry.version} is disabled; static validation passed`,
        });
      } catch (error) {
        results.push({
          id: entry.id,
          status: 'error',
          message: diagnosticMessage(error),
        });
      }
    }
    return Object.freeze(results);
  }

  /** Load and isolate-validate one installed plugin before main-thread activation. @beta */
  async loadInstalled(
    id: string,
    options: { readonly config?: Readonly<Record<string, unknown>> } = {}
  ): Promise<MossPlugin> {
    const entry = (await this.list()).find((candidate) => candidate.id === id);
    if (!entry) throw invalidManifest(`plugin not installed: ${id}`);
    return this.load(entry, options.config);
  }

  private async load(
    entry: InstalledMossPlugin,
    explicitConfig?: Readonly<Record<string, unknown>>
  ): Promise<MossPlugin> {
    await assertInstalledIdentity(entry);
    const config = explicitConfig ?? (await this.loadPluginConfig(entry));
    if (entry.format === 'dsh-package-v1') {
      const imported = await importDshPackage(entry.root);
      return { ...imported.plugin, config };
    }
    const manifest = await readMossPluginManifest(entry.root);
    const moduleUrl = pathToFileURL(path.resolve(entry.root, manifest.runtime.module)).href;
    return createIsolatedMossPlugin({
      moduleUrl,
      exportName: manifest.runtime.export ?? 'default',
      pluginId: manifest.id,
      timeoutMs: this.setupTimeoutMs,
      manifestWebContributions: manifest.web?.contributions,
      config,
    });
  }

  private async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.mutate(async (assertLease) => {
      const entries = (await this.readRegistry()).plugins;
      const target = entries.find((entry) => entry.id === id);
      if (!target) throw invalidManifest(`plugin not installed: ${id}`);
      if (enabled) {
        try {
          await assertInstalledIdentity(target);
        } catch (error) {
          throw invalidManifest(
            `plugin ${id} validation failed: ${diagnosticMessage(error)}`,
            error
          );
        }
      }
      await this.writeRegistry(
        entries.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)),
        assertLease
      );
    });
  }

  private async mutate<T>(operation: (assertLease: () => void) => Promise<T>): Promise<T> {
    await mkdir(this.registryDir, { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.registryDir, {
        stale: REGISTRY_LOCK_STALE_MS,
        update: 1_000,
        retries: { retries: 600, factor: 1, minTimeout: 50, maxTimeout: 50, randomize: true },
        onCompromised: (error) => {
          compromised = error;
        },
      });
    } catch (error) {
      throw wrapAsMoss(error, ErrorCode.USER_INPUT_INVALID, {
        message: 'unable to lock the plugin registry',
        context: { registryPath: this.registryPath },
      });
    }
    const assertLease = (): void => {
      if (compromised) {
        throw wrapAsMoss(compromised, ErrorCode.USER_INPUT_INVALID, {
          message: 'plugin registry lock was compromised',
          context: { registryPath: this.registryPath },
        });
      }
    };
    try {
      const result = await operation(assertLease);
      assertLease();
      return result;
    } finally {
      try {
        await release();
      } catch {
        // A completed atomic rename is the committed post-condition. Reporting a
        // release failure as an operation failure would make callers roll back
        // live state even though the durable registry already changed. The
        // heartbeat lock has a finite stale interval and is safe to recover.
      }
    }
  }

  private async resolveSource(source: string): Promise<ResolvedPluginSource> {
    const officialRoot = officialPluginRoot(source);
    if (officialRoot) return { root: await realpath(officialRoot) };
    const asPath = path.resolve(source);
    try {
      return { root: await realpath(asPath) };
    } catch {
      const packageName = exactNpmPackageName(source);
      if (!packageName) {
        throw invalidManifest(
          `unsupported plugin source: ${source}; npm plugins require an exact version`
        );
      }
      const generationRoot = path.join(
        this.npmRoot,
        'versions',
        encodeURIComponent(source),
        randomUUID()
      );
      await mkdir(generationRoot, { recursive: true, mode: 0o700 });
      await this.npmRunner('npm', {
        args: [
          'install',
          '--ignore-scripts',
          '--no-save',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          '--prefix',
          generationRoot,
          source,
        ],
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const root = await realpath(
        path.join(generationRoot, 'node_modules', ...packageName.split('/'))
      );
      return {
        root,
        discard: () => rm(generationRoot, { recursive: true, force: true }),
      };
    }
  }

  private async loadPluginConfig(
    entry: InstalledMossPlugin
  ): Promise<Readonly<Record<string, unknown>>> {
    const { MossPluginConfigStore, readMossPluginConfigSchema } =
      await import('./plugin-config-store.js');
    const schema =
      entry.format === 'dsh-package-v1'
        ? (await importDshPackage(entry.root)).configSchema
        : await readMossPluginConfigSchema(entry.root);
    if (!schema) return Object.freeze({});
    return new MossPluginConfigStore({
      configDir: path.dirname(this.registryDir),
    }).loadRuntimeConfig(entry.id, schema);
  }

  private async purgeRemovedPlugin(entry: InstalledMossPlugin): Promise<void> {
    const configPath = path.join(
      path.dirname(this.registryDir),
      'plugins',
      'config',
      `${encodeURIComponent(entry.id)}.json`
    );
    await rm(configPath, { force: true });
    await this.purgeNpmRoot(entry.root);
    if (entry.lastGood) await this.purgeNpmRoot(entry.lastGood.root);
  }

  private async purgeNpmRoot(root: string): Promise<void> {
    const realNpmRoot = await realpath(this.npmRoot).catch(() => this.npmRoot);
    const realPluginRoot = await realpath(root).catch(() => root);
    const relative = path.relative(realNpmRoot, realPluginRoot);
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
      const parts = relative.split(path.sep);
      const nodeModules = parts.indexOf('node_modules');
      if (nodeModules > 0) {
        await rm(path.join(realNpmRoot, ...parts.slice(0, nodeModules)), {
          recursive: true,
          force: true,
        });
      }
    }
  }

  private async readRegistry(): Promise<InstalledPluginFile> {
    try {
      const parsed = JSON.parse(await readFile(this.registryPath, 'utf8')) as InstalledPluginFile;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.plugins))
        throw new Error('invalid registry');
      return {
        schemaVersion: 1,
        plugins: parsed.plugins.map((entry, index) => validateInstalledPlugin(entry, index)),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { schemaVersion: 1, plugins: [] };
      throw wrapAsMoss(error, ErrorCode.USER_INPUT_INVALID, {
        message: `unable to read ${this.registryPath}`,
      });
    }
  }

  private async writeRegistry(
    plugins: readonly InstalledMossPlugin[],
    assertLease: () => void
  ): Promise<void> {
    await mkdir(this.registryDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.registryPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, plugins }, null, 2)}\n`, {
      mode: 0o600,
    });
    try {
      assertLease();
      await rename(temporary, this.registryPath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}
