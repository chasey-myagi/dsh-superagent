# 本地 dogfood（fork 专用）

工作区：`/workspace/dsh-superagent-ws/{dsh-superagent,memory-explore}`，profile `superagent`（`~/.dsh/profiles/superagent`，含 dsh-memory bundle）。

## 启动与停止

模型 key 放在 `~/.dsh/env-genesis.sh`，由服务脚本在 tmux pane 里 source：

```sh
export DSH_SUPERAGENT_ENV_FILE=~/.dsh/env-genesis.sh   # 不设则不 source
scripts/dsh-superagent start      # 启动并等待健康检查
scripts/dsh-superagent status     # JSON：pids / health / errors / setup / manually_stopped
scripts/dsh-superagent stop       # 优雅停止，最多等 Executor 跑完当前步骤 5 分钟
scripts/dsh-superagent restart
```

- `start` 在 tmux 会话 `dsh-superagent`（其他 profile 为 `dsh-<profile>`）里运行 `dsh --profile superagent --no-open`，默认等 180 秒；用 `--timeout` 或 `DSH_SUPERAGENT_START_TIMEOUT` 调整。
- `stop` 只发 SIGINT 并等待，不强制 kill，也不碰其他 tmux 会话；`--stop-timeout` 控制等待上限。`stop` 会写 `manually-stopped` 标记，自动恢复（带 `--respect-stop` 的巡检）在下次 `start`/`restart` 前不再拉起；`start` 会清掉标记。
- `status`、`start`、`restart` 的退出码：0 正常；1 没跑、跑了两个、不响应或 runtime 报错；2 其他组件（Source、Policy sync 等）报错，重启不解决；3 等待 setup，或 `start` 超时但进程还活着。完整语义见 [docs/006-deployment.md](006-deployment.md) 的 Start and stop。
- `--profile`、`--url`，或 `DSH_SUPERAGENT_PROFILE`、`DSH_SUPERAGENT_URL`，用于别的 profile / 端口。
- 日志在 `.artifacts/dsh-superagent-superagent-*.log`（保留最新 20 份）；`service.pid`、`manually-stopped` 在 `.artifacts/control/profiles/superagent/`。

`DSH_SUPERAGENT_ENV_FILE` 指向一个 shell 文件，启动时在 pane 内先 `. <file>` 再 `exec dsh`，所以 key 只进这个 pane 的环境，不进 tmux 全局环境。变量要在执行 `start` 的 shell 里导出；不设置就不 source，模型 key 需要另放进 pane 的环境。

## Node 24 的 ps ucomm=MainThread（已修复）

历史问题（fork #6 之前）：Node 24 会把主线程名写进 `ps` 的 `ucomm`，`dsh` 启动的进程显示为 `MainThread` 而不是 `node`。旧脚本只按 `ucomm in (node, dsh)` 找服务，于是：

- `start` 找不到已在跑的服务，等满 180 秒后误报 `No dsh-superagent process is running: startup failed`，而 :3082 实际正常；
- `stop` 找不到进程，旧实例和 tmux 会话残留，后续 `start` 被挡；
- `status` 的 `pids` 为空，但健康检查有响应。

修复：`serves()` 除了 `ucomm`，也接受命令行的程序名（`args[0]` 的 basename 为 `node`/`dsh`），并在测试里用 `MainThread` 的 `ucomm` 覆盖 start、status 与超时路径。

排查：

```sh
# 服务进程（ucomm 可能是 node、dsh 或 MainThread）
ps -ww -ax -o pid=,ucomm=,args= | grep -- '--profile superagent' | grep -v grep
# 用记录的 PID 看
pid=$(cat .artifacts/control/profiles/superagent/service.pid)
ps -ww -p "$pid" -o pid=,ucomm=,args=
# 脚本看到什么；pids 为空但下面能响应，就是识别或 URL 不对
scripts/dsh-superagent status
curl -s -H 'x-orchestrator-request: 1' http://127.0.0.1:3082/orchestrator/api/state | head -c 400
```

`status` 里 `manually_stopped: true` 时，自动恢复会保持停止，手动 `start` 即可恢复。`start` 超时的输出会带最新日志尾部，也可直接看 `.artifacts/dsh-superagent-superagent-*.log`。

面板：http://127.0.0.1:3082 → 侧栏 Superagent。

本地工单源 `scripts/local/gh-local`（模拟 gh，数据在 `~/.superagent-local/db.json`）：
```sh
gh-local new "<标题>" "<正文>" --target memory-explore|dsh-superagent
gh-local comment N "<文字>" ; gh-local show N ; gh-local list
```
设置：source:github `repository=local/dsh-superagent-ws`、`cli=~/.local/bin/gh-local`；policy 允许 `chasey-myagi`，规则 `dogfood-dev`；executor prepare =
`sh scripts/local/prepare.sh`（按工单 target 在对应仓库建 `agent/<name>` worktree）。

已跳过：`tests/sources.spec.ts` 中 Feishu "malformed line" 用例（error 健康态被 ready 覆盖的时序竞争，待上游修）。