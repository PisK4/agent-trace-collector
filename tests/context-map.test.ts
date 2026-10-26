import { expect, test } from 'bun:test';
import { contextMapInnerHtml, contextMapShellHtml, contextRowsHtml, tilesOf } from '../web/context-map.js';
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

/** 容器高度按 CSS 规则折算：clamp(160px, 宽/2.4, 240px)。 */
const WIDTHS = [280, 340, 592];
const heightOf = (w: number) => Math.min(240, Math.max(160, w / 2.4));

/** 两矩形是否越过 epsilon 实际相交。 */
function overlaps(a: { x: number, y: number, w: number, h: number }, b: { x: number, y: number, w: number, h: number }, eps = 0.01): boolean {
  return a.x < b.x + b.w - eps && b.x < a.x + a.w - eps
    && a.y < b.y + b.h - eps && b.y < a.y + a.h - eps;
}

/** 从渲染入口的 HTML 里解析每个 tile 按钮的类、位置与内部 HTML。 */
function tileButtons(html: string): { cls: string, x: number, y: number, w: number, h: number, body: string }[] {
  const out: { cls: string, x: number, y: number, w: number, h: number, body: string }[] = [];
  const re = /<button type="button" class="(ctx-tile[^"]*)"[^>]*style="left:(-?[\d.]+)px;top:(-?[\d.]+)px;width:(-?[\d.]+)px;height:(-?[\d.]+)px[^"]*"[^>]*>([\s\S]*?)<\/button>/g;
  for (const m of html.matchAll(re)) {
    out.push({ cls: m[1]!, x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]), body: m[6] ?? '' });
  }
  return out;
}

test('布局守恒：tile 界内不重叠、每类面积守恒、每类有块、永不产生空闲块', () => {
  const states: [string, PromptReading][] = [
    ['counted', sevenKinds()],
    ['est', reading({ ...sevenKinds(), counted: false })],
    ['legacy', sixKinds()],
    ['nowin', reading({ ...sevenKinds(), window: null, ratio: null })],
    ['full', reading({ tokens: 200000, window: 200000, ratio: 1, parts: [{ kind: 'chat', tokens: 200000 }] })],
    ['over', reading({ tokens: 210000, window: 200000, ratio: 1.05, parts: [{ kind: 'chat', tokens: 210000 }] })],
  ];
  for (const [label, p] of states) {
    for (const W of WIDTHS) {
      const H = heightOf(W);
      const tiles = tilesOf(p, W, H);
      expect(tiles.length).toBeGreaterThan(0);
      for (const tile of tiles) {
        expect(tile.x).toBeGreaterThanOrEqual(-0.01);
        expect(tile.y).toBeGreaterThanOrEqual(-0.01);
        expect(tile.x + tile.w).toBeLessThanOrEqual(W + 0.01);
        expect(tile.y + tile.h).toBeLessThanOrEqual(H + 0.01);
        expect(tile.w).toBeGreaterThan(0);
        expect(tile.h).toBeGreaterThan(0);
      }
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          expect(overlaps(tiles[i]!, tiles[j]!)).toBe(false);
        }
      }
      // 几何按类别守恒：每类 tile 面积和 == 该类份额 × 全图面积。
      // item 块显示真实 item tokens，未逐项余量有自己的块，所以逐块 token
      // 合计不等于 parts 合计——差额在余量块里如实存在，不在几何里抹平。
      const partsSum = p.parts.reduce((a, part) => a + Math.max(0, part.tokens), 0);
      for (const part of p.parts.filter(part => part.tokens > 0)) {
        const area = tiles.filter(tile => tile.kind === part.kind).reduce((a, tile) => a + tile.w * tile.h, 0);
        expect(Math.abs(area - (part.tokens / partsSum) * W * H)).toBeLessThan(0.5);
      }
      expect(label.length).toBeGreaterThan(0);
    }
  }
});

test('空闲容量不进图：有窗口、无窗口、占满与超窗都是全幅已用构成', () => {
  const cases = [
    sevenKinds(),
    reading({ ...sevenKinds(), window: null, ratio: null }),
    reading({ tokens: 200000, window: 200000, ratio: 1, parts: [{ kind: 'chat', tokens: 200000 }] }),
  ];
  for (const p of cases) {
    const inner = contextMapInnerHtml(p, 340, 160, 7);
    expect(inner).not.toContain('空闲');
    expect(inner).not.toContain('<svg');
    // 全幅：左上第一块从原点附近开始（间隙内缩除外），右下抵到容器边界。
    const first = tileButtons(inner)[0]!;
    expect(first.x).toBeLessThanOrEqual(2);
    expect(first.y).toBeLessThanOrEqual(2);
  }
  // 超窗：仍铺满，不缩小。
  const over = reading({ tokens: 210000, window: 200000, ratio: 1.05, parts: [{ kind: 'chat', tokens: 210000 }] });
  const overTiles = tilesOf(over, 340, 160);
  expect(Math.abs(overTiles[0]!.w - 340)).toBeLessThan(0.01);
});

