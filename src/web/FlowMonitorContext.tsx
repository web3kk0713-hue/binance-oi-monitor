import { createContext, useContext, type ReactNode } from 'react';
import type { Snapshot } from '../shared/types';
import type { Settings } from './storage';
import { useFlowMonitor, type FlowMonitor } from './useFlowMonitor';

const FlowContext = createContext<FlowMonitor | null>(null);

/** One collector across both views; stream ticks do not rerender the valuation workspace. */
export function FlowMonitorProvider({ settings, snapshot, children }: { settings: Settings; snapshot: Snapshot | null; children: ReactNode }) {
  const monitor = useFlowMonitor(settings, snapshot);
  return <FlowContext.Provider value={monitor}>{children}</FlowContext.Provider>;
}

export function useSharedFlowMonitor(): FlowMonitor {
  const monitor = useContext(FlowContext);
  if (!monitor) throw new Error('FlowMonitorProvider is required');
  return monitor;
}
