#!/bin/sh
# Host launcher for BB's root-run browser workers. The npm CLI stays unmodified.
set -eu

if [ -z "${CHROME_DEVTOOLS_AXI_SESSION:-}" ] && [ -n "${BB_THREAD_ID:-}" ]; then
  export CHROME_DEVTOOLS_AXI_SESSION="$BB_THREAD_ID"
fi

# Chromium cannot enable its sandbox as root. Do not alter an attached browser
# or shared MCP server: those services own their launch policy.
if [ "$(id -u)" = 0 ] && [ -z "${CHROME_DEVTOOLS_AXI_BROWSER_URL:-}" ] && [ -z "${CHROME_DEVTOOLS_AXI_MCP_SERVER_URL:-}" ]; then
  case " ${CHROME_DEVTOOLS_AXI_CHROME_ARGS:-} " in
    *" --no-sandbox "*) ;;
    *) export CHROME_DEVTOOLS_AXI_CHROME_ARGS="${CHROME_DEVTOOLS_AXI_CHROME_ARGS:+$CHROME_DEVTOOLS_AXI_CHROME_ARGS }--no-sandbox" ;;
  esac
fi

exec /usr/bin/chrome-devtools-axi "$@"
