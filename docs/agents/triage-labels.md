# Triage Labels

Skills 使用五个 canonical triage roles。本仓库的 issue tracker 是 local markdown（`.scratch/`），因此这些 roles 映射为每个 ticket file 顶部 `Status:` 行的取值，而不是 GitHub label。

| Canonical role    | `Status:` 值       | 含义                          |
| ----------------- | ------------------ | ----------------------------- |
| `needs-triage`    | `needs-triage`     | 等待维护者评估                |
| `needs-info`      | `needs-info`       | 等待报告者补充信息            |
| `ready-for-agent` | `ready-for-agent`  | 已完整说明，可由 Agent 接手   |
| `ready-for-human` | `ready-for-human`  | 需要人工实现                  |
| `wontfix`         | `wontfix`          | 不纳入实现                    |

Category role（`bug` / `enhancement`）写入同一区域顶部的 `Category:` 行。

每个已完成 triage 的 ticket 应同时具有一个 category 和一个 status。不得同时保留多个 status；冲突时先指出并询问维护者，再做其他事。

当某个 skill 提到 role（例如 “apply the AFK-ready triage label”）时，写入此表中间列对应的 `Status:` 值。这就是本仓库的实际 vocabulary——不要改用 GitHub labels，也不要在上游仓库创建这些 label。
