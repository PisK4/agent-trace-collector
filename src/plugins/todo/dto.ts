/**
 * Todo 插件交回核心的 DTO：某一轮跑完时的列表，带一个时点编号。
 *
 * 一轮含多笔 Request，其中一笔更新 Todo，具体哪笔不影响阅读；时点编号按轮内
 * 更新次序递增，供回退轮号时还原。状态值保留各家 Agent 的原词（pending、
 * in_progress、completed 等），核心不解释、不归一，只转义后显示。
 */
export type TodoItem = { content: string; status: string };

export type TodoSnapshot = {
  /** 轮内更新次序，从 0 起；同一时点的列表只出现一次。 */
  seq: number;
  items: readonly TodoItem[];
};

/**
 * 外部 DTO 落到页面前的唯一校验入口。插件或社区包可能返回畸形值，这里收口：
 * 字段缺失、类型不对、序号非整数、条目里混进非字符串都判为 null，核心据此只
 * 隐藏该页签内容，不把失败写成空列表，也不抛异常拖垮右栏。
 */
export function validateTodoSnapshot(value: unknown): TodoSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const snapshot = value as Record<string, unknown>;
  if (!Number.isInteger(snapshot.seq) || (snapshot.seq as number) < 0) return null;
  if (!Array.isArray(snapshot.items)) return null;
  const items: TodoItem[] = [];
  for (const raw of snapshot.items) {
    if (typeof raw !== 'object' || raw === null) return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.content !== 'string' || typeof item.status !== 'string') return null;
    items.push({ content: item.content, status: item.status });
  }
  return { seq: snapshot.seq as number, items };
}
