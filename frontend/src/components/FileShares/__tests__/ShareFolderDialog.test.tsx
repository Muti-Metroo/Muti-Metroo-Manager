import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ShareFolderDialog from '../ShareFolderDialog';

const { createShareMock } = vi.hoisted(() => ({
  createShareMock: vi.fn(),
}));

vi.mock('../../../api/client', () => ({
  createShare: createShareMock,
}));

const AGENT = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';

function renderDialog() {
  const onClose = vi.fn();
  render(
    <ShareFolderDialog
      agentId={AGENT}
      agentLabel="edge-1"
      remotePath="/srv/Team Files"
      onClose={onClose}
    />,
  );
  return { onClose };
}

describe('ShareFolderDialog', () => {
  afterEach(() => vi.clearAllMocks());

  it('creates a read-only share by default and shows the password once', async () => {
    const user = userEvent.setup();
    createShareMock.mockResolvedValue({
      share: {
        id: 1,
        name: 'team-files',
        agent_id: AGENT,
        remote_path: '/srv/Team Files',
        read_only: true,
        username: 'team-files',
        enabled: true,
        created_at: '2026-01-01T00:00:00Z',
        mount_path: '/dav/team-files/',
      },
      password: 'Gen3ratedPassw0rd',
      loopback_only: true,
    });
    renderDialog();

    expect(screen.getByLabelText('Share name')).toHaveValue('team-files');
    await user.click(screen.getByRole('button', { name: 'Create share' }));

    expect(createShareMock).toHaveBeenCalledWith({
      name: 'team-files',
      agent_id: AGENT,
      remote_path: '/srv/Team Files',
      read_only: true,
      username: undefined,
      password: undefined,
    });
    expect(await screen.findByText('Gen3ratedPassw0rd')).toBeInTheDocument();
    expect(screen.getAllByText(/\/dav\/team-files\//).length).toBeGreaterThan(0);
    // Manager bound to loopback: the dialog warns that only local mounts work.
    expect(screen.getByText(/listens on a loopback address/)).toBeInTheDocument();
  });

  it('rejects an invalid name and a short password before calling the API', async () => {
    const user = userEvent.setup();
    renderDialog();
    const name = screen.getByLabelText('Share name');
    await user.clear(name);
    await user.type(name, '-bad');
    expect(screen.getByText(/Use 1-64 characters/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create share' })).toBeDisabled();

    await user.clear(name);
    await user.type(name, 'ok');
    await user.type(screen.getByLabelText('Password'), 'short');
    expect(screen.getByRole('button', { name: 'Create share' })).toBeDisabled();
    expect(createShareMock).not.toHaveBeenCalled();
  });

  it('surfaces a server error and stays open', async () => {
    const user = userEvent.setup();
    createShareMock.mockRejectedValue(new Error('remote path not found on the agent\n'));
    const { onClose } = renderDialog();
    await user.click(screen.getByRole('button', { name: 'Create share' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'remote path not found on the agent',
    );
    expect(onClose).not.toHaveBeenCalled();
  });
});
