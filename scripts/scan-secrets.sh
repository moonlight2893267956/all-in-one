#!/usr/bin/env bash
#
# scan-secrets.sh — scan STAGED (git index) content for real-looking secrets.
#
# Design goals:
#   * Catch REAL secrets (sk-..., tvly-..., AKID..., Langfuse, GitHub PAT, AWS).
#   * NEVER block on placeholder/template values (sk-xxx, your_key_here,
#     replace-me, <...>) — those are meant to live in committed .env.example.
#   * Stay shell-only (no Python) so it runs anywhere git + bash run.
#
# Usage:
#   bash scripts/scan-secrets.sh        # exits 1 if a real secret is staged
#   npm run scan:secrets                # same
#
set -uo pipefail

# --- 1. Patterns for REAL secrets (long mixed-case/alnum tokens) -------------
PATTERNS=(
  'sk-[A-Za-z0-9]{20,}'          # OpenAI / DashScope / NewAPI style
  'tvly-[A-Za-z0-9]{20,}'        # Tavily
  'AKID[A-Za-z0-9]{20,}'         # Tencent Cloud
  'sk-lf-[A-Za-z0-9_-]{12,}'     # Langfuse secret key
  'gh[pousr]_[A-Za-z0-9]{20,}'   # GitHub PAT / fine-grained token
  'xox[baprs]-[A-Za-z0-9-]{10,}' # Slack token
  'aws_secret_access_key["'"'"']?\s*[:=]\s*["'"'"']?[A-Za-z0-9/+]{20,}'
)
PAT=$(IFS='|'; echo "${PATTERNS[*]}")

# --- 2. Lines that are obviously template/placeholder — skip them -----------
is_template() {
  printf '%s' "$1" | grep -Eqi \
    '(your[_-]?(api[_-]?)?(key|token|secret)|replace[_-]?me|changeme|example|<[^>]+>|xxxx|XXX|placeholder)'
}

# --- 3. Scan staged files, excluding example/sample/template files ----------
# git grep --cached searches the staged index. pathspec excludes skip
# *.example / *.sample / *.tmpl so committed templates never block a commit.
found=0
while IFS= read -r m; do
  # $m is "file:lineno:content"; template markers only ever appear in content.
  if is_template "$m"; then
    continue
  fi
  echo "POSSIBLE SECRET in staged content:"
  echo "  $m"
  found=1
done < <(
  git grep -n --cached -E "$PAT" -- \
    ':(exclude)*.example' \
    ':(exclude)*.sample' \
    ':(exclude)*.tmpl' 2>/dev/null
)

if [ "$found" -ne 0 ]; then
  echo ""
  echo "Commit blocked: staged changes appear to contain a real secret."
  echo "Review the matches above. If this is a false positive, you can bypass with:"
  echo "  git commit --no-verify   # NOT recommended unless you are certain"
  exit 1
fi

echo "scan-secrets: no real secrets found in staged content."
exit 0
