import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as lockfile from 'proper-lockfile';

import { ErrorCode, MossError, wrapAsMoss } from '../errors.js';
import { validateJsonSchema } from '../structured-output/schema-validator.js';
import { readMossPluginManifest } from './installed-plugin-registry.js';
import {
  parseMossPluginConfigSchema,
  type MossPluginConfigSchema,
} from './plugin-config-schema.js';

export type {
  MossPluginConfigPropertySchema,
  MossPluginConfigSchema,
  MossPluginJsonSchema,
} from './plugin-config-schema.js';

const PLUGIN_ID_PATTERN = /^[a-z0-9]+(?:[./-][a-z0-9]+)*$/;

/** Browser-safe plugin configuration projection. @beta */
export interface MossPluginConfigView {
  readonly values: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, { readonly configured: boolean }>>;
}

/** Storage options for the per-plugin configuration store. @beta */
export interface MossPluginConfigStoreOptions {
  readonly configDir: string;
}

interface StoredPluginConfig {
  readonly schemaVersion: 1;
  readonly values: Record<string, unknown>;
}

function invalidConfig(message: string, cause?: unknown): MossError {
  return new MossError({ code: ErrorCode.USER_INPUT_INVALID, message, cause });
}

function assertPluginId(pluginId: string): void {
  if (!PLUGIN_ID_PATTERN.test(pluginId)) throw invalidConfig(`invalid plugin id: ${pluginId}`);
}

function validationMessage(
  errors: readonly { readonly path: string; readonly message: string }[]
): string {
  return errors.map(({ path: errorPath, message }) => `${errorPath}: ${message}`).join('; ');
}

/** Read and validate the optional config schema declared by a plugin manifest. @beta */
export async function readMossPluginConfigSchema(
  pluginRoot: string
): Promise<MossPluginConfigSchema | undefined> {
  const manifest = await readMossPluginManifest(pluginRoot);
  if (!manifest.configSchema) return undefined;
  try {
    const root = await realpath(pluginRoot);
    const schemaPath = await realpath(path.resolve(root, manifest.configSchema));
    const relative = path.relative(root, schemaPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw invalidConfig('configSchema escapes plugin root');
    }
    return parseMossPluginConfigSchema(JSON.parse(await readFile(schemaPath, 'utf8')), schemaPath);
  } catch (error) {
    if (error instanceof MossError) throw error;
    throw wrapAsMoss(error, ErrorCode.USER_INPUT_INVALID, {
      message: `unable to read plugin config schema for ${manifest.id}`,
      context: { pluginId: manifest.id },
    });
  }
}

/**
 * Atomic per-plugin configuration store with browser-safe write-only projection.
 *
 * The trusted runtime may call `loadRuntimeConfig()` to obtain the complete
 * validated value. Browser adapters must use `getView()` and the dedicated
 * secret mutation methods instead.
 *
 * @beta
 */
export class MossPluginConfigStore {
  private readonly directory: string;

  constructor(options: MossPluginConfigStoreOptions) {
    this.directory = path.join(options.configDir, 'plugins', 'config');
  }

  private filePathFor(pluginId: string): string {
    assertPluginId(pluginId);
    return path.join(this.directory, `${encodeURIComponent(pluginId)}.json`);
  }

