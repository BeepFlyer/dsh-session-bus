# dsh-session-bus · 规格书

> 目标读者：写插件的会话（不共享本规格作者的上文，所有需要的背景都写在这里）。
> 状态：**待实现**。ADR 见 `decisions.md（ADR-006）` 的 ADR-006。
> 日期：2026-11-09
> 路径说明：文中若出现 `~/` 或 `~/.dsh/`，指作者本机路径的占位，移植时按自己的环境替换。

---

## 0. 一句话

让**会话之间**、以及**外部进程（飞书桥）与会话之间**，能按「注册的意图」互相投递消息。
底层的投递能力已经实测可用（见 ADR-006），本规格是在它上面加一层**注册表 + 匹配 + 护栏**。

---

## 1. 目标

1. 会话可以**登记自己**：身份、职责、知道什么、可被谁唤醒。
2. 会话可以**声明自己在等什么**（短期、一次性、有超时）。
3. 会话之间可以**主动投递**消息给另一个会话。
4. 外部进程（飞书桥）发事件进来，按注册表匹配后**投递给指定会话**。
5. 人类能在**设置页**看到谁注册了、谁在等什么、最近发生了什么。
6. 所有唤起可被限流（跳数 / 频率 / TTL），不会雪崩。

## 2. 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| 自动回复（B 处理完自动回投 A） | 会变成两个机器人互相聊天 |
| 按图片内容语义匹配 | 成本高；用类型 + 时间窗 + 说明文字足够 |
| 跨机器 | 只本机 loopback |
| 把附件内联进 prompt | 吃 token；改为给路径，会话自己 `read` |
| 替代 subagent | subagent 是会话内并行；本工具的价值是「那个会话有自己的历史」 |

---

## 3. 名词（必须先对齐，否则实现会糊）

```
observation  观察：源产生的原始输入（一条飞书消息、一次手动触发）
   ↓ 按 source 做去抖/合并（窗口默认 3s）
event        事件：一个窗口内的观察聚合，带 refs（指向落盘的原文）与 digest
   ↓ 按注册表匹配
delivery     投递：一个事件对某个会话的一次 prompt 调用
```

- 一个 event → **0..N 个 delivery**。
- 一个 delivery 只对**一个** sessionId。
- **事件正文永不进 prompt**；prompt 里只放路径 + 条数 + 摘要（指针原则）。

---

## 4. 存储（位置固定）

目录：`~/.dsh/session-bus/`

| 文件 | 内容 | 变化频率 |
|---|---|---|
| `agents.json` | 会话身份 + 长期订阅 + allowInterrupt/allowAbort/memoryPool | 低 |
| `waiting.json` | 短期等待项（一次性，带 TTL） | 高 |
| `settings.json` | 护栏与投递设置 | 低 |
| `deliveries.jsonl` | 投递审计日志，只追加 | — |
| `state/recent.jsonl` | 最近投递记录（发送/接收卡片与 `bus_recent` 用；正文 ≤ 4000 字） | 高 |
| `state/registry.jsonl` | 注册表变更审计（`bus_register` / admin） | 低 |

**为什么拆 `agents` / `waiting` 两张表**：身份几乎不变，等待项几分钟就变；
混在一起会互相覆盖。

### 4.1 `agents.json`

```json
{
  "version": 1,
  "agents": [
    {
      "sessionId": "session-07bed3e8-a620-4a28-9904-b552335d2d1c",
      "name": "大肥鱼",
      "role": "常驻陪伴 + 工具维护 + 记忆整理",
      "knows": ["voice-mode 插件", "飞书桥", "本机记忆系统", "Notion 接入"],
      "allowFrom": ["*"],
      "allowInterrupt": true,
      "allowAbort": false,
      "memoryPool": "G:\\liveDeepSeek\\memory\\大肥鱼\\",
      "enabled": true,
      "subscriptions": [
        {
          "id": "sub-01",
          "source": "feishu",
          "match": { "ownerOnly": true, "textContains": ["鲸鱼", "小回"] },
          "template": "飞书收到 {count} 条相关消息，见 {inboxPath}。先读文件再决定要不要回。",
          "cooldownSeconds": 30
        }
      ],
      "updatedAt": "2026-11-09T18:40:00+08:00"
    }
  ]
}
```

