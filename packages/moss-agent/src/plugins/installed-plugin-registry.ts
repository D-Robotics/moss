import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import * as lockfile from 'proper-lockfile';
import { ErrorCode, MossError, wrapAsMoss } from '../errors.js';
import {
  MOSS_WEB_SLOTS,
  type MossPlugin,
  type MossWebContribution,
} from '../core/plugins/plugin-host.js';
import { runProcess } from '../utils/run-process.js';

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
export interface InstalledMossPlugin {
  readonly id: string;
  readonly version: string;
  readonly source: string;
  readonly root: string;
  readonly enabled: boolean;
  readonly installedAt: string;
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
  readonly failures: readonly { id: string; message: string }[];
}

interface InstalledPluginFile {
  readonly schemaVersion: 1;
  readonly plugins: readonly InstalledMossPlugin[];
}

/** Storage options for the trusted installed-plugin registry. @beta */
export interface InstalledPluginRegistryOptions {
  readonly configDir: string;
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
      await access(await resolveContainedPath(root, manifest.configSchema, 'configSchema'));
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

async function validatePluginSetup(entry: InstalledMossPlugin): Promise<void> {
  const manifest = await readMossPluginManifest(entry.root);
  const worker = new Worker(new URL('./plugin-setup-worker.js', import.meta.url), {
    workerData: {
      moduleUrl: pathToFileURL(path.resolve(entry.root, manifest.runtime.module)).href,
      exportName: manifest.runtime.export ?? 'default',
      expectedId: manifest.id,
    },
  });
  let timeout: NodeJS.Timeout | undefined;
  const validation = new Promise<void>((resolve, reject) => {
    worker.once('message', (message: unknown) => {
      if (
        message &&
        typeof message === 'object' &&
        (message as Record<string, unknown>).ok === true
      ) {
        resolve();
        return;
      }
      const detail =
        message && typeof message === 'object'
          ? (message as Record<string, unknown>).message
          : undefined;
      reject(
        invalidManifest(typeof detail === 'string' ? detail : 'plugin setup validation failed')
      );
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(invalidManifest(`plugin setup worker exited with code ${code}`));
    });
    timeout = setTimeout(() => {
      reject(invalidManifest(`plugin setup validation timed out after 15 seconds`));
    }, PLUGIN_SETUP_VALIDATION_TIMEOUT_MS);
  });
  try {
    await validation;
  } finally {
    if (timeout) clearTimeout(timeout);
    await worker.terminate();
  }
}

/** Persistent registry for trusted local and npm Moss plugins. @beta */
export class InstalledPluginRegistry {
  private readonly registryDir: string;
  private readonly registryPath: string;
  private readonly npmRoot: string;
  private readonly npmRunner: typeof runProcess;

  constructor(options: InstalledPluginRegistryOptions) {
    this.registryDir = path.join(options.configDir, 'plugins');
    this.registryPath = path.join(this.registryDir, 'installed.json');
    this.npmRoot = path.join(this.registryDir, 'npm');
    this.npmRunner = runProcess;
  }

  async list(): Promise<readonly InstalledMossPlugin[]> {
    const file = await this.readRegistry();
    return Object.freeze([...file.plugins].sort((left, right) => left.id.localeCompare(right.id)));
  }

  async add(source: string): Promise<InstalledMossPlugin> {
    return this.mutate(async (assertLease) => {
      const root = await this.resolveSource(source);
      const manifest = await readMossPluginManifest(root);
      const existing = (await this.readRegistry()).plugins;
      if (existing.some(({ id }) => id === manifest.id)) {
        throw invalidManifest(`plugin already installed: ${manifest.id}`);
      }
      const entry: InstalledMossPlugin = {
        id: manifest.id,
        version: manifest.version,
        source,
        root,
        enabled: false,
        installedAt: new Date().toISOString(),
      };
      await this.writeRegistry([...existing, entry], assertLease);
      return entry;
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate(async (assertLease) => {
      const entries = (await this.readRegistry()).plugins;
      if (!entries.some((entry) => entry.id === id))
        throw invalidManifest(`plugin not installed: ${id}`);
      await this.writeRegistry(
        entries.filter((entry) => entry.id !== id),
        assertLease
      );
    });
  }

  async enable(id: string): Promise<void> {
    await this.setEnabled(id, true);
  }

  async disable(id: string): Promise<void> {
    await this.setEnabled(id, false);
  }

  async loadEnabled(): Promise<LoadedMossPlugins> {
    const plugins: MossPlugin[] = [];
    const failures: Array<{ id: string; message: string }> = [];
    for (const entry of await this.list()) {
      if (!entry.enabled) continue;
      try {
        plugins.push(await this.load(entry));
      } catch (error) {
        failures.push({
          id: entry.id,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { plugins: Object.freeze(plugins), failures: Object.freeze(failures) };
  }

  async doctor(): Promise<readonly MossPluginDoctorResult[]> {
    const results: MossPluginDoctorResult[] = [];
    for (const entry of await this.list()) {
      try {
        const manifest = await readMossPluginManifest(entry.root);
        await validatePluginSetup(entry);
        results.push({
          id: entry.id,
          status: entry.enabled ? 'ok' : 'disabled',
          message: entry.enabled
            ? `${manifest.version} validated successfully`
            : `${manifest.version} is disabled; setup validation passed`,
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

  private async load(entry: InstalledMossPlugin): Promise<MossPlugin> {
    const manifest = await readMossPluginManifest(entry.root);
    const moduleUrl = pathToFileURL(path.resolve(entry.root, manifest.runtime.module)).href;
    const imported = (await import(moduleUrl)) as Record<string, unknown>;
    const candidate = imported[manifest.runtime.export ?? 'default'];
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      typeof (candidate as MossPlugin).setup !== 'function'
    ) {
      throw invalidManifest(`plugin ${entry.id} did not export a MossPlugin`);
    }
    const plugin = candidate as MossPlugin;
    if (plugin.id !== manifest.id)
      throw invalidManifest(`plugin export id does not match manifest: ${manifest.id}`);
    return plugin;
  }

  private async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.mutate(async (assertLease) => {
      const entries = (await this.readRegistry()).plugins;
      const target = entries.find((entry) => entry.id === id);
      if (!target) throw invalidManifest(`plugin not installed: ${id}`);
      if (enabled) {
        try {
          await validatePluginSetup(target);
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
    let operationFailed = false;
    try {
      const result = await operation(assertLease);
      assertLease();
      return result;
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try {
        await release();
      } catch (error) {
        if (!operationFailed) {
          throw wrapAsMoss(error, ErrorCode.USER_INPUT_INVALID, {
            message: 'unable to release the plugin registry lock',
            context: { registryPath: this.registryPath },
          });
        }
      }
    }
  }

  private async resolveSource(source: string): Promise<string> {
    const officialRoot = officialPluginRoot(source);
    if (officialRoot) return realpath(officialRoot);
    const asPath = path.resolve(source);
    try {
      return await realpath(asPath);
    } catch {
      const packageName = exactNpmPackageName(source);
      if (!packageName) {
        throw invalidManifest(
          `unsupported plugin source: ${source}; npm plugins require an exact version`
        );
      }
      await mkdir(this.npmRoot, { recursive: true });
      await this.npmRunner('npm', {
        args: [
          'install',
          '--ignore-scripts',
          '--no-save',
          '--no-audit',
          '--no-fund',
          '--package-lock=false',
          '--prefix',
          this.npmRoot,
          source,
        ],
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      return realpath(path.join(this.npmRoot, 'node_modules', ...packageName.split('/')));
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
    assertLease();
    await rename(temporary, this.registryPath);
  }
}
