import type { MeshTestResponse } from '../api/types';
import { useModalDismiss } from '../hooks/useModalDismiss';
import DialogHeader from './DialogHeader';

interface TestResultsModalProps {
  type: 'success' | 'error';
  data?: MeshTestResponse;
  error?: string;
  onClose: () => void;
}

export default function TestResultsModal({ type, data, error, onClose }: TestResultsModalProps) {
  useModalDismiss({ onClose });
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose();
  };

  const header = <DialogHeader title="Mesh test results" onClose={onClose} />;

  if (type === 'error') {
    return (
      <div className="ui-overlay" onClick={handleOverlayClick}>
        <div className="ui-dialog max-w-lg" role="dialog" aria-modal="true">
          {header}
          <div className="ui-dialog-body">
            <div className="alert alert-error alert-soft" role="alert">
              {error || 'Mesh test failed'}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const reachable = data.reachable_count ?? 0;
  const total = data.total_count ?? 0;
  const duration = data.duration_ms ?? 0;
  const allPass = reachable === total;
  const remoteResults = (data.results || []).filter(r => !r.is_local);

  return (
    <div className="ui-overlay" onClick={handleOverlayClick}>
      <div className="ui-dialog max-w-lg" role="dialog" aria-modal="true">
        {header}
        <div
          className={`border-hairline flex items-center gap-2 border-b px-4 py-2 font-medium ${
            allPass ? 'text-success' : 'text-warning'
          }`}
        >
          <span
            className={`size-4 ${allPass ? 'icon-[tabler--circle-check]' : 'icon-[tabler--alert-triangle]'}`}
            aria-hidden="true"
          />
          {reachable}/{total} reachable &middot; {duration}ms
        </div>
        <div className="ui-dialog-body p-0">
          {remoteResults.length === 0 && <div className="ui-empty">No remote agents</div>}
          {remoteResults.length > 0 && (
            <table className="table table-sm">
              <tbody>
                {remoteResults.map(r => (
                  <tr key={r.agent_id}>
                    <td className="w-4">
                      <span
                        aria-hidden="true"
                        className={`status status-sm ${r.reachable ? 'status-success' : 'status-error'}`}
                      />
                    </td>
                    <td className="font-medium">{r.display_name || r.short_id}</td>
                    <td className="text-end font-mono">
                      {r.reachable ? (
                        `${r.response_time_ms}ms`
                      ) : (
                        <span className="text-error">{r.error || 'unreachable'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
