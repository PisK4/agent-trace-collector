// @ts-check
/**
 * Agent 品牌图标：把 Magpie 的 agent 图标库收进仓库，按 agent id 渲染 12px logo。
 *
 * 资产来源：magpie `internal/gui/assets/icons`（MIT）；SVG 内部命名显示源自
 * Lobe Icons。全量 57 个图标（47 SVG + 10 PNG）在 `agent-logos.json`，其中 PNG
 * 因静态发布只读 UTF-8 文本而以 base64 data URI 内联（渲染依赖 CSP 的
 * `img-src 'self' data:`）；文本本身经 `src/http.ts` 白名单发布，不向 `web/`
 * 添加图片文件。
 *
 * 首屏只内联当前已匹配的四个（Claude Code / Codex / OMP / Hermes）；其余在首次
 * 遇到时拉一次全量 JSON，到达后把带 `data-logo-pending` 的占位就地换成真图。
 * Magpie 里没有图标（generic）或未登记的自定义 / 插件 agent 显示通用轮廓。
 */

/** agent id → 图标名；与 Magpie `Agent.Icon` 一一对应（含别名 id）。 */
const AGENT_ICONS = /** @type {Record<string, string>} */ ({
  'claude':'claudecode-color','claude-desktop':'claude-color','claude-science':'claude-color',
  'codex':'codex-color','gemini':'geminicli-color','agy':'antigravity-color',
  'opencode':'opencode','openchamber':'openchamber','mimocode':'mimocode',
  'deveco':'deveco-color','pi':'pi','stepcode':'stepfun-color',
  'mothx':'mothx','aside':'aside','omo':'omo',
  'prime-agent':'prime-agent','goose':'goose','cursor':'cursor',
  'cursor-local':'cursor','zed':'zed','vscode':'vscode',
  'vscode-insiders':'vscode','vscodium':'vscode','zoo-code':'zoo-code',
  'copilot-jetbrains':'githubcopilot','air':'air','copilot':'githubcopilot',
  'crush':'crush','dsh':'deepseek-color','reasonix':'reasonix-color',
  'commandcode':'commandcode','fx':'fx','omp':'omp',
  'devin':'devin','hermes':'hermes','morph':'mistermorph-color',
  'kimi':'kimi','qwen':'qwen-color','muse':'meta-color',
  'empryo':'empryo-color','ante':'generic','astrbot':'astrbot',
  'jcode':'jcode','minimax-code':'minimax-color','droid':'factory',
  'cline':'cline','qoder':'qoder','qoder-cn':'qoder',
  'grok':'xai','grok-app':'grok','zcode':'zcode',
  'workbuddy':'workbuddy-color','workbuddy-ai':'workbuddy-color','codebuddy':'codebuddy-color',
  'pencil':'generic','openpencil':'generic','raycast':'raycast',
  'kirocrew':'generic','t3code':'t3code','hanako':'hanako',
  'atomcode':'atomcode','snow':'snow','alma':'alma',
  'cindy':'cindy','aionui':'aionui','lody':'lody',
  'magpie':'magpie','curl':'curl','pi-desktop':'pi'
});

/** Magpie 的 `Aliases`：客户端标签偶尔会落到别名上，先归一到 canonical id。 */
const ALIASES = /** @type {Record<string, string>} */ ({
  'cursor-agent':'cursor','gh-copilot':'copilot','antigravity-cli':'agy',
  'jetbrains-air':'air','cc':'claude','claude-code':'claude',
  'claude-app':'claude-desktop','operon':'claude-science','science':'claude-science',
  'cline-cli':'cline','codebuddy-code':'codebuddy','cbc':'codebuddy',
  'command-code':'commandcode','cmd':'commandcode','jetbrains':'copilot-jetbrains',
  'jetbrains-copilot':'copilot-jetbrains','copilot-idea':'copilot-jetbrains','copilot-intellij':'copilot-jetbrains',
  'intellij':'copilot-jetbrains','idea':'copilot-jetbrains','cursor-private-inference':'cursor-local',
  'factory':'droid','factory-droid':'droid','deepseek-harness':'dsh',
  'soulforge':'empryo','gemini-cli':'gemini','grok-build':'grok',
  'grok-cli':'grok','grokapp':'grok-app','openhanako':'hanako',
  'hana':'hanako','hanaagent':'hanako','hermes-agent':'hermes',
  'kimi-code':'kimi','kimi-cli':'kimi','kiro-crew':'kirocrew',
  'crew':'kirocrew','mcode':'minimax-code','mistermorph':'morph',
  'mister-morph':'morph','vibecoding':'mothx','muse-code':'muse',
  'musecode':'muse','oh-my-pi':'omp','chamber':'openchamber',
  'open-pencil':'openpencil','openpencil-desktop':'openpencil','pen.dev':'pencil',
  'pen-dev':'pencil','pendev':'pencil','qwen-code':'qwen',
  'qwen-cli':'qwen','raycast-ai':'raycast','reasonix-studio':'reasonix',
  'snow-cli':'snow','snow-ai':'snow','snow-app':'snow',
  'step':'stepcode','t3':'t3code','t3-code':'t3code',
  'oc':'opencode','mimo':'mimocode','vs-code':'vscode',
  'copilot-chat':'vscode','vscode-chat':'vscode','vs-code-insiders':'vscode-insiders',
  'code-insiders':'vscode-insiders','codium':'vscodium','vscodium-chat':'vscodium',
  'qodercli':'qoder','qoder-cli':'qoder','qoderclicn':'qoder-cn',
  'qodercn':'qoder-cn','qodercn-cli':'qoder-cn'
});