### 4.2 `waiting.json`

```json
{
  "version": 1,
  "waiting": [
    {
      "id": "wait-01",
      "sessionId": "session-07bed3e8-...",
      "reason": "等主人发的那张参考图",
      "source": "feishu",
      "match": { "ownerOnly": true, "type": "image", "textContains": ["大肥鱼"] },
      "createdAt": "2026-11-09T18:40:00+08:00",
      "expiresAt": "2026-11-09T19:10:00+08:00",
      "consume": "once"
    }
  ]
}
```

- `expiresAt` 到期后自动清除（插件每 60s 扫一次）。
- `consume: "once"` = 命中一次即删除。默认 `once`。
- `textContains` 可选：`[]` 或缺失时只按 `type + ownerOnly` 匹配。

### 4.3 `deliveries.jsonl`

一行一条：

```json
{"at":"2026-11-09T18:41:03+08:00","eventId":"evt-...","sessionId":"session-...","hop":0,"ok":true,"reason":null}
```

字段：`at` / `eventId` / `sessionId` / `hop` / `ok` / `reason`（失败原因码）。

---

## 5. 匹配规则（event → delivery）

### 5.1 候选来源

一个事件同时匹配**两类**注册：

1. `agents[].subscriptions[]` —— 长期订阅
2. `waiting[]` —— 短期等待项

两者**都参与匹配**，命中的都投递。

### 5.2 match 判据

| 字段 | 语义 |
|---|---|
| `any: true` | 无条件匹配（谨慎使用） |
| `ownerOnly: true` | 只匹配 owner 发来的 |
| `type` | `"message"` / `"image"` / `"file"` |
| `textContains: [..]` | **任一**命中即可（不是全部） |
| `regex` | 高级用法，UI 里折叠 |
| `from` | 指定发送者 id |
| `withinSeconds` | 只匹配最近 N 秒内的事件（等待项里一般不需要，TTL 已覆盖） |

**未提供的字段 = 不限制。**

### 5.3 一条事件匹配多个会话

**不同会话全部投递。** 每个会话各自串行（同会话并发会撞 `session/writer-held`），
会话之间可并行。

**同一 event 对同一 `sessionId` 最多投递一次**：多规则（等待项 + 订阅）命中同一会话时，
按优先级只取第一个命中者——等待项优先于长期订阅；同类型按创建时间早的优先。
被合并掉的规则不消费（等待项保留到下一次事件）。

**但受 7.x 的限流约束。**

### 5.4 模板变量

模板字符串里可用的占位符：

```
{count}       匹配到的观察条数
{inboxPath}   落盘目录或文件路径
{source}      事件源，如 feishu
{sender}      发送者显示名
{firstText}   第一条观察的正文前 50 字
{time}        投递时间 HH:MM
{eventId}     事件 id
```

**默认安全约束**：模板里**不建议**放 `{fullText}`。
若某订阅确实要全文，必须显式写 `{fullText}`——让"吃 token"是个可见的选择。

---

## 6. 投递（delivery）

### 6.1 固定前缀

每次投递的正文**必须**自动带上来源 / 目的地 / 时间：

```
[session-bus | feishu → 大肥鱼 | image | 18:40]
<模板渲染后的正文>
```

前缀格式固定为 `[session-bus | <source> → <name> | <type> | <HH:MM>]`，
开头的 `session-bus` 是**通道标记**——收到方能一眼分清这是总线路由的消息还是人在说话，
并且知道自己可以用 `bus_deliver` 回。
实现里由插件拼接，**不允许订阅自己覆盖前缀**。

### 6.2 prompt 调用

```ts
const sc = ctx.get('sessionController')
const ac = new AbortController()          // signal 必传
await sc.prompt({
  requestId: <uuid>,
  sessionId: <目标>,
  mode: 'queue',                          // 永远 queue，不用 steer
  content: [{ type: 'text', text: <前缀 + 正文> }]
}, ac.signal)
```

**实测到的前置条件（必须满足，否则报错）：**

