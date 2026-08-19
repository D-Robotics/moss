import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api-client.js';
import { Button } from './design-system.js';
import { PluginSlot } from './plugin-slot.js';
import type {
  Interaction,
  MentionInventory,
  RuntimeMode,
  WebContribution,
} from './workbench-types.js';

export interface ComposerAttachment {
  id: string;
  name: string;
  type: string;
  size: number;
  url?: string;
  text?: string;
  serverId?: string;
  downloadUrl?: string;
  error?: string;
  file?: File;
}

const fileBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read attachment'));
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.readAsDataURL(file);
  });

const uploadFile = async (file: File, current: ComposerAttachment): Promise<ComposerAttachment> => {
  try {
    const { attachment } = await api.uploadAttachment(
      file.name,
      file.type || 'text/plain',
      await fileBase64(file)
    );
    return {
      ...current,
      file,
      serverId: attachment.id,
      downloadUrl: attachment.downloadUrl,
      name: attachment.filename,
      type: attachment.mimeType,
      size: attachment.size,
      error: undefined,
    };
  } catch (error) {
    return { ...current, file, error: error instanceof Error ? error.message : 'Upload failed' };
  }
};

const AttachmentPicker = ({
  attachments,
  onChange,
}: {
  attachments: ComposerAttachment[];
  onChange(value: ComposerAttachment[]): void;
}) => {
  const input = useRef<HTMLInputElement>(null);
  const add = async (files: FileList | null) => {
    if (!files) return;
    const next = await Promise.all(
      [...files].map(async (file): Promise<ComposerAttachment> => {
        const id = crypto.randomUUID();
        const preview = file.type.startsWith('image/')
          ? { url: URL.createObjectURL(file) }
          : file.size < 128_000
            ? { text: await file.text() }
            : {};
        return uploadFile(file, {
          id,
          file,
          name: file.name,
          type: file.type,
          size: file.size,
          ...preview,
        });
      })
    );
    onChange([...attachments, ...next]);
  };
  return (
    <div className="attachment-picker">
      <input
        ref={input}
        hidden
        type="file"
        multiple
        accept="image/*,.txt,.md,.json,.diff,.patch"
        onChange={(event) => void add(event.target.files)}
      />
      <button type="button" onClick={() => input.current?.click()} aria-label="Attach files">
        ＋ Attach
      </button>
      {attachments.map((attachment) => (
        <figure key={attachment.id}>
          {attachment.url && <img src={attachment.url} alt="" width="34" height="34" />}
          <figcaption>
            {attachment.name}
            <small>
              {attachment.error ??
                `${Math.ceil(attachment.size / 1024)} KB${attachment.serverId ? ' · ready' : ''}`}
            </small>
          </figcaption>
          <button
            aria-label={`Remove ${attachment.name}`}
            onClick={() => {
              if (attachment.serverId) void api.deleteAttachment(attachment.serverId);
              if (attachment.url) URL.revokeObjectURL(attachment.url);
              onChange(attachments.filter(({ id }) => id !== attachment.id));
            }}
          >
            ×
          </button>
          {attachment.error && attachment.file && (
            <button
              onClick={() =>
                void uploadFile(attachment.file!, attachment).then((next) =>
                  onChange(attachments.map((value) => (value.id === attachment.id ? next : value)))
                )
              }
            >
              Retry
            </button>
          )}
        </figure>
      ))}
    </div>
  );
};

const InteractionPanel = ({
  interaction,
  onAnswer,
  onCancel,
}: {
  interaction: Interaction;
  onAnswer(value: string): void;
  onCancel(): void;
}) => {
  const [value, setValue] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => previous?.focus();
  }, []);
  return (
    <section
      ref={panel}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onCancel();
      }}
      className="interaction-panel"
      role="alertdialog"
      aria-label={interaction.kind === 'approval' ? 'Approval required' : 'Moss has a question'}
    >
      <p className="overline">
        {interaction.kind === 'approval' ? 'APPROVAL REQUIRED' : 'QUESTION'}
      </p>
      <h3>{interaction.prompt}</h3>
      {interaction.kind === 'approval' ? (
        <div>
          <Button onClick={() => onAnswer('allow_once')}>Allow once</Button>
          <Button onClick={() => onAnswer('allow_always')}>Always allow</Button>
          <Button variant="danger" onClick={() => onAnswer('deny')}>
            Deny
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) onAnswer(value.trim());
          }}
        >
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label="Answer"
            autoFocus
          />
          <Button type="submit">Answer</Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </form>
      )}
    </section>
  );
};

