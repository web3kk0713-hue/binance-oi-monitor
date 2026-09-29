import { createStructureHistoryClient } from '../data/structureHistory';

/** One bounded, serialized history cache for entry, position protection and research. */
export const structureHistoryClient = createStructureHistoryClient();
