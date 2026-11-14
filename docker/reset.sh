#!/bin/sh
set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }

case "${1-}:$#" in
  :0) project=membership-rewards; port=18441 ;;
  --test:1) project=membership-rewards-test; port=18442 ;;
  *) fail '用法：sh docker/reset.sh [--test]' ;;
esac

cd "$(dirname "$0")/.."
root=$(pwd -P)
cd "$root"
PWD=$root
export PWD

[ -z "${DOCKER_HOST-}" ] || fail '請取消 DOCKER_HOST，並選用本機 Docker context。'
context=$(docker context show)
endpoint=$(docker context inspect "$context" --format '{{.Endpoints.docker.Host}}')
case "$endpoint" in
  unix:///*) [ -S "${endpoint#unix://}" ] || fail '找不到本機 Docker socket。' ;;
  *) fail '重設只支援本機 Unix socket 的 Docker context。' ;;
esac

engine() { docker --host "$endpoint" "$@"; }
compose() {
  if [ "$project" = membership-rewards-test ]; then
    set -- -f compose.test.yaml "$@"
  fi
  engine compose --env-file /dev/null -p "$project" -f compose.yaml "$@"
}

printf '重設目標：%s（Docker context: %s）\n' "$project" "$context"
printf '專案路徑：%s\n' "$root"
printf '服務：127.0.0.1:%s；清除資料卷：%s_{postgres,db-secrets,app-secrets}\n' "$port" "$project"
printf '所有帳號、交易、券、核銷請求與本機密鑰都會清除。請輸入 %s 確認：' "$project"
IFS= read -r answer && [ "$answer" = "$project" ] || fail '未確認；未變更 Docker 資源。'

# 排除環境檔及 Compose 開關，僅使用本案明列的設定與服務。
unset DOCKER_CONTEXT COMPOSE_ENV_FILES COMPOSE_PROFILES COMPOSE_REMOVE_ORPHANS COMPOSE_IGNORE_ORPHANS
lock=/tmp/$project-reset.lock
mkdir "$lock" 2>/dev/null || fail "無法取得重設鎖 $lock；請確認沒有其他重設正在執行。"
wait_until_unready() {
  # 讓既有健康檢查完成 DB 停止後的失敗判定。
  remaining=65
  while [ "$remaining" -gt 0 ]; do
    app_id=$(compose ps -q --status running app) || return 1
    [ -n "$app_id" ] || return 0
    health=$(engine container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$app_id") || return 1
    [ "$health" != unhealthy ] || return 0
    sleep 1
    remaining=$((remaining - 1))
  done
  return 1
}
changing=0
finish() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$changing" -eq 1 ]; then
    printf '%s\n' '重設失敗，嘗試保持應用程式停止。請排除錯誤後重跑初始化或重設。' >&2
    if ! compose stop app || ! running=$(compose ps -q --status running app) || [ -n "$running" ]; then
      # 無法正常關閉時，先強制關閉入口；仍無法證實才嘗試隔離資料庫。
      if ! compose kill app || ! running=$(compose ps -q --status running app) || [ -n "$running" ]; then
        if ! compose stop db || ! running=$(compose ps -q --status running db) || [ -n "$running" ]; then
          printf '%s\n' '無法確認資料庫已停止，請先檢查 Docker 狀態。' >&2
        elif wait_until_unready; then
          printf '%s\n' '已確認應用程式未就緒；請排除錯誤後重跑初始化或重設。' >&2
        else
          printf '%s\n' '無法確認應用程式就緒狀態，請先檢查 Docker 狀態。' >&2
        fi
      fi
    fi
  fi
  rmdir "$lock" || printf '無法移除重設鎖 %s。\n' "$lock" >&2
  exit "$status"
}
trap finish EXIT
trap 'exit 1' HUP INT TERM

# 專案名稱相同仍可能來自別的路徑，或有測試程序正在使用資料庫。
containers=$(engine ps -aq --filter "label=com.docker.compose.project=$project")
files=$root/compose.yaml
if [ "$project" = membership-rewards-test ]; then files=$files,$root/compose.test.yaml; fi
for id in $containers; do
  owner=$(engine container inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{index .Config.Labels "com.docker.compose.oneoff"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$id")
  case "$owner" in
    "$root|app|False|$files"|"$root|db|False|$files"|"$root|secrets|False|$files") ;;
    *) fail '目標專案含有不屬於此路徑的容器或額外程序；未停止服務。' ;;
  esac
done

networks=$(engine network ls --format '{{.Name}}')
network=${project}_default
if printf '%s\n' "$networks" | grep -Fxq "$network"; then
  owner=$(engine network inspect --format '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.network"}}' "$network")
  [ "$owner" = "$project|default" ] || fail "網路 $network 不屬於本案。"
fi

volumes=$(engine volume ls --format '{{.Name}}')
set --
for key in postgres db-secrets app-secrets; do
  volume=${project}_${key}
  if ! printf '%s\n' "$volumes" | grep -Fxq "$volume"; then continue; fi
  owner=$(engine volume inspect --format '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "com.docker.compose.volume"}}|{{.Driver}}|{{len .Options}}|{{index .Labels "io.membership-rewards.checkout"}}' "$volume")
  case "$owner" in
    "$project|$key|local|0|$root") ;;
    "$project|$key|local|0|") fail "無法確認舊資料卷 $volume 的路徑；未停止服務，請保留資料卷。" ;;
    *) fail "資料卷 $volume 不屬於本專案路徑，未停止服務。" ;;
  esac
  attached=$(engine ps -aq --filter "volume=$volume")
  for id in $attached; do
    printf '%s\n' "$containers" | grep -Fxq "$id" || fail "資料卷 $volume 有其他容器使用；未停止服務。"
  done
  set -- "$@" "$volume"
done

changing=1
# 先停止 HTTP 入口。確認 PostgreSQL 已停止後，才移除資料與密鑰。
compose stop app
running=$(compose ps -q --status running app)
[ -z "$running" ] || fail 'HTTP 入口仍在執行，無法重設。'
compose stop db secrets
running=$(compose ps -q --status running app db secrets)
[ -z "$running" ] || fail '目標服務仍在執行，無法重設。'
compose build app
compose rm -f app db secrets
for volume do
  engine volume rm "$volume"
done
compose up -d --wait --no-build app
printf '重設完成：%s，應用程式已就緒。\n' "$project"
