#!/usr/bin/env bash
# grep-gate.sh — V30B shared-format grep gate for raw color literals.
# Fails CI if non-token hex colors appear in src/ (excluding test fixtures).
# Allowlist: #080b10 (app shell bg), #fff (button text).
set -euo pipefail

cd "$(dirname "$0")/.."

FAIL=0
# Match 3/6/8-digit hex color literals in src/, excluding allowlisted values
HITS=$(grep -rn --include='*.tsx' --include='*.ts' --include='*.css' \
  -E '#[0-9a-fA-F]{3,8}\b' src/ \
  | grep -vi '080b10' \
  | grep -vi '#fff\b' \
  | grep -vi 'var(--' \
  | grep -vi 'Auto-generated' \
  | grep -vi '&#[0-9]' \
  || true)

if [ -n "$HITS" ]; then
  echo "GREP GATE FAILED: raw hex color literals found in src/"
  echo "These should use var(--yap-*) token references instead:"
  echo "$HITS"
  FAIL=1
fi

if [ "$FAIL" -eq 1 ]; then
  exit 1
fi

echo "Grep gate passed: no raw color literals in src/"
