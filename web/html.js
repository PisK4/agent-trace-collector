// @ts-check
/**
 * 转义策略的唯一实现：HTML 转义与给回复文本用的极简 Markdown。
 * 协议正文一律先转义；只有 mdToHtml 识别少数结构，认不出的语法按原文保留，
 * 绝不把消息内容当 HTML 执行。
 */

const ESCAPES = /** @type {Record<string, string>} */ ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
});

/** @param {unknown} value */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ESCAPES[char] ?? char);
}

/**
 * 给回复文本用的极简 Markdown。先整体转义，再识别代码块、表格、列表与标题。
 * @param {unknown} text
 */
export function mdToHtml(text) {
  const source = String(text ?? '');
  /** @type {string[]} */
  const blocks = [];
  /** @param {string} html */
  const keep = (html) => `\u0000${blocks.push(html) - 1}\u0000`;
  const body = source.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_all, _lang, code) =>
    keep(`<pre class="md-code" tabindex="0">${esc(String(code).replace(/\n$/, ''))}</pre>`));

  /** @param {string} value */
  function inline(value) {
    return esc(value)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  const lines = body.split('\n');
  const out = [];
  let i = 0;
  /** @param {string} line */
  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  /** @param {string} line */
  const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(cell => cell.trim());
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim()) { out.push(''); i += 1; continue; }
    if (/^```/.test(line)) { out.push(''); i += 1; continue; }
    if (/^\s*\|.*\|\s*$/.test(line) && isTableSep(lines[i + 1] ?? '')) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? '')) {
        rows.push(cells(lines[i] ?? ''));
        i += 1;
      }
      out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${
        head.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr></thead><tbody>${
        rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')
      }</tbody></table></div>`);
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i] ?? '')) {
        items.push(`<li>${inline((lines[i] ?? '').replace(/^\s*[-*•]\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ul class="md-list">${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i] ?? '')) {
        items.push(`<li>${inline((lines[i] ?? '').replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
        i += 1;
      }
      out.push(`<ol class="md-list">${items.join('')}</ol>`);
      continue;
    }
    if (/^#{1,4}\s+/.test(line)) {
      out.push(`<p class="md-head">${inline(line.replace(/^#{1,4}\s+/, ''))}</p>`);
      i += 1;
      continue;
    }
    out.push(`<p>${inline(line)}</p>`);
    i += 1;
  }
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_all, key) => blocks[Number(key)] ?? '');
}
