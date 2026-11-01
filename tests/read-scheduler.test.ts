import { expect, test } from 'bun:test';
import { createReadScheduler } from '../web/read-scheduler.js';

/** 手控 Promise：测试用 deferred 控制任务时序，不靠慢 sleep。 */
function deferred<T = void>() {
  let release!: (value: T) => void;
  const done = new Promise<T>(resolve => { release = resolve; });
  return { done, release };
}

test('完整任务结束才释放活动槽', async () => {
  let release!: () => void;
  const body = new Promise<void>(resolve => { release = resolve; });
  const started: number[] = [];
  const scheduler = createReadScheduler({ activeLimit: 1, backgroundLimit: 1 });
  const scope = {};
  const a = scheduler.run({ scope, priority: 'interactive' }, async () => {
    started.push(1); await body; return 1;
  });
  const b = scheduler.run({ scope, priority: 'interactive' }, async () => {
    started.push(2); return 2;
  });
  await Promise.resolve();
  expect(started).toEqual([1]);
  release();
  expect(await Promise.all([a, b])).toEqual([1, 2]);
  scheduler.dispose();
});

test('队列满：交互淘汰最旧待发后台，后台直接 queue_full', async () => {
  const scheduler = createReadScheduler({ activeLimit: 1, pendingLimit: 1, backgroundLimit: 1 });
  const scope = {};
  const holder = deferred();
  const first = scheduler.run({ scope, priority: 'interactive' }, async () => {
    await holder.done;
  });
  // 占满待发位：一个后台。
  const background = scheduler.run({ scope, priority: 'background' }, async () => 'bg')
    .then(() => 'resolved', error => (error as { code?: string }).code);
  // 新交互进来：淘汰最旧待发后台。
  const interactive = scheduler.run({ scope, priority: 'interactive' }, async () => 'i');
  expect(await background).toBe('cancelled');
  // 队列现被交互占住：下一个交互 queue_full。
  const overflow = scheduler.run({ scope, priority: 'interactive' }, async () => 'x')
    .then(() => 'resolved', error => (error as { code?: string }).code);
  expect(await overflow).toBe('queue_full');
  holder.release();
  await first;
  expect(await interactive).toBe('i');
  const stats = scheduler.stats();
  expect(stats.evicted).toBe(1);
  expect(stats.queueFull).toBe(1);
  scheduler.dispose();
});

test('后台满槽时保留槽：交互不受后台排队阻塞', async () => {
  const scheduler = createReadScheduler({ activeLimit: 2, backgroundLimit: 1 });
  const scope = {};
  const holder = deferred();
  const bg1 = scheduler.run({ scope, priority: 'background' }, async () => {
    await holder.done; return 'bg1';
  });
  const bg2 = scheduler.run({ scope, priority: 'background' }, async () => 'bg2');
  const interactive = scheduler.run({ scope, priority: 'interactive' }, async () => 'i');
  await Promise.resolve();
  await Promise.resolve();
  // bg1 在跑（占满背景槽），bg2 排队；交互仍可启动（activeLimit 剩余槽）。
  expect(scheduler.stats().active).toBe(2);
  expect(scheduler.stats().pending).toBe(1);
  holder.release();
  expect(await bg1).toBe('bg1');
  expect(await interactive).toBe('i');
  expect(await bg2).toBe('bg2');
  scheduler.dispose();
});

test('连续交互达到上限后放行一个后台', async () => {
  const scheduler = createReadScheduler({ activeLimit: 1, backgroundLimit: 1, interactiveBurstLimit: 3 });
  const scope = {};
  const order: string[] = [];
  const tasks: Promise<unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    tasks.push(scheduler.run({ scope, priority: 'interactive' }, async () => {
      order.push(`i${i}`);
    }));
  }
  const bg = scheduler.run({ scope, priority: 'background' }, async () => {
    order.push('bg');
  });
  tasks.push(scheduler.run({ scope, priority: 'interactive' }, async () => {
    order.push('i4');
  }));
  await Promise.all(tasks);
  // activeLimit=1：四个交互先占满连续计数，之后允许一个后台，再回到交互。
  expect(order).toEqual(['i0', 'i1', 'i2', 'bg', 'i3', 'i4']);
  scheduler.dispose();
});

test('任务抛错释放槽并单独计数', async () => {
  const scheduler = createReadScheduler({ activeLimit: 1 });
  const scope = {};
  const failing = scheduler.run({ scope, priority: 'interactive' }, async () => {
    throw new Error('synthetic failure');
  }).then(() => 'resolved', error => (error as Error).message);
  // 槽释放挂在 settle 之后的 finally：等一个宏任务让它跑完。
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(scheduler.stats().active).toBe(0);
  const next = scheduler.run({ scope, priority: 'interactive' }, async () => 'after');
  expect(await next).toBe('after');
  expect(await failing).toBe('synthetic failure');
  expect(scheduler.stats().errors).toBe(1);
  scheduler.dispose();
});

