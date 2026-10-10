import { useModalDismiss } from '../hooks/useModalDismiss';
import DialogHeader from './DialogHeader';

interface ConfirmDialogProps {
  title: string;
  target: string;
  message: string;
  confirmLabel?: string;
  pendingLabel?: string;
  loading?: boolean;
  // Raises the message to warning weight, for a destructive action that
  // takes more than the named target with it (a recursive delete).
  tone?: 'normal' | 'warning';
  // Failure from the last confirm attempt; shown in the footer so the dialog
  // stays open and the operator can retry.
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export default function ConfirmDialog({
  title,
  target,
  message,
  confirmLabel = 'Remove',
  pendingLabel = 'Removing...',
  loading = false,
  tone = 'normal',
  error = null,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const dismiss = () => {
    if (!loading) onCancel();
  };
  useModalDismiss({ onClose: dismiss });
  return (
    <div className="ui-overlay" onClick={dismiss}>
      <div
        className="ui-dialog max-w-md"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={e => e.stopPropagation()}
      >
        <DialogHeader title={title} onClose={onCancel} closeDisabled={loading} />
        <div className="ui-dialog-body space-y-2">
          <div className="font-mono break-all">{target}</div>
          <div className={tone === 'warning' ? 'text-warning' : 'text-muted'}>{message}</div>
        </div>
        <div className="ui-dialog-footer">
          {error && (
            <span className="text-error me-auto" role="alert">
              {error}
            </span>
          )}
          <button
            type="button"
            className="btn btn-sm btn-text"
            onClick={onCancel}
            disabled={loading}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-sm btn-error"
            disabled={loading}
            onClick={onConfirm}
          >
            {loading ? pendingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