test('渲染入口的文字取舍来自实测尺寸：宽度不足整块 bare，高度不足只留名称', () => {
  // files 只占 300/200300 的面积：在 592 宽下是一根几像素的细条 → bare。
  const thin = reading({
    tokens: 200300,
    parts: [
      { kind: 'chat', tokens: 200000, items: [{ name: '2', tag: 'turn', n: null, tokens: 200000 }] },
      { kind: 'files', tokens: 300, items: [{ name: 'a.ts', tag: 'read', n: null, tokens: 300 }] },
    ],
  });
  const inner = contextMapInnerHtml(thin, 592, 240, 7);
  const buttons = tileButtons(inner);
  expect(buttons.some(b => b.cls.includes('bare'))).toBe(true);
  for (const b of buttons) {
    const bare = b.w < 47 || b.h < 24;
    const low = !bare && b.h < 44;
    const want = bare ? 'bare' : low ? 'low' : '';
    if (want === '') expect(b.cls).toBe('ctx-tile');
    else expect(b.cls).toContain(want);
  }
  // 高度不足 44 的横条只留名称行。
  const squat = reading({
    tokens: 100000,
    parts: [
      { kind: 'chat', tokens: 90000, items: [{ name: '2', tag: 'turn', n: null, tokens: 90000 }] },
      { kind: 'tools', tokens: 10000, items: [{ name: 'Bash', tag: null, n: null, tokens: 10000 }] },
    ],
  });
  const squatInner = contextMapInnerHtml(squat, 592, 240, 7);
  for (const b of tileButtons(squatInner)) {
    const bare = b.w < 47 || b.h < 24;
    const low = !bare && b.h < 44;
    expect(b.cls.includes('bare')).toBe(bare);
    expect(b.cls.includes('low')).toBe(low);
  }
});

test('碎项并入成员集合：大项保留、其余并成一块带类别名的集合块', () => {
  const smalls = Array.from({ length: 30 }, (_, i) => ({ name: `frag-${i}`, tag: 'read' as const, n: null, tokens: 300 }));
  const p = reading({
    tokens: 29000, window: 100000, ratio: 0.29,
    parts: [{ kind: 'files', tokens: 29000, items: [{ name: 'big-file.ts', tag: 'read', n: null, tokens: 20000 }, ...smalls] }],
  });
  const inner = contextMapInnerHtml(p, 340, 160, 7);
  expect(inner).toContain('其余文件引用 30 项');
  expect(inner).toContain('big-file.ts');
  expect(tileButtons(inner).length).toBe(2);
  // 成员集合块带成员身份清单，供悬停联动与点击明细使用。
  expect(inner).toMatch(/data-ctx-its="[^"]+"[^>]*data-ctx-scope="rest"/);
});

test('item 清单不覆盖类总量时，未逐项余量作为显式余量块占面积', () => {
  const p = reading({
    tokens: 50000, window: 200000, ratio: 0.25,
    parts: [{
      kind: 'files', tokens: 50000,
      items: [
        { name: 'a.ts', tag: 'read', n: null, tokens: 30000 },
        { name: 'b.ts', tag: 'read', n: null, tokens: 10000 },
      ],
    }],
  });
  const inner = contextMapInnerHtml(p, 592, 240, 7);
  expect(inner).toContain('文件引用其余部分');
  const tiles = tilesOf(p, 592, 240);
  const restTile = tiles.find(t => t.scope === 'rest');
  expect(restTile?.tokens).toBe(10000);
  expect(restTile?.its).toHaveLength(0);
  // 清单完整时（碎项合并用例）不出现这一块；此处全图 token 口径守恒。
  expect(tiles.reduce((s, t) => s + t.tokens, 0)).toBe(50000);
});

test('类别矩形过小时整类一块，不硬拆 item 层', () => {
  const p = reading({
    tokens: 200300,
    parts: [
      { kind: 'chat', tokens: 200000, items: [{ name: '2', tag: 'turn', n: null, tokens: 200000 }] },
      { kind: 'files', tokens: 300, items: [{ name: 'a.ts', tag: 'read', n: null, tokens: 300 }] },
    ],
  });
  const tiles = tilesOf(p, 592, 240);
  const files = tiles.find(t => t.kind === 'files')!;
  expect(files.scope).toBe('category');
  expect(files.name).toBe('文件引用');
});

