// 仅供 bun run typecheck 编译；不在运行时执行网络请求。
// 网络读取的契约从 app.js 的 createReader 迁到 reader-store；本文件随之改锚。
import { createReaderStore } from '../web/reader-store.js';
import { projectSteps, renderTraceRows, toolSummary } from '../web/trace-view.js';
import type { RequestRow } from '../src/queries/projection';

const store = createReaderStore(fetch);

await store.loadSessions();
await store.loadSessions('cursor');
await store.selectSession('synthetic-session');
await store.selectSession('synthetic-session', 30, 'latest');
await store.loadLater();
const window = store.getWindow();
const sessionKey: string | null = window.sessionKey;
const newerCursor: string | null = window.newerCursor;
// @ts-expect-error newerCursor必须为string|null；any退化时应报TS2578。
const invalidCursor: number = window.newerCursor;
void sessionKey;
void newerCursor;
void invalidCursor;

const read = await store.readRequest(1, true);
const detail = read.detail;
if (detail !== null) {
  const id: number = detail.req_id;
  // @ts-expect-error req_id必须为number；退化为any时该指令应报TS2578。
  const invalidId: string = detail.req_id;
  void id;
  void invalidId;
}
const meta = read.meta;
if (meta !== null) {
  const bodyState: import('../src/store').BodyState = meta.state;
  const bodyReason: string | null = meta.reason;
  // @ts-expect-error state必须为BodyState；any退化时应报未使用指令。
  const invalidState: number = meta.state;
  // @ts-expect-error reason必须为string|null；any退化时应报未使用指令。
  const invalidReason: number = meta.reason;
  void bodyState;
  void bodyReason;
  void invalidState;
  void invalidReason;
}

const range = await store.readRange(1, 0, 40);
const rangeFrom: number = range.from;
// @ts-expect-error from必须为number；any退化时应报TS2578。
const invalidFrom: string = range.from;
void rangeFrom;
void invalidFrom;

const tool = await store.readToolResult(1, 0);
const toolState: 'available' | 'pending' | 'ambiguous' | 'unpaired' | 'unavailable' | 'invalid_location' = tool.state;
// @ts-expect-error state是六值联合；any退化时应报TS2578。
const invalidToolState: number = tool.state;
void toolState;
void invalidToolState;

await store.loadStructure(1);
await store.loadDelta(1, 2);
await store.readRoute(1);
store.invalidate(1);

const peeked = store.peekRequest(1);
const readStatus: 'reading' | 'fresh' | 'invalidated' | 'failed' | null = peeked === null ? null : peeked.status;
// @ts-expect-error status是四值联合或null；any退化时应报TS2578。
const invalidStatus: number = peeked === null ? null : peeked.status;
void readStatus;
void invalidStatus;

const row = null as unknown as RequestRow;
const steps = projectSteps(row, null);
const firstKind: 'user' | 'assistant' | 'tool' | 'tool_result' | 'system' | 'record' | 'aux' = steps[0]!.kind;
// @ts-expect-error kind是七值联合；any退化时应报TS2578。
const invalidKind: number = steps[0]!.kind;
void firstKind;
void invalidKind;

const source = steps[0]!.source;
if (source !== null) {
  const side: 'request' | 'reply' = source.side;
  void side;
}
// @ts-expect-error source是三形联合或null；any退化时应报TS2578。
const invalidSide: number = source!.side;
void invalidSide;

const html: string = renderTraceRows(row, steps, 3, 'k');
const summary: string = toolSummary('Bash', '{}');
// @ts-expect-error renderTraceRows返回string；any退化时应报TS2578。
const invalidHtml: number = renderTraceRows(row, steps, 3, null);
void html;
void summary;
void invalidHtml;