test('待发取消立即 settle 且不执行任务', async () => {
  const scheduler = createReadScheduler({ activeLimit: 1 });
  const scope = {};
  const holder = deferred();
  const executed: string[] = [];
  const blocker = scheduler.run({ scope, priority: 'interactive' }, async () => {
    await holder.done;
  });
  const controller = new AbortController();
  const queued = scheduler.run({ scope, priority: 'interactive', signal: controller.signal },
    async () => { executed.push('ran'); });
  await Promise.resolve();
  controller.abort();
  expect(await queued.then(() => 'resolved', error => (error as { code?: string }).code)).toBe('cancelled');
  expect(executed).toEqual([]);
  holder.release();
  await blocker;
  scheduler.dispose();
});

test('在途取消把 abort 传给任务，settle 后才释放槽', async () => {
  const scheduler = createReadScheduler({ activeLimit: 1 });
  const scope = {};
  const holder = deferred();
  const controller = new AbortController();
  let seenAborted = false;
  const running = scheduler.run({ scope, priority: 'interactive', signal: controller.signal },
    async signal => {
      await holder.done;
      seenAborted = signal.aborted;
      return 'ignored-cancel';
    });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  controller.abort();
  holder.release();
  expect(await running).toBe('ignored-cancel');
  expect(seenAborted).toBe(true);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(scheduler.stats().active).toBe(0);
  // 忽略取消的任务不计为服务器读取失败；槽已释放，后续任务可运行。
  const after = scheduler.run({ scope, priority: 'interactive' }, async () => 'next');
  expect(await after).toBe('next');
  scheduler.dispose();
});

test('cancelScope 只取消该 scope 的任务', async () => {
  const scheduler = createReadScheduler({ activeLimit: 2 });
  const scopeA = {};
  const scopeB = {};
  const holderA = deferred();
  const executedB: string[] = [];
  const a = scheduler.run({ scope: scopeA, priority: 'interactive' }, async signal => {
    await holderA.done;
    return signal.aborted ? 'aborted' : 'a';
  });
  const b = scheduler.run({ scope: scopeB, priority: 'interactive' }, async () => {
    executedB.push('b'); return 'b';
  });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  scheduler.cancelScope(scopeA);
  holderA.release();
  expect(await a).toBe('aborted');
  expect(await b).toBe('b');
  expect(executedB).toEqual(['b']);
  scheduler.dispose();
});

test('待发任务随 cancelScope 从队列移除', async () => {
  const scheduler = createReadScheduler({ activeLimit: 1 });
  const scope = {};
  const holder = deferred();
  const blocker = scheduler.run({ scope, priority: 'interactive' }, async () => {
    await holder.done;
  });
  const controller = new AbortController();
  const queued = scheduler.run({ scope, priority: 'interactive', signal: controller.signal },
    async () => 'never');
  await Promise.resolve();
  scheduler.cancelScope(scope);
  expect(await queued.then(() => 'resolved', error => (error as { code?: string }).code)).toBe('cancelled');
  expect(scheduler.stats().pending).toBe(0);
  holder.release();
  await blocker;
  scheduler.dispose();
});

test('dispose 取消全部任务，重复 dispose 幂等，之后拒绝新任务', async () => {
  const scheduler = createReadScheduler({ activeLimit: 1 });
  const scope = {};
  const holder = deferred();
  const running = scheduler.run({ scope, priority: 'interactive' }, async signal => {
    await holder.done;
    return signal.aborted ? 'aborted' : 'done';
  });
  const queued = scheduler.run({ scope, priority: 'interactive' }, async () => 'never');
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  scheduler.dispose();
  scheduler.dispose();
  expect(await queued.then(() => 'resolved', error => (error as { code?: string }).code)).toBe('cancelled');
  holder.release();
  expect(await running).toBe('aborted');
  const after = scheduler.run({ scope, priority: 'interactive' }, async () => 'x');
  expect(await after.then(() => 'resolved', error => (error as { code?: string }).code)).toBe('cancelled');
});

test('stats 返回聚合计数与注入时钟的排队执行时间', async () => {
  let now = 0;
  const clock = () => now;
  const scheduler = createReadScheduler({ activeLimit: 1, clock });
  const scope = {};
  const holder = deferred();
  const first = scheduler.run({ scope, priority: 'interactive' }, async () => {
    now = 10;
    await holder.done;
    now = 40;
  });
  // 入队发生在 first 执行前：second 的排队区间从 0 起算。
  const second = scheduler.run({ scope, priority: 'interactive' }, async () => {
    now = 70;
  });
  await Promise.resolve();
  expect(scheduler.stats().pending).toBe(1);
  holder.release();
  await Promise.all([first, second]);
  const stats = scheduler.stats();
  expect(stats.executed).toBe(2);
  expect(stats.enqueued).toBe(2);
  expect(stats.queueWaitMs.max).toBe(40);
  expect(stats.runMs.max).toBe(40);
  scheduler.dispose();
});
