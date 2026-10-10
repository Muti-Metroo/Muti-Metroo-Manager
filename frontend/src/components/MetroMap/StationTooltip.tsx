import { useState, useCallback, useRef, useEffect } from 'react';
import type { MeshTestResult } from '../../api/types';
import type { PositionedAgent } from './layout';
import { copyToClipboard } from '../../util/clipboard';
import { formatUptime } from '../../util/format';

const NOTE_PREVIEW_MAX = 280;

interface StationTooltipProps {
  agent: PositionedAgent | null;
  meshResult: MeshTestResult | undefined;
  stationElement: SVGGElement | null;
  svgElement: SVGSVGElement | null;
  // Operator-configured SOCKS5 override; preferred for the local agent
  // over its self-reported socks5_addr.
  socksAddress: string;
  // Persisted note for this agent; empty string means no note.
  note: string;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onClickAgent: (agentId: string) => void;
}

export default function StationTooltip({
  agent,
  meshResult,
  stationElement,
  svgElement,
  socksAddress,
  note,
  onMouseEnter,
  onMouseLeave,
  onClickAgent,
}: StationTooltipProps) {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [copyHint, setCopyHint] = useState('Click to copy');
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!stationElement || !agent) return;

    const rect = stationElement.getBoundingClientRect();
    let x = rect.right + 10;
    let y = rect.top;

    // Adjust after render
    requestAnimationFrame(() => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      const tRect = tooltip.getBoundingClientRect();

      if (x + tRect.width > window.innerWidth - 10) {
        x = rect.left - tRect.width - 10;
      }
      if (y + tRect.height > window.innerHeight - 10) {
        y = window.innerHeight - tRect.height - 10;
      }
      if (y < 10) y = 10;

      setPos({ x, y });
    });

    setPos({ x, y });
  }, [stationElement, agent]);

  const handleCopy = useCallback(async () => {
    if (!agent) return;
    const ok = await copyToClipboard(agent.id || agent.short_id);
    setCopyHint(ok ? 'Copied!' : 'Copy failed');
    setTimeout(() => setCopyHint('Click to copy'), 1500);
  }, [agent]);

  if (!agent) return null;

  const roles = agent.roles || ['transit'];
  const displaySocks = agent.is_local && socksAddress ? socksAddress : agent.socks5_addr;

  const uptimeStr = formatUptime(agent.uptime_hours);

  const exitRoutes = agent.exit_routes || [];
  const domainRoutes = agent.domain_routes || [];
  const forwardListeners = agent.forward_listeners || [];
  const forwardEndpoints = agent.forward_endpoints || [];

  return (
    <div
      ref={tooltipRef}
      className="station-tooltip"
      style={{ left: pos.x, top: pos.y }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="tooltip-header">
        <div
          className="tooltip-name tooltip-name-clickable"
          onClick={() => {
            onMouseLeave();
            onClickAgent(agent.short_id);
          }}
        >
          {agent.display_name || agent.short_id}
        </div>
      </div>

      {roles.length > 0 && (
        <div className="tooltip-roles">
          {roles.map(role => (
            <span key={role} className={`ui-chip tooltip-role-badge ${role}`}>
              {role}
            </span>
          ))}
        </div>
      )}

      {meshResult && (
        <div className="tooltip-section">
          <div className="tooltip-section-header reachability">Reachability</div>
          {meshResult.reachable ? (
            <div className="tooltip-reachability-ok">
              OK ({meshResult.is_local ? 'local' : `${meshResult.response_time_ms}ms`})
            </div>
          ) : (
            <div className="tooltip-reachability-error">
              FAILED: {meshResult.error || 'unreachable'}
            </div>
          )}
        </div>
      )}

      <div className="tooltip-info">
        {agent.hostname && (
          <div className="tooltip-info-line">
            <span className="tooltip-info-label">Hostname</span>
            <span className="tooltip-info-value">{agent.hostname}</span>
          </div>
        )}
        {(agent.os || agent.arch) && (
          <div className="tooltip-info-line">
            <span className="tooltip-info-label">Platform</span>
            <span className="tooltip-info-value">
              {[agent.os, agent.arch].filter(Boolean).join('/')}
            </span>
          </div>
        )}
        {agent.version && (
          <div className="tooltip-info-line">
            <span className="tooltip-info-label">Version</span>
            <span className="tooltip-info-value">{agent.version}</span>
          </div>
        )}
        {uptimeStr && (
          <div className="tooltip-info-line">
            <span className="tooltip-info-label">Uptime</span>
            <span className="tooltip-info-value">{uptimeStr}</span>
          </div>
        )}
        {agent.ip_addresses && agent.ip_addresses.length > 0 && (
          <div className="tooltip-info-line">
            <span className="tooltip-info-label">IPs</span>
            <span className="tooltip-info-value">
              {agent.ip_addresses.slice(0, 2).join(', ')}
              {agent.ip_addresses.length > 2 && ` (+${agent.ip_addresses.length - 2})`}
            </span>
          </div>
        )}
      </div>

      <div className="tooltip-section">
        <div className="tooltip-section-header access">Remote Access</div>
        <div className="tooltip-info-line">
          <span className="tooltip-info-label">Shell</span>
          <span className="tooltip-info-value">
            {agent.shells && agent.shells.length > 0 ? (
              <span className="tooltip-access-tags">
                {agent.shells.map(sh => (
                  <span key={sh} className="ui-chip tooltip-access-tag">
                    {sh}
                  </span>
                ))}
              </span>
            ) : (
              <span className="tooltip-access-na">Not available</span>
            )}
          </span>
        </div>
        <div className="tooltip-info-line">
          <span className="tooltip-info-label">File Transfer</span>
          <span className="tooltip-info-value">
            {agent.file_transfer_enabled ? (
              <span className="tooltip-access-enabled">Enabled</span>
            ) : (
              <span className="tooltip-access-na">Not available</span>
            )}
          </span>
        </div>
      </div>

      {displaySocks && (
        <div className="tooltip-section">
          <div className="tooltip-section-header socks5">SOCKS4/5 Proxy</div>
          <div className="tooltip-section-value">{displaySocks}</div>
        </div>
      )}

      {exitRoutes.length > 0 && (
        <div className="tooltip-section">
          <div className="tooltip-section-header exits">CIDR Routes</div>
          <div className="tooltip-exits-list">
            {exitRoutes.slice(0, 5).map(cidr => (
              <span key={cidr} className="ui-chip tooltip-cidr">
                {cidr}
              </span>
            ))}
            {exitRoutes.length > 5 && (
              <span className="tooltip-cidr-more">+{exitRoutes.length - 5} more</span>
            )}
          </div>
        </div>
      )}

      {domainRoutes.length > 0 && (
        <div className="tooltip-section">
          <div className="tooltip-section-header exits">Domain Routes</div>
          <div className="tooltip-exits-list">
            {domainRoutes.slice(0, 5).map(domain => (
              <span key={domain} className="ui-chip tooltip-domain">
                {domain}
              </span>
            ))}
            {domainRoutes.length > 5 && (
              <span className="tooltip-cidr-more">+{domainRoutes.length - 5} more</span>
            )}
          </div>
        </div>
      )}

      {(forwardListeners.length > 0 || forwardEndpoints.length > 0) && (
        <div className="tooltip-section">
          {forwardListeners.length > 0 && (
            <>
              <div className="tooltip-forwards-header">Port Forward Listeners</div>
              <div className="tooltip-forwards-list">
                {forwardListeners.map(key => (
                  <span key={key} className="ui-chip tooltip-forward-key">
                    {key}
                  </span>
                ))}
              </div>
            </>
          )}
          {forwardEndpoints.length > 0 && (
            <>
              <div className="tooltip-forwards-header">Port Forward Endpoints</div>
              <div className="tooltip-forwards-list">
                {forwardEndpoints.map(key => (
                  <span key={key} className="ui-chip tooltip-forward-key">
                    {key}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {note && (
        <div className="tooltip-section">
          <div className="tooltip-section-header notes">Notes</div>
          <div className="tooltip-notes-preview">
            {note.length > NOTE_PREVIEW_MAX
              ? note.slice(0, NOTE_PREVIEW_MAX).trimEnd() + '…'
              : note}
          </div>
        </div>
      )}

      <div className="tooltip-id-section" onClick={handleCopy}>
        <div className="tooltip-id-label">Agent ID</div>
        <div className="tooltip-id">{agent.id || agent.short_id}</div>
        <div className={`tooltip-id-hint${copyHint === 'Copied!' ? ' tooltip-id-copied' : ''}`}>
          {copyHint}
        </div>
      </div>
    </div>
  );
}
