import {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from 'react';
import { createPortal } from 'react-dom';

import './design-system.css';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

export const Button = ({
  variant = 'secondary',
  size = 'medium',
  icon,
  children,
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: 'small' | 'medium';
  icon?: ReactNode;
}) => (
  <button
    type="button"
    data-moss-ui="button"
    data-variant={variant}
    data-size={size}
    className={`moss-button ${className}`.trim()}
    {...props}
  >
    {icon && <span className="moss-button-icon">{icon}</span>}
    {children}
  </button>
);

export const Input = ({
  label,
  hint,
  icon,
  labelHidden = false,
  className = '',
  id: providedId,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  icon?: ReactNode;
  labelHidden?: boolean;
}) => {
  const generatedId = useId();
  const id = providedId ?? generatedId;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <label className={`moss-field ${className}`.trim()} data-moss-ui="input" htmlFor={id}>
      <span className={labelHidden ? 'moss-visually-hidden' : 'moss-field-label'}>{label}</span>
      <span className="moss-input-shell">
        {icon && <span className="moss-input-icon">{icon}</span>}
        <input id={id} aria-describedby={hintId} {...props} />
      </span>
      {hint && (
        <small id={hintId} className="moss-field-hint">
          {hint}
        </small>
      )}
    </label>
  );
};

export interface TabOption<T extends string> {
  value: T;
  label: string;
}

export const Tabs = <T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  orientation = 'horizontal',
}: {
  value: T;
  options: readonly TabOption<T>[];
  onChange(value: T): void;
  ariaLabel: string;
  orientation?: 'horizontal' | 'vertical';
}) => {
  const activateSibling = (index: number, direction: number) => {
    const next = options[(index + direction + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <div
      className="moss-tabs"
      data-moss-ui="tabs"
      data-orientation={orientation}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation={orientation}
    >
      {options.map((option, index) => (
        <button
          type="button"
          role="tab"
          id={`moss-tab-${option.value}`}
          aria-controls={`moss-panel-${option.value}`}
          aria-selected={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          key={option.value}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const previous = orientation === 'vertical' ? 'ArrowUp' : 'ArrowLeft';
            const next = orientation === 'vertical' ? 'ArrowDown' : 'ArrowRight';
            if (event.key === previous || event.key === next) {
              event.preventDefault();
              activateSibling(index, event.key === previous ? -1 : 1);
              const target =
                event.currentTarget.parentElement?.querySelectorAll<HTMLElement>('[role="tab"]')[
                  (index + (event.key === previous ? -1 : 1) + options.length) % options.length
                ];
              target?.focus();
            }
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
};

export const Dialog = ({
  open,
  title,
  description,
  children,
  footer,
  onClose,
}: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose(): void;
}) => {
  const titleId = useId();
  const descriptionId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !cardRef.current) return;
      const focusable = [
        ...cardRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ),
      ];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    requestAnimationFrame(() =>
      cardRef.current?.querySelector<HTMLElement>('button, input')?.focus()
    );
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previous?.focus();
    };
  }, [onClose, open]);
  if (!open) return null;
  return createPortal(
    <div className="moss-dialog-layer" data-moss-ui="dialog" onMouseDown={onClose}>
      <div
        ref={cardRef}
        className="moss-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          <Button variant="ghost" size="small" onClick={onClose} aria-label="Close dialog">
            ×
          </Button>
        </header>
        <div className="moss-dialog-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>,
    document.body
  );
};

/** Controlled modal alias used by built-in and trusted plugin surfaces. */
export const Modal = Dialog;

/** Accessible controlled menu with focus restoration and escape dismissal. */
export const Menu = ({
  open,
  trigger,
  children,
  onClose,
  label,
}: {
  open: boolean;
  trigger: ReactNode;
  children: ReactNode;
  onClose(): void;
  label: string;
}) => {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const dismiss = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') onClose();
      if (event instanceof MouseEvent && !rootRef.current?.contains(event.target as Node))
        onClose();
    };
    document.addEventListener('keydown', dismiss);
    document.addEventListener('mousedown', dismiss);
    return () => {
      document.removeEventListener('keydown', dismiss);
      document.removeEventListener('mousedown', dismiss);
      previous?.focus();
    };
  }, [onClose, open]);
  return (
    <div className="moss-menu-root" ref={rootRef} data-moss-ui="menu">
      {trigger}
      {open && (
        <div className="moss-menu" role="menu" aria-label={label}>
          {children}
        </div>
      )}
    </div>
  );
};

export const Toast = ({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'error';
}) => (
  <div
    className="moss-toast"
    data-moss-ui="toast"
    data-tone={tone}
    role="status"
    aria-live="polite"
  >
    <span aria-hidden="true" />
    {children}
  </div>
);

export const Tooltip = ({ children, content }: { children: ReactNode; content: string }) => (
  <span className="moss-tooltip-anchor" data-moss-ui="tooltip">
    {children}
    <span className="moss-tooltip" role="tooltip">
      {content}
    </span>
  </span>
);

export const Card = ({
  children,
  interactive = false,
  className = '',
  ...props
}: HTMLAttributes<HTMLDivElement> & { interactive?: boolean }) => (
  <div
    className={`moss-card ${className}`.trim()}
    data-moss-ui="card"
    data-interactive={interactive || undefined}
    {...props}
  >
    {children}
  </div>
);

export const Disclosure = ({
  summary,
  children,
  open,
}: {
  summary: ReactNode;
  children: ReactNode;
  open?: boolean;
}) => (
  <details className="moss-disclosure" data-moss-ui="disclosure" open={open}>
    <summary>{summary}</summary>
    <div className="moss-disclosure-body">{children}</div>
  </details>
);

export const Code = ({ children, language }: { children: string; language?: string }) => (
  <figure className="moss-code" data-moss-ui="code">
    {language && <figcaption>{language}</figcaption>}
    <pre>
      <code>{children}</code>
    </pre>
  </figure>
);

export const Diff = ({ value }: { value: string }) => (
  <figure className="moss-code moss-diff" data-moss-ui="diff">
    <figcaption>Diff</figcaption>
    <pre>
      {value.split('\n').map((line, index) => (
        <code
          data-diff-line={
            line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : 'context'
          }
          key={`${index}-${line}`}
        >
          {line || ' '}
          {'\n'}
        </code>
      ))}
    </pre>
  </figure>
);

export const Terminal = ({
  command,
  output,
  status = 'complete',
}: {
  command: string;
  output: string;
  status?: 'running' | 'complete' | 'failed';
}) => (
  <figure className="moss-terminal" data-moss-ui="terminal" data-status={status}>
    <figcaption>
      <span aria-hidden="true" /> Terminal
      <strong>{status}</strong>
    </figcaption>
    <pre>
      <code>
        <span className="moss-terminal-prompt">$ {command}</span>
        {'\n'}
        {output}
      </code>
    </pre>
  </figure>
);
