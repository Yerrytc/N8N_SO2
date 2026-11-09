#!/usr/bin/env bash
# Ejecuta todas las verificaciones y guarda la salida en evidence/. Uso: ./scripts/run_all.sh
set -u
cd "$(dirname "$0")/.."
mkdir -p evidence
{ echo "# $(date -Is) | $(node -v) | $(uname -sr)"; (cd apps/api && node --test test/pt.test.js 2>&1 | grep -E '^(ok|not ok)|^# (tests|pass|fail)'); } | tee evidence/test_results.txt
node scripts/e2e_demo.js > evidence/e2e_demo.txt 2>&1 && echo "e2e_demo: ok"
node scripts/load_test.js > evidence/load_test.txt 2>&1 && echo "load_test: ok"
python3 scripts/check_infra.py > evidence/check_infra.txt 2>&1; tail -1 evidence/check_infra.txt
python3 scripts/check_workflows.py > evidence/check_workflows.txt 2>&1; tail -1 evidence/check_workflows.txt
if [ -x /usr/lib/postgresql/16/bin/postgres ] && [ "$(id -u)" = 0 ]; then ./scripts/sql_check.sh > evidence/sql_check.txt 2>&1; tail -3 evidence/sql_check.txt; else echo "sql_check: omitido (requiere PostgreSQL 16 y root; ver README)"; fi
