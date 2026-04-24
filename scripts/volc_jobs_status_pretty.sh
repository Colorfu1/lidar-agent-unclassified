#!/usr/bin/env bash
set -euo pipefail

LEDGER_CSV="submitted_jobs_yamls/submission_ledger.csv"
STATUS_CACHE="submitted_jobs_yamls/.volc_jobs_status_cache.json"
STATUS_DIFF="submitted_jobs_yamls/.volc_jobs_status_diff.json"
LIMIT=20
SHOW_ALL=0
SHOW_DIFF=0
SHOW_JSON=0
TASK_ID_FILTER=""
NORMAL_QUEUE_ID="q-20241104174420-vt829"
PIPELINE_QUEUE_ID="q-20250327162123-lwvqb"

usage() {
  cat >&2 <<'EOF'
Usage: scripts/volc_jobs_status_pretty.sh [options]

Options:
  --csv <path>        Ledger CSV path (default: submitted_jobs_yamls/submission_ledger.csv)
  --limit <n>         Show latest N submitted jobs from ledger (default: 20)
  --all               Ignore --limit and query all task IDs in ledger
  --task-id <id>      Query only one task ID (bypasses ledger scan)
  --normal-queue <id> Override normal queue ID for grouping
  --pipeline-queue <id> Override pipeline queue ID for grouping
  --diff                Compare with cached state, output only changes
  --cache <path>        Override status cache file path
  --diff-out <path>     Override diff output JSON path
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --csv)
      LEDGER_CSV="${2:-}"
      shift 2
      ;;
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    --all)
      SHOW_ALL=1
      shift
      ;;
    --task-id)
      TASK_ID_FILTER="${2:-}"
      shift 2
      ;;
    --normal-queue)
      NORMAL_QUEUE_ID="${2:-}"
      shift 2
      ;;
    --pipeline-queue)
      PIPELINE_QUEUE_ID="${2:-}"
      shift 2
      ;;
    --json)
      SHOW_JSON=1
      shift
      ;;
    --diff)
      SHOW_DIFF=1
      shift
      ;;
    --cache)
      STATUS_CACHE="${2:-}"
      shift 2
      ;;
    --diff-out)
      STATUS_DIFF="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required for pretty status output." >&2
  exit 1
fi

TMP_IDS="$(mktemp)"
TMP_ROWS="$(mktemp)"
cleanup() {
  rm -f "$TMP_IDS" "$TMP_ROWS"
}
trap cleanup EXIT

if [ -n "$TASK_ID_FILTER" ]; then
  printf '%s\n' "$TASK_ID_FILTER" > "$TMP_IDS"
else
  if [ ! -f "$LEDGER_CSV" ] && [ -f "submitted_jobs_yamls/submission_ledger.jsonl" ]; then
    printf 'task_id,submit_time,profile,yaml_path,archived_yaml_path,job_name,description,resource_queue_id\n' > "$LEDGER_CSV"
    jq -r '[.task_id, (.submit_time // ""), (.profile // "default"), (.yaml_path // ""), (.archived_yaml_path // ""), (.job_name // ""), (.description // ""), (.resource_queue_id // "")] | @csv' \
      submitted_jobs_yamls/submission_ledger.jsonl >> "$LEDGER_CSV"
  fi

  if [ ! -f "$LEDGER_CSV" ]; then
    echo "Ledger CSV not found: $LEDGER_CSV" >&2
    echo "Submit jobs first with scripts/volc_submit_and_archive.sh to populate it." >&2
    exit 1
  fi

  if [ "$SHOW_ALL" -eq 1 ]; then
    tail -n +2 "$LEDGER_CSV" | cut -d',' -f1 | tr -d '"' | sed '/^$/d' > "$TMP_IDS"
  else
    tail -n +2 "$LEDGER_CSV" | tail -n "$LIMIT" | cut -d',' -f1 | tr -d '"' | sed '/^$/d' > "$TMP_IDS"
  fi
fi

if [ ! -s "$TMP_IDS" ]; then
  echo "No task IDs found in ledger selection." >&2
  exit 1
fi

python3 - "$TMP_IDS" "$TMP_ROWS" <<'PYEOF'
import sys, json, subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

ids_file, rows_file = sys.argv[1], sys.argv[2]
task_ids = [l.strip() for l in open(ids_file) if l.strip()]

def fetch_one(task_id):
    result = subprocess.run(
        ['volc', 'ml_task', 'get', '--id', task_id, '--output', 'json'],
        capture_output=True, text=True
    )
    raw = result.stdout
    idx = raw.find('[{')
    if idx >= 0:
        try:
            data = json.loads(raw[idx:])
            t = data[0] if data else {}
            specs = t.get('TaskRoleSpecs', [])
            workers = sum(s.get('RoleReplicas', 0) for s in specs if s.get('RoleName') == 'worker') \
                      or sum(s.get('RoleReplicas', 0) for s in specs)
            return {
                'task_id': t.get('JobId', task_id),
                'job_name': t.get('JobName', ''),
                'status': t.get('Status', 'Unknown'),
                'workers': workers,
                'resource_queue_id': t.get('ResourceQueueId', ''),
                'creator': t.get('Creator', ''),
                'start': t.get('Start', ''),
                'elapsed': t.get('Elapsed'),
                'fetch_error': ''
            }
        except Exception:
            pass
    return {'task_id': task_id, 'job_name': '', 'status': 'GetError', 'workers': 0,
            'resource_queue_id': '', 'creator': '', 'start': '', 'elapsed': None,
            'fetch_error': raw.replace('\n', ' ')[:200]}

