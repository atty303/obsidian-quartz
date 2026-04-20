#!/usr/bin/env bash
set -euo pipefail

pattern='Fully synced'
debounce='5'
action_cmd=''
watch_cmd=''

usage() {
  cat >&2 <<'EOF'
usage:
  watch.sh [-p pattern] [-d debounce_sec] --action 'cmd...' --watch 'cmd...'
EOF
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p) pattern="$2"; shift 2 ;;
    -d) debounce="$2"; shift 2 ;;
    --action) action_cmd="$2"; shift 2 ;;
    --watch) watch_cmd="$2"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$action_cmd" ]] || usage
[[ -n "$watch_cmd" ]] || usage

child_pid=""
timer_pid=""
pending=0
in_ready_burst=0
stop_requested=0

run_action() {
  echo "[trigger] $(date)" >&2
  bash -c "$action_cmd"
}

cancel_timer() {
  if [[ -n "${timer_pid:-}" ]]; then
    kill "$timer_pid" 2>/dev/null || true
    wait "$timer_pid" 2>/dev/null || true
    timer_pid=""
  fi
}

schedule_timer() {
  cancel_timer
  (
    sleep "$debounce"
    exit 0
  ) &
  timer_pid=$!
}

shutdown() {
  stop_requested=1
  cancel_timer
  if [[ -n "${child_pid:-}" ]]; then
    kill -TERM "$child_pid" 2>/dev/null || true
  fi
}

trap 'shutdown' TERM INT HUP QUIT

coproc WATCH { exec bash -c "$watch_cmd"; }
child_pid=$WATCH_PID
echo "Started $watch_cmd with PID $child_pid" 1>&2

while :; do
  if IFS= read -r -t 0.1 line <&"${WATCH[0]}"; then
    printf '%s\n' "$line"
    if [[ "$line" == *"$pattern"* ]]; then
      if (( ! in_ready_burst )); then
        pending=1
        in_ready_burst=1
        schedule_timer
      fi
    else
      in_ready_burst=0
    fi
  fi

  if [[ -n "${timer_pid:-}" ]] && ! kill -0 "$timer_pid" 2>/dev/null; then
    wait "$timer_pid" 2>/dev/null || true
    timer_pid=""
    if (( pending )); then
      pending=0
      run_action
    fi
  fi

  if ! kill -0 "$child_pid" 2>/dev/null; then
    set +e
    wait "$child_pid"
    status=$?
    set -e
    echo "[watch exited] status=$status cmd=$watch_cmd" >&2
    break
  fi

  if (( stop_requested )); then
    echo "Stopping due to signal" 1>&2
    break
  fi
done

cancel_timer
wait "$child_pid" 2>/dev/null || true

if (( pending )) && (( ! stop_requested )); then
  run_action
fi