- `signal` 必传（内部第一行就 `signal.throwIfAborted()`）
- `content` 必须含非空白 text 或 attachment，否则 `gateway/bad-request`
- `mode` 只能是 `queue | steer`
- `requestId` 必填
- `clientTimeZone` 若传，必须是 UTC 或合法 IANA 名
- **subagent 会话会被拒绝**
- 同会话并发 → `session/writer-held`；会话不存在 → `session/not-found`

### 6.3 `accepted` 不等于成功

`prompt()` 返回 `accepted: true` 只表示**入队**。

若要"投递成功"的语义，需要再：

```ts
await ctx.sessions.flush(agent.session)
```

**本规格要求：审计日志里 `ok:true` 只有在 flush 之后才写**（或记录 `accepted` 与 `flushed` 两个字段）。

---

## 7. 护栏

### 7.1 跳数（防乒乓）

- 投递消息里带 `hop` 计数（存在 `deliveries.jsonl` 与内部上下文）。
- **超过 `maxHop`（默认 3）拒绝投递**，审计日志记 `reason: "hop-exceeded"`。
- 设置页可改 `maxHop`。

### 7.2 频率

- 全局：**每分钟最多 `maxPerMinute` 次投递**（默认 10），超出则排队或丢弃（策略见 7.5）。
- 单会话：**最短间隔 `minIntervalMs`**（默认 5000ms）。
- 设置页可改。

### 7.3 TTL

- `waiting[]` 项默认 1800s 过期，可在创建时覆盖。
- 插件每 60s 扫一次，过期即删并记审计。

### 7.4 权限

**默认全放开：`allowFrom` 缺省（或 `["*"]`）= 任何会话都能投给我。**

理由：本机单人单机，白名单拦的不是恶意，只是误投；而误投已经由 §7.1 跳数、§7.2 频率、
§7.3 TTL 三道兜住。加白名单只会制造摩擦（实测撞过一次 `permission-denied`：会话 A 想回
B，B 没放行 A，回信无路）。

**字段保留，供个别会话自己收紧**：

- `["*"]` 或缺失 = 谁都能投（默认）
- `["owner"]` = 只接受人类 / 外部 owner 事件
- `[sessionId, ...]` = 显式白名单

**不做动态授权**：「收到过 X 的消息就给 X 一次回投许可」这种规则不实现——默认已经放开，
这个洞不存在；需要收紧的会话自己写显式白名单即可。

判定顺序（实现口径）：`allowFrom` 缺失 / 空数组 / 含 `"*"` → 一律放行；否则只有显式
匹配才放行（owner 消息看列表是否含 `"owner"`，会话消息看列表是否含来源 sessionId）。

### 7.5 队列与丢弃

超频时的策略，按顺序：

1. 同一事件对同一会话只投一次（天然去重）
2. 超过 `maxPerMinute` → 进内存队列，最长等待 60s
3. 仍不能投 → 丢弃，审计日志 `reason: "rate-limited"`，并在设置页高亮

### 7.6 启动校验

插件加载时：

1. 扫 `waiting.json`，把 `expiresAt` 已过期的清掉（审计 `ttl-expired`）
2. 对仍有效的等待项，用 `workspaceRegistry.archivedSessionIds` 校验会话是否已归档；
   已归档的标 `stale: true` 并保留 24h 再删（审计 `stale-removed`）。冷会话不在内存里是
   正常状态，**不**据此标 stale
3. **不删用户没让它删的东西**，只标记

### 7.7 并发

- 插件内**一把全局写锁**，串行化对 `agents.json` / `waiting.json` 的读改写。
- 投递按 sessionId 分锁，同会话串行。

---

## 8. 对外接口

### 8.1 HTTP 路由（给外部进程，如飞书桥）

