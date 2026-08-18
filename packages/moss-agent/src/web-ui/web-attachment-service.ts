import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import type { ChatOptions } from '../core/agent/moss-agent.js';
import { ErrorCode, MossError, wrapAsMoss } from '../errors.js';

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const TEXT_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/xml',
  'application/yaml',
  'application/x-yaml',
]);
const ATTACHMENT_ID = /^attachment-[0-9a-f-]{36}$/;

/** Browser-safe uploaded attachment or copied generated artifact metadata. @beta */
export interface MossWebAttachmentSummary {
  readonly id: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly kind: 'text' | 'image' | 'artifact';
  readonly size: number;
  readonly createdAt: number;
  readonly downloadUrl: string;
}

interface StoredAttachment extends Omit<MossWebAttachmentSummary, 'downloadUrl'> {
  readonly schemaVersion: 1;
}

export interface MossWebAttachmentServiceOptions {
  readonly storageDir: string;
  readonly workspaceDir?: string;
  readonly maxTextBytes?: number;
  readonly maxImageBytes?: number;
  readonly maxArtifactBytes?: number;
}

/** Durable, bounded Web attachment and generated-artifact store. @internal */
export class MossWebAttachmentService {
  private readonly maxTextBytes: number;
  private readonly maxImageBytes: number;
  private readonly maxArtifactBytes: number;

  constructor(private readonly options: MossWebAttachmentServiceOptions) {
    this.maxTextBytes = options.maxTextBytes ?? 1024 * 1024;
    this.maxImageBytes = options.maxImageBytes ?? 10 * 1024 * 1024;
    this.maxArtifactBytes = options.maxArtifactBytes ?? 25 * 1024 * 1024;
  }

  async upload(input: {
    filename: string;
    mimeType: string;
    contentBase64: string;
  }): Promise<MossWebAttachmentSummary> {
    const filename = this.filename(input.filename);
    const mimeType = input.mimeType.trim().toLowerCase();
    const kind = this.uploadKind(mimeType);
    const body = this.decodeBase64(input.contentBase64);
    const limit = kind === 'image' ? this.maxImageBytes : this.maxTextBytes;
    if (body.length === 0 || body.length > limit) {
      this.invalid(`${kind} attachment must contain 1 to ${limit} bytes`);
    }
    if (kind === 'text') this.decodeText(body);
    if (kind === 'image' && !this.matchesImageSignature(mimeType, body)) {
      this.invalid(`attachment bytes do not match ${mimeType}`);
    }
    return this.store({ filename, mimeType, kind, body });
  }

  async registerArtifact(workspaceRelativePath: string): Promise<MossWebAttachmentSummary> {
    if (!this.options.workspaceDir) this.invalid('workspace artifact registration is unavailable');
    if (!workspaceRelativePath.trim() || path.isAbsolute(workspaceRelativePath)) {
      this.invalid('artifact path must be a workspace-relative path');
    }
    const workspace = await fs.realpath(this.options.workspaceDir);
    const unresolved = path.resolve(workspace, workspaceRelativePath);
    if (!this.contains(workspace, unresolved)) this.invalid('artifact path escapes the workspace');
    let source: string;
    try {
      source = await fs.realpath(unresolved);
    } catch (error) {
      throw wrapAsMoss(error, ErrorCode.CONFIG_IO_FAILED, {
        message: 'Failed to resolve generated artifact',
      });
    }
    if (!this.contains(workspace, source)) this.invalid('artifact symlink escapes the workspace');
    const stat = await fs.stat(source);
    if (!stat.isFile()) this.invalid('artifact path must identify a regular file');
    if (stat.size === 0 || stat.size > this.maxArtifactBytes) {
      this.invalid(`artifact must contain 1 to ${this.maxArtifactBytes} bytes`);
    }
    const filename = this.filename(path.basename(source));
    return this.store({
      filename,
      mimeType: this.artifactMimeType(filename),
      kind: 'artifact',
      body: await fs.readFile(source),
    });
  }

  async resolveForPrompt(ids: readonly string[]): Promise<NonNullable<ChatOptions['attachments']>> {
    if (ids.length > 8) this.invalid('a prompt may include at most 8 attachments');
    if (new Set(ids).size !== ids.length) this.invalid('attachment ids must be unique');
    const blocks: NonNullable<ChatOptions['attachments']> = [];
    for (const id of ids) {
      const { metadata, body } = await this.read(id);
      if (metadata.mimeType.startsWith('text/') || TEXT_TYPES.has(metadata.mimeType)) {
        blocks.push({
          type: 'text',
          text: `[Attachment: ${metadata.filename}]\n${this.decodeText(body)}`,
        });
      } else if (IMAGE_TYPES.has(metadata.mimeType)) {
        blocks.push({
          type: 'image',
          data: body.toString('base64'),
          mimeType: metadata.mimeType,
          filename: metadata.filename,
        });
      } else {
        this.invalid(`artifact "${metadata.filename}" cannot be sent to the model`);
      }
    }
    return blocks;
  }