test('上游轮次与折叠桶的固定叫法区分于本仓结算轮', () => {
  const inner = contextMapInnerHtml(sevenKinds(), 592, 240, 7);
  expect(inner).toContain('上下文第 2 轮');
  expect(inner).toContain('更早上下文 6 轮');
  expect(inner).toContain('另外 8 项');
  // 类级块显示类别名。
  expect(inner).toContain('系统提示');
});

test('tile 按钮带联动与明细属性，无 SVG、无 clipPath、无越界绘制', () => {
  const inner = contextMapInnerHtml(sevenKinds(), 340, 160, 7);
  expect(inner).not.toContain('<svg');
  expect(inner).not.toContain('clipPath');
  expect(inner).toContain('data-ctx-scope="item"');
  expect(inner).toContain('data-ctx-scope="category"');
  expect(inner).toContain('data-ctx-kind="chat"');
  expect(inner).toContain('打开明细');
  for (const b of tileButtons(inner)) {
    expect(b.x).toBeGreaterThanOrEqual(0);
    expect(b.y).toBeGreaterThanOrEqual(0);
    expect(b.x + b.w).toBeLessThanOrEqual(340 + 0.01);
    expect(b.y + b.h).toBeLessThanOrEqual(160 + 0.01);
  }
  // 悬停 title 语义移到 aria-label：数值不截断。
  expect(inner).toContain('tokens，占提示总量');
});

test('无正值类时外壳与 tile 层都不渲染', () => {
  const empty = reading({ tokens: 0, parts: [{ kind: 'chat', tokens: 0 }], ratio: null });
  expect(contextMapShellHtml(empty, 7)).toBe('');
  expect(contextMapInnerHtml(empty, 340, 160, 7)).toBe('');
  const noItems = reading({ tokens: 500, parts: [{ kind: 'chat', tokens: 500 }] });
  expect(contextMapShellHtml(noItems, 7)).toContain('data-ctx-map="7"');
  expect(contextRowsHtml(noItems, 7)).toBe('');
});

test('内容列表跨类按 token 降序，折叠摘要按已保存条目计数', () => {
  const p = reading({
    parts: [{
      kind: 'files', tokens: 100,
      items: Array.from({ length: 11 }, (_, i) => ({ name: `f${i}.txt`, tag: 'read' as const, n: null, tokens: 10 })),
    }],
  });
  const rows = contextRowsHtml(p, 7);
  expect(rows.match(/class="ctx-row"/g)?.length).toBe(11);
  expect(rows).toContain('显示全部 11 个已保存条目');
  expect(rows).toContain('data-fold="ctxmore:7"');
  // 行带稳定身份键，供悬停联动与点击明细定位。
  expect(rows).toContain('data-ctx-key="files\u0001read\u0001f0.txt"');
});

test('列表特殊 tag：上下文轮次叫法、×N 聚合与路径目录', () => {
  const rows = contextRowsHtml(sevenKinds(), 7);
  expect(rows).toContain('另外 8 项');
  expect(rows).toContain('更早上下文 6 轮');
  expect(rows).toContain('上下文第 2 轮');
  expect(rows).toContain('×62');
  expect(rows).toContain('×3');
  // turns/more 自带数量词，不重复挂 ×N（带尖括号避免误伤 ×62 的子串）。
  expect(rows).not.toContain('>×6<');
  expect(rows).not.toContain('>×8<');
  // 路径类 item：名字在前、目录在后。
  expect(rows).toContain('src/http.ts');
  expect(rows).toContain('requests.ts');
  expect(rows).toContain('<small>src/queries/</small>');
  expect(rows).toContain('>MCP<');
  expect(rows).toContain('>提醒<');
});

test('六类旧口径照常渲染，未知类别保持原名', () => {
  const legacy = tilesOf(sixKinds(), 340, 160);
  expect(legacy.some(t => t.kind === 'memory')).toBe(true);
  const unknown = reading({
    tokens: 1000, window: 2000, ratio: 0.5,
    parts: [{ kind: 'mystery', tokens: 1000, items: [{ name: '未知来源', tag: null, n: null, tokens: 1000 }] }],
  });
  const inner = contextMapInnerHtml(unknown, 340, 160, 7);
  expect(inner).toContain('mystery');
  expect(inner).toContain('--p-unknown');
});
