import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DnsTldsTab from '../DnsTldsTab';
import { ApiError } from '../../api/client';

vi.mock('../../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    manageMeshHostSuffixes: vi.fn(),
  };
});

import { manageMeshHostSuffixes } from '../../api/client';
const mocked = vi.mocked(manageMeshHostSuffixes);

describe('DnsTldsTab', () => {
  beforeEach(() => {
    mocked.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the active suffixes after loading', async () => {
    mocked.mockResolvedValueOnce({ suffixes: ['mesh', 'muti-metroo.alt'] });

    render(<DnsTldsTab canSignManagement={true} />);

    expect(screen.getByText('Loading…')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    const table = screen.getByRole('table');
    expect(within(table).getByText('.mesh')).toBeInTheDocument();
    expect(within(table).getByText('.muti-metroo.alt')).toBeInTheDocument();
  });

  it('shows the empty state when no suffixes are configured', async () => {
    mocked.mockResolvedValueOnce({ suffixes: [] });
    render(<DnsTldsTab canSignManagement={true} />);
    await waitFor(() => {
      expect(screen.getByText('No TLD suffixes configured')).toBeInTheDocument();
    });
  });

  it('shows the unavailable state on 503', async () => {
    mocked.mockRejectedValueOnce(new ApiError('mesh host management not configured', 503));
    render(<DnsTldsTab canSignManagement={true} />);
    await waitFor(() => {
      expect(screen.getByText(/Mesh-host management is not configured/)).toBeInTheDocument();
    });
  });

  it('client-side rejects an invalid suffix before submitting', async () => {
    const user = userEvent.setup();
    mocked.mockResolvedValueOnce({ suffixes: ['mesh'] });

    render(<DnsTldsTab canSignManagement={true} />);
    await waitFor(() => expect(screen.getByText('.mesh')).toBeInTheDocument());

    const input = screen.getByPlaceholderText(/TLD suffix/);
    await user.type(input, '.bad');

    expect(screen.getByText(/start with a dot/i)).toBeInTheDocument();
    const addBtn = screen.getByRole('button', { name: /^Add$/ });
    expect(addBtn).toBeDisabled();
    // Validation runs client-side; the API should NOT be called for the
    // bad input.
    expect(mocked).toHaveBeenCalledTimes(1); // initial list only
  });

  it('accepts and POSTs a multi-level suffix', async () => {
    const user = userEvent.setup();
    mocked.mockResolvedValueOnce({ suffixes: ['mesh'] });
    mocked.mockResolvedValueOnce({ suffixes: ['mesh', 'muti-metroo.alt'] });

    render(<DnsTldsTab canSignManagement={true} />);
    const table = screen.getByRole('table');
    await waitFor(() => expect(within(table).getByText('.mesh')).toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/TLD suffix/), 'muti-metroo.alt');
    await user.click(screen.getByRole('button', { name: /^Add$/ }));

    await waitFor(() => expect(within(table).getByText('.muti-metroo.alt')).toBeInTheDocument());
    expect(mocked).toHaveBeenLastCalledWith({ action: 'add', suffix: 'muti-metroo.alt' });
  });

  it('surfaces a 409 suffix-in-use error verbatim', async () => {
    const user = userEvent.setup();
    mocked.mockResolvedValueOnce({ suffixes: ['mesh'] });
    mocked.mockRejectedValueOnce(
      new ApiError('suffix has registered hosts: mesh used by gateway.mesh, target-11.mesh', 409),
    );

    render(<DnsTldsTab canSignManagement={true} />);
    const table = screen.getByRole('table');
    await waitFor(() => expect(within(table).getByText('.mesh')).toBeInTheDocument());

    await user.click(within(table).getByRole('button', { name: /^Remove$/ }));
    // Confirm dialog opens; both the row button and the dialog button
    // are labelled "Remove" — the dialog button is the second match.
    const removeBtns = screen.getAllByRole('button', { name: /^Remove$/ });
    await user.click(removeBtns[removeBtns.length - 1]);

    await waitFor(() => {
      expect(screen.getByText(/registered hosts: mesh used by gateway\.mesh/)).toBeInTheDocument();
    });
    // The row should still be there because the removal failed.
    expect(within(table).getByText('.mesh')).toBeInTheDocument();
  });

  it('renders read-only when canSignManagement is false', async () => {
    mocked.mockResolvedValueOnce({ suffixes: ['mesh'] });
    render(<DnsTldsTab canSignManagement={false} />);
    const table = screen.getByRole('table');
    await waitFor(() => expect(within(table).getByText('.mesh')).toBeInTheDocument());

    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText(/TLD suffix/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove$/ })).not.toBeInTheDocument();
  });
});
