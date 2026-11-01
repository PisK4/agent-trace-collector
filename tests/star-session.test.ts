// 明星会话数据形状：数字全部钉在提案 note 的关键数字表上（表是唯一口径）。
// 改数字先改表再改这里；生产语义（协议形状、配对定位）与通用合成场景分开验。
import { expect, test } from 'bun:test';
import { STAR_ID_BASE, STAR_PLAN, starSessionData, starSummary, starTurns } from '../prototypes/star-session.js';

const TOOL_TABLE: Record<string, number> = { Read: 34, Bash: 22, Edit: 17, Grep: 9, Write: 6, Skill: 3 };

test('主链 44 笔、协议 31:13、对照 4、Aux 3', () => {
  const { requests } = starSessionData();
  const main = requests.filter(r => r.purposeChain === 'participate');
  expect(main.length).toBe(44);
  expect(main.filter(r => r.protocol === 'anthropic').length).toBe(31);
  expect(main.filter(r => r.protocol === 'chat').length).toBe(13);
  expect(requests.filter(r => r.agent === 'omp').length).toBe(4);
  expect(requests.filter(r => r.chainRole === 'aux' && r.agent !== 'omp').length).toBe(3);
  expect(requests.length).toBe(51);
});

test('工具分布对表；失败恰好 2 笔 Bash 调用', () => {
  const { requests, failures } = starSessionData();
  const main = requests.filter(r => r.purposeChain === 'participate');
  const counts: Record<string, number> = {};
  for (const r of main) for (const c of r.toolCalls) counts[c.tool_name] = (counts[c.tool_name] ?? 0) + 1;
  expect(counts).toEqual(TOOL_TABLE);
  expect(failures.length).toBe(2);
  for (const f of failures) {
    expect(f.tool_name).toBe('Bash');
    expect(f.req_id).toBe(STAR_ID_BASE + 40);
  }
});

test('用量闭合到表值：208k / 17.4k / $0.42 / 缓存 93.2% / 峰值 118 tok/s', () => {
  const { requests } = starSessionData();
  const main = requests.filter(r => r.purposeChain === 'participate');
  const sum = (pick: (r: (typeof main)[number]) => number) => main.reduce((s, r) => s + pick(r), 0);
  const prompt = sum(r => (r.usage.in ?? 0) + (r.usage.read ?? 0) + (r.usage.write ?? 0));
  expect(prompt).toBe(208000);
  expect(sum(r => r.usage.out ?? 0)).toBe(17400);
  expect(Math.round(sum(r => r.usage.cost ?? 0) * 10000) / 10000).toBeCloseTo(0.42, 4);
  const hit = sum(r => r.usage.read ?? 0) / prompt;
  expect(hit).toBeGreaterThan(0.9315);
  expect(hit).toBeLessThan(0.9325);
  const peak = main[20]!;
  expect(Math.round((peak.usage.out! / peak.timing.ms!) * 1000)).toBe(118);
  for (const r of main) expect(r.usage.in).toBeGreaterThanOrEqual(0);
});

test('轮次带 9 个：轮首是用户主动文本，各轮终点是轮内最后一笔主链', () => {
  const turns = starTurns();
  expect(turns.length).toBe(9);
  expect(turns.map(t => t.start_req)).toEqual([800, 806, 813, 819, 825, 826, 829, 838, 845].map(id => STAR_ID_BASE + (id - 800)));
  for (const t of turns) expect(t.ordinals.length).toBeGreaterThan(0);
});

test('主链调用全部配对，结果定位落在承接笔的消息序号', () => {
  const { requests } = starSessionData();
  for (const r of requests) {
    for (const c of r.toolCalls) {
      expect(c.result_req).not.toBeNull();
      expect(c.result_path).toMatch(/^request\.messages\[\d+\]\.content\[\d+\]$/);
      expect(c.result_ord).toBeGreaterThanOrEqual(2);
    }
  }
});

test('八类占比合计 100 且含 harness；回复正文带调用块（配对页参数链）', () => {
  const planSum = STAR_PLAN.reduce((s, p) => s + p.share, 0);
  expect(Math.round(planSum * 1000) / 1000).toBe(1);
  expect(STAR_PLAN.some(p => p.kind === 'harness')).toBe(true);
  const { requests } = starSessionData();
  // anthropic 调用笔回复内嵌 tool_use 块；chat 调用笔走 choices.tool_calls。
  const withCalls = requests.filter(r => r.toolCalls.length > 0 && r.purposeChain === 'participate');
  expect(withCalls.length).toBeGreaterThan(10);
  for (const r of withCalls) {
    if (r.protocol === 'anthropic') {
      const reply = r.reply as { stop_reason?: string; content: { type?: string }[] };
      expect(reply.stop_reason).toBe('tool_use');
      expect(reply.content.some(b => b.type === 'tool_use')).toBe(true);
    } else {
      const reply = r.reply as { choices: { finish_reason?: string; message: { tool_calls?: unknown[] } }[] };
      expect(reply.choices[0]!.finish_reason).toBe('tool_calls');
      expect(reply.choices[0]!.message.tool_calls?.length).toBeGreaterThan(0);
    }
  }
});

test('summary 数字取表：工具分布、totals、models、路径计数与静态条目', () => {
  const s = starSummary();
  expect(s.totals).toEqual({ in_tok: 208000, out_tok: 17400, cost: 0.42, cost_absent: 0, cache_hit: 0.932 });
  expect(s.structure.models).toEqual([{ name: 'synth-a', count: 43 }, { name: 'synth-c', count: 1 }]);
  expect(s.tools.find(t => t.name === 'Bash')?.errors).toBe(2);
  expect(s.skills.map(k => k.name).sort()).toEqual(['atc-notes', 'doc-render']);
  expect(s.interrupts.count).toBe(0);
  const writtenTotal = s.paths.written.reduce((sum, p) => sum + p.count, 0);
  const readTotal = s.paths.read.reduce((sum, p) => sum + p.count, 0);
  expect(writtenTotal).toBe(17 + 6);
  expect(readTotal).toBe(34);
  expect(s.coverage.calls_paired).toBe(s.coverage.calls_total);
  expect(s.turns).toBe(9);
});
