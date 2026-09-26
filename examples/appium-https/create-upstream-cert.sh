#!/usr/bin/env bash
# Generates a short-lived local test certificate, never a production certificate.
set -euo pipefail
: "${BSTG_LAB_CERT_DIR:?New directory}" "${BSTG_LAB_CERT_HOST:?DNS name or IPv4 address}"
umask 077
mkdir "$BSTG_LAB_CERT_DIR"
SAN="$(python3 - <<'PY'
import os,ipaddress,re
host=os.environ['BSTG_LAB_CERT_HOST']
try: print('IP:'+str(ipaddress.ip_address(host)))
except ValueError:
 assert re.fullmatch(r'[A-Za-z0-9.-]+',host), 'invalid DNS name'
 print('DNS:'+host)
PY
)"
openssl req -x509 -newkey rsa:2048 -nodes -days 7 -subj '/CN=BSTG Authorized Local HTTPS Lab' -addext "subjectAltName=$SAN" -keyout "$BSTG_LAB_CERT_DIR/upstream-key.pem" -out "$BSTG_LAB_CERT_DIR/upstream-cert.pem"
echo 'Keep private key local. Trust the public certificate in this lab only.'
