# dsh-workspace-progress

DSH（DeepSeek Harness）的**工作区级跨 Session 进度同步插件**。同一工作区里的多个 Session 自动共享一份基于真实执行证据的进度，新 Session 第一次进入模型时自动获得最新的低 token 摘要，不需要人工复制上下文。

- 默认 **0 次额外 LLM 调用**
- 注入摘要默认 **≤ 800 tokens**
- 原始事件日志、Session 状态与展示文件分离；**不写原始工具输出**
- 面向 Windows 的文件锁与原子替换实现，macOS/Linux 同样可用

验证环境：DSH Desktop `0.2.2-rc.1`（Windows 11，Node 24）。

---

## 解决的问题

同一个项目常常由多个 Session 分工：A 写代码、B 跑测试、C 做论文/调研、D 审查。DSH 各 Session 上下文独立，于是：

- 新 Session 重复调查已经解决的问题；
- 不同 Session 对项目状态理解不一致；
- 已完成任务被重复执行；
- 重要实验结论、技术决策没有传递；
- 用户手工复制其他 Session 的进度。

本插件把「Session 事件」变成「可追溯的事实」，再聚合成两份文件（`progress.md` 与 `summary.md`），并在新 Session 的首个模型步骤注入摘要。

---

## 安装

### 方式一：Plugin Manager（推荐）

```text
plugin_manager install_bundle  target = <本目录绝对路径>
```

安装后写入当前 profile 的 `cordis.patch.yml`，约 1 秒生效，不需要重启 DSH。

### 方式二：手动加入 profile

在 `cordis.patch.yml` 中追加：

```yaml
- insert:
    - id: workspace-progress
      name: dsh-workspace-progress
      config:
        enabled: true
        inject: true
        summaryMaxTokens: 700
```

并确保 profile 的 `package.json` 依赖指向本目录（`link:` 或 `file:`）。

### 卸载

```text
plugin_manager remove_bundle  target = dsh-workspace-progress
```

或删除对应 patch 行。卸载后 DSH 的会话、工具与日志行为恢复原样；已生成的 `.dsh/progress` 文件保留，可手动删除。

---

## 使用方式

日常**不需要任何操作**：

1. 在项目目录里用 DSH 正常工作；
2. 每个 `turn/end` 后自动落盘；
3. 空闲 5 秒后重算并刷新 `progress.md` / `summary.md`；
4. 同工作区的新 Session 在第一步自动收到摘要（每个 Session 只注入一次）；
5. 需要细节时，模型或人直接读 `.dsh/progress/progress.md`。

### 斜杠命令

| 命令 | 作用 |
| --- | --- |
| `/progress` | 查看当前工作区摘要 |
| `/progress sync` | 强制重扫当前 Session 并重算 |
| `/progress refresh` | 重新生成 `progress.md` / `summary.md` |
| `/progress note <文本>` | 记录一条技术决策（进入「关键技术决策」） |
| `/progress on` / `off` | 启用 / 关闭该工作区（关闭后不再写文件） |
| `/progress archive` | 归档超过保留期的 Session 记录 |
| `/progress path` | 显示路径与注入状态 |

---

## 数据目录

```text
<project>/.dsh/progress/
├── config.json          # 工作区级开关（/progress on|off），可选
├── progress.md          # 人类可读的完整进度（自动生成）
├── summary.md           # 低 token 摘要（自动生成，注入用）
├── meta.json            # 聚合元数据（时间、Session 数、统计）
├── .gitignore           # 默认忽略原始日志与状态
├── sessions/<id>.json   # 每个 Session 的最新状态
├── events/<id>.jsonl    # 每个 Session 的追加事实日志
└── archive/<yyyy-mm>/   # 归档
```

- `sessions/*.json` 是**覆盖式**的最新状态，重复同步不会堆叠历史。
- `events/*.jsonl` 只追加，保留事实来源，可回溯。
- `progress.md` / `summary.md` 是**派生视图**，随时可由前两者重建。
- `.gitignore` 默认忽略 `sessions/`、`events/`、`config.json`、`meta.json`；只有 `progress.md` 与 `summary.md` 可以按需提交。

---

## 工作区识别

- 以 Session 的**有效工作目录**为准（`ctx.workingDirectory.get(session)`），取不到时回退到 `session.header.cwd`。
- Windows 路径做大小写归一与分隔符归一；`~` 只用于展示。
- 发现 `.git` 时以**仓库根**作为项目根：子目录 Session 自动归并；linked worktree 通过 `.git` 文件 + `commondir` 归并到同一仓库，并记录各自分支。
- 可用 `scope` 配置改为 `worktree`（worktree 独立）或 `directory`（只看当前目录）。
- 不依赖 Session 名称。

---

## 采到什么、怎么记

只采集可复核的证据：

| 事件 | 记录内容 |
| --- | --- |
| `tool/call` + `tool/result` | 工具名、成功/失败、文件路径、命令（脱敏、截断）、退出码 |
| `todo_write` | 待办文本与状态（明确标记为「AI 声明」） |
| `turn/end` | 本轮轮次、结束原因、调用/失败/编辑/测试计数 |
| `user/message` | 仅第一条用户消息的首行，作为 Session 目标（脱敏、≤140 字符） |
| `assistant/message` | 默认不采集；开启后只保留 ≤5 条「完成声明」原文摘要，且标注未验证 |

**不记录**：文件内容、工具原始输出、模型推理、完整对话历史。

### 真实性口径

四类状态严格分开，不能互相替代：

