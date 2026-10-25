import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { fixture } from './fixtures';
import { commitUnit, openStore } from '../src/store';

test('事务失败不留下证据或游标', () => {
  const f = fixture();
  try {
    expect(() => f.store.write(db => {
      db.run("INSERT INTO source_cursor(source_kind,source_name,file_generation,committed_off,last_ok_ms) VALUES ('ledger','usage.jsonl','g:0',100,1)");
      throw new Error('injected');
    })).toThrow('injected');
    expect(f.store.read.query('SELECT count(*) AS n FROM source_cursor').get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test('建库包含28个业务表且使用AUTOINCREMENT', () => {
  const f = fixture();
  try {
    const names = (f.store.read.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[]).map(row => row.name);
    expect(names).toEqual([
      'bg_job', 'block', 'collector_state', 'cost_observation',
      'derive_call_work', 'derive_chain_work', 'derive_generation', 'derive_queue',
      'derive_request_result', 'derive_result_work', 'derive_role_work', 'derive_tool_result',
      'ingest_issue', 'pending_hook', 'purged_evidence', 'raw_hook', 'raw_ledger',
      'raw_otlp_span', 'raw_route',
      'request', 'request_alias', 'request_block', 'request_evidence', 'retention_event',
      'route_summary', 'source_cursor', 'source_gap', 'tool_call',
    ]);
    const requestSql = f.store.read.query(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='request'",
    ).get() as { sql: string };
    expect(requestSql.sql).toContain('AUTOINCREMENT');
    expect(f.store.read.query('PRAGMA auto_vacuum').get()).toEqual({ auto_vacuum: 2 });
    expect(f.store.read.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  } finally {
    f.close();
  }
});

test('已提交并合并删除的请求ID不复用', () => {
  const f = fixture();
  try {
    const insert = f.store.db.prepare("INSERT INTO request(started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (1,'2026-10-20','hook','pending',0,1,1,1)");
    expect(Number(insert.run().lastInsertRowid)).toBe(1);
    expect(Number(insert.run().lastInsertRowid)).toBe(2);
    expect(Number(insert.run().lastInsertRowid)).toBe(3);
    f.store.write(db => {
      db.run('INSERT INTO request_alias(old_id,new_id) VALUES (3,1)');
      db.run('DELETE FROM request WHERE req_id=3');
    });
    const next = Number(insert.run().lastInsertRowid);
    expect(next).toBe(4);
    f.store.write(db => {
      db.run('INSERT INTO request_alias(old_id,new_id) VALUES (?,2)', [next]);
      db.run('DELETE FROM request WHERE req_id=?', [next]);
    });
    expect(f.store.read.query('SELECT old_id,new_id FROM request_alias ORDER BY old_id').all()).toEqual([
      { old_id: 3, new_id: 1 }, { old_id: 4, new_id: 2 },
    ]);
    f.store.close();
    const reopened = openStore(join(f.dir, 'trace.db'));
    try {
      expect(Number(reopened.db.run("INSERT INTO request(started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (1,'2026-10-20','hook','pending',0,1,1,1)").lastInsertRowid)).toBe(5);
      expect(reopened.read.query('SELECT old_id,new_id FROM request_alias ORDER BY old_id').all()).toEqual([
        { old_id: 3, new_id: 1 }, { old_id: 4, new_id: 2 },
      ]);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test('collector_state可读写且别名目标受外键保护', () => {
  const f = fixture();
  try {
    f.store.write(db => {
      db.run('INSERT INTO collector_state(key,value_json) VALUES (?,?)', ['probe', '{"ok":true}']);
      db.run("INSERT INTO request(started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (1,'2026-10-20','hook','pending',0,1,1,1)");
      db.run("INSERT INTO request(started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (2,'2026-10-20','hook','pending',0,1,1,1)");
      db.run('INSERT INTO request_alias(old_id,new_id) VALUES (3,1)');
      db.run('INSERT INTO request_alias(old_id,new_id) VALUES (4,2)');
    });
    expect(f.store.read.query('SELECT value_json FROM collector_state WHERE key=?').get('probe'))
      .toEqual({ value_json: '{"ok":true}' });
    expect(() => f.store.write(db => db.run('DELETE FROM request WHERE req_id=2'))).toThrow();
    f.store.write(db => {
      db.run('DELETE FROM request_alias WHERE old_id=4');
      db.run('DELETE FROM request WHERE req_id=2');
    });
    expect(f.store.read.query('SELECT old_id,new_id FROM request_alias').all())
      .toEqual([{ old_id: 3, new_id: 1 }]);
    expect(f.store.read.query('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    f.close();
  }
});

test('写事务内的只读连接只看到旧快照', () => {
  const f = fixture();
  try {
    expect(() => f.store.write(db => {
      db.run("INSERT INTO request(started_ms,day,via,body_state,derive_version,have,created_at,updated_at) VALUES (1,'2026-10-20','hook','pending',0,1,1,1)");
      expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 0 });
      throw new Error('rollback');
    })).toThrow('rollback');
    expect(f.store.read.query('SELECT count(*) AS n FROM request').get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

function runWorker(dbPath: string, mode: 'before-commit' | 'after-commit'): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, 'worker.ts'), dbPath, mode], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let output = '';
    const pump = (async () => {
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
    })();
    void (async () => {
      const started = Date.now();
      while (!output.includes('READY')) {
        if (Date.now() - started > 5000) {
          proc.kill(9);
          await proc.exited;
          reject(new Error('worker_timeout'));
          return;
        }
        await Bun.sleep(10);
      }
      proc.kill(9);
      await proc.exited;
      await pump.catch(() => {});
      if (!output.includes('READY')) {
        reject(new Error(`worker_did_not_start:${output}`));
        return;
      }
      resolve();
    })();
  });
}

test('子进程提交前崩溃不留证据或游标', async () => {
  const f = fixture();
  const dbPath = join(f.dir, 'trace.db');
  try {
    f.store.close();
    await runWorker(dbPath, 'before-commit');
    const reopened = openStore(dbPath);
    try {
      expect(reopened.read.query('SELECT count(*) AS n FROM raw_ledger').get()).toEqual({ n: 0 });
      expect(reopened.read.query('SELECT count(*) AS n FROM source_cursor').get()).toEqual({ n: 0 });
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test('子进程提交后崩溃保留两行与完整偏移', async () => {
  const f = fixture();
  const dbPath = join(f.dir, 'trace.db');
  try {
    f.store.close();
    await runWorker(dbPath, 'after-commit');
    const reopened = openStore(dbPath);
    try {
      expect(reopened.read.query('SELECT count(*) AS n FROM raw_ledger').get()).toEqual({ n: 2 });
      expect(reopened.read.query('SELECT committed_off FROM source_cursor').get()).toEqual({ committed_off: 100 });
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test('auto_vacuum增量回收让物理文件收缩', () => {
  const f = fixture();
  const dbPath = join(f.dir, 'trace.db');
  const size = () => statSync(dbPath).size;
  try {
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const before = size();
    f.store.write(db => {
      db.run('CREATE TABLE shrink_probe(id INTEGER PRIMARY KEY,z BLOB)');
      const insert = db.prepare('INSERT INTO shrink_probe(z) VALUES (?)');
      for (let i = 0; i < 256; i++) insert.run(crypto.getRandomValues(new Uint8Array(32768)));
    });
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const full = size();
    f.store.write(db => db.run('DROP TABLE shrink_probe'));
    for (let i = 0; i < 128; i++) {
      const row = f.store.db.query('PRAGMA freelist_count').get() as { freelist_count: number };
      if (row.freelist_count === 0) break;
      f.store.db.exec('PRAGMA incremental_vacuum(256)');
    }
    f.store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const after = size();
    expect(full).toBeGreaterThan(before);
    expect(after).toBeLessThan(full);
  } finally {
    f.close();
  }
});

test('拒绝未知的高版本schema', () => {
  const f = fixture();
  const path = join(f.dir, 'trace.db');
  try {
    f.store.close();
    const raw = new Database(path);
    raw.exec('PRAGMA user_version=99');
    raw.close();
    expect(() => openStore(path)).toThrow('schema_version_unsupported');
  } finally {
    f.close();
  }
});

test('过低版本库拒绝打开，空库建到当前版本', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-store-version-'));
  try {
    const legacy = join(dir, 'legacy', 'trace.db');
    mkdirSync(join(dir, 'legacy'), { recursive: true, mode: 0o700 });
    const raw = new Database(legacy);
    raw.exec('CREATE TABLE legacy(x); PRAGMA user_version=4');
    raw.close();
    expect(() => openStore(legacy)).toThrow('schema_rebuild_required');
    const store = openStore(join(dir, 'fresh', 'trace.db'));
    try {
      expect(store.read.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
    } finally { store.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v6库原地升到v7：纯新增表，既有数据不动', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atc-store-upgrade-'));
  try {
    // 先按当前版本建库、写入一行数据，再降级 user_version 模拟 v6 库。
    const path = join(dir, 'trace.db');
    const seed = openStore(path);
    seed.write(db => db.run(
      `INSERT INTO request(started_ms, day, via, body_state, derive_version, have, created_at, updated_at)
       VALUES (1, '2026-10-26', 'through', 'pending', 0, 2, 1, 1)`));
    seed.close();
    const raw = new Database(path);
    raw.run('PRAGMA user_version=6');
    raw.close();
    const store = openStore(path);
    try {
      expect(store.read.query('PRAGMA user_version').get()).toEqual({ user_version: 7 });
      expect((store.read.query('SELECT COUNT(*) AS n FROM request').get() as { n: number }).n).toBe(1);
      // 升级是纯新增：OTLP 原始层表就位且为空。
      expect((store.read.query('SELECT COUNT(*) AS n FROM raw_otlp_span').get() as { n: number }).n).toBe(0);
    } finally { store.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('v5库拒绝普通启动且没有迁移入口', () => {
  const f = fixture();
  try {
    f.store.close();
    const raw = new Database(join(f.dir, 'trace.db'));
    raw.exec('PRAGMA user_version=5');
    raw.close();
    // 破坏式更新：低版本没有升级路径，也没有半迁移状态可续跑。
    expect(() => openStore(join(f.dir, 'trace.db'))).toThrow('schema_rebuild_required');
  } finally { f.close(); }
});

test('写事务统计覆盖成功与回滚', () => {
  const f = fixture();
  try {
    const before = f.store.writeStats.count;
    expect(commitUnit(f.store, 'idle', () => null)).toBeNull();
    expect(f.store.writeStats.count).toBe(before);
    f.store.write(db => db.run("INSERT INTO collector_state(key,value_json) VALUES ('a','1')"), 'synthetic');
    expect(f.store.writeStats.count).toBe(before + 1);
    expect(f.store.writeStats.max_ms).toBeGreaterThanOrEqual(0);
    expect(() => f.store.write(db => {
      db.run("INSERT INTO collector_state(key,value_json) VALUES ('b','1')");
      throw new Error('synthetic_rollback');
    }, 'synthetic')).toThrow('synthetic_rollback');
    expect(f.store.writeStats.count).toBe(before + 2);
    expect(f.store.writeStats.by_name.synthetic?.count).toBe(2);
    expect(f.store.writeStats.by_name.idle).toBeUndefined();
    expect(f.store.read.query("SELECT COUNT(*) AS n FROM collector_state WHERE key='b'").get())
      .toEqual({ n: 0 });
  } finally { f.close(); }
});
