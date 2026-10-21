// 仅供 bun run typecheck 编译；不在运行时执行网络请求。
import { createReader } from '../web/app.js';

const reader = createReader(fetch);
await reader.loadSessions();
await reader.loadRequests();
await reader.selectSession('synthetic-session');
await reader.selectRequest(1);
const request = reader.getState().request;
if (request !== null) {
  const id: number = request.req_id;
  // @ts-expect-error req_id必须为number；退化为any时该指令应报TS2578。
  const invalidId: string = request.req_id;
  void id;
  void invalidId;
}
const session = reader.getState().sessions[0];
if (session !== undefined) {
  const key: string = session.conv_key;
  // @ts-expect-error conv_key必须为string；退化为any时应报TS2578。
  const invalidKey: number = session.conv_key;
  void key;
  void invalidKey;
}
