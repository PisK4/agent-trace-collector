import { describe, expect, test } from 'bun:test';
import { DEFAULT_DERIVE_BUDGET, loadConfig } from '../src/config';
import { startCollector } from '../src/main';
import { fixture } from './fixtures';

// startCollector 的启用路径断言：切片模式在读模型迁移到发布指针之前，
// 只有容量实验台能开。进程装配的其余部分（timer、server、信号）不在单测面里。
describe('startCollector 切片模式启用路径', () => {
  test('设了派生预算且未声明实验身份时拒绝启动', async () => {
    const f = fixture();
    try {
      const config = {
        ...loadConfig({}),
        port: 0,
        dataDir: f.dir,
        ledgerPath: `${f.dir}/missing.jsonl`,
        routingDir: `${f.dir}/missing-routing`,
        deriveBudget: DEFAULT_DERIVE_BUDGET,
      };
      await expect(startCollector(config)).rejects.toThrow('slice_read_unmigrated');
    } finally {
      f.close();
    }
  });

  test('容量实验身份放行切片模式且能正常起停', async () => {
    const f = fixture();
    try {
      const config = {
        ...loadConfig({}),
        port: 0,
        dataDir: f.dir,
        ledgerPath: `${f.dir}/missing.jsonl`,
        routingDir: `${f.dir}/missing-routing`,
        deriveBudget: DEFAULT_DERIVE_BUDGET,
      };
      const collector = await startCollector(config, { capacityExperiment: true });
      const response = await fetch(`http://127.0.0.1:${collector.port}/api/stats`, {
        headers: { origin: `http://127.0.0.1:${collector.port}` },
      });
      expect(response.status).toBe(200);
      await collector.stop();
    } finally {
      f.close();
    }
  });
});
