#!/usr/bin/env bash
# Explicit local removal only; backend credential revocation is an Admin task.
set -euo pipefail
set +x
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
exec python3 -I "${script_dir}/lifecycle.py" uninstall "$@"