前缀 `/api/session-bus`。**只接受 loopback**，带共享 token（`x-bus-token`）。

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/signal` | 外部事件进来：`{source, kind, from, text, attachments[], meta}`。返回 eventId 与匹配到的 delivery 数 |
| POST | `/deliver` | 直接投递（跳过匹配）：`{sessionId, text}` |
| GET | `/agents` | 列出已注册会话 |
| GET | `/waiting` | 列出等待项 |
| GET | `/log?limit=50` | 最近的投递审计 |

**鉴权**：loopback + token。接飞书时升级为 HMAC 签名 + 时间戳防重放（P1）。

### 8.2 会话侧工具（给 agent）

必须提供这七个工具，名字固定（`bus_list_agents` 已改名为 `bus_peers`）：

| 工具 | 入参 | 用途 |
|---|---|---|
| `bus_register` | `{sessionId?, originalSessionId?, name?, role?, knows?, memoryPool?, allowFrom?, allowInterrupt?, allowAbort?, enabled?, reason?, force?}` | 注册/修改会话记录；省略 sessionId 即改自己；改别人仅元数据，权限字段/改名需 force+reason；审计写 registry.jsonl |
| `bus_peers` | 无 | 列出所有注册会话（status / pendingWaits / pendingMessages / memoryPool / allowFrom / allowAbort） |
| `bus_deliver` | `{sessionId, text, mode?, kind?, ref?, reason?, resumeHint?, hop?}` | queue / steer / abort 投递；返回 agentStatus / inboxCount / merged / packed |
| `bus_recent` | `{sessionId?, limit?}` | 按 blockId 查自己发过的消息：pending / taken / unknown |
| `bus_wait_for` | `{source, match, reason, ttlSeconds?, consume?}` | 登记一个等待项 |
| `bus_list_waiting` | 无 | 看自己在等什么 |
| `bus_clear_waiting` | `{id?}` | 清掉等待项（不传 id = 清自己的全部） |

**`bus_peers` 是「身份信息的读者是 AI」这条需求的落地**——让会话能决定"这活派给谁"。

UI 侧（Client 半部）：接收方把唤醒型消息渲染成左侧「来自会话 X」气泡；发送方在回合末显示「已发送 N 条」卡片；运行中插入的 steer 消息在接收方回合末显示「本轮收到 N 条插入」回执卡（DSH 不把运行中 claim 的消息画成独立气泡）。

### 8.3 设置页

独立 section（`settings.section`，参考 voice-mode 的做法），四块：

**① 注册会话列表 —— 完整 CRUD**

```
┌ 事件订阅 ────────────────────────────────────────────┐
│ ● 大肥鱼      [常驻陪伴]   feishu:ownerOnly   等 1 项  [编辑][停用][删除]
│ ● Wiki维护者   [文档维护]   feishu:"wiki"      等 0 项  [编辑][停用][删除]
│ ○ 游戏开发     [已停用]                                [编辑][启用][删除]
│                                                      [+ 新建会话注册]
└──────────────────────────────────────────────────────┘
```

- **新建与编辑共用同一个表单**（RS 明确要求「新建和编辑应该可以整一块」）
- 表单字段：`name` / `sessionId` / `role` / `knows[]` / `allowFrom[]` / `enabled` / 长期订阅（P2 才做）
- **删除必须二次确认**（显示会话名，不是 id）
- 停用的置灰、**不隐藏**——隐藏会让人以为自己没注册
- 列表项要显示「等 N 项」的实时计数

**② 等待项**

```
大肥鱼 · 等主人发的参考图 · 剩 24 分钟 · [清除]
Wiki维护者 · 等 wiki 相关文件 · 剩 3 分钟 · [清除]
```

- 支持单条清除
- 过期 / stale 的项单独标灰，24h 后自动清

**③ 护栏参数**

```
相互唤起最大跳数      [3]
每分钟最多投递        [10]
单会话最短间隔        [5s]
等待项默认 TTL        [1800s]
```

**④ 最近投递（折叠区）**

读 `deliveries.jsonl` 尾部 50 条，显示：时间 / 来源 → 目的地 / 事件类型 / 成功与否 / 失败原因。

---

## 9. 落地步骤（建议分期）

### P0（先把主链跑通）

1. 插件骨架 + 路由注册（**必须 `ctx.inject(['webServer'], …)`**，直接 `ctx.webServer` 会报
   `cannot get property "webServer" without inject`）
2. `agents.json` / `waiting.json` 读写 + 全局写锁
3. `/deliver` 路由 → `prompt()` → `flush()` → 审计
4. `/signal` 路由 → 简单匹配（`ownerOnly` / `type` / `textContains`）→ 投递
5. 会话侧工具：`bus_deliver` / `bus_wait_for` / `bus_peers`
6. 护栏：TTL + 跳数 + 单会话串行

### P1

7. 设置页 UI（三块）
8. 频率限制 + 队列
9. `/signal` 的去抖合并（3s 窗口）
10. 启动校验 / stale 标记
11. 飞书桥侧改造：收到消息 POST `/signal`（桥那边只加十几行）

### P2

12. HMAC + 时间戳防重放
13. `agents.json` 的 `subscriptions` 长期订阅（P0 只做 waiting，也能跑）

---

## 10. 验收（必须实跑，不接受"应该能用"）

| # | 动作 | 判据 |
|---|---|---|
| 1 | 会话 A 调 `bus_wait_for({source:"feishu", type:"image"})` | `GET /waiting` 能看到这条，带 expiresAt |
| 2 | curl 打 `/signal` 模拟一张飞书图片 | 返回 eventId 且 `delivered >= 1` |
| 3 | 目标会话里 | **真的出现**带 `[session-bus \| feishu → X \| image \| HH:MM]` 前缀的消息 |
| 4 | 目标会话调 `bus_clear_waiting()` | `GET /waiting` 里该条消失 |
| 5 | 等 TTL 过期（可设 10s 测） | 自动清除，`/log` 有记录 |
| 6 | 会话 A 调 `bus_deliver` 给 B | B 里出现消息，前缀 `[session-bus \| <A> → <B> \| session \| HH:MM \| kind=…]`；UI 侧显示为来源气泡/卡片 |
| 7 | 构造 hop = maxHop 的投递 | 被拒，`/log` 记 `hop-exceeded` |
| 8 | 同一会话 1 秒内投两次 | 第二次等待或被限流，不报 `writer-held` 给用户 |
| 9 | 会话数前后对比 | **不产生新会话** |
| 10 | 坏 token / 非 loopback | 401 / 拒绝 |
| 11 | **（P1）** 设置页新建一条注册 → 编辑它 → 停用 → 删除 | 每一步后 `GET /agents` 立刻反映；删除有二次确认；停用的项置灰但仍在列表里 |

---

## 11. 环境与已知坑（务必照抄，别重新踩）

- DSH 桌面端 **0.2.1-rc.5**，profile = `desktop`。
- profile 目录：`~/.dsh/profiles/desktop/`
- **装插件用 `plugin_manager install_bundle`**（写 profile 的 `package.json` bundles 列表），
  **不是改 `cordis.patch.yml`**。实测**即时应用，不用重启**。
- 插件目录建议：`./`，profile 里用 `link:` 引用。
- 参考现有探针：`（本机探针实现，未随本仓库发布）`（同一个 env、同一套路由注册方式）。
- **写文件禁止用 PowerShell 的 `Set-Content -Encoding UTF8`**（会加 BOM，`JSON.parse` 直接抛
  `Unexpected token '﻿'`，本机已炸两次）。用 node `fs.writeFileSync(p, t, 'utf8')`
  或 `[IO.File]::WriteAllText(p, t, [Text.UTF8Encoding]::new($false))`。
- 桌面 Host 的 origin 由 `ctx.webServer.getOrigin()` 取（探针实测 `http://127.0.0.1:64294`，
  **端口每次重启会变，不要写死**）。
- 不要动现有插件：`voice-mode` / `dsh-ultimate-tower` / `dsh-whale-widget` / `dsh-probe-prompt` /
  `mcp-*` 那几条 insert。
- 装前备份 profile 的 `package.json` 与 `cordis.patch.yml`。

---

## 12. 回滚

```powershell
# 在 DSH 会话里
plugin_manager remove_bundle dsh-session-bus
# 手动清理
Remove-Item '~/.dsh/session-bus' -Recurse -Force
# 桥侧：删掉 /signal 那几行
```

---

## 13. 参考

- ADR-006：`decisions.md（ADR-006）`（外部事件唤醒走 Host 插件进程内投递）
- 探针实现：`（本机探针实现，未随本仓库发布）`
