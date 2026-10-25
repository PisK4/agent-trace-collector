import { expect, test } from 'bun:test';
import { contextMapHtml, contextRowsHtml, tilesOf } from '../web/context-map.js';
import type { PromptReading } from '../src/queries/readings';

/** 合成 PromptReading；真实 parts 形状来自 magpie 透传，测试只用合成数据。 */
function reading(overrides: Partial<PromptReading> = {}): PromptReading {
  const base: PromptReading = {
    state: 'recomputed', reason: 'complete', actual_version: 1,
    tokens: 185300, counted: true, window: 200000, held: null, turns: 2,
    ratio: 0.9265, legacy: false, note: null,
    parts: [],
  };
  return Object.assign(base, overrides);
}

/** 七类合成构成：含 more/turns/turn 折叠桶、×N 聚合与路径类 item。 */
function sevenKinds(): PromptReading {
  return reading({
    parts: [
      { kind: 'system', tokens: 4820, items: [{ name: '系统提示', tag: null, n: null, tokens: 4820 }] },
      {
        kind: 'tools', tokens: 16240,
        items: [
          { name: 'mcp__ata', tag: 'mcp', n: 5, tokens: 6180 },
          { name: 'Bash', tag: null, n: null, tokens: 3240 },
          { name: 'Read', tag: null, n: null, tokens: 2110 },
          { name: '另外 8 项', tag: 'more', n: 8, tokens: 4710 },
        ],
      },
      { kind: 'skills', tokens: 3810, items: [{ name: 'skills', tag: 'skills', n: null, tokens: 3810 }] },
      {
        kind: 'memory', tokens: 3520,
        items: [
          { name: '/pis/.claude/AGENTS.md', tag: 'user', n: null, tokens: 1980 },
          { name: 'reminders', tag: 'reminder', n: null, tokens: 1540 },
        ],
      },
      {
        kind: 'files', tokens: 47380,
        items: [
          { name: 'src/http.ts', tag: 'read', n: null, tokens: 8460 },
          { name: 'src/queries/requests.ts', tag: 'read', n: null, tokens: 6210 },
          { name: 'src/schema.sql', tag: 'read', n: null, tokens: 4880 },
          { name: 'fixture.json', tag: 'shell', n: null, tokens: 3410 },
          { name: '另外 7 项', tag: 'more', n: 7, tokens: 4700 },
        ],
      },
      {
        kind: 'results', tokens: 29760,
        items: [
          { name: 'Bash', tag: 'result', n: 62, tokens: 26680 },
          { name: 'Grep', tag: 'result', n: 3, tokens: 2410 },
          { name: '另外 5 项', tag: 'more', n: 5, tokens: 670 },
        ],
      },
      {
        kind: 'chat', tokens: 79770,
        items: [
          { name: 'earlier', tag: 'turns', n: 6, tokens: 5400 },
          { name: '2', tag: 'turn', n: null, tokens: 74370 },
        ],
      },
    ],
  });
}

/** 六类旧口径：skills 并回 memory（magpie 10-24 之前的形状）。 */
function sixKinds(): PromptReading {
  const d = sevenKinds();
  const skills = d.parts.find(part => part.kind === 'skills')!;
  const memory = d.parts.find(part => part.kind === 'memory')!;
  memory.tokens += skills.tokens;
  memory.items = [...skills.items!, ...memory.items!].sort((a, b) => b.tokens - a.tokens);
  d.parts = d.parts.filter(part => part.kind !== 'skills');
  return d;
}

const WIDTHS = [280, 340, 592];
const HEIGHT = 132;

/** 两矩形是否越过 epsilon 实际相交。 */
function overlaps(a: { x: number, y: number, w: number, h: number }, b: { x: number, y: number, w: number, h: number }, eps = 0.01): boolean {
  return a.x < b.x + b.w - eps && b.x < a.x + a.w - eps
    && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
}

