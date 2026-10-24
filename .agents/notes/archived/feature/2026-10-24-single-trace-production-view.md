# Agent Note: 生产单一轨迹视图与窗口导航

Status: implemented
Archived: 2026-10-24

## Problem

生产中栏仍是「对话 / 请求账本」双视图：首屏从最早请求开始、正文预取把连续历史页与阅读位置绑死、详情缓存永不失效、迟到的异步响应没有会话代次守卫。原型已验证单行轨迹的信息层次，但生产没有对应的读取与渲染结构。

## Decision

中栏切换为单一轨迹：窗口、正文、结构与工具结果全部经 `reader-store`（Task 4）读取，步骤投影用 `trace-view`（Task 5）的纯函数，`app.js` 只做装配与交互。删除 `createReader`、`ensureDetail` / `ensureBody`、`prefetchDetails` / `prefetchBodies` / `BODY_PREFETCH`、`renderConversation` / `convCard` / `ledgerRow` 家族与 `view` 状态，只留一套权威缓存；对应的 `createReader` 行为测试随契约迁到 reader-store，`reader-types.ts` 改锚新接口。

窗口导航：`selectSession` 用 `direction=older` 建最近窗口（按视口高度取 30–100 笔），默认选最新并把选中组带入可见区（首载批次期间保持，用户滚动后停止）；顶部「加载更早」prepend 去重排序，锚点补偿两帧校准（实测残差约 3px，来自多次重绘的 scrollTop 亚像素取整，记录在案）；显式刷新重建窗口、清旧展开与阅读版本并记录时间；「回到最新」先刷新再定位末笔。URL 只写 session/trace/tab；URL 指定的 trace 在窗口外时保留语义、右栏说明未在窗口、不扫描全部历史，不静默改选最新（popstate 同样带 trace 进入）。选择身份全部用 req_id / step key / call ord，加载更早后的重新编号不影响身份。

右栏在 Task 7 完整改版前保留读数四节与路由（路由改经 store 按需读取），正文页签用结构的连续读取，未确认关系与工具状态沿投影口径显示。

[阅读角色与步骤定位修复](../../implemented/bug-fix/2026-10-24-reader-role-and-selection-consistency.md)调整了选中高亮、来源定位与稀疏消息展示；请求身份、最近窗口和有界读取的决定继续有效。

## Alternatives considered

**保留双视图入口。** 两套渲染与两套缓存路径会继续分叉；单一轨迹是原型验证过的阅读方式，账本特有的读数全部进右栏。

**预取整窗正文。** 30 笔 × 首片在长会话上同时占住内存与连接；按批（4 并发）载入详情 + 元信息 + 最多两片可信增量，每批落屏。

**加载更早后重置滚动到顶部。** prepend 的意义就是保住阅读位置；锚点补偿比归零更符合连续阅读。

## Consequences

生产页面与原型共用经验证的 compact-* 行样式与状态语义；对话与账本视图退役，`conv-*` / `req-head` / `path-table` 等无引用 CSS 已删除（`renderReply` / `renderTools` / `renderMessages` 使用的类保留）。验证：`bun test`（八文件 121 例全过，含窗口合并、迟到响应、409 作废、稳定键、XSS）与 `bun run typecheck` 通过；合成浏览器验收（18 笔状态会话 + 42 笔窗口会话）：36px 行高、默认展开 0、同请求共享编号、行内无 time 与模型名、默认选中可见、107 失败行、108 截断行、106 辅助行、112 未配对与 113 位置待定、116 双调用「结果见请求 117」点击读取并定位、加载更早 42 组无重复、窗口外 trace 右栏说明且组数不变（2026-10-24）。已知边界：锚点补偿残差约 3px（亚像素取整）；右栏工具详情仍是过渡形态，Task 7 落地概览/参数/结果/Schema 四页。
