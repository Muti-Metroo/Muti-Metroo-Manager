import { useState } from 'react';
import type { TopologyAgentInfo } from '../../api/types';
import Tabs from '../Tabs';
import PeersTab from './PeersTab';
import ListenersTab from './ListenersTab';

type ConnectivitySubTab = 'peers' | 'listeners';

const CONNECTIVITY_SUB_TABS: { id: ConnectivitySubTab; label: string }[] = [
  { id: 'peers', label: 'Peers' },
  { id: 'listeners', label: 'Listeners' },
];

interface ConnectivityTabProps {
  agent: TopologyAgentInfo;
  canSignManagement: boolean | null;
  agentsById: Map<string, TopologyAgentInfo>;
  onMeshChanged: () => void;
}

export default function ConnectivityTab({
  agent,
  canSignManagement,
  agentsById,
  onMeshChanged,
}: ConnectivityTabProps) {
  // Local state (not URL): agent-panel tabs don't carry sub-tab routing.
  // Peers is the default so it shows first when the tab opens.
  const [subTab, setSubTab] = useState<ConnectivitySubTab>('peers');

  return (
    <section className="flex min-h-0 flex-1 flex-col">
      <Tabs
        size="sm"
        className="mb-3"
        tabs={CONNECTIVITY_SUB_TABS}
        activeId={subTab}
        onChange={setSubTab}
      />

      {subTab === 'listeners' ? (
        <ListenersTab
          agent={agent}
          canSignManagement={canSignManagement}
          onListenersChanged={onMeshChanged}
        />
      ) : (
        <PeersTab
          agent={agent}
          canSignManagement={canSignManagement}
          agentsById={agentsById}
          onPeersChanged={onMeshChanged}
        />
      )}
    </section>
  );
}
