/**
 * 中立格式叶子：本地日键与时间兜底标题。
 *
 * 它们长在 magpie 适配器里时被 kernel、查询与 hook 反向引用；格式本身与来源
 * 协议无关，归这里，不 import 仓库内其他模块。
 */

/** 本地时区日键（YYYY-MM-DD）；账本与路由的 day 列共用，不引入 UTC 换算。 */
export function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 标题兜底：模型名加本地时刻，从不依赖正文，任何正文状态都能读。 */
export function modelTimeTitle(model: string | null, ms: number): string {
  const date = new Date(ms);
  return `${model ?? 'unknown'} · ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
