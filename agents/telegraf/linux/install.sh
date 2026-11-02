#!/usr/bin/env bash
# Run explicitly with bash; Python 3.11+ and systemd are prerequisites.
set -euo pipefail
set +x
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077
if [[ ${EUID} -ne 0 ]]; then
  printf '%s\n' 'InfraPulse: root privileges required.' >&2
  exit 1
fi
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
key_arg=false
for argument in "$@"; do
  case "$argument" in
    --key-file|--key-file=*) key_arg=true ;;
    --help|-h) exec python3 -I "${script_dir}/lifecycle.py" install "$@" ;;
  esac
done
prompt_file=''
cleanup() {
  if [[ -n ${prompt_file} && ${prompt_file} == /tmp/infrapulse-key.* && -f ${prompt_file} && ! -L ${prompt_file} ]]; then
    rm -- "${prompt_file}"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
# Existing credentials are opened only after lifecycle.py validates the complete
# managed installation. Never read through this symlink in the shell.
if [[ ${key_arg} == false && ! -L /opt/infrapulse-agent/current ]]; then
  if [[ ! -t 0 ]]; then
    printf '%s\n' 'InfraPulse: supply a private --key-file for noninteractive initial installation.' >&2
    exit 1
  fi
  prompt_file=$(mktemp /tmp/infrapulse-key.XXXXXXXXXX)
  chmod 600 -- "${prompt_file}"
  printf '%s' 'InfraPulse API key: ' >&2
  unset api_key
  IFS= read -r -s api_key
  printf '\n' >&2
  printf '%s' "${api_key}" > "${prompt_file}"
  unset api_key
  python3 -I "${script_dir}/lifecycle.py" install "$@" --key-file "${prompt_file}"
else
  python3 -I "${script_dir}/lifecycle.py" install "$@"
fi
