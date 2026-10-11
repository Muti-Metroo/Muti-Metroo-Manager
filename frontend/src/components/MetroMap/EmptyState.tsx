interface EmptyStateProps {
  // True when the topology contains the local agent but no remotes.
  // False (or undefined) when even the local agent is missing — i.e. a
  // fresh install with no config yet.
  hasLocalAgent?: boolean;
  onOpenAgentWizard?: () => void;
  onOpenEntryWizard?: () => void;
}

export default function EmptyState({
  hasLocalAgent,
  onOpenAgentWizard,
  onOpenEntryWizard,
}: EmptyStateProps) {
  // Two genuinely different situations, so they get different copy: a mesh
  // that was never configured needs a config; a mesh whose peers are all
  // down needs the operator to go look at those peers.
  const { icon, title, detail } = hasLocalAgent
    ? {
        icon: 'icon-[tabler--plug-connected-x]',
        title: 'No peers reachable',
        detail:
          'The local agent is running, but none of its configured peers answered. Check that those agents are up and that their listeners are reachable from this host.',
      }
    : {
        icon: 'icon-[tabler--topology-star-3]',
        title: 'No agents in the mesh',
        detail:
          'Nothing is connected yet. Generate a config to bootstrap the first node, or set up an entry point to route traffic into the mesh.',
      };

  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <div className="rounded-box border-hairline bg-base-100 pointer-events-auto max-w-md border p-6 text-center shadow-lg">
        <span
          className={`${icon} text-base-content/30 mx-auto mb-3 block size-10`}
          aria-hidden="true"
        />
        <h2 className="mb-1 text-sm font-semibold">{title}</h2>
        <p className="text-muted mb-4">{detail}</p>
        {(onOpenAgentWizard || onOpenEntryWizard) && (
          <div className="flex flex-wrap justify-center gap-2">
            {onOpenAgentWizard && (
              <button type="button" className="btn btn-sm btn-primary" onClick={onOpenAgentWizard}>
                Generate agent config
              </button>
            )}
            {onOpenEntryWizard && (
              <button type="button" className="btn btn-sm btn-soft" onClick={onOpenEntryWizard}>
                Set up entry point
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