test('treemap 守恒：tile 界内不重叠、每类有面积、tile 总量等于 parts、有窗口必有空闲块', () => {
  const states: [string, PromptReading][] = [
    ['counted', sevenKinds()],
    ['est', reading({ ...sevenKinds(), counted: false })],
    ['legacy', sixKinds()],
    ['nowin', reading({ ...sevenKinds(), window: null, ratio: null })],
  ];
  for (const [label, p] of states) {
    for (const W of WIDTHS) {
      const tiles = tilesOf(p, W, HEIGHT);
      expect(tiles.length).toBeGreaterThan(0);
      let nonFreeSum = 0;
      for (const tile of tiles) {
        // 界内：铺进 W×H，不越出，不留负宽高。
        expect(tile.x).toBeGreaterThanOrEqual(-0.01);
        expect(tile.y).toBeGreaterThanOrEqual(-0.01);
        expect(tile.x + tile.w).toBeLessThanOrEqual(W + 0.01);
        expect(tile.y + tile.h).toBeLessThanOrEqual(HEIGHT + 0.01);
        expect(tile.w).toBeGreaterThanOrEqual(0);
        expect(tile.h).toBeGreaterThanOrEqual(0);
        if (tile.free !== true) nonFreeSum += tile.tokens;
      }
      // tile 间不重叠（squarify 顺序铺放的结构保证，界内互斥）。
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          expect(overlaps(tiles[i]!, tiles[j]!)).toBe(false);
        }
      }
      // 非空闲块的 token 总和等于正值类之和（item tile 按类占比换算回类总量）。
      const partsSum = p.parts.reduce((a, part) => a + part.tokens, 0);
      expect(Math.abs(nonFreeSum - partsSum)).toBeLessThan(0.5);
      // 每个正值类都至少占一块。
      for (const part of p.parts.filter(part => part.tokens > 0)) {
        expect(tiles.some(tile => tile.kind === part.kind)).toBe(true);
      }
      // 有窗口且未占满必有空闲块；窗口未知没有空闲块。
      const hasFree = tiles.some(tile => tile.free === true);
      expect(hasFree).toBe(p.window !== null && p.tokens! < p.window!);
      if (hasFree) {
        const free = tiles.find(tile => tile.free === true)!;
        expect(free.tokens).toBe(p.window! - p.tokens!);
      }
      // 状态标签只用于断言来源，四状态同一布局语义。
      expect(label.length).toBeGreaterThan(0);
    }
  }
});

test('占满窗口时无空闲块，超窗仍全幅铺已用部分', () => {
  const full = reading({ tokens: 200000, window: 200000, parts: [{ kind: 'chat', tokens: 200000 }] });
  expect(tilesOf(full, 340, HEIGHT).some(tile => tile.free === true)).toBe(false);
  const over = reading({ tokens: 210000, window: 200000, parts: [{ kind: 'chat', tokens: 210000 }] });
  const overTiles = tilesOf(over, 340, HEIGHT);
  expect(overTiles.some(tile => tile.free === true)).toBe(false);
  expect(overTiles[0]!.w).toBe(340);
});

test('无正值类时 treemap 与列表都不渲染', () => {
  const empty = reading({ tokens: 0, parts: [{ kind: 'chat', tokens: 0 }], ratio: null });
  expect(contextMapHtml(empty, 7)).toBe('');
  expect(contextRowsHtml(empty, 7)).toBe('');
  const noItems = reading({ tokens: 500, parts: [{ kind: 'chat', tokens: 500 }] });
  expect(contextMapHtml(noItems, 7)).not.toBe('');
  // 类无 items：map 是类级块，列表为空不留容器。
  expect(contextRowsHtml(noItems, 7)).toBe('');
});

test('特殊 tag 渲染：more/turns/turn 的固定叫法与 ×N 聚合', () => {
  const rows = contextRowsHtml(sevenKinds(), 7);
  expect(rows).toContain('另外 8 项');
  expect(rows).toContain('更早 6 轮');
  expect(rows).toContain('第 2 轮');
  expect(rows).toContain('×62');
  expect(rows).toContain('×3');
  // turns/more 自带数量词，不重复挂 ×N（带尖括号避免误伤 ×62 的子串）。
  expect(rows).not.toContain('>×6<');
  expect(rows).not.toContain('>×8<');
  // 路径类 item：名字在前、目录在后。
  expect(rows).toContain('src/http.ts');
  expect(rows).toContain('requests.ts');
  expect(rows).toContain('<small>src/queries/</small>');
  // tag 徽标与 MCP 聚合。
  expect(rows).toContain('>MCP<');
  expect(rows).toContain('>提醒<');
});

