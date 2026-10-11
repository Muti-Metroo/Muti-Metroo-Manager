import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DnsHostsTab from '../DnsHostsTab';

vi.mock('../../api/client', async importOriginal => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    manageMeshHosts: vi.fn(),
  };
});

import { manageMeshHosts } from '../../api/client';
const mocked = vi.mocked(manageMeshHosts);

describe('DnsHostsTab', () => {
  beforeEach(() => {
    mocked.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('accepts a single-label suffix match', async () => {
    const user = userEvent.setup();
    mocked.mockResolvedValueOnce({ suffixes: ['mesh'], hosts: [] });

    render(<DnsHostsTab canSignManagement={true} onGoToTlds={() => {}} />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/Hostname/), 'target-11.mesh');
    await user.type(screen.getByPlaceholderText(/IPv4/), '10.8.0.11');

    expect(screen.getByRole('button', { name: /^Add$/ })).not.toBeDisabled();
    expect(screen.queryByText(/Name must end with/)).not.toBeInTheDocument();
  });

  it('accepts a multi-level suffix match (longest wins)', async () => {
    const user = userEvent.setup();
    mocked.mockResolvedValueOnce({ suffixes: ['alt', 'muti-metroo.alt'], hosts: [] });

    render(<DnsHostsTab canSignManagement={true} onGoToTlds={() => {}} />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/Hostname/), 'foo.muti-metroo.alt');
    await user.type(screen.getByPlaceholderText(/IPv4/), '10.0.0.1');

    expect(screen.getByRole('button', { name: /^Add$/ })).not.toBeDisabled();
  });

  it('rejects names that do not end with any active suffix', async () => {
    const user = userEvent.setup();
    mocked.mockResolvedValueOnce({ suffixes: ['mesh', 'muti-metroo.alt'], hosts: [] });

    render(<DnsHostsTab canSignManagement={true} onGoToTlds={() => {}} />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/Hostname/), 'host.lan');
    await user.type(screen.getByPlaceholderText(/IPv4/), '1.2.3.4');

    expect(screen.getByText(/Name must end with one of:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Add$/ })).toBeDisabled();
  });

  it('rejects a single-label name even when it equals the suffix', async () => {
    // Mesh-host names must have at least one label below the TLD; the
    // agent rejects single-label registrations server-side, so we
    // surface the same rule client-side for immediate feedback.
    const user = userEvent.setup();
    mocked.mockResolvedValueOnce({ suffixes: ['mesh'], hosts: [] });

    render(<DnsHostsTab canSignManagement={true} onGoToTlds={() => {}} />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/Hostname/), 'mesh');
    await user.type(screen.getByPlaceholderText(/IPv4/), '10.0.0.1');

    expect(screen.getByText(/Name must end with one of:/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Add$/ })).toBeDisabled();
  });

  it('still accepts a multi-level bare-TLD entry (e.g. muti-metroo.alt under suffix muti-metroo.alt)', async () => {
    const user = userEvent.setup();
    mocked.mockResolvedValueOnce({ suffixes: ['muti-metroo.alt'], hosts: [] });

    render(<DnsHostsTab canSignManagement={true} onGoToTlds={() => {}} />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    await user.type(screen.getByPlaceholderText(/Hostname/), 'muti-metroo.alt');
    await user.type(screen.getByPlaceholderText(/IPv4/), '10.0.0.1');

    expect(screen.getByRole('button', { name: /^Add$/ })).not.toBeDisabled();
    expect(screen.queryByText(/Name must end with/)).not.toBeInTheDocument();
  });

  it('shows the empty-suffix hint when no TLDs are configured', async () => {
    const onGoToTlds = vi.fn();
    mocked.mockResolvedValueOnce({ suffixes: [], hosts: [] });

    render(<DnsHostsTab canSignManagement={true} onGoToTlds={onGoToTlds} />);
    await waitFor(() => expect(screen.queryByText('Loading…')).not.toBeInTheDocument());

    expect(screen.getByText(/No TLD suffixes are configured/)).toBeInTheDocument();
    // Add form is hidden until at least one TLD is registered.
    expect(screen.queryByPlaceholderText(/Hostname/)).not.toBeInTheDocument();
  });
});
