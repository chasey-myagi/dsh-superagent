#!/bin/sh
# 本地工单 prepare：按工单 target 在对应仓库开 worktree，分支 agent/<name>。在执行根目录下由 sh 运行。
set -eu
exec 2>>"${HOME:-/tmp}/.superagent-local/prepare.log"; echo "--- $(date) $*" >&2; env | grep -E "^(PATH|HOME|GIT)" >&2
WS=${DSH_SUPERAGENT_WS:-/workspace/dsh-superagent-ws}
target=$(gh-local target "${DSH_SUPERAGENT_GITHUB_NUMBER:?}" 2>/dev/null || echo memory-explore)
repo="$WS/$target"; [ -d "$repo/.git" ] || repo="$WS/memory-explore"
base=$(git -C "$repo" rev-parse --abbrev-ref HEAD)
# 串行化：并发 worktree add 会抢 git 锁（DOGFOOD D8）
exec 9>"$repo/.git/superagent-prepare.lock"; flock 9
git -C "$repo" worktree add -b "agent/${DSH_SUPERAGENT_NAME:?}" "${DSH_SUPERAGENT_DIR:?}" "$base"
echo "prepared $DSH_SUPERAGENT_DIR from $repo@$base"