test('布局侧碎项合并桶：可视文字与悬停 title 都带「另外 N 项」', () => {
  // 20 个碎 item 单个都过不了 TILE_MIN，布局把它们并成一块 rest——这是
  // 布局侧合并（区别于数据里 magpie 的 more tag item），块名与 title 一致。
  const items = Array.from({ length: 20 }, (_, i) => ({ name: `frag-${i}`, tag: 'read', n: null, tokens: 1000 }));
  const p = reading({ tokens: 20000, window: 100000, ratio: 0.2, parts: [{ kind: 'files', tokens: 20000, items }] });
  const map = contextMapHtml(p, 7);
  expect(map).toContain('>另外 20 项<');
  expect(map).toContain('文件引用 · 另外 20 项 · 20.0k tokens');
});

test('内容列表跨类按 token 降序，超过 8 行折叠进「显示全部」', () => {
  const p = reading({
    parts: [{
      kind: 'files', tokens: 100,
      items: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, tag: 'read' as const, n: null, tokens: 10 })),
    }],
  });
  const rows = contextRowsHtml(p, 7);
  // 前 8 行直出，其余 3 行折叠在 details 里（DOM 都在，视觉上收起）。
  expect(rows.match(/class="ctx-row"/g)?.length).toBe(11);
  expect(rows).toContain('显示全部 11 项');
  expect(rows).toContain('data-fold="ctxmore:7"');
});

test('treemap SVG：tile 带 key/its 联动属性、title 与槽位色类、空闲块虚线', () => {
  const svg = contextMapHtml(sevenKinds(), 7);
  expect(svg).toContain('<svg height="132" role="img"');
  expect(svg).toContain('aria-label="上下文构成：185.3k tokens，7 类"');
  // skills 落第七槽色类，tile fill 用主题槽位变量。
  expect(svg).toContain('class="ctx-tile ck-p7"');
  expect(svg).toContain('fill="var(--p7)"');
  // item tile 与类级 tile 都有悬停 title（类名 + token + 占比）。
  expect(svg).toContain('<title>对话内容 · 79.8k tokens · 43%</title>');
  expect(svg).toContain('<title>工具结果 · Bash · 26.7k tokens · 14%</title>');
  // 空闲块：inset 底色加虚线边；高占用下极窄不落文字，读数在悬停 title。
  expect(svg).toContain('fill="var(--inset)"');
  expect(svg).toContain('stroke-dasharray="3 3"');
  expect(svg).toContain('<title>空闲 · 14.7k tokens</title>');
  // 低占用时缓动分区让空闲块保持可读宽度，文字直出。
  const lowUse = reading({
    tokens: 50000, window: 200000, ratio: 0.25,
    parts: [{ kind: 'chat', tokens: 50000, items: [{ name: '1', tag: 'turn', n: null, tokens: 50000 }] }],
  });
  const lowSvg = contextMapHtml(lowUse, 9);
  expect(lowSvg).toContain('>空闲 150.0k</text>');
  // 百分比坐标 + clipPath 防溢出。
  expect(svg).toMatch(/x="\d+\.\d+%"/);
  expect(svg).toContain('<clipPath id="ctxc7-');
  // 六类旧口径照常渲染：无 skills 槽，memory 仍是第三槽。
  const legacySvg = contextMapHtml(sixKinds(), 8);
  expect(legacySvg).not.toContain('ck-p7');
  expect(legacySvg).toContain('ck-p3');
});

test('窗口未知：无空闲块、不出现窗口占用读数，treemap 全幅铺已用部分', () => {
  const p = reading({ ...sevenKinds(), window: null, ratio: null });
  const svg = contextMapHtml(p, 7);
  expect(svg).not.toContain('stroke-dasharray');
  expect(svg).not.toContain('空闲');
  // 类级块照常显示类标签与构成占比（占比是类内构成，不是窗口占用率）。
  expect(svg).toContain('>对话内容</text>');
  expect(svg).toContain('79.8k · 43%');
});
