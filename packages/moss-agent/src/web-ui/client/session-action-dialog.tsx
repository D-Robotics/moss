import { Button, Dialog, Input } from './design-system.js';
import type { SessionSummary } from './workbench-types.js';

export interface PendingSessionAction {
  readonly action: 'rename' | 'delete' | 'rewind';
  readonly session: SessionSummary;
  readonly title: string;
  readonly description: string;
  readonly expected?: string;
}

export const SessionActionDialog = ({
  pending,
  value,
  onValue,
  onClose,
  onConfirm,
}: {
  pending?: PendingSessionAction;
  value: string;
  onValue(value: string): void;
  onClose(): void;
  onConfirm(): void;
}) => {
  const rewindCount = Number(value);
  const disabled =
    !pending ||
    (pending.action === 'rename' && !value.trim()) ||
    (pending.action === 'delete' && value !== pending.expected) ||
    (pending.action === 'rewind' && (!Number.isInteger(rewindCount) || rewindCount < 0));
  return (
    <Dialog
      open={Boolean(pending)}
      title={pending?.title ?? 'Task action'}
      description={pending?.description}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={pending?.action === 'delete' ? 'danger' : 'primary'}
            disabled={disabled}
            onClick={onConfirm}
          >
            {pending?.action === 'delete' ? 'Delete' : 'Continue'}
          </Button>
        </>
      }
    >
      {pending?.expected ? (
        <code className="dialog-confirmation-value">{pending.expected}</code>
      ) : null}
      <Input
        label={pending?.title ?? 'Task action value'}
        labelHidden
        type={pending?.action === 'rewind' ? 'number' : 'text'}
        value={value}
        onChange={(event) => onValue(event.target.value)}
      />
    </Dialog>
  );
};
