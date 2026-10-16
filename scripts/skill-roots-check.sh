#!/usr/bin/env bash
# Read-only. Reports every skill that Claude, Codex and ~/.agents resolve to
# different content. Each skill should be one source, linked into every root.
# Exit 0: every skill present in two or more roots matches. Exit 1: a skill
# differs or a skill link is broken. A daily BB script automation runs this.
set -u
roots=(claude:.claude/skills codex:.codex/skills agents:.agents/skills)

digest() {
  (cd -P "$1" && find -L . -type f ! -path '*/.git/*' -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum | cut -c1-12
}

names=$(for r in "${roots[@]}"; do d="$HOME/${r#*:}"; [ -d "$d" ] && ls -A "$d"; done | LC_ALL=C sort -u)
shared=0 bad=()
for s in $names; do
  line="" found=0 kinds=""
  for r in "${roots[@]}"; do
    p="$HOME/${r#*:}/$s"
    if [ -L "$p" ] && [ ! -e "$p" ]; then echo "SKILL_BROKEN: $s ${r%%:*} $p"; bad+=("$s"); h=none
    elif [ -r "$p/SKILL.md" ]; then h=$(digest "$p"); found=$((found + 1)); kinds="$kinds $h"
    else h=none; fi
    line="$line ${r%%:*}=$h"
  done
  [ "$found" -ge 2 ] || continue
  shared=$((shared + 1))
  if [ "$(printf '%s\n' $kinds | sort -u | wc -l)" -gt 1 ]; then echo "SKILL_DIFFERS: $s$line"; bad+=("$s"); fi
done
if [ ${#bad[@]} -eq 0 ]; then
  echo "skill roots ok: $shared shared skills match in claude, codex, agents"
  exit 0
fi
list=$(printf '%s\n' "${bad[@]}" | LC_ALL=C sort -u | tr '\n' ' ')
echo "$(printf '%s\n' "${bad[@]}" | sort -u | wc -l) skills differ between skill roots or have a broken link: ${list% }" >&2
exit 1
