# Agent Note: 维护命令的三处收尾（F27/F30/F31）

Status: implemented

## Problem

2026-11-04 的缺陷清单留下三条维护路径上的问题：

- **F27**：`normalize-response-ids` 直接把存量 `response_id_norm` 改成规范值，改写前不检查目标键是否已被别的旧键占用。两个只差前缀的请求会得到同一个键，`byResponseId` 随后把它判成 ambiguous，两边都不再自动合并。
- **F30**：`restoreBundle` 只验证清单、哈希、完整性与包内版本号，没有验证恢复出来的库能否被当前代码打开。白名单写着 v6–v14 可恢复，但旧结构测试只是把当前库的 `PRAGMA user_version` 改成 6/7，迁移从未真正跑过。
- **F31**：`RESTORABLE_SCHEMA_VERSIONS` 上方留下三条互相矛盾的注释（「只有当前版本」「v6～v10」「实际到 v12」）。只含数据库的 `backup` 输出 `ok:true` 与 `ingestion_restorable:false`，容易被只读 `ok` 的自动化当成恢复点。

三条都属于「恢复/维护成功后才发现不可用」的同一类缺口，处理时沿用既有维护锁、停服务与原子事务。

## Decision

### F27：冲突在写入前整批拒绝

`previewResponseIdNormalization` 新增 `conflicts` 字段，列出同表内会落到同一个目标键的不同旧值。应用路径先跑同一份扫描，`conflicts` 非空就抛 `response_id_conflict`，不进入写事务，也不调用 `reconcilePending`。CLI 的失败路径输出 `normalize-response-ids_failed:response_id_conflict`，退出 1。

冲突判定按整批操作后的实际形态预演，只放行现有唯一候选合并路径：

1. 按 `normalizeResponseId` 把所有 `request` 行分到目标键。
2. 目标键只有一个 route 候选时，等待队列里指向该键、且源行不是候选本身的 hook 行会被 `mergeHookInto` 删除。
3. 删完之后仍有多个非 `rejected` 行共用这个键，才算冲突；0 个或多个 route 候选、或源行没有等待项，都不放行。

`pending_hook` 与 `raw_ledger` 不做同键冲突判断：它们是等待队列与原始层，多行共用一个响应键是正常形态，`byResponseId` 只读 `request`。命令不自动合并冲突行，先拒绝整批，由人确认两行是否同源。

### F30：恢复在 staging 上真正迁移并探活

`restoreBundle` 在复制到 staging、哈希与完整性校验、盐绑定与包内版本核对之后，新增一步 `migrateStagedDatabase`：

- 用 `openStore` 打开 staging 里的 `trace.db`。这是写操作：它执行 v6→v14 迁移、切到 WAL、建立只读连接并校验容量计数，不能称为只读 smoke。
- 断言 `user_version` 等于当前代码版本，再对 `request`、`request_evidence`、`pending_hook`、`derive_queue`、`collector_state` 各跑一次计数查询。
- 迁移后再核对一次 `privacy:salt` 绑定，确认迁移没有动盐记录。
- 任何一步失败都映射为 `restore_migration_failed`；staging 在 catch 里整目录删除，目标尚未 `mkdir`，不会留下半套目录。
- 迁移会改写库文件，发布前用新的 SHA-256 与当前版本重写 `manifest.json`，保持「清单描述的就是包内库」。`format` 与 `salt_id` 原样保留。
- `close()` 会做 TRUNCATE checkpoint；若 staging 仍留下非空 `-wal`，说明清单哈希代表不了整份库，同样按失败处理。

测试夹具使用 commit `f574f9c` 的 `schema.sql` + `schema-v6.sql` 建真实 v6 库（含 `auto_vacuum` 与 WAL 设置），再从它出 bundle；不是把当前库的版本号改成 6。成功用例断言恢复后库升到 v14、请求数据保留、三件套与可能的空 WAL/SHM 都是 0600；失败用例删掉 `tool_call` 让 v8 建索引失败，断言目标不存在、staging 清空。

### F31：一条权威注释

