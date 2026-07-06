export type FtaFlowOrientation = 'Horizontal' | 'Vertical';

export const FTA_FLOW_ORIENTATION_STORAGE_KEY = 'fta-flow-orientation';

export function readFtaFlowOrientationFromStorage(): FtaFlowOrientation {
  if (typeof window === 'undefined') return 'Horizontal';
  try {
    const v = localStorage.getItem(FTA_FLOW_ORIENTATION_STORAGE_KEY);
    if (v === 'Vertical' || v === 'TB') return 'Vertical';
    if (v === 'Horizontal' || v === 'LR') return 'Horizontal';
    return 'Horizontal';
  } catch {
    return 'Horizontal';
  }
}

export function writeFtaFlowOrientationToStorage(o: FtaFlowOrientation): void {
  try {
    localStorage.setItem(FTA_FLOW_ORIENTATION_STORAGE_KEY, o);
  } catch {
    /* ignore quota / private mode */
  }
}
