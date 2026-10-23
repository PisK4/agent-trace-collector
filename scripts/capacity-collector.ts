/**
 * 容量实验的采集器子进程。配置由负载端写入临时根，启动前再做一次隔离断言：
 * 任何路径不匹配都退出，不连接真实上游，也不读默认数据目录。
 *
 * 切片模式是显式开关：`--slice` 与 `--slice-budget <预算文件>` 必须成对给出。
 * 预算只从那份文件的 `slice.derive_budget` 读，缺了就以 `capacity_slice_budget_missing`
 * 退出，不退到 `DEFAULT_DERIVE_BUDGET`——那会把一条常量冒充成校准结果。
 */
import { readFileSync } from 'node:fs';
import type { DeriveBudget } from '../src/config';
import { startCollector } from '../src/main';
import { assertCapacityIsolation } from '../src/capacity';
import { buildCapacityConfig } from './capacity-support';
import { loadSliceBudget } from './capacity-gate';

function fail(code: string): never {
  process.stderr.write(`${code}\n`);
  process.exit(2);
}

const args = Bun.argv.slice(2);
const configPath = args[0];
if (configPath === undefined || configPath.startsWith('--')) fail('capacity_config_missing');

let slice = false;
let sliceBudgetPath: string | null = null;
for (let index = 1; index < args.length; index += 1) {
  const flag = args[index]!;
  if (flag === '--slice') {
    slice = true;
    continue;
  }
  if (flag === '--slice-budget') {
    const value = args[index + 1];
    if (value === undefined || value.length === 0) fail('capacity_flag_value_missing:--slice-budget');
    sliceBudgetPath = value;
    index += 1;
    continue;
  }
  fail(`capacity_unknown_flag:${flag}`);
}

let deriveBudget: DeriveBudget | undefined;
if (slice) {
  if (sliceBudgetPath === null) fail('capacity_slice_budget_missing');
  try {
    deriveBudget = loadSliceBudget(sliceBudgetPath).budget;
  } catch (error) {
    fail(error instanceof Error ? error.message : 'capacity_slice_budget_missing');
  }
} else if (sliceBudgetPath !== null) {
  // 只给预算不给开关：模式得由显式开关说出来，不从"顺手传了路径"推断。
  fail('capacity_slice_flag_required');
}

const input = JSON.parse(readFileSync(configPath, 'utf8')) as {
  root: string; upstream_port: number; body_budget: number; disk_limit: number;
  intervals?: Record<string, number>;
};
const config = buildCapacityConfig({
  root: input.root,
  upstreamPort: input.upstream_port,
  bodyBudget: input.body_budget,
  diskLimit: input.disk_limit,
  intervals: input.intervals as never,
  deriveBudget,
});
assertCapacityIsolation({ root: input.root, config, upstreamPort: input.upstream_port });
// 切片模式在生产启用路径上被拒绝（读模型未迁移到发布指针）；实验台读数走
// readEffectiveGroup，不消费 request 派生列，在这里声明身份后放行。
const collector = await startCollector(config, { capacityExperiment: true });
process.stdout.write(`collector_listening:${collector.port}\n`);
const stop = async (): Promise<void> => {
  await collector.stop();
  process.exit(0);
};
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
