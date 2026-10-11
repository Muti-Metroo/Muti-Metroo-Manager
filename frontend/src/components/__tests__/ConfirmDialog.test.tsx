import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ConfirmDialog from '../ConfirmDialog';

function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      title="Delete file"
      target="/etc/hosts"
      message="Are you sure?"
      onCancel={onCancel}
      onConfirm={onConfirm}
      {...overrides}
    />,
  );
  return { onCancel, onConfirm, dialog: screen.getByRole('dialog', { name: 'Delete file' }) };
}

describe('ConfirmDialog', () => {
  it('shows the target and message, and confirms', async () => {
    const user = userEvent.setup();
    const { onConfirm, dialog } = renderDialog({ confirmLabel: 'Delete' });

    expect(within(dialog).getByText('/etc/hosts')).toBeInTheDocument();
    expect(within(dialog).getByText('Are you sure?')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { onCancel } = renderDialog();

    await user.keyboard('{Escape}');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  // A confirm already in flight must not be dismissable, or the operator can
  // close the dialog while the destructive request is still running.
  it('ignores Escape and disables its buttons while loading', async () => {
    const user = userEvent.setup();
    const { onCancel, onConfirm, dialog } = renderDialog({
      loading: true,
      pendingLabel: 'Deleting...',
    });

    await user.keyboard('{Escape}');
    expect(onCancel).not.toHaveBeenCalled();

    expect(within(dialog).getByRole('button', { name: 'Deleting...' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('surfaces a failed attempt without closing', () => {
    const { dialog } = renderDialog({ error: 'permission denied' });

    expect(within(dialog).getByRole('alert')).toHaveTextContent('permission denied');
    // Still interactive, so the operator can retry or cancel.
    expect(within(dialog).getByRole('button', { name: 'Remove' })).toBeEnabled();
  });

  it('raises the message to warning weight for a recursive delete', () => {
    const { dialog } = renderDialog({
      message: 'This deletes the folder and all its contents.',
      tone: 'warning',
    });

    expect(within(dialog).getByText('This deletes the folder and all its contents.')).toHaveClass(
      'text-warning',
    );
  });
});
