#!/usr/bin/env bash
# BB-DIVERGE: native worker inbox acknowledgement is the handled/ move.
# Require the immutable IDs actually handled, rather than re-enumerating newer
# arrivals. The Python companion uses directory-relative no-follow operations;
# native fm_task_inbox_body still owns decoding of the message envelope.
set -eu
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/fm-inbox-take.py" "$@"