  /** Return non-secret values plus configured/not-configured secret state. @beta */
  async getView(pluginId: string, schema: MossPluginConfigSchema): Promise<MossPluginConfigView> {
    const stored = await this.read(pluginId);
    const values: Record<string, unknown> = {};
    const secrets: Record<string, { configured: boolean }> = {};
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (property.writeOnly) {
        secrets[name] = { configured: Object.hasOwn(stored.values, name) };
      } else if (Object.hasOwn(stored.values, name)) {
        values[name] = stored.values[name];
      }
    }
    return Object.freeze({ values: Object.freeze(values), secrets: Object.freeze(secrets) });
  }

  /** Update non-secret fields after validating the supported JSON Schema subset. @beta */
  async update(
    pluginId: string,
    schema: MossPluginConfigSchema,
    patch: Readonly<Record<string, unknown>>
  ): Promise<void> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw invalidConfig('plugin config update must be an object');
    }
    await this.mutate(pluginId, schema, (values) => {
      for (const [name, value] of Object.entries(patch)) {
        const property = schema.properties?.[name];
        if (!property) throw invalidConfig(`unknown plugin config property: ${name}`);
        if (property.writeOnly) {
          throw invalidConfig(`writeOnly property requires putSecret(): ${name}`);
        }
        values[name] = value;
      }
    });
  }

  /** Store one write-only value without exposing existing secret material. @beta */
  async putSecret(
    pluginId: string,
    schema: MossPluginConfigSchema,
    name: string,
    value: unknown
  ): Promise<void> {
    const property = schema.properties?.[name];
    if (!property?.writeOnly)
      throw invalidConfig(`plugin config property is not writeOnly: ${name}`);
    await this.mutate(pluginId, schema, (values) => {
      values[name] = value;
    });
  }

  /** Delete one write-only value; required-value validation resumes on runtime load. @beta */
  async deleteSecret(
    pluginId: string,
    schema: MossPluginConfigSchema,
    name: string
  ): Promise<void> {
    const property = schema.properties?.[name];
    if (!property?.writeOnly)
      throw invalidConfig(`plugin config property is not writeOnly: ${name}`);
    await this.mutate(pluginId, schema, (values) => {
      delete values[name];
    });
  }

  /** Load the complete configuration for trusted runtime setup and enforce required fields. @beta */
  async loadRuntimeConfig(
    pluginId: string,
    schema: MossPluginConfigSchema
  ): Promise<Readonly<Record<string, unknown>>> {
    const stored = await this.read(pluginId);
    const validation = validateJsonSchema(stored.values, schema);
    if (!validation.valid) {
      throw invalidConfig(
        `plugin config validation failed: ${validationMessage(validation.errors)}`
      );
    }
    return Object.freeze({ ...stored.values });
  }

  /** Replace the complete trusted runtime value during activation rollback. @internal */
  async replaceRuntimeConfig(
    pluginId: string,
    schema: MossPluginConfigSchema,
    replacement: Readonly<Record<string, unknown>>
  ): Promise<void> {
    await this.mutate(pluginId, schema, (values) => {
      for (const name of Object.keys(values)) delete values[name];
      Object.assign(values, replacement);
    });
  }

  /** Remove all persisted values and write-only secrets for an uninstalled plugin. @internal */
  async remove(pluginId: string): Promise<void> {
    await rm(this.filePathFor(pluginId), { force: true });
  }

  private async mutate(
    pluginId: string,
    schema: MossPluginConfigSchema,
    mutation: (values: Record<string, unknown>) => void
  ): Promise<void> {
    assertPluginId(pluginId);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(this.directory, 0o700);
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(this.directory, {
        stale: 5_000,
        update: 1_000,
        retries: { retries: 200, factor: 1, minTimeout: 25, maxTimeout: 25, randomize: true },
      });
    } catch (error) {
      throw wrapAsMoss(error, ErrorCode.CONFIG_IO_FAILED, {
        message: `unable to lock plugin config for ${pluginId}`,
        context: { pluginId },
      });
    }
    try {
      const stored = await this.read(pluginId);
      const values = { ...stored.values };
      mutation(values);
      const partialSchema: MossPluginConfigSchema = { ...schema, required: [] };
      const validation = validateJsonSchema(values, partialSchema);
      if (!validation.valid) {
        throw invalidConfig(
          `plugin config validation failed: ${validationMessage(validation.errors)}`
        );
      }
      await this.write(pluginId, { schemaVersion: 1, values });
    } finally {
      try {
        await release();
      } catch {
        // The atomic rename already committed. A stale lock can be recovered;
        // surfacing this as a failed write would desynchronise live rollback
        // from the durable configuration post-condition.
      }
    }
  }

  private async read(pluginId: string): Promise<StoredPluginConfig> {
    const filePath = this.filePathFor(pluginId);
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('config root must be an object');
      }
      const candidate = parsed as Partial<StoredPluginConfig>;
      if (
        candidate.schemaVersion !== 1 ||
        !candidate.values ||
        typeof candidate.values !== 'object' ||
        Array.isArray(candidate.values)
      ) {
        throw new Error('invalid plugin config file');
      }
      return { schemaVersion: 1, values: { ...candidate.values } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, values: {} };
      }
      throw wrapAsMoss(error, ErrorCode.CONFIG_IO_FAILED, {
        message: `unable to read plugin config for ${pluginId}`,
        context: { pluginId },
      });
    }
  }

  private async write(pluginId: string, stored: StoredPluginConfig): Promise<void> {
    const filePath = this.filePathFor(pluginId);
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, filePath);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw wrapAsMoss(error, ErrorCode.CONFIG_IO_FAILED, {
        message: `unable to write plugin config for ${pluginId}`,
        context: { pluginId },
      });
    }
  }
}
