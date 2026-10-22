import { expect, test } from 'bun:test';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { fixture } from './fixtures';
import { persistBody, restoreBody } from '../src/body';
import type { BodyInput } from '../src/body';
import { redact } from '../src/privacy';

const salt = new Uint8Array(32).fill(7);

function seedRequest(store: ReturnType<typeof fixture>['store'], id: number): void {
  store.write(db => db.run(
    `INSERT INTO request(req_id,started_ms,day,via,body_state,derive_version,have,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, 1, '2026-10-20', 'hook', 'pending', 0, 1, 1, 1],
  ));
}

const twoRepeats: BodyInput = {
  protocol: 'anthropic',
  request: {
    system: [{ type: 'text', text: 'system' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: [{ type: 'text', text: 'A', cache_control: { type: 'ephemeral' } }] },
    ],
  },
  reply: { id: 'msg_demo', content: [{ type: 'thinking', thinking: 'synthetic' }, { type: 'text', text: 'B' }] },
  redact_version: 1,
};

test('重复消息只存一份块但保留两条引用', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    seedRequest(f.store, 2);
    persistBody(f.store, 1, twoRepeats);
    persistBody(f.store, 2, twoRepeats);
    expect(restoreBody(f.store, 1)).toEqual(twoRepeats);
    expect(restoreBody(f.store, 2)).toEqual(twoRepeats);
    expect(f.store.read.query('SELECT count(*) AS n FROM block').get()).toEqual({ n: 1 });
    expect(f.store.read.query('SELECT count(*) AS n FROM request_block').get()).toEqual({ n: 4 });
  } finally {
    f.close();
  }
});

test('cache_control 不同则不是同一块', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    seedRequest(f.store, 2);
    persistBody(f.store, 1, twoRepeats);
    const plain: BodyInput = {
      protocol: 'anthropic',
      request: { messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }] }] },
      reply: null,
      redact_version: 1,
    };
    persistBody(f.store, 2, plain);
    // 第 1 笔两条相同内容共用一块；第 2 笔去掉了 cache_control，字节不同，另占一块。
    expect(f.store.read.query('SELECT count(*) AS n FROM block').get()).toEqual({ n: 2 });
  } finally {
    f.close();
  }
});

test('无 messages 的协议对象整份进骨架并可无损还原', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    const body: BodyInput = {
      protocol: 'responses',
      request: { input: 'hello', temperature: 0.2 },
      reply: { id: 'resp_x', output: [], usage: { input_tokens: 3 } },
      redact_version: 1,
    };
    persistBody(f.store, 1, body);
    expect(restoreBody(f.store, 1)).toEqual(body);
    expect(f.store.read.query('SELECT count(*) AS n FROM request_block').get()).toEqual({ n: 0 });
  } finally {
    f.close();
  }
});

test('角色未知的消息保留原对象并标 unknown 枚举', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    const messages = [{ role: 'critic', content: 'x' }, { role: 'tool', content: 'y' }, 'not-an-object'];
    persistBody(f.store, 1, { protocol: 'anthropic', request: { messages }, reply: null, redact_version: 1 });
    const roles = f.store.read.query<{ ord: number; role: number }, [number]>(
      'SELECT ord, role FROM request_block WHERE req_id=? ORDER BY ord',
    ).all(1);
    expect(roles).toEqual([{ ord: 0, role: 4 }, { ord: 1, role: 3 }, { ord: 2, role: 4 }]);
    expect(restoreBody(f.store, 1)?.request).toEqual({ messages });
  } finally {
    f.close();
  }
});

test('写入中途抛错时块、引用与状态一起回滚', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    expect(() => f.store.write(db => {
      db.run('INSERT INTO block(hash,fingerprint,z,raw_size) VALUES (?,?,?,?)', [new Uint8Array(32), 'fp', new Uint8Array([1]), 1]);
      throw new Error('injected');
    })).toThrow('injected');
    expect(f.store.read.query('SELECT count(*) AS n FROM block').get()).toEqual({ n: 0 });
    expect(f.store.read.query('SELECT body_state FROM request WHERE req_id=1').get()).toEqual({ body_state: 'pending' });
  } finally {
    f.close();
  }
});

test('不存在的请求写入被拒绝', () => {
  const f = fixture();
  try {
    expect(() => persistBody(f.store, 99, twoRepeats)).toThrow('body_request_missing');
  } finally {
    f.close();
  }
});

test('正文保存推进输入修订并置待处理，补正文再次推进', () => {
  const f = fixture();
  const key = JSON.stringify(['session', 'synthetic-session']);
  try {
    f.store.write(db => db.run(
      `INSERT INTO request(req_id,started_ms,day,via,conv_key,conv_source,actor,actor_state,
         body_state,derive_version,have,created_at,updated_at)
       VALUES (1,1,'2026-10-20','hook',?,'session','synthetic-session','known','pending',0,1,1,1)`,
      [key],
    ));
    const state = () => f.store.read.query<{
      input_epoch: string; input_revision: number; purpose_pending: number;
    }, []>('SELECT input_epoch,input_revision,purpose_pending FROM request WHERE req_id=1').get()!;
    const initial = state();
    expect(initial).toEqual({ input_epoch: '', input_revision: 0, purpose_pending: 1 });

    persistBody(f.store, 1, twoRepeats);
    const saved = state();
    expect(saved.input_epoch).not.toBe('');
    expect(saved.input_revision).toBe(1);
    expect(f.store.read.query('SELECT state FROM derive_queue').get()).toEqual({ state: 'dirty' });

    // 正文被替换（补正文/重写）同样是输入变化，epoch 保留、修订增长。
    f.store.write(db => db.run('UPDATE request SET purpose_pending=0'));
    persistBody(f.store, 1, { ...twoRepeats, reply: null });
    expect(state()).toEqual({
      input_epoch: saved.input_epoch, input_revision: saved.input_revision + 1, purpose_pending: 1,
    });
  } finally {
    f.close();
  }
});

test('已回收的正文不再还原', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    persistBody(f.store, 1, twoRepeats);
    f.store.write(db => db.run("UPDATE request SET body_state='evicted', skeleton_z=NULL WHERE req_id=1"));
    expect(restoreBody(f.store, 1)).toBeNull();
  } finally {
    f.close();
  }
});

test('库文件与 WAL 里没有明文凭证', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    const raw: BodyInput = {
      protocol: 'anthropic',
      request: {
        messages: [{ role: 'user', content: [{ type: 'text', text: 'call with sk-synthetic-abcdefgh and Bearer synthetic-secret-123' }] }],
        headers: { authorization: 'Bearer synthetic-secret-123' },
      },
      reply: { id: 'msg_x', content: [{ type: 'text', text: 'ok' }] },
      redact_version: 1,
    };
    // 正常入口先 redact 再 persist；这里按这条路径存一遍，再查落盘字节。
    const safe: BodyInput = {
      ...raw,
      request: redact(raw.request, salt) as unknown,
      reply: redact(raw.reply, salt) as unknown,
    };
    persistBody(f.store, 1, safe);
    // 只读连接还开着时 WAL 不能截断，直接读主库与 WAL 的当前字节即可。
    for (const name of ['trace.db', 'trace.db-wal']) {
      const file = join(f.dir, name);
      let bytes = Buffer.alloc(0);
      try {
        if (statSync(file).size > 0) bytes = readFileSync(file);
      } catch {
        continue;
      }
      const text = bytes.toString('latin1');
      expect(text.includes('sk-synthetic-abcdefgh')).toBe(false);
      expect(text.includes('synthetic-secret-123')).toBe(false);
    }
    expect(JSON.stringify(restoreBody(f.store, 1))).not.toContain('synthetic-secret-123');
  } finally {
    f.close();
  }
});

test('骨架不含 messages 且记录块大小', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    persistBody(f.store, 1, twoRepeats);
    const row = f.store.read.query<{ body_bytes: number; msg_count: number; skeleton_z: Uint8Array; body_state: string }, [number]>(
      'SELECT body_bytes, msg_count, skeleton_z, body_state FROM request WHERE req_id=?',
    ).get(1);
    expect(row?.msg_count).toBe(2);
    expect(row?.body_state).toBe('available');
    expect(row?.body_bytes).toBeGreaterThan(0);
    const skeleton = JSON.parse(zstdDecompressSync(row!.skeleton_z).toString('utf8')) as Record<string, unknown>;
    expect(skeleton.has_messages).toBe(true);
    expect(skeleton.request_without_messages).toEqual({ system: [{ type: 'text', text: 'system' }] });
  } finally {
    f.close();
  }
});

test('末条块引用缺失时正文不可还原', () => {
  const f = fixture();
  try {
    seedRequest(f.store, 1);
    persistBody(f.store, 1, twoRepeats);
    f.store.write(db => db.run(
      'DELETE FROM request_block WHERE req_id=1 AND ord=1'));
    expect(restoreBody(f.store, 1)).toBeNull();
  } finally {
    f.close();
  }
});
