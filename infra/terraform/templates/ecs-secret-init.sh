#!/bin/sh
# Invoked once per ECS task. Do not trace, print, or pass secrets in argv.
set +x
set -eu
umask 077

case "$1" in
  management)
    : "${DATABASE_URL:?missing database_url}" "${ASSERTION_TRUST:?missing assertion_trust}"
    owner=10002:10002
    ;;
  grafana)
    : "${ASSERTION_KEY:?missing assertion_key}" "${ADMIN_USER:?missing admin_user}" "${ADMIN_PASSWORD:?missing admin_password}"
    owner=472:472
    ;;
  *) exit 1 ;;
esac

cd /run/secrets
write_secret() {
  file=$1
  # The directory is new and root-owned. Never overwrite an existing entry.
  (set -C; printf '%s' "$2" > "$file")
  chmod 0400 "$file"
  chown "$owner" "$file"
}

case "$1" in
  management)
    write_secret management-db-url "$DATABASE_URL"
    write_secret assertion-trust "$ASSERTION_TRUST"
    ;;
  grafana)
    write_secret assertion-key "$ASSERTION_KEY"
    write_secret grafana-admin-user "$ADMIN_USER"
    write_secret grafana-admin-password "$ADMIN_PASSWORD"
    ;;
esac
