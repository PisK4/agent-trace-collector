import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadBoundSaltTx, loadConfig } from '../src/config';
import { openStore } from '../src/store';
import { startCollector } from '../src/main';
import { enqueueDerive } from '../src/derive/sync';
import { SEED_GROUP, seedRequest } from './fixtures';

// 供 main.test.ts 拉起的子进程：派生计算永不返回，验证 SIGTERM 在等待上限内
// 自己退出（F42）。数据目录由父进程经 ATC_STOP_HANG_DIR 注入并负责清理。
const dir = process.env.ATC_STOP_HANG_DIR;
if (dir === undefined || dir.length === 0) throw new Error('ATC_STOP_HANG_DIR_missing');
mkdirSync(join(dir, 'routing'), { recursive: true });

// 盐与库的绑定要在空库时建立：先有数据再绑会被拒绝。
const seed = openStore(join(dir, 'trace.db'));
seed.write(db => loadBoundSaltTx(db, dir));
seedRequest(seed, [{ req_id: 1, started_ms: 1, sort_source: 'ledger', sort_key: 'ledger|0001' }]);
seed.write(db => db.run('UPDATE request SET purpose_pending=0 WHERE req_id=1'));
enqueueDerive(seed, SEED_GROUP.convKey, SEED_GROUP.actor, '');
seed.close();

const collector = await startCollector({
  ...loadConfig({}),
  port: 0,
  dataDir: dir,
  ledgerPath: `${dir}/missing.jsonl`,
  routingDir: `${dir}/routing`,
  intervals: { derive: 5 },
}, {
  sessionAdapters: [],
  deriveComputeInWorker: false,
  // 永不返回的计算：首轮派生在 startCollector 内同步进入这里并挂住。
  deriveCompute: () => new Promise(() => {}),
  stopDeriveWaitMs: 1000,
});
void collector;
// ready 必须在 startCollector 返回之后才发：此刻信号处理器已注册，且首轮派生
// 已同步进入计算并挂住——父进程看到这一行再发 SIGTERM，卡住的才是派生等待。
process.stdout.write('ready\n');
// 挂住自身：退出只来自 SIGTERM 走 onSignal -> stop() -> process.exit。
await new Promise<never>(() => {});
