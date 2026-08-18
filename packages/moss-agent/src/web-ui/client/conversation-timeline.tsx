import { Fragment, useEffect, useRef, useState } from 'react';
import { api } from './api-client.js';
import { Code, Diff, Disclosure, Terminal } from './design-system.js';
import { PluginSlot } from './plugin-slot.js';
import type { TimelineItem, WebContribution } from './workbench-types.js';

const inline = (text: string) =>
  text
    .split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
    .map((part, index) =>
      part.startsWith('`') ? (
        <code key={index}>{part.slice(1, -1)}</code>
      ) : part.startsWith('**') ? (
        <strong key={index}>{part.slice(2, -2)}</strong>
      ) : (
        <Fragment key={index}>{part}</Fragment>
      )
    );

const Markdown = ({ text }: { text: string }) => {
  const lines = text.split('\n');
  const nodes: React.ReactNode[] = [];
  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? '';
    if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index]?.startsWith('```'))
        body.push(lines[index++] ?? '');
      index++;
      nodes.push(
        <Code key={nodes.length} language={language}>
          {body.join('\n')}
        </Code>
      );
      continue;
    }
    if (line.includes('|') && lines[index + 1]?.match(/^\s*\|?\s*:?-+/)) {
      const rows: string[][] = [];
      rows.push(
        line
          .split('|')
          .filter(Boolean)
          .map((cell) => cell.trim())
      );
      index += 2;
      while (index < lines.length && lines[index]?.includes('|'))
        rows.push(
          (lines[index++] ?? '')
            .split('|')
            .filter(Boolean)
            .map((cell) => cell.trim())
        );
      nodes.push(
        <div className="markdown-table-wrap" key={nodes.length}>
          <table>
            <thead>
              <tr>
                {rows[0]?.map((cell) => (
                  <th key={cell}>{inline(cell)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.slice(1).map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex}>{inline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    if (/^#{1,4} /.test(line)) {
      const level = line.match(/^#+/)?.[0].length ?? 2;
      nodes.push(
        <div className={`md-heading md-h${level}`} key={nodes.length}>
          {inline(line.replace(/^#+\s*/, ''))}
        </div>
      );
      index++;
      continue;
    }
    if (/^[-*] /.test(line)) {
      const list: string[] = [];
      while (index < lines.length && /^[-*] /.test(lines[index] ?? ''))
        list.push((lines[index++] ?? '').slice(2));
      nodes.push(
        <ul key={nodes.length}>
          {list.map((value) => (
            <li key={value}>{inline(value)}</li>
          ))}
        </ul>
      );
      continue;
    }
    nodes.push(line ? <p key={nodes.length}>{inline(line)}</p> : <br key={nodes.length} />);
    index++;
  }
  return <div className="markdown-body">{nodes}</div>;
};

const rendererKind = (name: string) => {
  const lower = name.toLowerCase();
  if (lower.includes('diff')) return 'diff';
  if (/(terminal|shell|exec|command)/.test(lower)) return 'terminal';
  if (/(read|file)/.test(lower)) return 'read';
  if (/(edit|write|patch)/.test(lower)) return 'edit';
  if (/(search|find|grep)/.test(lower)) return 'search';
  if (/(web|browser|http)/.test(lower)) return 'web';
  return 'json';
};

const ToolPreview = ({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) => {
  const [artifact, setArtifact] = useState<{ filename: string; downloadUrl: string }>();
  const content =
    typeof item.result === 'string'
      ? item.result
      : JSON.stringify(item.result ?? item.input ?? {}, null, 2);
  const kind = rendererKind(item.name);
  const download =
    typeof item.result === 'object' && item.result !== null
      ? (item.result as { downloadUrl?: unknown; name?: unknown })
      : undefined;
  const artifactPath =
    typeof item.result === 'object' && item.result !== null
      ? ((item.result as { workspaceRelativePath?: unknown }).workspaceRelativePath ??
        (item.result as { path?: unknown }).path)
      : undefined;
  if (download && typeof download.downloadUrl === 'string')
    return (
      <div className="generated-file">
        <Code language="json">{content}</Code>
        <a
          href={download.downloadUrl}
          download={typeof download.name === 'string' ? download.name : ''}
        >
          Download generated file
        </a>
      </div>
    );
  if (
    typeof artifactPath === 'string' &&
    !artifactPath.startsWith('/') &&
    !artifactPath.includes('..')
  )
    return (
      <div className="generated-file">
        <Code language={kind}>{content}</Code>
        {artifact ? (
          <a href={artifact.downloadUrl} download={artifact.filename}>
            Download generated file
          </a>
        ) : (
          <button
            onClick={() =>
              void api
                .createArtifact(artifactPath)
                .then(({ attachment }) => setArtifact(attachment))
            }
          >
            Prepare generated file
          </button>
        )}
      </div>
    );
  if (kind === 'diff' || kind === 'edit') return <Diff value={content} />;
  if (kind === 'terminal')
    return <Terminal command={item.name} output={content} status={item.state} />;
  return <Code language={kind === 'json' ? 'json' : kind}>{content}</Code>;
};

export const ConversationTimeline = ({
  items,
  sessionId,
  contributions,
  scrollTop,
  onScroll,
  onSelectTool,
  onRetry,
  onCopy,
  onFeedback,
}: {
  items: TimelineItem[];
  sessionId?: string;
  contributions: WebContribution[];
  scrollTop: number;
  onScroll(value: number): void;
  onSelectTool(item: Extract<TimelineItem, { kind: 'tool' }>): void;
  onRetry(): void;
  onCopy(text: string): void;
  onFeedback(value: 'up' | 'down'): void;
}) => {
  const rootRef = useRef<HTMLElement>(null);
  const followRef = useRef(true);
  useEffect(() => {
    if (rootRef.current) {
      rootRef.current.scrollTop = scrollTop;
      followRef.current =
        rootRef.current.scrollHeight - rootRef.current.clientHeight - scrollTop < 80;
    }
  }, [sessionId]);
  useEffect(() => {
    if (followRef.current && rootRef.current)
      rootRef.current.scrollTop = rootRef.current.scrollHeight;
  }, [items]);
  return (
    <section
      className="timeline"
      ref={rootRef}
      onScroll={(event) => {
        followRef.current =
          event.currentTarget.scrollHeight -
            event.currentTarget.clientHeight -
            event.currentTarget.scrollTop <
          80;
        onScroll(event.currentTarget.scrollTop);
      }}
      aria-live="polite"
      aria-relevant="additions text"
    >
      {items.map((item) => {
        if (item.kind === 'tool')
          return (
            <Disclosure
              key={item.id}
              summary={
                <button
                  className={`tool-row tool-${item.state}`}
                  onClick={() => onSelectTool(item)}
                >
                  <span className="tool-state" />
                  <span className="tool-copy">
                    <strong>{item.name}</strong>
                    <small>
                      {item.state === 'running'
                        ? 'Running tool'
                        : `${rendererKind(item.name)} · ${item.state}`}
                    </small>
                  </span>
                  <span className="tool-arrow">›</span>
                </button>
              }
            >
              <div className="tool-inline-tree">
                <ToolPreview item={item} />
                <PluginSlot
                  slot="tool.inline"
                  contributions={contributions}
                  owner={{ kind: 'tool', id: item.id, data: item }}
                />
              </div>
            </Disclosure>
          );
        if (item.kind === 'reasoning')
          return (
            <Disclosure summary="Reasoning" key={item.id}>
              <Markdown text={item.text} />
            </Disclosure>
          );
        if (item.kind === 'retry')
          return (
            <article className="event-card warning" key={item.id}>
              <strong>Retry {item.attempt}</strong>
              <span>{item.text}</span>
              <button onClick={onRetry}>Retry now</button>
            </article>
          );
        if (item.kind === 'compaction')
          return (
            <article className="event-card" key={item.id}>
              <strong>Context compacted</strong>
              <span>
                {item.droppedMessages} messages summarized · {item.summaryChars} characters
              </span>
              {item.outline && (
                <ul>
                  {item.outline.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </article>
          );
        if (item.kind === 'usage')
          return (
            <article className="usage-meter" key={item.id}>
              <span>Usage</span>
              <strong>{item.inputTokens + item.outputTokens} tokens</strong>
              <meter
                min="0"
                max={Math.max(item.contextTokens ?? 1, item.inputTokens + item.outputTokens)}
                value={item.inputTokens + item.outputTokens}
              />
            </article>
          );
        if (item.kind === 'context')
          return (
            <Disclosure summary={`Context · ${item.status}`} key={item.id}>
              <dl>
                <dt>Goal</dt>
                <dd>{item.goal}</dd>
                <dt>Next action</dt>
                <dd>{item.nextAction}</dd>
                <dt>Reason</dt>
                <dd>{item.reason}</dd>
              </dl>
            </Disclosure>
          );
        if (item.kind === 'status')
          return (
            <article className={`event-card ${item.state ?? ''}`} role="status" key={item.id}>
              <strong>{item.state === 'interrupted' ? 'Interrupted' : 'Run status'}</strong>
              <span>{item.text}</span>
            </article>
          );
        return (
          <article className={`message message-${item.kind} ${item.state ?? ''}`} key={item.id}>
            <div className="message-author">{item.kind === 'user' ? 'You' : 'Moss'}</div>
            <Markdown text={item.text} />
            {item.kind === 'assistant' && (
              <div className="message-actions">
                <button onClick={() => onCopy(item.text)}>Copy</button>
                <button onClick={() => onFeedback('up')} aria-label="Helpful">
                  ↑
                </button>
                <button onClick={() => onFeedback('down')} aria-label="Not helpful">
                  ↓
                </button>
                <button onClick={onRetry}>Retry</button>
              </div>
            )}
            <PluginSlot
              slot="conversation.message"
              contributions={contributions}
              owner={{ kind: 'message', id: item.id, data: item }}
            />
          </article>
        );
      })}
    </section>
  );
};
