#!/bin/sh
set -u

: "${NPC_NAME:?set NPC_NAME to a persona name}"
PERSONAS=/opt/npc/personas
TICK=/opt/npc/tick.md

# `codex exec resume --last --all` reloads the whole newest session file.
# With [history] persistence save-all that file only grows, and on
# 2026-08-22 Zella's reached a gigabyte: every resume then died on the
# container's memory limit, forever, because the same file greeted every
# restart. A session too big to reload is archived and a fresh one begins.
archive_fat_sessions() {
  find "$CODEX_HOME/sessions" -type f -name '*.jsonl' -size +64M 2>/dev/null \
  | while read -r f; do
    mkdir -p "$CODEX_HOME/sessions-archive"
    mv "$f" "$CODEX_HOME/sessions-archive/"
    printf 'archived oversized session %s\n' "$f" >&2
  done
}

turn() {
  archive_fat_sessions
  if find "$CODEX_HOME/sessions" -type f -name '*.jsonl' -print -quit 2>/dev/null | grep -q .; then
    codex exec resume --last --all \
      --dangerously-bypass-approvals-and-sandbox \
      --skip-git-repo-check \
      -m gpt-5.6-terra \
      -c 'model_reasoning_effort="medium"' \
      - < "$TICK"
    return
  fi

  codex exec \
    --dangerously-bypass-approvals-and-sandbox \
    --skip-git-repo-check \
    -C /workspace \
    -m gpt-5.6-terra \
    -c 'model_reasoning_effort="medium"' \
    - < "$TICK"
}

mkdir -p "$CODEX_HOME/sessions" /workspace
{
  cat "$PERSONAS/$NPC_NAME.md"
  printf '\n'
  if [ -f "$PERSONAS/$NPC_NAME-world.md" ]; then
    cat "$PERSONAS/$NPC_NAME-world.md"
    printf '\n'
  fi
  printf '# World connection\n\nYour arena agent id is `%s`. Use it when arena_login asks for agent_id.\n' "$ARENA_AGENT_ID"
} > /workspace/AGENTS.md

while true; do
  turn || printf '%s\n' "$NPC_NAME turn failed; retrying after the normal interval." >&2
  sleep 120
done
