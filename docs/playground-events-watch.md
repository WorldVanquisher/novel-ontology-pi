# Playground / novel watch 契约草案与联调

本轮接口参考：[PR #4](https://github.com/gardianofthedarkness/novel-ontology-pi/pull/4)，
读取时为 open、未合并，准确 head 为 `e2c849cabd3f00e500b967972870d1d7e2e4901a`。
后端实现基于本轮获取的 `origin/main`：`c1fb2b4`，未混入前端分支。
PR #4 的 [CI run #7](https://github.com/gardianofthedarkness/novel-ontology-pi/actions/runs/39682293220)
仍为 failure：npm test 中图测试期望“初春饰利”、实际为 undefined。
本分支本地通过不代表 PR #4 的 CI 已修复。
原工作区及 `/tmp/novel-ontology-events-watch` 原样保留；本轮独立分支为
`feat/playground-events-watch-v2`，工作区为 `/tmp/novel-ontology-events-watch-v2`。
以下是供 Qiguang 确认的草案，尚未获得语义确认；没有代发消息。

## 与 PlaygroundEvent 的差异

| 前端事件 / 状态 | 当前真实路径与本轮记录 | 展示层仍需处理 |
| --- | --- | --- |
| `block.started` | BlockProcessor 进入该 block，记录 blockId | label 由展示层生成 |
| `sectioned` | sectionBlock 成功返回后记录句子数 | 可直接映射 |
| `verdict` | **未接通**；不修改 miniloop / DecisionPatch，也不从最终结果编造逐 patch 判决 | 等待真实 observation 接口 |
| `proposal.added` | ChangeSet 持久化后，记录首次出现的 proposal ID、kind、confidence、provenance | 不是 WorldNode；没有 node、edges、payload 或布局 |
| `changeset.pending` / pending | 文件中的 `pending_review` | label 和 proposal → nodeIds 映射在适配层生成 |
| approved | 记录 `changeset.approved`，文件状态为 `approved` | **尚不等于 merged**，前端 union 尚无 approved |
| `changeset.held` / held | 整份文件变为 `held`，携带完整 proposalIds | 前端不能只 hold 一个 node 再批准其余 node |
| revision_requested | 记录 `changeset.revision_requested`，文件同名状态 | 前端 union 尚无对应状态；沿用原有整 block 重跑及轮数限制 |
| accumulating | 仅在保存该状态时记录 `changeset.accumulating` | 真实 processor 当前保存 pending 及审核结果 |
| `changeset.applied` | apply 所有调用成功返回后记录 processed 及 unsupportedProposalIds | processed 保留原有返回值含义，包含既有空操作，不是实际写入数 |
| `changeset.merged` / merged | 仅在 apply 成功且没有未实现 proposal kind 时记录；target 为 store | 指目标 OntologyStore 完成应用，**不代表图已重建**；磁盘 ChangeSet 仍是 approved |
| `graph.rebuilt` | buildGraphFromBundle 完成读入、投影及数据库关闭后，记录 counts | 是独立事实，不能由 merged 推断 |

`add_alias` / `set_state_change` 在原有 apply 中仍为空操作；本轮不改变其算法，
这种 ChangeSet 只报 applied 和未支持 ID，不报整份 merged。
图重建保留 schema-v1 不支持的关系仅存在 bundle 的既有行为；counts 是实际图投影数，
不表示 bundle 中所有信息已进入图。输入 JSON 损坏或非 ENOENT 读取失败会使重建失败，
不能吞错后报告 graph.rebuilt。图的原有 MERGE/CREATE 行为未改为全量清库。

### 待 Qiguang 确认

1. 建议独立展示适配层生成 `parent`、`lane`、`chrono`、`lanePos`、`interiorPos`，
   不把布局写回 ontology。适配层归属谁，以及 bigEvent、branch、关系与前端节点的映射规则是什么？
   后端 proposal 的 `add_alias`、`set_state_change`、关系提案本来也不一定能映射为一个 WorldNode。
2. demo 的单节点 held + 其余部分 approve 不符合当前整份审核语义。
   建议真实模式禁用 demo 本地 approve，并按整份 ChangeSet 显示 held。
   本轮没有增加局部批准/暂缓或任何写 API。
3. 建议前端轨道实现 `SseEventSource` 和事件 → 展示模型适配，解析下述封装、按 ID 去重，
   按 changesetId 更新集合。当前 App.tsx 还有 DEMO_NODE_IDS、KNIT_SITE、手工初始图与本地 approve，
   所以仅替换 DemoEventSource 并不能完成真实接入。
4. 空白客户端需要独立初始图快照，以及与事件游标一致的交接规则。快照字段、布局生成、
   快照期间写入的一致性方案及负责人尚未确认。本轮没有提供 `/snapshot`，
   从头重放也不能恢复记录日志之前已有的 ontology。
5. 请确认采用原生事实 + 展示适配的两层契约，以及下述 endpoint / replay 协议。

## 已实现的传输草案

- `novel watch <novel-dir> [--port N]`；默认 `127.0.0.1:4317`，CLI 不接受 host 参数。
  模块 API 仅允许 `127.0.0.1` / `::1`。`--port 0` 供测试随机分配端口。
- `GET /events`，`Content-Type: text/event-stream`；只有此只读路由。
  不调用模型、merge gate、bundle 写入或图重建；目录必须已存在，日志可尚未创建。
- 每条业务帧为 `id: <ID>` + `data: <EventRecord JSON>` + 空行；使用默认 message 事件，
  因此浏览器 `onmessage` 解析 `record.event`，不能把整个 record 当 PlaygroundEvent。
- EventRecord：`{version: 1, id: string, timestamp: ISO时间, event: ProcessingEvent}`。
  类型在 `src/events/types.ts`；本轮与未合并前端没有包依赖。
- ID 为该 JSONL 完整记录换行符之后的 UTF-8 **字节偏移**，固定 16 位补零十进制字符串。
  不要把 JS 字符数当偏移，不要拿时间戳排序。存储和 SSE 使用同一 ID。
- 首次不带游标，从文件开头重放，然后继续追踪追加；日志不存在则等待，不创建文件。
  `Last-Event-ID` 优先于 `?after=<ID>`，重放严格从该记录之后开始。
  `0000000000000000` 表示从头；新建 EventSource 可用 after 恢复浏览器应用保存的游标。
  原生 EventSource 同一实例自动重连时会发送 Last-Event-ID。
- 超前、非记录边界、格式错误的游标返回 HTTP 409，客户端应清理其展示状态并显式选择从头恢复；
  不静默跳到最新。初次校验后遇到损坏/截断则断开，尽力发送无 ID 的 stream.error 帧。
  前端应把 stream.error 视为需要人工检查/显式重置，避免持续重连损坏历史。
- 文件顺序就是发送顺序；timestamp 仅供显示。每个客户端独立重放；网络交付不是 exactly-once，
  客户端须按 ID 去重，处理完一条再保存游标。心跳每 15 秒为 SSE 注释，无业务 ID。
- 只消费以换行结束的记录，半行（包括半个 UTF-8 字符）等待后续追加；单记录最多 1 MiB。
  有界分批读取、等待 socket drain；客户端断开/服务退出会解除等待、清除轮询计时器并关闭文件。
  重放与追踪追加使用同一个消费游标，不另起监听窗口；连接期间文件 inode 改变会断开，
  避免把替换文件混入当前历史。SIGINT/SIGTERM 等待服务清理后退出。
- 为 loopback 浏览器 origin（localhost、127.0.0.1、::1 的 HTTP/S 来源）返回匹配的 CORS header，
  无 wildcard、无 credentials；远程网页 origin 不获 CORS 许可。

## 记录位置与操作边界

处理日志为 `<novel-dir>/events.jsonl`；**领域事件**仍为
`<novel-dir>/ontology/events.jsonl`，二者不可混用，日志不属于 ontology schema。
新建日志/锁权限为 0600。事件显式投影字段，不记录 API key、认证配置、模型对象、
请求/响应、原始错误正文、任意 payload properties 或 reviewNotes。

真实接线位置：

- `saveChangeSet` / `setChangeSetStatus` 默认记录保存后的提案元数据与状态变化。
  原子 rename 使读者不会看到半份 ChangeSet JSON；同一 ID 内容修改尚无 proposal.updated 事件。
- `BlockProcessor` 第四参数 `{novelDir}` 启用该工作区持久化及日志；
  不传路径时保留原有库调用方式，无法自动猜测日志目录。可选 emit 用于外部观察，
  持久化事实仍写 novelDir 日志。不把 CLI 的尚未实现 ingest 伪装成已接通。
- `applyChangeSet(..., emit?)` 与 `buildGraphFromBundle(..., emit?)` 支持 observer；
  真实 CLI approve、graph build 已传入 EventLog.emit，直接库调用需要显式传 observer。
  `graph build <bundle-dir>` 的日志目录取 bundle-dir 的父目录；标准调用传 `<novel-dir>/ontology`。
- 最新 main 已含释放 QueryResult、Connection、Database 的修复；本轮仅增加重建失败分支
  finally 关闭与成功后事件，未修改读取/检索方法，以支持失败后重新打开。

约束：一个 novel 同时只运行一个业务写入流程。进程内日志追加排队，跨进程用独占锁拒绝竞争；
这不是整个 ontology 的多写者事务。watch 可多客户端读取。
日志是只追加历史，不支持在线轮转/替换/重写；需要维护时先停止写者和 watch，
检查历史、清理客户端状态再启动。崩溃遗留 `.lock` 或半行时写者拒绝追加，需人工检查，
watch 不会替你修复文件。

状态文件、bundle 和日志没有跨文件事务。若状态已保存而日志写入失败，调用抛错，
已发生的状态变化不回滚，可能有事件缺口；进程崩溃也可能留下缺口。
不可仅凭日志判断完整当前状态，也不可因观察日志失败就自动重试 approve（可能重复应用关系）。
bundle 部分写入后失败可能已留下部分数据，但不会报告整份 merged；图重建失败也不报 rebuilt。
若应用成功而后续图重建失败，merged 可以存在，rebuilt 不存在。

## NAS 启动，Mac 经 SSH 联调

NAS 使用已经有 ontology/changesets 的真实 novel 目录；watch 不创建初始图，也不运行 ingestion。
在本轮工作区执行（测试复用原仓库依赖，没有修改 package.json / lockfile）：

```bash
cd /tmp/novel-ontology-events-watch-v2
npm run build
npm test
node dist/src/cli.js watch /absolute/path/to/novel --port 4317
```

Mac 另开终端，替换用户和 NAS 主机名，保持 SSH 运行：

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:4317:127.0.0.1:4317 user@nas
```

Mac 验证历史及后续事件（Ctrl-C 只断开客户端，NAS watch 继续运行）：

```bash
curl -N http://127.0.0.1:4317/events
# 把上次完整接收帧的 id 原样填入，不要使用下方占位符本身：
curl -N -H 'Last-Event-ID: REPLACE_WITH_LAST_ID' http://127.0.0.1:4317/events
```

需要制造一个**真实图重建事实**时，在 NAS 另一个终端对实际 bundle 执行：

```bash
cd /tmp/novel-ontology-events-watch-v2
node dist/src/cli.js graph build /absolute/path/to/novel/ontology
```

这条命令会写本地可重建的 graph 缓存与处理日志；watch 本身始终只读。
已有真实 pending ChangeSet 的审核仍由原 CLI 独立执行，不通过 SSE 服务。
浏览器 Playground 可在 Mac 的 localhost:5173 运行，将前端待实现的 SseEventSource URL
设为 `http://127.0.0.1:4317/events`；在适配层/初始快照完成之前只验证传输，
不要把 demo 图或本地 approve 的结果当成真实 ontology 状态。
NAS watch 用 Ctrl-C 或 SIGTERM 关闭，不需要开放 NAS 的 4317 防火墙端口。

## 验证与未接通项

根目录 build + test（本地 Node v26.9.0，31/31 通过；未代替 PR #4 的 Node 22 CI）
覆盖无模型费用的真实 processor（mock model）、fixture 提案、真实 CLI approve、
状态文件与日志一致、写入失败、图重建损坏输入及重新打开、SSE 顺序/历史/重连/心跳、
半行 UTF-8、非法游标、缺日志等待、跨多批重放到实时追加、只读/loopback、断开/慢客户端/
服务关闭资源清理、SIGTERM，以及日志损坏/截断/替换、模型/审核失败和 bundle 部分写入失败。
测试 fixtures 明确标记，不冒充真实 ingestion；没有前端修改，故不涉及 playground 构建。

尚未接通：CLI ingest/miniloop run、逐 patch verdict、work LLM extraction、完整 proposal 展示 payload、
proposal.updated、初始图 snapshot、前端 SseEventSource / reducer / 布局适配。
Muse 的 Bundle export/import 位于独立 PR #5，本轮 query/search/timeline 也由 Muse 负责；
本分支未实现、未引入这些命令。

检查本轮 Git 改动（完整 diff 包含尚未跟踪的新文件）：

```bash
cd /tmp/novel-ontology-events-watch-v2
git branch --show-current
git status --short
git diff --check
git diff -- src/cli.ts src/connectors/ladybug.ts src/merge src/processing
less /tmp/novel-events-watch-v2.diff
```
