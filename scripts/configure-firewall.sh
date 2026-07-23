#!/usr/bin/env bash
set -euo pipefail

PORT=3002
MODE=${1:-add}
LAN_CIDR=${2:-}

if [[ -z $LAN_CIDR || ! $LAN_CIDR =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
  echo "Usage: sudo ./scripts/configure-firewall.sh [add|remove|replace] <lan-cidr> [previous-client ...]" >&2
  exit 2
fi

if [[ $EUID -ne 0 ]]; then
  echo "Run this helper with sudo: sudo ./scripts/configure-firewall.sh" >&2
  exit 1
fi

command -v ufw >/dev/null 2>&1 || {
  echo "ufw is not installed." >&2
  exit 1
}

case "$MODE" in
  add)
    ufw allow from "$LAN_CIDR" to any port "$PORT" proto tcp comment "Voidling Guides LAN"
    echo "Allowed Voidling Guides on TCP $PORT from LAN: $LAN_CIDR"
    ;;
  remove)
    ufw --force delete allow from "$LAN_CIDR" to any port "$PORT" proto tcp || true
    echo "Removed Voidling Guides TCP $PORT rules for LAN: $LAN_CIDR"
    ;;
  replace)
    for previous in "${@:3}"; do
      if [[ ! $previous =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ]]; then
        echo "Invalid previous client or CIDR: $previous" >&2
        exit 2
      fi
      ufw --force delete allow from "$previous" to any port "$PORT" proto tcp || true
    done
    ufw allow from "$LAN_CIDR" to any port "$PORT" proto tcp comment "Voidling Guides LAN"
    echo "Replaced prior Voidling Guides rules with TCP $PORT from LAN: $LAN_CIDR"
    ;;
  *)
    echo "Usage: sudo ./scripts/configure-firewall.sh [add|remove|replace] <lan-cidr> [previous-client ...]" >&2
    exit 2
    ;;
esac

ufw status numbered
