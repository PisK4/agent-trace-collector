/** 分页输入的公共契约：游标编解码、limit 校验与统一的用户输入错误。 */

export type Page<T> = { items: T[]; next_cursor: string | null };

export class QueryInputError extends Error {}

export function encodeCursor(value: unknown[]): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor<T>(cursor: string, check: (value: unknown) => T | null): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new QueryInputError('invalid_cursor');
  }
  const checked = check(parsed);
  if (checked === null) throw new QueryInputError('invalid_cursor');
  return checked;
}

export function checkLimit(limit: number, max: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new QueryInputError('invalid_limit');
  return limit;
}
