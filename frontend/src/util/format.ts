// Human-readable uptime from a duration in hours.
// < 1h → minutes, < 24h → whole hours, otherwise "Xd Yh".
export function formatUptime(hours: number): string {
  if (!(hours > 0)) return '';
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours)}h`;
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return `${days}d ${rem}h`;
}
