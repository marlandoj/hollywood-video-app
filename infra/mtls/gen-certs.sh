#!/usr/bin/env bash
# Generates the internal CA plus the API server and frontend-proxy client
# certificates used for service-to-service mTLS (NFR-004, C-008). Output goes
# to infra/mtls/certs, which is git-ignored and mounted read-only into the
# containers; nothing is baked into an image.
set -euo pipefail
out="${1:-$(dirname "$0")/certs}"
days="${HV_MTLS_DAYS:-825}"
mkdir -p "$out"
cd "$out"
if [ -f ca.crt ] && [ -f api.crt ] && [ -f frontend.crt ] && [ "${HV_MTLS_FORCE:-0}" != "1" ]; then
  echo "certificates already present in $out (set HV_MTLS_FORCE=1 to regenerate)"
  exit 0
fi
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 -days "$days" \
  -subj "/CN=hollywood-video-internal-ca" -keyout ca.key -out ca.crt >/dev/null 2>&1
cat > api.ext <<EXT
subjectAltName=DNS:api,DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth
EXT
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 \
  -subj "/CN=api" -keyout api.key -out api.csr >/dev/null 2>&1
openssl x509 -req -in api.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days "$days" -sha256 -extfile api.ext -out api.crt >/dev/null 2>&1
cat > frontend.ext <<EXT
extendedKeyUsage=clientAuth
EXT
openssl req -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -sha256 \
  -subj "/CN=frontend" -keyout frontend.key -out frontend.csr >/dev/null 2>&1
openssl x509 -req -in frontend.csr -CA ca.crt -CAkey ca.key -CAcreateserial -days "$days" -sha256 -extfile frontend.ext -out frontend.crt >/dev/null 2>&1
rm -f api.csr frontend.csr api.ext frontend.ext ca.srl
chmod 600 ca.key api.key frontend.key
chmod 644 ca.crt api.crt frontend.crt
echo "wrote CA, api, and frontend certificates to $out"
