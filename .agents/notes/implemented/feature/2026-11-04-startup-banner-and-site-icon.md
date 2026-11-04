# Agent Note: 启动横幅与站点图标

Status: implemented

## Problem

采集器启动时只往 stdout 写一行 `collector_listening:<port>`，没有任何人类可读的输出。从 launchd 日志或手动 `bun run start` 看，看不出这个进程是什么、监听在哪、数据落在哪。装了两份副本时更难分辨。

浏览器标签页显示的是默认地球图标：`web/index.html` 已经声明了 SVG favicon，但部分浏览器不吃 SVG 图标，标签页继续回退到通用图标。作者实测在 Safari 上看到的就是地球。

## Decision

**启动横幅**放在 `src/banner.ts`，`main.ts` 的 `import.meta.main` 分支在服务起来之后打印。

图中的蜘蛛由 `web/tracery-dark.svg` 光栅化后按墨迹包围盒降采样成半块字符（`▀▄█`）得到，共 30×14，不是另画一个图形。右侧接三行：`Tracery`、监听地址、数据目录（家目录前缀缩成 `~`）。颜色只在 `process.stdout.isTTY` 时加——生产是 launchd 把 stdout 重定向到文件，日志里不该出现转义序列。

横幅打印在 `collector_listening` 之前，那一行原样保留：`scripts/capacity/capacity-support.ts` 按正则从子进程输出里解析端口。

**站点图标**补位图兜底：`web/favicon.png`（32×32）与 `web/apple-touch-icon.png`（180×180）从同一份 SVG 生成，`index.html` 同时声明 PNG、按 `prefers-color-scheme` 分开的明暗两个 SVG、以及 apple-touch-icon；两张新图登记进 `STATIC_FILES`。

**顺带修掉一个真实缺陷。** 静态资源一直按 `readFileSync(file, 'utf8')` 读，二进制会被替换成 U+FFFD：返回的 PNG 头部从 `8950 4e47` 变成 `efbfbd 50 4e 47`，浏览器拿到的是坏图。SVG 是文本，所以此前没暴露。改为按 `content-type` 判定：文本与 JSON/SVG 走 utf8，其余按字节读。

## Alternatives considered

- **横幅用手写 ASCII 字。** 与仓库里已有的 logo 无关，等于多一份品牌资产要维护。光栅化现有 SVG 的好处是改 logo 时重出一份即可。
- **只用 SVG favicon。** 已经是现状，问题正是不被部分浏览器接受。
- **把横幅写进日志模块的诊断事件。** 诊断日志是结构化 JSON，塞多行字符画会破坏一行一事件的约定；横幅走 stdout 更合适。
- **给 favicon 引入 ICO 多尺寸。** ICO 需要额外工具链（sips 不产 ICO），而 PNG 声明在现代浏览器上等效。

## Consequences

- **logo 变更要重出字符画。** `src/banner.ts` 里的 `MARK` 常量是光栅化产物，不是源：改 `tracery-dark.svg` 后这份字符画会与页面不一致。
- **字符画有对齐前提。** 半块字符按 2:1 纵向比降采样，只在等宽字体下对齐；字体不含 `▀▄█` 的终端会退化成方块或问号。
- **多两份二进制资产。** 约 11 KB，随仓库发布；它们是从 SVG 生成的派生物，改图时要一起重生成。
- **二进制静态资源现在有回归测试。** 按 utf8 读坏 PNG 这类问题会在 `tests/http.test.ts` 直接失败，而不是等浏览器出现坏图。

## Testing

- `bun test tests/banner.test.ts`：横幅含产品名、监听地址与缩写后的数据目录；只有显式要颜色时才出现转义序列。
- `bun test tests/http.test.ts`：新增「二进制静态资产按字节原样返回」，把 `/favicon.png` 的响应体与磁盘文件逐字节比对。
- 生产实测：`/favicon.png` 与 `/apple-touch-icon.png` 均 200 且字节数与磁盘一致；`tracery.log` 首屏出现横幅，其后仍是 `collector_listening:8320`。
