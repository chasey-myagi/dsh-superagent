#!/usr/bin/env bash
# Offline self-test for scripts/local/stop-duplicates.
#
# Starts a tiny fake orchestrator API and a fake gh-local, then checks:
#   * --help exits 0
#   * --dry-run matches by title / issue without POSTing
#   * a shared code token (parse_since) is enough to match
#   * unrelated titles do not match
#   * a real run stops the ticket and comments its issue once
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
script="$here/stop-duplicates"
tmp=$(mktemp -d)
server_pid=""

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

command -v python3 >/dev/null 2>&1 || fail "python3 is required"
[ -x "$script" ] || fail "stop-duplicates is not executable"

# 1. Help must work without an orchestrator.
"$script" --help >/dev/null || fail "--help exited nonzero"

# 2. Fake management API with three open tickets.
cat > "$tmp/server.py" <<'PY'
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port_file, request_log = sys.argv[1], sys.argv[2]
TICKETS = [
    {
        "id": "t20",
        "title": "D17: parse_since 容忍 querystring 把 +08:00 解成空格",
        "state": "open",
        "threads": [{"key": "github:20", "source": "github",
                     "facts": {"number": {"value": "#20"}}}],
    },
    {
        "id": "t21",
        "title": "D16: recall 默认 limit/相对截断，真实查询别再轻易返回 20 条",
        "state": "open",
        "threads": [{"key": "github:21", "source": "github",
                     "facts": {"number": {"value": "#21"}}}],
    },
    {
        "id": "t22",
        "title": "D22: merge 后自动 stop 同题竞态工单，避免重复劳动",
        "state": "open",
        "threads": [{"key": "github:22", "source": "github",
                     "facts": {"number": {"value": "#22"}}}],
    },
]

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def record(self):
        with open(request_log, "a", encoding="utf-8") as handle:
            handle.write(f"{self.command} {self.path}\n")

    def reply(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.record()
        if self.path.startswith("/orchestrator/api/tickets?state=open"):
            self.reply({"items": TICKETS, "total": len(TICKETS), "next_offset": None})
        else:
            self.reply({"error": "not found"}, 404)

    def do_POST(self):
        self.record()
        if self.path.startswith("/orchestrator/api/tickets/") and self.path.endswith("/stop"):
            self.reply({"stopped": True})
        else:
            self.reply({"error": "not found"}, 404)

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
with open(port_file, "w", encoding="utf-8") as handle:
    handle.write(str(server.server_address[1]))
server.serve_forever()
PY

python3 "$tmp/server.py" "$tmp/port" "$tmp/requests.log" &
server_pid=$!
for _ in $(seq 1 100); do
  [ -s "$tmp/port" ] && break
  sleep 0.05
done
[ -s "$tmp/port" ] || fail "fake API did not start"
base="http://127.0.0.1:$(cat "$tmp/port")/orchestrator/api"

# Fake gh-local: record its argv.
cat > "$tmp/gh-local" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "${GH_LOCAL_LOG:?GH_LOCAL_LOG is not set}"
SH
chmod +x "$tmp/gh-local"

# 3. Dry-run by title stops nothing and matches only the D16 ticket.
out=$("$script" --base-url "$base" --dry-run --title "D16: recall 默认 limit" 2>&1)
case "$out" in
  *t21*) ;;
  *) fail "dry-run by title did not match t21: $out" ;;
esac
case "$out" in
  *t20*|*t22*) fail "dry-run by title matched an unrelated ticket: $out" ;;
esac
if grep -q '^POST' "$tmp/requests.log"; then
  fail "dry-run posted a request"
fi

# 4. Dry-run by issue matches the D17 ticket only.
out=$("$script" --base-url "$base" --dry-run --issue 20 2>&1)
case "$out" in
  *t20*) ;;
  *) fail "dry-run by issue did not match t20: $out" ;;
esac
case "$out" in
  *t21*|*t22*) fail "dry-run by issue matched an unrelated ticket: $out" ;;
esac

# 5. A shared identifier token is enough even when Jaccard is low.
out=$("$script" --base-url "$base" --dry-run --title "parse_since 空格处理" 2>&1)
case "$out" in
  *t20*) ;;
  *) fail "shared parse_since token did not match t20: $out" ;;
esac

# 6. Unrelated topic matches nothing.
out=$("$script" --base-url "$base" --dry-run --title "D99 完全无关的天气页面" 2>&1)
case "$out" in
  *"no matching open tickets"*) ;;
  *) fail "unrelated title matched a ticket: $out" ;;
esac

# 7. Real run: stop t21, post no extra stop, comment issue #21 once.
out=$(PATH="$tmp:$PATH" GH_LOCAL_LOG="$tmp/comments.log" \
  "$script" --base-url "$base" --reason "D16 已合并" --title "D16: recall 默认 limit" 2>&1)
case "$out" in
  *"stopped t21"*) ;;
  *) fail "real run did not stop t21: $out" ;;
esac
grep -q '^POST /orchestrator/api/tickets/t21/stop$' "$tmp/requests.log" \
  || fail "real run did not POST the stop endpoint"
[ "$(grep -c '^POST' "$tmp/requests.log")" -eq 1 ] \
  || fail "real run stopped more than one ticket"
[ -f "$tmp/comments.log" ] || fail "real run did not comment the issue"
grep -q '^comment 21 已由合并取代：D16 已合并；已 stop 工单 t21$' "$tmp/comments.log" \
  || fail "issue comment does not describe the replaced work: $(cat "$tmp/comments.log")"

echo "PASS: stop-duplicates self-test"