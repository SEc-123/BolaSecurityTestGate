#!/usr/bin/env bash
set -euo pipefail

target_root="${TARGET_ROOT:-/opt/bstg-targets/traceability}"
archive="${TRACEABILITY_ARCHIVE:-/tmp/traceability-source-bstg.tar.gz}"
compat_source="${COMPAT_SOURCE:-/tmp/php56-mysql-compat.php}"
compat_target="${COMPAT_TARGET:-/opt/bstg-targets/php56-mysql-compat.php}"
function_compat_source="${FUNCTION_COMPAT_SOURCE:-/tmp/traceability-function-compat.php}"
db_name="${TRACE_DB_NAME:-bstg_traceability}"
db_user="${TRACE_DB_USER:-bstg_trace}"
db_pass="${TRACE_DB_PASS:-BstgTracePass123!}"
port="${TRACE_PORT:-18081}"

rm -rf "$target_root"
mkdir -p "$target_root" /var/log/bstg-targets
tar -xzf "$archive" -C "$target_root" --strip-components=1

mysql -uroot -e "DROP DATABASE IF EXISTS \`$db_name\`; CREATE DATABASE \`$db_name\` DEFAULT CHARACTER SET utf8; CREATE USER IF NOT EXISTS '$db_user'@'localhost' IDENTIFIED BY '$db_pass'; GRANT ALL PRIVILEGES ON \`$db_name\`.* TO '$db_user'@'localhost'; FLUSH PRIVILEGES;"
mysql -uroot "$db_name" < "$target_root/install/install.sql"

python3 - "$target_root/data/conn.php" "$db_user" "$db_pass" "$db_name" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
db_user = sys.argv[2]
db_pass = sys.argv[3]
db_name = sys.argv[4]
path.write_text(f'''<?php
$db_host = "127.0.0.1"; //database host
$db_user = "{db_user}";//database user
$db_pwd = "{db_pass}";//database password
$db_name = "{db_name}";//database name
$db_port = "3306";//database port
$sys_key = "";//license key
?>''', encoding='utf-8')
PY

install_lock="$target_root/install/install.lock"
touch "$install_lock"
install -m 0644 "$compat_source" "$compat_target"
install -m 0644 "$function_compat_source" "$target_root/data/function.php"
chown -R www-data:www-data "$target_root" "$compat_target"

(lsof -ti :"$port" | xargs -r kill -9) || true
cd "$target_root"
runuser -u www-data -- nohup php \
  -d auto_prepend_file="$compat_target" \
  -d display_errors=1 \
  -d error_reporting=E_ALL \
  -S 0.0.0.0:"$port" \
  -t "$target_root" \
  >/var/log/bstg-targets/traceability-php.log 2>&1 &

sleep 2
curl -sS -i "http://127.0.0.1:$port/manage/" | sed -n '1,90p'
curl -sS -i "http://127.0.0.1:$port/q.php?fwm=FW202009300001" | sed -n '1,80p'
mysql -uroot -e "SELECT COUNT(*) AS admin_count FROM $db_name.tgs_admin; SELECT COUNT(*) AS code_count FROM $db_name.tgs_code; SELECT COUNT(*) AS agent_count FROM $db_name.tgs_agent;"
ss -lntp | grep ":$port"
