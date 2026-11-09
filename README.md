# dsh-session-bus

**Session bus for DeepSeek Harness** — registered intent, event matching, guarded delivery between DSH sessions and external processes.

> DSH 的时间任务只能按时间唤醒，subagent 只在会话内部。这个插件补上缺的那一块：
> **由外部事件唤醒指定会话**，以及**会话之间互相投递**。

---

## 它解决什么问题

DSH 现有的两种"发起"方式都不够用：

| 已有能力 | 边界 |
|---|---|
| `schedule`（定时任务） | 触发源只有 rrule，**只能按时间**唤醒 |
| `subagent` / `teammate` | 会话**内部**的隔离上下文，不是另一个独立会话 |
| `@deepseek-ai/dsh-webhook` | 每个事件**开一个新会话**，不唤醒指定会话 |

这个插件补的是第四种：**外部事件 → 匹配注册表 → 投递给指定的、可能正开着的会话**。

---

## 为什么必须是 Host 插件

这一条是整个项目的地基，先说清楚，省得有人重复踩：

**跨进程接管一个桌面端正打开着的会话，是被明确拒绝的。**

- `SessionAlreadyOwnedError` → `session/writer-held`
- cwd 校验：`session "..." was recorded in "...", not "..."`
- `ctx.sessions.retain()` + `beginSubmission` 是 **Client 侧** API，外部进程拿不到绑定
- cordis 事件总线不跨进程，不能当 IPC

**只有一种位置可行：在桌面 Host 进程内**，调

```js
ctx.get('sessionController').prompt({ requestId, sessionId, mode: 'queue', content: [...] })
```

它内部先 `resolveAgent`——会话开着就用活的 agent，关着就从持久化 resume，**同一个 session、同一份日志**。

完整的排查过程与实测证据见 [SPEC.md](SPEC.md) 与 `docs/decisions.md` 的 ADR-006。

---

## 能力

- **注册表** —— 会话登记自己的身份、职责、知道什么、可被谁唤醒
- **等待项** —— 会话声明"我在等一张飞书图片"，一次性、带 TTL、命中即删
- **事件窗口** —— 外部事件按 `(source, from)` 聚到 3 秒窗口，一个窗口只产生一个 event
- **匹配 + 投递** —— 一个 event 匹配 0..N 个会话，各自投递；消息自动带 `[来源 → 目的地 | 类型 | 时间]` 前缀
- **护栏** —— 跳数、每分钟上限、单会话最短间隔、权限、TTL
- **设置页** —— 注册表 CRUD、等待项、护栏参数、最近投递

---

## 安装

要求：DSH ≥ 0.2.1，Node ≥ 20。

```bash
git clone https://github.com/BeepFlyer/dsh-session-bus.git
cd dsh-session-bus
```

**生成 HTTP 访问 token**（也可用环境变量 `BUS_TOKEN` 覆盖）：

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))" > token.txt
```

**装进 desktop profile**（在 DSH 会话里说一句，或用 `plugin_manager`）：

> 把 `dsh-session-bus` 以 `link:` 方式装进 desktop profile 的 bundles 列表。

**重启 DSH** —— 设置页 UI 需要重新打包进前端；Host 侧改动重载即可。

存储目录默认 `~/.dsh/session-bus/`，可用 `BUS_DIR` 环境变量改。

---

## 快速开始

**1. 让某个会话登记一个等待项**（在该会话里对它说）：

> 调 `bus_wait_for`，登记你在等一张飞书图片，TTL 10 分钟。

**2. 从外部发一个事件**：

```bash
TOKEN=$(cat token.txt)
curl -s -X POST http://127.0.0.1:<端口>/api/session-bus/signal \
  -H "x-bus-token: $TOKEN" -H "content-type: application/json" \
  --data-binary '{"source":"feishu","from":"owner","type":"image","text":"大肥鱼看这张"}'
```

端口从 `ctx.webServer.getOrigin()` 取（每次重启可能变，不要写死）。

**3. 那个会话会收到一条带前缀的消息**，内容由等待项的模板渲染：

```
[feishu → 大肥鱼 | image | 18:40]
主人发来一张图片，已存到 <路径>。处理完记得清掉等待项。
```

---

## HTTP API

仅接受 loopback，需 `x-bus-token`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/session-bus/signal` | 观察入窗（3s），返回 `{observationId, windowClosesAt, windowSize}` |
| POST | `/api/session-bus/deliver` | owner 直接投递 |
| POST | `/api/session-bus/admin` | 脚本用 admin |
| GET | `/api/session-bus/agents` | 注册表（含 waitingCount） |
| GET | `/api/session-bus/waiting` | 等待项 |
| GET | `/api/session-bus/log?limit=50` | 最近投递 |

浏览器设置页走同源 Cookie 栅栏的 `/api/session-bus-admin`，不暴露 token。

---

## 给 agent 的工具

| 工具 | 用途 |
|---|---|
| `bus_list_agents` | 列出所有注册会话（含 role / knows / 等待数） |
| `bus_deliver` | 投递消息给另一个会话 |
| `bus_wait_for` | 登记一个等待项 |
| `bus_list_waiting` | 看自己在等什么 |
| `bus_clear_waiting` | 清掉等待项 |

---

## 护栏

| 项 | 默认 | 说明 |
|---|---|---|
| `maxHop` | 3 | 超过即 `hop-exceeded`，防两个会话乒乓 |
| `maxPerMinute` | 10 | 全局每分钟投递上限 |
| `minIntervalMs` | 5000 | 同一会话最短间隔，**排队不失败** |
| `defaultTtlSeconds` | 1800 | 等待项默认寿命 |
| `allowFrom` | `["*"]` | 缺省全放开；想收紧的会话自己写白名单 |

设计原则：**事件正文永不进 prompt**，只放路径 + 条数 + 摘要。让"吃 token"成为一个可见的选择，而不是默认行为。

---

## 隐私与安全

- 只监听 loopback，不对外提供服务
- token 文件在 `.gitignore` 里，仓库不含任何凭证
- HMAC + 时间戳防重放可选（默认关），开启后 `x-bus-signature = HMAC-SHA256(secret, timestamp + "\n" + rawBody)`
- 投递的消息作为**普通用户消息**进入目标会话——它不能提权，只能触发一轮正常对话

---

## 已知限制

- 只在本机实测（Windows 10 + DSH 0.2.1-rc.5）；理论上跨平台，未验证
- 3 秒窗口是**固定窗口**，不是滑动窗口
- **子代理会话会被拒绝**（`sessionController.prompt` 的限制）
- 设置页 UI 变更需要重启 DSH 才生效（前端要重新打包）
- 未接任何具体的事件源；飞书桥、GitHub 等需要各自 POST `/signal`

---

## 设计文档

- [SPEC.md](SPEC.md) —— 完整规格：名词、存储、匹配、护栏、验收清单
- 背景排查与实测证据见仓库讨论与 DSH 的 `decisions.md`（ADR-006）

---

## 许可

MIT