rows = [None] * len(task_ids)
with ThreadPoolExecutor(max_workers=8) as pool:
    futures = {pool.submit(fetch_one, tid): i for i, tid in enumerate(task_ids)}
    for f in as_completed(futures):
        rows[futures[f]] = f.result()

with open(rows_file, 'a') as out:
    for row in rows:
        out.write(json.dumps(row) + '\n')
PYEOF


# Step 2: same-name discovery.
# For each unique resolved job_name from Step 1, query volc for Queue/Staging/Running/Success
# jobs not already in the ledger, append them to TMP_ROWS (status marked with *).
UNIQUE_NAMES="$(jq -r 'select(.job_name != "") | .job_name' "$TMP_ROWS" | sort -u)"

if [ -n "$UNIQUE_NAMES" ]; then
  FMT="JobId,JobName,Status,Start,Creator,ResourceQueueId,TaskRoleSpecs"
  TMP_NAMES="$(mktemp)"
  printf '%s\n' "$UNIQUE_NAMES" > "$TMP_NAMES"
  # Parallel Step 2: fan out one volc ml_task list per unique job name
  python3 - "$TMP_ROWS" "$FMT" "$TMP_NAMES" <<'PYEOF2'
import sys, json, subprocess
from concurrent.futures import ThreadPoolExecutor, as_completed

rows_file = sys.argv[1]
fmt = sys.argv[2]
names_file = sys.argv[3]
names = [l.strip() for l in open(names_file) if l.strip()]

# Read already-known IDs from rows_file
known = set()
try:
    with open(rows_file) as f:
        for line in f:
            line = line.strip()
            if line:
                known.add(json.loads(line).get('task_id', ''))
except Exception:
    pass

def fetch_name(jname):
    result = subprocess.run(
        ['volc', 'ml_task', 'list', '--output', 'json',
         '-n', jname, '-s', 'Queue,Staging,Running,Success',
         '--format', fmt],
        capture_output=True, text=True
    )
    raw = result.stdout + result.stderr
    idx = raw.find('[{')
    if idx < 0:
        return []
    try:
        rows = json.loads(raw[idx:])
    except Exception:
        return []
    out = []
    for r in rows:
        jid = r.get('JobId', '')
        status = r.get('Status', '')
        if not jid or jid in known:
            continue
        specs = r.get('TaskRoleSpecs', [])
        workers = sum(s.get('RoleReplicas', 0) for s in specs if s.get('RoleName') == 'worker') \
                  or sum(s.get('RoleReplicas', 0) for s in specs)
        out.append({'task_id': jid, 'job_name': r.get('JobName', ''),
                    'status': status + '*', 'workers': workers,
                    'resource_queue_id': r.get('ResourceQueueId', ''),
                    'creator': r.get('Creator', ''), 'start': r.get('Start', ''),
                    'elapsed': None, 'fetch_error': ''})
        known.add(jid)
    return out

with ThreadPoolExecutor(max_workers=8) as pool:
    futures = [pool.submit(fetch_name, n) for n in names]
    with open(rows_file, 'a') as out:
        for f in as_completed(futures):
            for row in f.result():
                out.write(json.dumps(row) + '\n')
PYEOF2
  rm -f "$TMP_NAMES"
fi

# JSON output mode: dump all rows as a JSON array and exit
if [ "$SHOW_JSON" -eq 1 ]; then
  python3 -c "
import json, sys
rows = []
for line in open('$TMP_ROWS'):
    line = line.strip()
    if line:
        rows.append(json.loads(line))
json.dump(rows, sys.stdout, ensure_ascii=False)
"
  exit 0
fi

# Print final grouped output (single pass after Step 2 appends)
TOTAL="$(wc -l < "$TMP_IDS" | tr -d ' ')"
echo "Jobs Status (Local Ledger CSV -> volc ml_task get + same-name discovery)"
echo "Source CSV: $LEDGER_CSV"
echo "Selected task IDs: $TOTAL  (* = active same-name job, not in local ledger)"
echo

python3 - "$TMP_ROWS" "$TMP_IDS" "$NORMAL_QUEUE_ID" "$PIPELINE_QUEUE_ID" <<'PYEOF3'
import sys, json
from collections import defaultdict

rows_file, ids_file, normal_q, pipeline_q = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

ledger_ids = [l.strip() for l in open(ids_file) if l.strip()]

all_rows = {}
for line in open(rows_file):
    line = line.strip()
    if not line:
        continue
    r = json.loads(line)
    all_rows[r['task_id']] = r