`RESTORABLE_SCHEMA_VERSIONS` 上方只留一条注释：v6–v14 恢复后由当前代码原地迁移，更早没有升级路径，更高版本当前代码打不开。`backup` 的行为不改：只含数据库的副本成功时仍是 `ok:true`，用独立的 `ingestion_restorable:false` 说明它不能恢复占位符连续性。测试锁住这两个字段，避免以后把成功改成失败或删掉限制说明。

## Alternatives considered

**F27 冲突时自动合并。** 两个旧键只差一个已知前缀时，看起来很像同一次调用；但库内没有证据能排除并发调用或重试。自动合并会把猜测写成 `request_alias`，并删掉一行请求与它的正文。整批拒绝把判断留给能看原始记录的人。

**F27 只在 `request` 同键时报警，不预演合并。** 现有的合法现场就是 hook 行与路由行先同键、再由 `reconcilePending` 合并；只要报同键，主用例（`msg_` 前缀的 hook 回执并入裸键路由行）就会先被拒绝。预演唯一候选路径保留了这条主路径，又挡住它覆盖不到的形态。

**F30 恢复后只读 smoke。** 只读打开不会跑迁移，证明不了「首次启动能起来」；而 `openStore` 会写 schema，把它叫只读 smoke 是错误口径。迁移只能在隔离副本上做，做完再发布。

**F30 发布未迁移的原库，另留一份迁移副本做验证。** 要多复制一份可能到 GiB 级的数据库，还要清掉副本；直接在 staging 迁移省掉这份拷贝，清单重写后输出仍是可再次恢复的包。

**F31 把 DB-only 备份改成 `ok:false`。** 备份文件本身生成成功，把 `ok` 改成失败会让脚本无法区分「备份失败」与「备份成功但不能恢复连续性」。调用方需要的是一个独立能力位，不是把成功改写成失败。

**F31 新增 `usable_for_restore` 字段。** 现有 `ingestion_restorable` 已经表达同一件事，再加一个近义字段只会让消费者挑错。只合并注释，不加字段。

## Consequences

- 冲突时整批不写。运维需要先处理冲突键再重跑；预览 JSON 的 `conflicts` 会给出表、目标键与旧值。预览命令本身仍以 `ok:true`、退出 0 输出，自动化要读 `conflicts` 字段，或在应用阶段接收 `response_id_conflict`。
- 合法现场（唯一路由行 + 有等待项的 hook 行）不受影响，原 `response-ids.test.ts` 的合并用例仍通过。
- 恢复旧包会实际执行一次迁移，耗时与首次启动相同；恢复成功后发布的是当前版本的库，清单同步更新。恢复目录可能带空的 `trace.db-wal`/`trace.db-shm`，权限同为 0600。
- `restore_migration_failed` 表示 staging 内迁移或可服务性检查失败；包校验失败另用 `restore_bundle_invalid`。恢复步骤与错误处理见[运维手册](../../../../docs/operations.md)。
- 旧结构夹具只覆盖 v6（白名单下界）。v7–v13 走同一条加列链，但没有各版本的独立样本；以后改动迁移分支时应补对应夹具。
- `migrateStagedDatabase` 用 `verify.ts` 的 `CODE_SCHEMA_VERSION` 断言迁移结果，未从 `store.ts` 扩大导出面；两处数字由既有 precheck 测试钉住。

## Testing

- `bun test tests/response-ids.test.ts tests/restore-migration.test.ts tests/maintenance.test.ts`：44 pass、0 fail。
- `bun run typecheck`：通过。
- 旧实现回放：把 `src/maintenance/response-ids.ts` 与 `src/maintenance/backup.ts` 暂存回退后重跑同一批新用例，冲突用例、v6 恢复升级用例与迁移失败原子性用例均失败：旧代码不报冲突、恢复后清单仍是 `schema:6`、缺 `tool_call` 的包被直接发布。
- 合成数据范围：真实 v6 建表链、合成盐与合成请求；没有复制生产库、个人盐或真实正文。组内验证未跑全量套件或真实旧包恢复；整合后的部署与只读巡查见[生产验收](../../../../docs/acceptance.md#开放缺陷生产部署真实流量2026-11-06)。
