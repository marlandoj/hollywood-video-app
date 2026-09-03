#!/usr/bin/env bash
# Generates the internal CA plus the API server and frontend-proxy client
# certificates used for service-to-service mTLS (NFR-004, C-008). Output goes
# to infra/mtls/certs, which is git-ignored; nothing is baked into an image.
# The layout is per role so that each container can be handed only its own
# identity:
#   ca/        ca.key ca.crt              stays on the host, never mounted
#   api/       api.crt api.key ca.crt     mounted into the api container
#   frontend/  frontend.crt frontend.key ca.crt   mounted into the proxy
set -euo pipefail
out="${1:-$(dirname "$0")/certs}"
days="${HV_MTLS_DAYS:-825}"
ca_cn="${HV_MTLS_CA_CN:-hollywood-video-internal-ca}"
mkdir -p "$out/ca" "$out/api" "$out/frontend"
cd "$out"
# Earlier versions wrote a flat layout here. Any such file is removed so that
# nothing outside the per-role directories can be picked up by a mount or a
# build context.
rm -f ca.key ca.crt ca.srl api.key api.crt api.csr api.ext frontend.key frontend.crt frontend.csr frontend.ext
if [ -f ca/ca.crt ] && [ -f api/api.crt ] && [ -f frontend/frontend.crt ] && [ "${HV_MTLS_FORCE:-0}" != "1" ]; then
  echo "certificates already present in $out (set HV_MTLS_FORCE=1 to regenerate)"
  exit 0
fi
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days "$days" \
  -subj "/CN=$ca_cn" -keyout ca/ca.key -out ca/ca.crt >/dev/null 2>&1
cat > api.ext <<EXT
subjectAltName=DNS:api,DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth
EXT
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 \
  -subj "/CN=api" -keyout api/api.key -out api.csr >/dev/null 2>&1
openssl x509 -req -in api.csr -CA ca/ca.crt -CAkey ca/ca.key -CAcreateserial -days "$days" -sha256 -extfile api.ext -out api/api.crt >/dev/null 2>&1
cat > frontend.ext <<EXT
extendedKeyUsage=clientAuth
EXT
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 \
  -subj "/CN=frontend" -keyout frontend/frontend.key -out frontend.csr >/dev/null 2>&1
openssl x509 -req -in frontend.csr -CA ca/ca.crt -CAkey ca/ca.key -CAcreateserial -days "$days" -sha256 -extfile frontend.ext -out frontend/frontend.crt >/dev/null 2>&1
cp ca/ca.crt api/ca.crt
cp ca/ca.crt frontend/ca.crt
rm -f api.csr frontend.csr api.ext frontend.ext ca/ca.srl
chmod 700 ca
chmod 600 ca/ca.key api/api.key frontend/frontend.key
chmod 644 ca/ca.crt api/api.crt api/ca.crt frontend/frontend.crt frontend/ca.crt
echo "wrote CA, api, and frontend certificates to $out"
