#!/usr/bin/env python3
"""Generate disposable loopback-only acceptance TLS files using existing OpenSSL.

No system trust changes. CA signing key is removed with the temporary directory.
Refuses to overwrite an existing fixture, so active workers keep their trust.
"""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

p = argparse.ArgumentParser()
p.add_argument('--output', required=True)
a = p.parse_args()
out = Path(a.output).resolve()
out.mkdir(parents=True, exist_ok=True)
names = ['ca.pem', 'cert.pem', 'key.pem']
if any((out / name).exists() for name in names):
    p.error('TLS output already exists; choose a new directory')
os.umask(0o077)
with tempfile.TemporaryDirectory(prefix='bstg-local-tls-') as temporary:
    tmp = Path(temporary)
    config = tmp / 'openssl.cnf'
    config.write_text('''[req]
distinguished_name=dn
[dn]
[ca_ext]
basicConstraints=critical,CA:TRUE,pathlen:0
keyUsage=critical,keyCertSign,cRLSign
[server_ext]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:10.0.2.2
''')
    def run(*args):
        subprocess.run(['openssl', *map(str, args)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=BSTG Local Acceptance CA', '-config', config, '-extensions', 'ca_ext', '-keyout', tmp / 'ca.key', '-out', out / 'ca.pem')
    run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', out / 'key.pem', '-out', tmp / 'server.csr')
    run('x509', '-req', '-days', '30', '-in', tmp / 'server.csr', '-CA', out / 'ca.pem', '-CAkey', tmp / 'ca.key', '-set_serial', '1', '-extfile', config, '-extensions', 'server_ext', '-out', out / 'cert.pem')
    run('verify', '-CAfile', out / 'ca.pem', out / 'cert.pem')
print(out)
