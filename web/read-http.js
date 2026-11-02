/**
 * 页面读取的唯一 HTTP adapter：把具名操作编码为 API 请求，解析响应并映射
 * 稳定错误。不排队、不缓存、不重试；store 与 feature 经 ReadTransport.execute
 * 使用它，不拼 URL、不识别 Response/status。
 *
 * 任务持续到响应体读完、JSON 解析与顶层校验完成——仅等响应头就放行会漏算
 * 下载与解析阶段。取消后在每个等待点检查 signal；错误信息只携带稳定码，
 * 不输出 headers、正文或 URL 参数。
 */

/** @typedef {import('../src/read-contract').ReadOperations} ReadOperations */
/** @typedef {import('../src/read-contract').ReadErrorCode} ReadErrorCode */

/**
 * @param {{
 *   fetcher: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>,
 *   baseUrl?: string,
 *   headers?: () => Record<string, string>,
 * }} options
 *   fetcher 由装配处注入（页面传 window fetch）；baseUrl 供非同源宿主注入；
 *   headers 每次调用可注入凭证，默认不发。认证配置失败原样报错，不放宽边界。
 * @returns {import('../src/read-contract').ReadTransport}
 */
export function createHttpReadTransport({ fetcher, baseUrl = '', headers }) {
  const enc = encodeURIComponent;
  /** 与服务端批读一致的上限：编码后超限未发 Fetch 即拒绝，客户端据此折半。 */
  const MAX_READ_URL_BYTES = 16 * 1024;

  /**
   * 显式操作编码表：调用者不能提供任意 URL。null 参数不进查询串，
   * 与服务端「缺参数走默认」的语义一致。
   * @param {keyof ReadOperations} operation
   * @param {ReadOperations[keyof ReadOperations]['input']} input
   * @returns {string}
   */
  function encode(operation, input) {
    switch (operation) {
      case 'sessions': {
        const params = new URLSearchParams({ limit: String(input.limit) });
        if (input.cursor !== null) params.set('cursor', input.cursor);
        return `/api/sessions?${params}`;
      }
      case 'requests': {
        const params = new URLSearchParams({ direction: input.direction, limit: String(input.limit) });
        if (input.cursor !== null) params.set('cursor', input.cursor);
        return `/api/sessions/${enc(input.key)}/requests?${params}`;
      }
      case 'detail':
        return `/api/requests/${input.id}`;
      case 'body':
        return `/api/requests/${input.id}/body?from=${input.from}&to=${input.to}&if_reading=${enc(input.token)}`;
      case 'toolResult':
        return `/api/requests/${input.id}/tools/${input.ord}/result?if_reading=${enc(input.token)}`;
      case 'route':
        return `/api/requests/${input.id}/route`;
      case 'turns': {
        const query = input.from === null ? '' : `?from=${input.from}`;
        return `/api/sessions/${enc(input.key)}/turns${query}`;
      }
      case 'bgJobs':
        return `/api/sessions/${enc(input.key)}/bg-jobs`;
      case 'summary':
        return `/api/sessions/${enc(input.key)}/summary`;
      case 'summaryEntries': {
        const params = new URLSearchParams({ kind: input.query.kind });
        if (typeof input.query.name === 'string') params.set('name', input.query.name);
        if (typeof input.query.path === 'string') params.set('path', input.query.path);
        return `/api/sessions/${enc(input.key)}/summary/entries?${params}`;
      }
      case 'contextItem': {
        const params = new URLSearchParams({ kind: input.query.kind });
        if (input.query.name !== null) params.set('name', input.query.name);
        if (input.query.tag !== null) params.set('tag', input.query.tag);
        if (input.query.cursor !== null) params.set('cursor', input.query.cursor);
        params.set('if_reading', input.token);
        return `/api/requests/${input.id}/context-item?${params}`;
      }
      case 'stats':
        return '/api/stats';
      case 'readings':
        return `/api/sessions/${enc(input.key)}/readings?ids=${enc(JSON.stringify(input.ids))}`;
      case 'bodyRanges':
        return `/api/sessions/${enc(input.key)}/reading-ranges?items=${enc(JSON.stringify(input.ranges))}`;
      default:
        throw Object.assign(new Error('unsupported_operation'), { code: 'unsupported_operation' });
    }
  }

  /**
   * @param {ReadErrorCode} code
   * @param {number} [status] HTTP 状态，仅供诊断
   * @returns {Error}
   */
  const fail = (code, status) =>
    Object.assign(new Error(code), status === undefined ? { code } : { code, status });

  /**
   * 顶层形状校验：客户端不重复服务端语义，只拒绝「解析了但不能当该操作结果」
   * 的响应。canonical id 可能不同于请求 id（alias 解析），身份对应只在批次
   * 上断言——requested_id 是服务端显式回显的输入位置事实。
   * @param {keyof ReadOperations} operation
   * @param {ReadOperations[keyof ReadOperations]['input']} input
   * @param {unknown} parsed
   */
  function validate(operation, input, parsed) {
    const isObj = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const reject = () => { throw fail('invalid_response'); };
    const isToken = (value) => typeof value === 'string' && value.startsWith('r1-');
    /** 批次公共校验：index 唯一在界、requested_id 对应、覆盖 [0, next_index)。 */
    const checkBatch = (items, requestedIds, nextIndex) => {
      if (!Array.isArray(items)) reject();
      const seen = new Set();
      for (const item of items) {
        if (!isObj(item) || !Number.isSafeInteger(item.index)
          || item.index < 0 || item.index >= requestedIds.length) reject();
        if (seen.has(item.index)) reject();
        seen.add(item.index);
        if (item.requested_id !== requestedIds[item.index]) reject();
        if (item.state === 'ok') { if (!isObj(item.value)) reject(); }
        else if (typeof item.reason !== 'string') reject();
      }
      if (nextIndex === null) {
        if (seen.size !== requestedIds.length) reject();
      } else {
        if (!Number.isSafeInteger(nextIndex) || nextIndex <= 0 || nextIndex >= requestedIds.length) reject();
        if (seen.size !== nextIndex || [...seen].some(index => index >= nextIndex)) reject();
      }
    };

    switch (operation) {
      case 'sessions':
      case 'requests':
      case 'turns':
        if (!isObj(parsed) || !Array.isArray(parsed.items)
          || !(parsed.next_cursor === null || parsed.next_cursor === undefined
            || typeof parsed.next_cursor === 'string')) reject();
        return;
      case 'bgJobs':
        if (!Array.isArray(parsed)) reject();
        return;
      case 'detail':
      case 'summary':
        if (!isObj(parsed)) reject();
        return;
      case 'body':
        if (!isObj(parsed) || typeof parsed.req_id !== 'number' || !isToken(parsed.reading_token)) reject();
        return;
      case 'toolResult':
        if (!isObj(parsed) || typeof parsed.state !== 'string' || !isToken(parsed.reading_token)) reject();
        return;
      case 'route':
        if (!isObj(parsed) || typeof parsed.state !== 'string') reject();
        return;
      case 'summaryEntries':
        if (!isObj(parsed) || !(Array.isArray(parsed.items) || Array.isArray(parsed.requests))) reject();
        // 调用条目必须带定位与新字段；缺字段的半成品不能当成功结果。
        if (Array.isArray(parsed.items)) {
          for (const item of parsed.items) {
            if (!isObj(item) || !Number.isSafeInteger(item.req_id) || !Number.isSafeInteger(item.ord)
              || !(item.tool_name === null || typeof item.tool_name === 'string')
              || typeof item.state !== 'string'
              || !(item.exec_ms === null
                || (typeof item.exec_ms === 'number' && Number.isFinite(item.exec_ms) && item.exec_ms >= 0))
              || !(item.summary === null || typeof item.summary === 'string')) reject();
          }
        }
        return;
      case 'contextItem':
        if (!isObj(parsed) || typeof parsed.req_id !== 'number' || !isToken(parsed.reading_token)
          || !Array.isArray(parsed.entries)) reject();
        return;
      case 'stats':
        if (!isObj(parsed)) reject();
        return;
      case 'readings': {
        if (!isObj(parsed)) reject();
        checkBatch(parsed.items, input.ids, parsed.next_index);
        for (const item of parsed.items) {
          if (item.state !== 'ok') continue;
          const { detail, meta } = item.value;
          if (!isObj(detail) || !isObj(meta) || detail.req_id !== item.requested_id
            || meta.req_id !== item.requested_id || !isToken(detail.reading_token)
            || detail.reading_token !== meta.reading_token) reject();
        }
        return;
      }
      case 'bodyRanges': {
        if (!isObj(parsed)) reject();
        checkBatch(parsed.items, input.ranges.map(range => range.id), parsed.next_index);
        for (const item of parsed.items) {
          if (item.state !== 'ok') continue;
          if (!isObj(item.value) || item.value.req_id !== item.requested_id
            || !isToken(item.value.reading_token)) reject();
        }
        return;
      }
      default:
        reject();
    }
  }

  return {
    /**
     * @template {keyof ReadOperations} K
     * @param {K} operation
     * @param {ReadOperations[K]['input']} input
     * @param {{ signal: AbortSignal }} options
     * @returns {Promise<ReadOperations[K]['output']>}
     */
    async execute(operation, input, { signal }) {
      const url = baseUrl + encode(operation, input);
      if (new TextEncoder().encode(url).length > MAX_READ_URL_BYTES) throw fail('batch_too_large');
      let response;
      try {
        response = await fetcher(url, { method: 'GET', headers: headers?.(), signal });
      } catch (error) {
        if (signal.aborted) throw fail('cancelled');
        throw fail('unavailable');
      }
      if (signal.aborted) throw fail('cancelled');
      if (!response.ok) {
        const status = response.status;
        const code = status === 409 ? 'reading_changed'
          : status === 404 ? 'not_found'
          : status === 400 ? 'invalid_input'
          : status === 401 ? 'unauthorized'
          : status === 403 ? 'forbidden'
          : status === 414 ? 'batch_too_large'
          : 'unavailable';
        throw fail(code, status);
      }
      let parsed;
      try {
        parsed = await response.json();
      } catch {
        throw fail('invalid_response');
      }
      if (signal.aborted) throw fail('cancelled');
      validate(operation, input, parsed);
      return parsed;
    },
  };
}