1. **AI 声称** → 「AI 声明完成（未独立验证）」；
2. **工具执行成功** → 「文件变更及证据」；
3. **测试命令通过** → 「已验证（有执行证据）」；
4. **任务整体完成** → 本插件**不做**这种自动判断。

失败测试进入「当前阻塞和风险」，不会出现在「已验证」。多 Session 改同一文件时，按各自工具调用分别归属；无法归属的内容不会强行算到某个 Session 头上。

---

## 注入

- 注入点：`agent/pre-step`（waterfall），在 Session 首个模型步骤追加一条 `snapshot` 消息。
- 内容：`summary.md` + 工作区路径 + 完整进度路径 + 真实性说明，总长受 `injectMaxTokens` 限制。
- 每个 Session 默认只注入一次；标记持久化在 `sessions/<id>.json`，恢复 Session 不会重复注入。
- `injectionMode: every-turn` 可改为每轮刷新一次；`off` 关闭注入。
- 注入内容不是历史消息的复制，不会随轮次增长。

---

## 配置

在 patch 行的 `config` 中设置（括号内为默认值）：

| 键 | 说明 |
| --- | --- |
| `enabled` (`true`) | 全局开关 |
| `inject` (`true`) | 是否注入摘要 |
| `injectionMode` (`once`) | `once` / `every-turn` / `off` |
| `summaryMaxTokens` (`700`) | `summary.md` 预算 |
| `injectMaxTokens` (`800`) | 注入消息预算 |
| `idleDebounceMs` (`5000`) | `turn/end` 后合并刷新的延迟 |
| `scope` (`repository`) | `repository` / `worktree` / `directory` |
| `captureUserPrompt` (`true`) | 是否记录 Session 目标 |
| `captureAssistantClaims` (`false`) | 是否记录 AI 完成声明 |
| `maxSessionAgeDays` (`45`) | 聚合时忽略更老的 Session |
| `retainSessionDays` (`30`) | 归档保留期 |

工作区级开关写在 `<project>/.dsh/progress/config.json`，优先级高于全局配置（只能收窄，不会强行打开全局关闭）。

---

## 并发、恢复与失败策略

- **每 Session 独立文件**：`sessions/<id>.json` 与 `events/<id>.jsonl` 只由所属 Session 写，互不覆盖。
- **聚合视图**在目录锁（`mkdir` 原子锁 + 过期接管）内重算并原子替换（临时文件 + `fsync` + 带重试的 `rename`，适配 Windows 的 `EPERM/EBUSY`）。
- **事件游标**：`lastSeq` 持久化在 Session 状态中；插件启动时对 live Session 用 `session.snapshotEvents(lastSeq)` 补齐遗漏事件，重复事件按 seq 幂等丢弃。
- **失败不阻塞**：所有监听器异步执行并捕获异常，只写日志；注入失败时原样放行 `pre-step`。
- **关闭时**：尽力 flush，最多等待 1.5 秒，不阻塞退出。

---

## 隐私

写出前统一脱敏：

- `sk-*`、`ghp_*`、`github_pat_*`、`AKIA*`、`xox*-*`、`AIza*`；
- `Bearer` token；
- `api_key` / `token` / `secret` / `password` / `authorization` 等键值；
- `--token=` 之类的命令行参数；
- 邮箱地址。

命令与文本都会截断，工具输出从不落盘。私钥、环境变量值与文件内容不采集。

---

## 成本

| 项目 | 数值 |
| --- | --- |
| 额外 LLM 调用 | 0 |
| 每 Session 注入 | 1 次，≤800 tokens |
| 每轮磁盘写入 | 1 个 Session JSON + 若干 JSONL 行 |
| 聚合刷新 | `turn/end` 后 5 秒内一次，纯本地计算 |
| 历史回放 | 仅插件启动时对 live Session 补齐一次 |

---

## 已知限制

1. 注入依赖 `agent/pre-step`；DSH 若改变该事件签名需同步更新。
2. 插件首次安装时，历史 Session 只能从**仍在内存中的 live Session** 回放；纯历史（未打开）的 Session 不计入，直到再次打开。
3. 「任务完成」不做自动判定，只呈现证据分级；这是刻意设计。
4. 不做跨机器同步、向量检索、LLM 语义总结（均为后续可选增强）。
5. 工作区聚合默认按 Git 仓库归并 worktree；不同分支共享同一份进度，分支信息单独标注。
6. 没有导出 UI 面板；`progress.md` 即为可提交、可分享的导出物。

---

## 开发与测试

```bash
node --test test/*.test.js
```

测试覆盖：路径与 worktree 识别、脱敏、测试命令识别、证据提取、去重、失败不冒充成功、100 轮 token 预算、并发锁、异常恢复、命令。

```
index.js            引擎：事件、注入、命令、聚合调度
lib/paths.js        工作区与 Git 识别
lib/policy.js       配置、脱敏、token 预算、工具分类
lib/evidence.js     事件 → 事实
lib/state.js        单 Session 状态与去重
lib/aggregate.js    工作区聚合
lib/render.js       progress.md / summary.md / 注入文本
lib/store.js        原子写、目录锁、JSONL、归档
```

## 兼容性

- DSH Desktop `0.2.2-rc.1`（Cordis 4.1）
- Node.js ≥ 22（使用 `node:test`、`fs/promises`）
- Windows 10/11、macOS、Linux
- 零运行时依赖，不启用任何 MCP、数据库或常驻进程

## License

MIT