import Tabs from './Tabs';
import DnsHostsTab from './DnsHostsTab';
import DnsTldsTab from './DnsTldsTab';

export type DnsSubTab = 'hosts' | 'tlds';

const DNS_SUB_TABS: { id: DnsSubTab; label: string }[] = [
  { id: 'hosts', label: 'Hosts' },
  { id: 'tlds', label: 'TLDs' },
];

interface DnsTabProps {
  subTab: DnsSubTab;
  onSubTabChange: (id: DnsSubTab) => void;
  // Whether the locally-connected agent can sign management mutations.
  // null while unknown. When false, add/remove forms are hidden since
  // the server would reject them with an auth error.
  canSignManagement: boolean | null;
}

export default function DnsTab({ subTab, onSubTabChange, canSignManagement }: DnsTabProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col p-4">
      <Tabs
        size="sm"
        className="mb-3"
        tabs={DNS_SUB_TABS}
        activeId={subTab}
        onChange={onSubTabChange}
      />

      {subTab === 'tlds' ? (
        <DnsTldsTab canSignManagement={canSignManagement} />
      ) : (
        <DnsHostsTab
          canSignManagement={canSignManagement}
          onGoToTlds={() => onSubTabChange('tlds')}
        />
      )}
    </section>
  );
}