export const Composer = ({
  sessionId,
  prompt,
  running,
  disabled = false,
  mode,
  permissionPreset,
  model,
  delivery,
  interaction,
  mentions,
  contributions,
  onPrompt,
  onSend,
  onStop,
  onMode,
  onPermissionPreset,
  onModel,
  onDelivery,
  onResolve,
  onCancelInteraction,
  onCommand,
}: {
  sessionId?: string;
  prompt: string;
  running: boolean;
  disabled?: boolean;
  mode: RuntimeMode;
  permissionPreset: 'cautious' | 'balanced' | 'autonomous';
  model: string;
  delivery: 'queue' | 'steer';
  interaction?: Interaction;
  mentions: MentionInventory;
  contributions: WebContribution[];
  onPrompt(value: string): void;
  onSend(text: string, attachments: ComposerAttachment[]): void;
  onStop(): void;
  onMode(value: RuntimeMode): void;
  onPermissionPreset(value: 'cautious' | 'balanced' | 'autonomous'): void;
  onModel(value: string): void;
  onDelivery(value: 'queue' | 'steer'): void;
  onResolve(answer: string): void;
  onCancelInteraction(): void;
  onCommand(command: string): void;
}) => {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  useEffect(
    () => () => {
      for (const attachment of attachmentsRef.current)
        if (attachment.url) URL.revokeObjectURL(attachment.url);
    },
    []
  );
  const suggestions = useMemo(() => {
    if (prompt.startsWith('/')) {
      const token = prompt.split(/\s/, 1)[0]?.toLowerCase() ?? '';
      return mentions.commands.filter((value) => value.toLowerCase().startsWith(token));
    }
    const at = prompt.match(/@([\w-]*)$/)?.[1];
    return at === undefined
      ? []
      : [...mentions.skills, ...mentions.experts].filter((value) =>
          value.toLowerCase().includes(at.toLowerCase())
        );
  }, [mentions, prompt]);
  if (interaction)
    return (
      <InteractionPanel
        interaction={interaction}
        onAnswer={onResolve}
        onCancel={onCancelInteraction}
      />
    );
  const submit = () => {
    if (disabled) return;
    const text = prompt.trim();
    if (!text) return;
    if (attachments.some((attachment) => !attachment.serverId)) return;
    if (text.startsWith('/')) {
      onCommand(text);
      for (const attachment of attachments)
        if (attachment.serverId) void api.deleteAttachment(attachment.serverId);
    } else onSend(text, attachments);
    for (const attachment of attachments) if (attachment.url) URL.revokeObjectURL(attachment.url);
    setAttachments([]);
  };
  const appendTrigger = (trigger: '/' | '@') => {
    const spacing = prompt.length > 0 && !prompt.endsWith(' ') ? ' ' : '';
    onPrompt(`${prompt}${spacing}${trigger}`);
    requestAnimationFrame(() => promptInput.current?.focus());
  };
  return (
    <section className="composer-shell">
      <div className="composer-status">
        <span className={running ? 'working-dot' : 'ready-dot'} />
        <span>{running ? 'Moss is working' : disabled ? 'Creating task…' : 'Ready'}</span>
        {!running && !disabled ? <small>Enter to send · Shift + Enter for a new line</small> : null}
      </div>
      <div className="composer-card">
        <PluginSlot
          slot="conversation.composer"
          contributions={contributions}
          owner={{ kind: 'session', id: sessionId ?? 'new' }}
        />
        {suggestions.length > 0 && (
          <div className="mention-menu" role="listbox">
            {suggestions.slice(0, 8).map((value) => (
              <button
                type="button"
                key={value}
                onClick={() =>
                  onPrompt(
                    prompt.replace(
                      /(?:\/|@)[\w-]*$/,
                      `${prompt.startsWith('/') ? (value.startsWith('/') ? value : `/${value}`) : value.startsWith('@') ? value : `@${value}`} `
                    )
                  )
                }
              >
                {value}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={promptInput}
          aria-label="Task prompt"
          name="prompt"
          autoComplete="off"
          value={prompt}
          onChange={(event) => onPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Describe the outcome you want Moss to deliver…"
          rows={3}
          disabled={disabled}
        />
        <AttachmentPicker attachments={attachments} onChange={setAttachments} />
        <div className="composer-actions">
          <div className="composer-controls">
            <label className="composer-select">
              <span className="composer-select-label">Mode</span>
              <select
                aria-label="Permission mode"
                name="permission-mode"
                value={mode}
                onChange={(event) => onMode(event.target.value as RuntimeMode)}
              >
                <option value="plan">Plan</option>
                <option value="default">Default</option>
                <option value="acceptEdits">Accept edits</option>
              </select>
            </label>
            <label className="composer-select">
              <span className="composer-select-label">Permission</span>
              <select
                aria-label="Permission preset"
                name="permission-preset"
                value={permissionPreset}
                onChange={(event) =>
                  onPermissionPreset(event.target.value as 'cautious' | 'balanced' | 'autonomous')
                }
              >
                <option value="cautious">Cautious</option>
                <option value="balanced">Balanced</option>
                <option value="autonomous">Autonomous</option>
              </select>
            </label>
            <label className="composer-select">
              <span className="composer-select-label">During run</span>
              <select
                aria-label="Delivery"
                name="delivery-mode"
                value={delivery}
                onChange={(event) => onDelivery(event.target.value as 'queue' | 'steer')}
              >
                <option value="queue">Queue</option>
                <option value="steer">Steer</option>
              </select>
            </label>
            <button type="button" className="composer-chip" onClick={() => onModel(model)}>
              {model}
            </button>
            <button
              type="button"
              className="composer-chip"
              onClick={() => appendTrigger('@')}
              aria-label="Add a skill mention"
            >
              @ Skill
            </button>
            <button
              type="button"
              className="composer-chip"
              onClick={() => appendTrigger('/')}
              aria-label="Add a slash command"
            >
              / Command
            </button>
          </div>
          {running ? (
            <button type="button" className="stop-button" onClick={onStop}>
              ■ Stop
            </button>
          ) : (
            <button
              type="button"
              className="send-button"
              disabled={
                disabled || !prompt.trim() || attachments.some((attachment) => !attachment.serverId)
              }
              onClick={submit}
              aria-label="Send task"
            >
              ↑
            </button>
          )}
        </div>
      </div>
    </section>
  );
};
