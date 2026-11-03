# 本地 dogfood（fork 专用）

工作区：`/workspace/dsh-superagent-ws/{dsh-superagent,memory-explore}`，profile `superagent`（`~/.dsh/profiles/superagent`，含 dsh-memory bundle）。

启动：
```sh
export DSH_SUPERAGENT_ENV_FILE=~/.dsh/env-genesis.sh   # 模型 key 在 tmux pane 内 source，不进 tmux 全局环境
scripts/dsh-superagent start|status|stop
```
面板：http://127.0.0.1:3082 → 侧栏 Superagent。

本地工单源 `scripts/local/gh-local`（模拟 gh，数据在 `~/.superagent-local/db.json`）：
```sh
gh-local new "<标题>" "<正文>" --target memory-explore|dsh-superagent
gh-local comment N "<文字>" ; gh-local show N ; gh-local list
```
设置：source:github `repository=local/dsh-superagent-ws`、`cli=~/.local/bin/gh-local`；policy 允许 `chasey-myagi`，规则 `dogfood-dev`；executor prepare =
`sh scripts/local/prepare.sh`（按工单 target 在对应仓库建 `agent/<name>` worktree）。

已跳过：`tests/sources.spec.ts` 中 Feishu "malformed line" 用例（error 健康态被 ready 覆盖的时序竞争，待上游修）。
