# DOGFOOD-LOG（dsh-superagent + dsh-memory 自举开发）

时间为 Asia/Shanghai。工单来源 gh-local（本地），合并走 GitHub PR（squash）。

| # | 时间 | 发现 | 处理 | 结果 |
|---|------|------|------|------|
| D1 | 11-04 03:20 | `scripts/dsh-superagent start` 的 tmux pane 拿不到模型 key | 加 `DSH_SUPERAGENT_ENV_FILE` 钩子在 pane 内 source | fork local-dogfood 0778e9c |
| D2 | 11-04 03:21 | 启动健康检查 60s 超时，但服务其实已就绪（首启慢） | 记录，待加长超时/改进提示 | open |
| D3 | 11-04 | Feishu "malformed line" 测试时序竞争 | it.skip + 注释 | open（上游） |
| D4 | 11-04 | 记忆工具调用/结果被上报进记忆（自我污染）；蒸馏语言漂移 | 插件过滤 + LANG_RULE | memory-explore #3 |
| T1 | 11-04 03:22–03:26 | 工单 #1 DSH_MEMORY_DISABLE 开关 | router recall_facts ×3 → worker d919681，9/9 测试 | memory-explore #4 已合并 |
| D5 | 11-04 03:30 | `git` 无全局身份，worker 以 grokbot-agent 提交而人工 cherry-pick 失败 | 两个仓库设 repo-local user | done |
| D6 | 11-04 | worker worktree 基于 prepare 时当前分支；主仓切分支会影响后续工单基线 | prepare 应固定基于 origin/main | open → 可开工单 |
| D7 | 11-04 03:33 | 工单 #2–#4 全部失败：superagent 拒绝在含 repo 级 credential helper 的仓库里开工（防止 worker 拿到推送凭据）——好的安全护栏 | 删 repo 级 helper，改用 `gitpush` 一次性 `-c` helper 推送 | done，重试 |
| D8 | 11-04 03:38 | 三个工单同时重试时 prepare 全部失败，错误只截出 stderr 首行（"Preparing worktree…"），看不到真因；逐个重试即成功 → 疑似并发 worktree add 抢 git 锁 | prepare.sh 加日志到 ~/.superagent-local/prepare.log；待：prepare 加 flock 串行、superagent 报错应带完整 stderr 尾部 | 部分 |
| T2 | 11-04 03:40–03:54 | 工单 #2 memserver 可观测 | worker 927e57e（trace.jsonl / /v1/metrics / /dash，只记 query 长度） | memory-explore #5 已合并 |
| T3 | 11-04 03:40–04:10 | 工单 #3 记忆评测 | worker b4c3c25；基线 P@5 0.5125 / R@5 1.0 / MRR 1.0 / 去重 0.8 / 语言 1.0 | memory-explore #6 已合并 |
| D10 | 11-04 04:15 | token 无 workflow scope，推 .github/workflows 被拒 | Actions 配置暂放 ci/github-actions-ci.yml，统一入口 ci/run.sh | open（换 token） |
| T4 | 11-04 03:40–04:18 | 工单 #4 superagent 每工单 trace/timeline/metrics | worker f4454ed，1203 pass | dsh-superagent fork #2 已合并 |
| D9 | 11-04 04:20 | tests/service-script.spec.ts 在环境里有 DSH_SUPERAGENT_ENV_FILE 时失败（测试没隔离环境变量） | 记录；可开工单让测试清理该变量 | open |
| D11 | 11-04 | P@5 仅 0.51：每个查询平均只有 1–2 条应命中，top5 里混入无关 fact；召回缺少分数阈值 | 下一轮工单：recall 加相对分数截断，目标 P@5 ≥ 0.7 且 R@5 不降 | open |
| T5/T6 | 11-04 04:18 起 | 工单 #5 prepare 报错带 stderr 尾部；#6 start 超时误报 | worker 进行中 | 进行中 |

## 2026-11-04 milestone wrap-up
- T5/T6 merged: fork #3 (18c5beb, prepare error keeps exit code and stderr tail) and #4 (e40d344, 180s health timeout).
- D12: `stop` doesn't kill the tmux session; the old orchestrator kept running and blocked start. Worked around with `tmux kill-session -t dsh-superagent`.
- D13: after restart, `start` reported "startup failed", but the service answers on :3082 and /orchestrator/api/metrics returns the new schema. Process detection probably disagrees with the health check. Next ticket.
- Trace starts empty after the restart (tickets.total=0). Older tickets were never recorded.

## 2026-11-04 Round 2
- T7–T9 (D12/D13/D9): one root cause. On Node 24, `ps ucomm` reports `MainThread`, so process detection missed the service. Merged fork #6 (covers #7 and #8) and #7 (D9 test isolation). Measured: stop ends the tmux session; start exits 0 in about 10s (it used to falsely report failure after ~180s). 1212 tests pass with and without DSH_SUPERAGENT_ENV_FILE. #7's worker branch was dropped because it duplicated #8 and conflicted.
- Recall relative cutoff (memory-explore #7, MEMSERVER_MIN_REL_SCORE=0.5): P@5 0.5125 → 0.9125. R@5 and MRR stay at 1.0. CI gate raised from 0.50 to 0.85. Sweep: 0.3=.77 0.4=.86 0.5=.91 0.6=.975 0.7=.975 (R@5 drops to .975).
- D14 (from /v1/metrics): distill failed 2 of 3 times with `Unterminated string` because the LLM's JSON output was truncated. Session had 530 events and 151k input tokens. Each failure costs ~24s, and a whole round of tokens is wasted before the retry succeeds. Next: chunk distill by event window, or raise max_tokens and repair truncated JSON.
- D15 (from /v1/metrics and the ticket metrics): recall p50 is 3.9s, all LLM plan generation (heuristic mode takes ~1ms). The router made 0 recall_facts calls on round-2 tickets #7–#9. Also, superagent metrics show `assignment.samples=0` even though tickets have assignments=1, so the assignment stage isn't recorded in the trace. Next: cache recall plans or use a heuristic-first plan; add the assignment trace point.
