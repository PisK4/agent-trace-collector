/**
 * 容量实验的采集器子进程。配置由负载端写入临时根，启动前再做一次隔离断言：
 * 任何路径不匹配都退出，不连接真实上游，也不读默认数据目录。
 */
import { readFileSync } from 'node:fs';
import { startCollector } from '../src/main';
import { assertCapacityIsolation } from '../src/capacity';
import { buildCapacityConfig } from './capacity-support';

const configPath = Bun.argv[2];
if (configPath === undefined) {
  process.stderr.write('capacity_config_missing\n');
  process.exit(2);
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
});
assertCapacityIsolation({ root: input.root, config, upstreamPort: input.upstream_port });
const collector = await startCollector(config);
process.stdout.write(`collector_listening:${collector.port}\n`);
const stop = async (): Promise<void> => {
  await collector.stop();
  process.exit(0);
};
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
