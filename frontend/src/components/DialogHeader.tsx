interface DialogHeaderProps {
  title: string;
  // Tabler icon class (e.g. 'icon-[tabler--settings]') shown before the title.
  icon?: string;
  // Omit for dialogs that have no dismiss affordance of their own, like the
  // authentication prompt.
  onClose?: () => void;
  closeDisabled?: boolean;
}

/**
 * The title bar every dialog in the app shares. Centralised so the close
 * button keeps one shape and one accessible name; it had drifted between
 * "Close", "Dismiss" and "Close icon picker" for the same control.
 */
export default function DialogHeader({
  title,
  icon,
  onClose,
  closeDisabled = false,
}: DialogHeaderProps) {
  return (
    <div className="ui-dialog-header">
      <span className="flex items-center gap-2">
        {icon && <span className={`${icon} text-primary size-4`} aria-hidden="true" />}
        {title}
      </span>
      {onClose && (
        <button
          type="button"
          className="btn btn-text btn-xs btn-square"
          aria-label="Close"
          onClick={onClose}
          disabled={closeDisabled}
        >
          <span className="icon-[tabler--x] size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
