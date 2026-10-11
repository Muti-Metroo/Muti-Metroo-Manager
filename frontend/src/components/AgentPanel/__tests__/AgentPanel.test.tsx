import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import AgentPanel from '../AgentPanel';
import { EMPTY_AGENT_META } from '../../../api/types';
import type { TopologyAgentInfo } from '../../../api/types';

// ShellTab is stubbed with a mount-tracking component: the assertion that
// matters is whether React unmounts it on a panel-tab switch (which would
// tear down the real terminal + WebSocket in its cleanup effect).
const shellLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock('../ShellTab', () => ({
  default: () => {
    useEffect(() => {
      shellLifecycle.mounts++;
      return () => {
        shellLifecycle.unmounts++;
      };
    }, []);
    return <div data-testid="shell-tab" />;
  },
}));

vi.mock('../FilesTab', () => ({
  default: () => <div data-testid="files-tab" />,
}));

const agent = {
  id: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
  short_id: 'a1b2',
  shell_enabled: true,
  file_transfer_enabled: true,
  shells: ['sh'],
} as TopologyAgentInfo;

function renderPanel(activeTab: 'shell' | 'files') {
  return (
    <AgentPanel
      agent={agent}
      isActive={true}
      activeTab={activeTab}
      onTabChange={() => {}}
      meshResult={undefined}
      capabilities={{ shell: null, fileTransfer: null, icmp: null }}
      canSignManagement={true}
      apiAddress="localhost:8080"
      socksAddress="localhost:8080"
      meta={EMPTY_AGENT_META}
      onMetaChange={() => {}}
      networks={[]}
      allForwardKeys={[]}
      agentsById={new Map()}
      onCapabilityUpdate={() => {}}
      onMeshChanged={() => {}}
      onClose={() => {}}
      animate={false}
      onAnimated={() => {}}
    />
  );
}

describe('AgentPanel shell session persistence', () => {
  beforeEach(() => {
    shellLifecycle.mounts = 0;
    shellLifecycle.unmounts = 0;
  });

  it('keeps the shell tab mounted (display:none) across panel-tab switches', () => {
    const { rerender } = render(renderPanel('shell'));
    expect(screen.getByTestId('shell-tab')).toBeInTheDocument();
    expect(shellLifecycle.mounts).toBe(1);

    // Switch to Files: the shell subtree stays mounted but hidden.
    rerender(renderPanel('files'));
    expect(screen.getByTestId('files-tab')).toBeInTheDocument();
    const shellTab = screen.getByTestId('shell-tab');
    expect(shellTab.parentElement).toHaveStyle({ display: 'none' });
    expect(shellLifecycle.unmounts).toBe(0);

    // Switch back: same instance becomes visible again, no remount.
    rerender(renderPanel('shell'));
    expect(shellTab.parentElement).not.toHaveStyle({ display: 'none' });
    expect(shellLifecycle.mounts).toBe(1);
    expect(shellLifecycle.unmounts).toBe(0);
  });

  it('does not mount the shell tab until it is first opened', () => {
    render(renderPanel('files'));
    expect(screen.queryByTestId('shell-tab')).not.toBeInTheDocument();
    expect(shellLifecycle.mounts).toBe(0);
  });
});
