# Issue tracker: Local Markdown

本仓库的 specs 与实施 tickets 作为 markdown 文件存放在 `.scratch/` 中，不使用 GitHub Issues 作为日常跟踪面。

## Conventions

- 每个 feature 一个目录：`.scratch/<feature-slug>/`
- Spec 是 `.scratch/<feature-slug>/spec.md`
- Implementation issue 每个 ticket 一个文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 开始编号；绝不要写成一个合并的 tickets 文件
- Triage state 记录为每个 issue file 顶部附近的 `Status:` 行（role 字符串见 `triage-labels.md`）
- Comments 和对话历史追加到文件底部的 `## Comments` heading 下

## When a skill says "publish to the issue tracker"

在 `.scratch/<feature-slug>/` 下创建新文件（必要时创建目录）。

## When a skill says "fetch the relevant ticket"

读取引用路径处的文件。用户通常会直接传入路径或 issue number。

## Wayfinding operations

供 `/wayfinder` 使用。**map** 是一个文件，每个 ticket 对应一个 **child** 文件。

- **Map**: `.scratch/<effort>/map.md`——Notes / Decisions-so-far / Fog body。
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 开始编号，body 中是问题。`Type:` 行记录 ticket 类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **Blocking**: 顶部附近的 `Blocked by: NN, NN` 行。当它列出的每个文件都是 `resolved` 时，ticket 即为 unblocked。
- **Frontier**: 扫描 `.scratch/<effort>/issues/` 中 open、unblocked 且 unclaimed 的文件；按编号第一个胜出。
- **Claim**: 在任何工作开始前设置 `Status: claimed` 并保存。
- **Resolve**: 把答案追加到 `## Answer` heading 下，设置 `Status: resolved`，然后向 `map.md` 中 map 的 Decisions-so-far 追加 context pointer（gist + link）。

## 上游 issue（人工通道，不由 skills 使用）

本仓库是 fork。日常跟踪不走 GitHub；仅当你**明确要求向上游反馈**时，才人工向上游提交 issue：

```bash
gh issue create --repo EthanYoQ/AI-Novel-Writer --title "..." --body "..."
```

必须显式带 `--repo`：本 clone 的 `origin` 是 fork `skywolf123/AI-Novel-Writer`，省略该参数会把 issue 建到 fork 上。当前账号对上游只有 `pull` 权限，无 `triage`/`push`，因此上游 issue 的标签和分流不由本地 skills 处理。