/** 首屏内联：Claude 用 currentColor 以便浅色加深、深色回原色。 */
const INLINE = /** @type {Record<string, string>} */ ({
  claude: '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path clip-rule="evenodd" d="M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z" fill="currentColor" fill-rule="evenodd"></path></svg>',
  // Codex 原版（codex-color）在 12px 下白底会盖住结、渐变又读不出；这里用
  // openai.svg 的单色结，浅 #3941FF / 深 #8FA8FF，原版仍存于 JSON。
  codex: '<svg fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"></path></svg>',
  omp: '<svg fill="currentColor" fill-rule="evenodd" viewBox="12 16 40 40" xmlns="http://www.w3.org/2000/svg"><path d="M14 16h36v8H40v32h-8V24h-6v22h-8V24h-4z"></path></svg>',
  hermes: '<svg fill="currentColor" fill-rule="evenodd" viewBox="12 16 40 40" xmlns="http://www.w3.org/2000/svg"><path d="M21 20h7v14h8V20h7v32h-7V40h-8v12h-7zM13 21l7 3v6l-7-3zM51 21l-7 3v6l7-3z"></path></svg>',
});

/** 未匹配 agent 的兜底：12px 中立 agent 轮廓，不冒充任何品牌。 */
const FALLBACK = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"><rect x="1.4" y="1.4" width="9.2" height="9.2" rx="2.2"/><circle cx="6" cy="4.9" r="1.4"/><path d="M3.4 9.2c.5-1.3 1.4-1.9 2.6-1.9s2.1.6 2.6 1.9"/></svg>';

/** @type {Record<string, string> | null} */
let logos = null;
/** @type {Promise<Record<string, string> | null> | null} */
let loading = null;

/** 去掉 omp#profile 这类后缀，再把 Magpie 别名归一。 @param {string} agent */
const canonical = (agent) => {
  const base = agent.split('#')[0];
  return ALIASES[base] ?? base;
};

/** @param {string} agent */
const iconOf = (agent) => AGENT_ICONS[canonical(agent)];

/** @param {string} asset */
const assetHtml = (asset) => asset.startsWith('data:')
  ? `<img src="${asset}" alt="" width="12" height="12">`
  : asset;

/**
 * 拉一次全量图标；失败时保持兜底，不把空行留给读者。
 * @returns {Promise<Record<string, string> | null>}
 */
export function loadAgentLogos() {
  if (logos !== null) return Promise.resolve(logos);
  if (loading !== null) return loading;
  const request = fetch('/agent-logos.json', { credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : null))
    .then((payload) => {
      const next = payload !== null && typeof payload === 'object' && payload.icons ? payload.icons : null;
      if (next !== null) {
        logos = next;
        refreshAgentLogos();
      }
      return logos;
    })
    .catch(() => null)
    .finally(() => { loading = null; });
  loading = request;
  return request;
}

/**
 * 把已到达的资产换到占位元素上；不重绘整个列表，避免丢滚动位置。
 * @param {ParentNode} root
 */
export function refreshAgentLogos(root = document) {
  if (logos === null || typeof root.querySelectorAll !== 'function') return;
  for (const el of root.querySelectorAll('.agent-logo[data-logo-pending]')) {
    const agent = el.getAttribute('data-agent') ?? '';
    const icon = iconOf(agent);
    const asset = icon === null ? undefined : logos[icon];
    if (asset === undefined) continue;
    el.innerHTML = assetHtml(asset);
    el.classList.remove('is-fallback');
    el.removeAttribute('data-logo-pending');
  }
}

/**
 * 会话行第二行的 logo。`null` 是归属未知，也画兜底，保证各行文字起排一致。
 * @param {string | null} agent
 * @returns {string}
 */
export function agentLogoHtml(agent) {
  if (agent === null) {
    return `<span class="agent-logo is-fallback" aria-hidden="true">${FALLBACK}</span>`;
  }
  const id = canonical(agent);
  const inline = INLINE[id];
  if (inline !== undefined) {
    return `<span class="agent-logo" data-agent="${escapeAttr(id)}" aria-hidden="true">${inline}</span>`;
  }
  const icon = AGENT_ICONS[id];
  // generic 在 Magpie 里就是「没有图标」，不去拉全量 JSON 浪费时间。
  if (icon !== undefined && icon !== 'generic') {
    const asset = logos?.[icon];
    if (asset !== undefined) {
      return `<span class="agent-logo" data-agent="${escapeAttr(id)}" aria-hidden="true">${assetHtml(asset)}</span>`;
    }
    void loadAgentLogos();
    return `<span class="agent-logo is-fallback" data-agent="${escapeAttr(id)}" data-logo-pending="1" aria-hidden="true">${FALLBACK}</span>`;
  }
  return `<span class="agent-logo is-fallback" data-agent="${escapeAttr(id)}" aria-hidden="true">${FALLBACK}</span>`;
}

/** @param {string} value */
function escapeAttr(value) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
