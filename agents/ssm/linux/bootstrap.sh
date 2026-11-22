# Practical Linux hybrid SSM registration script (Debian/Ubuntu x86_64).
set +x
set +v
set -euo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin LC_ALL=C
unset activation_code activation_id

readonly IP_ROOT=/var/lib/infrapulse-agent
ip_temporary=''
ip_fail() { printf '%s\n' "$1" >&2; exit 1; }

ip_save() {
  local value=$1 temporary
  temporary=$(mktemp "$IP_ROOT/.marker.XXXXXXXX") || ip_fail STATE_WRITE_FAILED
  printf '%s' "$value" > "$temporary"
  chmod 0600 "$temporary"
  mv -f "$temporary" "$IP_ROOT/registration" || ip_fail STATE_WRITE_FAILED
}

ip_download() {
  local target=$1 url=$2 expected_hash=$3 digest
  [[ "$url" == https://* ]] || ip_fail ARTIFACT_INVALID
  timeout 190s curl --silent --show-error --fail --location \
    --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 180 \
    --output "$target" "$url" || ip_fail DOWNLOAD_FAILED
  digest=$(sha256sum -- "$target" | awk '{print $1}')
  [[ "$digest" == "$expected_hash" ]] || ip_fail HASH_MISMATCH
}

bootstrap_main() {
  [[ $EUID == 0 ]] || ip_fail ROOT_REQUIRED
  [[ $(uname -m) == x86_64 ]] || ip_fail UNSUPPORTED_PLATFORM
  declare -F ip_canonical_metadata load_bootstrap_intent >/dev/null || ip_fail CANONICAL_ASSET_REQUIRED

  if ! command -v dpkg >/dev/null 2>&1; then
    ip_fail UNSUPPORTED_PLATFORM
  fi

  # Ensure basic tools needed by bootstrap and subsequent SSM Configure step are present.
  local missing=()
  for tool in curl jq sha256sum findmnt flock; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if [[ ${#missing[@]} -gt 0 ]] && command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl jq util-linux coreutils >/dev/null 2>&1 || true
  fi
  for tool in curl sha256sum dpkg sed systemctl; do
    command -v "$tool" >/dev/null 2>&1 || ip_fail PREREQUISITE_MISSING
  done

  ip_canonical_metadata
  load_bootstrap_intent

  mkdir -p -m 0700 "$IP_ROOT"
  [[ ! -e "$IP_ROOT/decommission.requested" ]] || ip_fail DECOMMISSION_REQUESTED

  if [[ -f "$IP_ROOT/registration" ]]; then
    local owner node
    owner=$(<"$IP_ROOT/registration")
    node=${owner%:*}; node=${node##*:}
    if [[ "$owner" == "$server_id:$enrollment_id:$node:$configuration_version" && "$node" =~ ^mi-[0-9a-f]{17}$ ]]; then
      unset activation_code
      systemctl enable --now amazon-ssm-agent >/dev/null 2>&1 || true
      printf '%s\n' ALREADY_REGISTERED
      return
    fi
  fi

  ip_save "$server_id:$enrollment_id:pending:$configuration_version"
  ip_temporary=$(mktemp -d "$IP_ROOT/.bootstrap.XXXXXXXX") || ip_fail TEMP_UNAVAILABLE
  trap 'unset activation_code; [[ -n ${ip_temporary:-} ]] && rm -rf -- "$ip_temporary"' EXIT

  ip_download "$ip_temporary/ssm-package.deb" "$ssm_url" "$ssm_sha256"
  ip_download "$ip_temporary/ssm-setup-cli" "$helper_url" "$helper_sha256"
  chmod 0700 "$ip_temporary/ssm-setup-cli"

  # Stop any prior SSM agent before installing/registering cleanly.
  systemctl stop amazon-ssm-agent >/dev/null 2>&1 || true
  dpkg -i "$ip_temporary/ssm-package.deb" >/dev/null 2>&1 || ip_fail REGISTRATION_UNCERTAIN

  local output node
  output=$(timeout 240s "$ip_temporary/ssm-setup-cli" -register \
    -activation-id "$activation_id" \
    -activation-code "$activation_code" \
    -region "$region" 2>&1) || { printf '%s\n' "$output" >&2; ip_fail REGISTRATION_UNCERTAIN; }
  unset activation_code

  node=$(sed -nE 's/^.*Managed instance-id: (mi-[0-9a-f]{17}).*$/\1/p' <<< "$output" | head -n 1)
  unset output
  [[ "$node" =~ ^mi-[0-9a-f]{17}$ ]] || ip_fail REGISTRATION_UNCERTAIN

  systemctl enable --now amazon-ssm-agent >/dev/null 2>&1 || true
  ip_save "$server_id:$enrollment_id:$node:$configuration_version"
  printf '%s\n' REGISTERED
}

bootstrap_main "$@"
