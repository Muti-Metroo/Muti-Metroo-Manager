import type { DashboardRouteInfo } from '../api/types';
import Tabs from './Tabs';
import RouteTable from './RouteTable';
import RouteTraceSection from './RouteTraceSection';

export type RoutesSubTab = 'active' | 'test';

interface RoutesPanelProps {
  routes: DashboardRouteInfo[] | null;
  subTab: RoutesSubTab;
  onSubTabChange: (id: RoutesSubTab) => void;
  onHighlight: (pathIds: string[]) => void;
  onClearHighlight: () => void;
  onSelectAgent: (agentId: string) => void;
}

const SUB_TABS: { id: RoutesSubTab; label: string }[] = [
  { id: 'active', label: 'Active routes' },
  { id: 'test', label: 'Test routing' },
];

export default function RoutesPanel({
  routes,
  subTab,
  onSubTabChange,
  onHighlight,
  onClearHighlight,
  onSelectAgent,
}: RoutesPanelProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col p-4">
      <Tabs
        size="sm"
        className="mb-3"
        tabs={SUB_TABS}
        activeId={subTab}
        onChange={onSubTabChange}
      />

      {subTab === 'active' ? (
        <RouteTable
          routes={routes}
          onHighlight={onHighlight}
          onClearHighlight={onClearHighlight}
          onSelectAgent={onSelectAgent}
        />
      ) : (
        <RouteTraceSection />
      )}
    </section>
  );
}
