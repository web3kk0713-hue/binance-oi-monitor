export function money(value: number | null | undefined, compact = true): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (!compact) return '$' + value.toLocaleString('en-US', { maximumFractionDigits: abs < 0.000001 ? 12 : abs < 1 ? 8 : 2 });
  if (abs >= 1e12) return '$' + (value / 1e12).toFixed(2) + 'T';
  if (abs >= 1e9) return '$' + (value / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return '$' + (value / 1e6).toFixed(2) + 'M';
  if (abs >= 1e3) return '$' + (value / 1e3).toFixed(1) + 'K';
  return '$' + value.toLocaleString('en-US', { maximumFractionDigits: abs < 1 ? 6 : 2 });
}
export function percent(value: number | null | undefined): string { return value == null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-US', { maximumFractionDigits: 1 }) + '%'; }
export function signed(value: number | null, suffix = '%', digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const unit = 10 ** -digits;
  if (value !== 0 && Math.abs(value) < unit) return `${value > 0 ? '+' : '−'}<${unit}${suffix}`;
  return `${value > 0 ? '+' : ''}${value.toLocaleString('en-US', { maximumFractionDigits: digits })}${suffix}`;
}
export function signedMoney(value: number | null): string { return value === null ? '—' : `${value > 0 ? '+' : value < 0 ? '−' : ''}${money(Math.abs(value))}`; }
export function tokenPrice(value: number | null | undefined): string { return value == null || !Number.isFinite(value) ? '—' : '$' + value.toLocaleString('en-US', { maximumSignificantDigits: 7 }); }
export function dateTime(timestamp: number | null | undefined): string { return timestamp ? new Date(timestamp).toLocaleString('zh-CN', { hour12: false }) : '—'; }
export function clockTime(timestamp: number | null | undefined): string { return timestamp ? new Date(timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '—'; }
export function age(timestamp: number | null | undefined, now: number): string {
  if (!timestamp) return '未更新'; const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  return seconds < 60 ? `${seconds} 秒前` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分钟前` : `${Math.floor(seconds / 3600)} 小时前`;
}
export function escapeHtml(value: unknown): string { return String(value).replace(/[&<>"']/g, (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]!); }
