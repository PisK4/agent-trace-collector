import { writeFileSync } from 'node:fs';
import { evaluateReports, loadBudget, loadScenarioReports, sha256File } from './capacity-gate';
import type { CapacityBudget, GateFailure, ScenarioReport } from './capacity-gate';

export type CapacityDecision = 'keep-sync' | 'slice' | 'stop-non-long';

export type CapacityDecisionFile = {
  schema: 1;
  decision: CapacityDecision;
  primary: string | null;
  severity: number;
  report_sha256: string;
  budget_sha256: string;
  failures: GateFailure[];
  decided_at: string;
  command: string;
};

/**
 * 严重度按比值算：上限类看超了多少倍，下限类看差了多少倍。
 * 两边都除以被超过的那一侧，才能在同一把尺子上比。
 */
function severityOf(failure: GateFailure): number {
  return failure.kind === 'max'
    ? failure.actual / Math.max(1, failure.limit)
    : failure.limit / Math.max(1, failure.actual);
}

/**
 * 决策只回答"当前同步设计能不能按现状发布"，不为产品目标代签。
 * `slice` 要求主因落在长组的同步派生成本上，且别处没有绝对失败；
 * 其余有失败的情形一律 `stop-non-long`，保留同步路径并如实列出失败项。
 */
export function decideCapacity(input: {
  failures: readonly GateFailure[];
  scenarios: readonly string[];
}): { decision: CapacityDecision; primary: string | null; severity: number } {
  if (input.failures.length === 0) {
    // 空失败项有两种来源：全都通过，或者根本没有场景被测量。后者不能当作通过。
    if (input.scenarios.length === 0) throw new Error('capacity_decision_no_scenarios');
    return { decision: 'keep-sync', primary: null, severity: 0 };
  }
  const scored = input.failures
    .map(failure => ({ failure, score: severityOf(failure) }))
    .sort((left, right) => right.score - left.score);
  const primary = scored[0]!.failure.scenario;
  const longChecks = new Set(['max_write_tx_ms', 'event_loop_p99_ms', 'drain_ms', 'backlog_max_age_ms']);
  const longHasPrimaryCheck = scored.some(item =>
    item.failure.scenario === 'long-10000' && longChecks.has(item.failure.check));
  const otherAbsolute = input.failures.some(failure =>
    failure.scenario !== 'long-10000' &&
    (failure.basis === 'code-constant' || failure.basis === 'product-target'));
  const decision = primary === 'long-10000' && longHasPrimaryCheck && !otherAbsolute
    ? 'slice'
    : 'stop-non-long';
  return { decision, primary, severity: scored[0]!.score };
}

export function buildDecisionFile(input: {
  failures: readonly GateFailure[];
  scenarios: readonly string[];
  report: string;
  budget: string;
  command: string;
  decidedAt?: string;
}): CapacityDecisionFile {
  const verdict = decideCapacity({ failures: input.failures, scenarios: input.scenarios });
  return {
    schema: 1,
    ...verdict,
    report_sha256: sha256File(input.report),
    budget_sha256: sha256File(input.budget),
    failures: [...input.failures],
    decided_at: input.decidedAt ?? new Date().toISOString(),
    command: input.command,
  };
}

const FLAGS = ['--report', '--budget', '--out'] as const;

function parseDecisionArgs(argv: readonly string[]): { report: string; budget: string; out: string } {
  const args = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]!;
    if (!(FLAGS as readonly string[]).includes(flag)) throw new Error(`capacity_unknown_flag:${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.length === 0) throw new Error(`capacity_flag_value_missing:${flag}`);
    args.set(flag, value);
  }
  for (const flag of FLAGS) {
    if (!args.has(flag)) throw new Error(`capacity_flag_value_missing:${flag}`);
  }
  return { report: args.get('--report')!, budget: args.get('--budget')!, out: args.get('--out')! };
}

if (import.meta.main) {
  try {
    const { report: reportPath, budget: budgetPath, out } = parseDecisionArgs(Bun.argv.slice(2));
    let budget: CapacityBudget;
    let reports: ScenarioReport[];
    try {
      budget = loadBudget(budgetPath);
      reports = loadScenarioReports(reportPath);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : 'capacity_decision_invalid'}\n`);
      process.exit(2);
    }
    const failures = evaluateReports(reports, budget);
    const file = buildDecisionFile({
      failures,
      scenarios: reports.map(item => item.scenario),
      report: reportPath,
      budget: budgetPath,
      command: ['bun scripts/capacity-decision.ts', ...Bun.argv.slice(2)].join(' '),
    });
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ decision: file.decision, primary: file.primary, severity: file.severity })}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'capacity_decision_invalid'}\n`);
    process.exit(2);
  }
}