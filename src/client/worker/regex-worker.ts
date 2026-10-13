import type { DisplayTask } from '../../lib/display-regex.mjs';
import { transformDisplayText } from '../../lib/display-regex.mjs';
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.onmessage = ({ data }: MessageEvent<{id: number; task: DisplayTask}>) => {
  try { scope.postMessage({ id: data.id, result: transformDisplayText(data.task) }); }
  catch (error) { scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : '正则执行失败' }); }
};
