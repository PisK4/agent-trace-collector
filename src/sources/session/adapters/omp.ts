/** OMP 本地会话：`$OMP_HOME` 或 `~/.omp/agent/sessions` 下的 JSONL。 */

import { createJsonlSessionAdapter } from './pi-jsonl';

export const ompAdapter = createJsonlSessionAdapter({
  key: 'omp',
  sourceKind: 'omp_session',
  homeEnv: 'OMP_HOME',
  homeDir: '.omp',
});
