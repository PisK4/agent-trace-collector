/**
 * 社区插件的执行线程入口：按清单给出的绝对路径动态 import 包，在包里找认领
 * 该 agent 的 Parser 按序折叠，只把快照交回主线程。
 *
 * 包只导出 `parsers`；api 版本由清单声明并在主线程比对，被拒的包进不到这里。
 * 包内任何异常都折成固定分类码——异常文本可能带路径或数据，不出这个线程。
 */
import { pathToFileURL } from 'node:url';
import type { TodoCall } from '../types';
import type { TodoSnapshot } from '../todo/dto';

type FoldMessage = {
  kind: 'fold'; id: number; entryPath: string; agent: string;
  previous: TodoSnapshot | null; calls: readonly TodoCall[];
};

type ExternalParser = { agent?: unknown; parse?: unknown };
type ExternalModule = { parsers?: unknown };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

/** 同一个包只 import 一次；包内模块状态在实例存活期间保留。 */
const modules = new Map<string, Promise<ExternalModule>>();

function load(path: string): Promise<ExternalModule> {
  let loaded = modules.get(path);
  if (loaded === undefined) {
    loaded = import(pathToFileURL(path).href) as Promise<ExternalModule>;
    modules.set(path, loaded);
  }
  return loaded;
}

scope.onmessage = (event: MessageEvent) => {
  const message = event.data as FoldMessage;
  if (message.kind !== 'fold') return;
  void (async () => {
    try {
      const module = await load(message.entryPath);
      const parsers = Array.isArray(module.parsers) ? module.parsers as ExternalParser[] : [];
      let latest = message.previous;
      for (const call of message.calls) {
        for (const parser of parsers) {
          if (parser.agent !== message.agent || typeof parser.parse !== 'function') continue;
          const next = (parser.parse as (input: TodoCall, previous: TodoSnapshot | null) => unknown)(
            call, latest);
          // 弃权返回 null，由下一个 Parser 或下一次调用继续；快照由主线程校验。
          if (next === null || next === undefined) continue;
          latest = next as TodoSnapshot;
          break;
        }
      }
      scope.postMessage({ kind: 'result', id: message.id, snapshot: latest });
    } catch {
      scope.postMessage({ kind: 'error', id: message.id, code: 'plugin_failed' });
    }
  })();
};