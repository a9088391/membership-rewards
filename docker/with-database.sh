#!/bin/sh
set -eu

password=$(cat /run/membership-db/password)
case "$password" in
  ''|*[!0-9a-f]*) echo '資料庫密碼檔格式錯誤' >&2; exit 1 ;;
esac
if [ "${#password}" -ne 64 ]; then
  echo '資料庫密碼檔長度錯誤' >&2
  exit 1
fi
export DATABASE_URL="postgresql://membership:${password}@db:5432/membership?schema=public"
exec "$@"