ledger_rows = [all_rows[tid] for tid in ledger_ids if tid in all_rows]
discovered  = [r for r in all_rows.values() if r['status'].endswith('*')]

disc_by_name = defaultdict(list)
for r in discovered:
    disc_by_name[r['job_name']].append(r)
for lst in disc_by_name.values():
    lst.sort(key=lambda r: r.get('start') or '', reverse=True)

def trunc(s, n):
    s = str(s) if s else ''
    return s if len(s) <= n else s[:n-2] + '..'

def queue_label(qid):
    if qid == normal_q:   return 'normal'
    if qid == pipeline_q: return 'pipeline'
    return trunc(qid, 10)

# auto-size JobName column to longest name
max_name = max((len(r['job_name']) for r in all_rows.values()), default=10)
W = [28, max(max_name, 7), 10, 3, 8, 19]
HDRS = ['JobId', 'JobName', 'Status', 'W', 'Queue', 'Start']

def hline(left='├', mid='┼', right='┤', fill='─'):
    return left + mid.join(fill * (w + 2) for w in W) + right

def trow(cells):
    return '│' + '│'.join(' ' + str(c).ljust(w) + ' ' for c, w in zip(cells, W)) + '│'

def make_cells(r, indent=False):
    prefix = '  * ' if indent else '    '
    return [
        trunc(prefix + r['task_id'], W[0]),
        r['job_name'],
        r['status'],
        str(r['workers']),
        queue_label(r['resource_queue_id']),
        (r.get('start') or '')[:19],
    ]

def print_section(title, rows, section_queue):
    print(title)
    if not rows:
        print('  (none)')
        print()
        return
    print(hline('┌', '┬', '┐'))
    print(trow(HDRS))
    for r in rows:
        print(hline('├', '┼', '┤'))
        print(trow(make_cells(r, indent=False)))
        for sub in disc_by_name.get(r['job_name'], []):
            if sub['resource_queue_id'] == section_queue:
                print(trow(make_cells(sub, indent=True)))
    print(hline('└', '┴', '┘'))
    print()

normal   = [r for r in ledger_rows if r['resource_queue_id'] == normal_q]
pipeline = [r for r in ledger_rows if r['resource_queue_id'] == pipeline_q]
other    = [r for r in ledger_rows if r['resource_queue_id'] not in (normal_q, pipeline_q)]

print_section(f'Normal Queue ({normal_q})', normal, normal_q)
print_section(f'Pipeline Queue ({pipeline_q})', pipeline, pipeline_q)
print_section('Other / Unknown Queue', other, '')
PYEOF3

# Step 4: Diff against cached state and update cache
if [ "$SHOW_DIFF" -eq 1 ]; then
  python3 - "$TMP_ROWS" "$STATUS_CACHE" "$STATUS_DIFF" <<'PYEOF4'
import sys, json, os
from datetime import datetime

rows_file, cache_file, diff_file = sys.argv[1], sys.argv[2], sys.argv[3]

# Build current state: { task_id: { job_name, status } }
current = {}
for line in open(rows_file):
    line = line.strip()
    if not line:
        continue
    r = json.loads(line)
    current[r['task_id']] = {
        'job_name': r['job_name'],
        'status': r['status'],
    }

# Load previous state
previous = {}
prev_time = None
if os.path.exists(cache_file):
    try:
        cached = json.load(open(cache_file))
        previous = cached.get('tasks', {})
        prev_time = cached.get('timestamp', None)
    except Exception:
        pass

# Compute diff
changes = []
for tid, cur in current.items():
    prev = previous.get(tid)
    if prev is None:
        # New task not seen before
        changes.append({
            'task_id': tid,
            'job_name': cur['job_name'],
            'old_status': None,
            'new_status': cur['status'],
        })
    elif prev['status'] != cur['status']:
        # Status changed
        changes.append({
            'task_id': tid,
            'job_name': cur['job_name'],
            'old_status': prev['status'],
            'new_status': cur['status'],
        })

# Tasks that disappeared (in previous but not current) - usually API flakiness, skip

# Output diff section
print()
print("=== Status Changes (since last query) ===")
if prev_time:
    print(f"Last cached: {prev_time}")
if not changes:
    print("No changes detected.")
else:
    for c in changes:
        short_id = c['task_id'].split('-')[-1] if '-' in c['task_id'] else c['task_id']
        name = c['job_name']
        if c['old_status'] is None:
            print(f"  [NEW] {name} ({short_id}): {c['new_status']}")
        else:
            print(f"  {name} ({short_id}): {c['old_status']} -> {c['new_status']}")

# Write diff result JSON for external consumers (e.g. Feishu bridge)
diff_data = {
    'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    'prev_timestamp': prev_time,
    'changes': changes,
}
with open(diff_file, 'w') as f:
    json.dump(diff_data, f, indent=2, ensure_ascii=False)

# Save current state to cache (overwrites previous — only stores latest snapshot)
cache_data = {
    'timestamp': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
    'tasks': current,
}
with open(cache_file, 'w') as f:
    json.dump(cache_data, f, indent=2, ensure_ascii=False)

PYEOF4
fi
