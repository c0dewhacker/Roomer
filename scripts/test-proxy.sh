#!/usr/bin/env bash
set -euo pipefail

upstream_pid=''
container_name="roomer-proxy-test-$$"
cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
  if [[ -n "$upstream_pid" ]]; then kill "$upstream_pid" >/dev/null 2>&1 || true; fi
}
trap cleanup EXIT

node -e "require('http').createServer((request,response)=>{response.end('upstream:'+request.url)}).listen(19091,'0.0.0.0')" &
upstream_pid=$!

docker run --rm -d \
  --name "$container_name" \
  --add-host host.docker.internal:host-gateway \
  -p 19092:80 \
  -e API_URL=http://host.docker.internal:19091 \
  --mount type=bind,source=/dev/null,target=/etc/nginx/snippets/realip.conf \
  -v "$PWD/apps/web/nginx.conf:/etc/nginx/templates/default.conf.template:ro" \
  nginx:1.31-alpine >/dev/null

for _ in {1..30}; do
  response="$(curl --silent http://127.0.0.1:19092/scim/v2/Users 2>/dev/null || true)"
  api_response="$(curl --silent http://127.0.0.1:19092/api/v1/category-icons/example.svg 2>/dev/null || true)"
  if [[ "$response" == 'upstream:/scim/v2/Users' && "$api_response" == 'upstream:/api/v1/category-icons/example.svg' ]]; then
    exit 0
  fi
  sleep 0.2
done

docker logs "$container_name" >&2
echo "Public API proxy smoke test failed (SCIM: $response; API asset: $api_response)" >&2
exit 1
