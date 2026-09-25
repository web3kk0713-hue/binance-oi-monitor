import { DEFAULT_DIRECTION_CONFIG, isDirectionConfig, type DirectionConfig } from '../shared/directionConfig';

export const DIRECTION_STORAGE_KEY = 'oi-monitor:v1:direction-config:v1';
export interface DirectionPreferences { config: DirectionConfig; notice: string; }
const copyConfig = (config: DirectionConfig): DirectionConfig => ({ oiPct: config.oiPct, pricePct: config.pricePct,
  flowSharePct: config.flowSharePct, requireSpot: config.requireSpot });

export function decodeDirectionPreferences(raw: string | null): DirectionPreferences {
  if (raw === null) return { config: copyConfig(DEFAULT_DIRECTION_CONFIG), notice: '' };
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion === 1
      && 'config' in value && isDirectionConfig(value.config)) return { config: copyConfig(value.config), notice: '' };
  } catch { /* Invalid data must never loosen the active rule. */ }
  return { config: copyConfig(DEFAULT_DIRECTION_CONFIG), notice: '保存的方向配置无效，已恢复标准档；请重新选择。' };
}

export function readDirectionPreferences(): DirectionPreferences {
  try { return decodeDirectionPreferences(localStorage.getItem(DIRECTION_STORAGE_KEY)); }
  catch { return { config: copyConfig(DEFAULT_DIRECTION_CONFIG), notice: '浏览器不允许读取配置，当前使用标准档。' }; }
}

export function writeDirectionPreferences(config: DirectionConfig): boolean {
  if (!isDirectionConfig(config)) return false;
  try { localStorage.setItem(DIRECTION_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, config: copyConfig(config) })); return true; }
  catch { return false; }
}
