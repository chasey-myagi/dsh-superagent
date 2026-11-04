#!/bin/sh
# 本地工单 prepare：按工单 target 在对应仓库开 worktree，分支 agent/<name>。在执行根目录下由 sh 运行。
# D18：worktree 与主仓隔离——主仓工作区在 prepare 后只读，避免 worker 按绝对路径改脏主仓。
set -eu
exec 2>>"${HOME:-/tmp}/.superagent-local/prepare.log"; echo "--- $(date) $*" >&2; env | grep -E "^(PATH|HOME|GIT|DSH_)" >&2
WS=${DSH_SUPERAGENT_WS:-/workspace/dsh-superagent-ws}
target=$(gh-local target "${DSH_SUPERAGENT_GITHUB_NUMBER:?}" 2>/dev/null || echo memory-explore)
repo="$WS/$target"; [ -d "$repo/.git" ] || repo="$WS/memory-explore"
base=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
# 串行化：并发 worktree add 会抢 git 锁（DOGFOOD D8）
exec 9>"$repo/.git/superagent-prepare.lock"; flock 9
git -C "$repo" worktree add -b "agent/${DSH_SUPERAGENT_NAME:?}" "${DSH_SUPERAGENT_DIR:?}" "$base"
# 标记：仅此目录可写（worker 提示与隔离测试用）
printf 'superagent-worktree=1\ntarget=%s\nmain=%s\n' "$target" "$repo" >"$DSH_SUPERAGENT_DIR/.superagent-worktree"
# 主仓工作区只读（跟踪文件）；.git 仍可更新 refs。运营合并前需 scripts/local/unlock-mains.sh
bash "$(dirname "$0")/protect-mains.sh" "$repo" || true
echo "prepared $DSH_SUPERAGENT_DIR from $repo@$base (main working tree protected)"
