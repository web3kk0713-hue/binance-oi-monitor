import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { isDirectionConfig, type DirectionConfig } from '../shared/directionConfig';
import { decodeDirectionPreferences, DIRECTION_STORAGE_KEY, readDirectionPreferences, writeDirectionPreferences } from './directionPreferences';

interface DirectionSettings { config: DirectionConfig; notice: string; revision: number; apply: (config: DirectionConfig) => boolean; }
const Context = createContext<DirectionSettings | null>(null);

/** One shared preference across both pages, independent of data collection and alert thresholds. */
export function DirectionSettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(() => ({ ...readDirectionPreferences(), revision: 0 }));
  const apply = useCallback((config: DirectionConfig) => {
    if (!isDirectionConfig(config)) return false;
    const saved = writeDirectionPreferences(config);
    setState(previous => ({ config: { ...config }, revision: previous.revision + 1,
      notice: saved ? '已生效并保存，两页共用。' : '已生效，但浏览器不允许保存；刷新后可能丢失。' }));
    return true;
  }, []);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key !== null && event.key !== DIRECTION_STORAGE_KEY) return;
      try { if (event.storageArea !== window.localStorage) return; } catch { return; }
      const updated = decodeDirectionPreferences(event.newValue);
      setState(previous => ({ ...updated, revision: previous.revision + 1,
        notice: updated.notice || '已同步其他页面的方向配置。' }));
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);
  const value = useMemo(() => ({ ...state, apply }), [state, apply]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useDirectionSettings(): DirectionSettings {
  const value = useContext(Context);
  if (!value) throw new Error('DirectionSettingsProvider is required');
  return value;
}
