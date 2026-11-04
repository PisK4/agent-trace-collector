/** Parser 共用的纯形状判断；不 import 核心，不认识表名与协议。 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function textOf(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** 把未知条目数组收成 DTO 的形状；任何一条不合形状就整份弃权。 */
export function itemsOf(value: unknown): { content: string; status: string }[] | null {
  if (!Array.isArray(value)) return null;
  const items: { content: string; status: string }[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) return null;
    const content = textOf(raw.content);
    const status = textOf(raw.status);
    if (content === null || status === null) return null;
    items.push({ content, status });
  }
  return items;
}
