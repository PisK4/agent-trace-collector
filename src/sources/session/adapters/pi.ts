/** Pi 本地会话：`$PI_HOME` 或 `~/.pi/agent/sessions` 下的 JSONL。 */

import { createJsonlSessionAdapter } from './pi-jsonl';

export const piAdapter = createJsonlSessionAdapter({
  key: 'pi',
  sourceKind: 'pi_session',
  homeEnv: 'PI_HOME',
  homeDir: '.pi',
});
