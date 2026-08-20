#!/bin/sh
# Quick check that the backend on :8002 is running the current code.
echo "health:"
curl -s -m 3 http://127.0.0.1:8002/health || echo "  backend not responding on :8002"
echo
echo "variant routes:"
curl -s -m 3 http://127.0.0.1:8002/openapi.json \
  | python -c "import json,sys; p=json.load(sys.stdin)['paths']; v=sorted(x for x in p if 'variant' in x); print('\n'.join('  '+x for x in v) if v else '  NONE - backend is stale, restart it')"