  async read(id: string): Promise<{ metadata: MossWebAttachmentSummary; body: Buffer }> {
    this.assertId(id);
    try {
      const stored = JSON.parse(
        await fs.readFile(this.metadataPath(id), 'utf8')
      ) as StoredAttachment;
      if (stored.schemaVersion !== 1 || stored.id !== id)
        this.invalid('attachment metadata is invalid');
      const body = await fs.readFile(this.bodyPath(id));
      if (body.length !== stored.size) this.invalid('attachment content is incomplete');
      return { metadata: this.summary(stored), body };
    } catch (error) {
      if (error instanceof MossError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        this.invalid(`attachment "${id}" was not found`);
      throw wrapAsMoss(error, ErrorCode.CONFIG_IO_FAILED, {
        message: `Failed to read attachment "${id}"`,
      });
    }
  }

  async delete(id: string): Promise<boolean> {
    this.assertId(id);
    const removed = await fs.rm(this.metadataPath(id), { force: true }).then(() => true);
    await fs.rm(this.bodyPath(id), { force: true });
    return removed;
  }

  private async store(input: {
    filename: string;
    mimeType: string;
    kind: StoredAttachment['kind'];
    body: Buffer;
  }): Promise<MossWebAttachmentSummary> {
    const id = `attachment-${randomUUID()}`;
    const stored: StoredAttachment = {
      schemaVersion: 1,
      id,
      filename: input.filename,
      mimeType: input.mimeType,
      kind: input.kind,
      size: input.body.length,
      createdAt: Date.now(),
    };
    await fs.mkdir(this.options.storageDir, { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(this.bodyPath(id), input.body, { mode: 0o600, flag: 'wx' });
      await fs.writeFile(this.metadataPath(id), `${JSON.stringify(stored)}\n`, {
        mode: 0o600,
        flag: 'wx',
      });
    } catch (error) {
      await Promise.all([
        fs.rm(this.bodyPath(id), { force: true }),
        fs.rm(this.metadataPath(id), { force: true }),
      ]);
      throw wrapAsMoss(error, ErrorCode.CONFIG_IO_FAILED, {
        message: 'Failed to persist Web attachment',
      });
    }
    return this.summary(stored);
  }

  private summary(stored: StoredAttachment): MossWebAttachmentSummary {
    const { schemaVersion: _, ...summary } = stored;
    return { ...summary, downloadUrl: `/api/attachments/${stored.id}` };
  }

  private bodyPath(id: string): string {
    return path.join(this.options.storageDir, `${id}.bin`);
  }

  private metadataPath(id: string): string {
    return path.join(this.options.storageDir, `${id}.json`);
  }

  private filename(value: string): string {
    const basename = path.posix
      .basename(value.replaceAll('\\', '/'))
      .replace(/[\u0000-\u001f\u007f]/g, '');
    const normalized = basename.trim().slice(0, 180);
    if (!normalized || normalized === '.' || normalized === '..')
      this.invalid('filename is invalid');
    return normalized;
  }

  private uploadKind(mimeType: string): 'text' | 'image' {
    if (IMAGE_TYPES.has(mimeType)) return 'image';
    if (mimeType.startsWith('text/') || TEXT_TYPES.has(mimeType)) return 'text';
    return this.invalid(`unsupported attachment type "${mimeType}"`);
  }

  private decodeBase64(value: string): Buffer {
    if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
      this.invalid('contentBase64 must be canonical base64 without a data URL prefix');
    }
    return Buffer.from(value, 'base64');
  }

  private decodeText(body: Buffer): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      return this.invalid('text attachment must be valid UTF-8');
    }
  }

  private matchesImageSignature(mimeType: string, body: Buffer): boolean {
    if (mimeType === 'image/png')
      return body.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    if (mimeType === 'image/jpeg')
      return body[0] === 0xff && body[1] === 0xd8 && body.at(-2) === 0xff && body.at(-1) === 0xd9;
    if (mimeType === 'image/gif') return body.subarray(0, 4).toString('ascii') === 'GIF8';
    return (
      body.subarray(0, 4).toString('ascii') === 'RIFF' &&
      body.subarray(8, 12).toString('ascii') === 'WEBP'
    );
  }

  private artifactMimeType(filename: string): string {
    const extension = path.extname(filename).toLowerCase();
    const types: Record<string, string> = {
      '.txt': 'text/plain',
      '.md': 'text/markdown',
      '.json': 'application/json',
      '.csv': 'text/csv',
      '.html': 'text/html',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
    };
    return types[extension] ?? 'application/octet-stream';
  }

  private contains(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return (
      relative === '' ||
      (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
    );
  }

  private assertId(id: string): void {
    if (!ATTACHMENT_ID.test(id)) this.invalid('attachment id is invalid');
  }

  private invalid(message: string): never {
    throw new MossError({ code: ErrorCode.USER_INPUT_INVALID, message });
  }
}
