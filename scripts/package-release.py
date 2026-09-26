#!/usr/bin/env python3
"""Package the staged source and normal build output; never include runtime data."""
import hashlib
import json
from pathlib import Path
import subprocess
import zipfile
from source_manifest import check_source_manifest

root = Path(__file__).resolve().parent.parent

def git(*args):
    return subprocess.check_output(['git', *args], cwd=root).decode().strip()

subprocess.run(['git', 'diff', '--exit-code', '--quiet'], cwd=root, check=True)
check_source_manifest(root)
version = json.loads((root / 'package.json').read_text())['version']
for entry in ['dist/index.html', 'server/dist/index.js']:
    if not (root / entry).is_file():
        raise SystemExit('Run npm run build before packaging: missing ' + entry)
files = [p for p in git('ls-files', '-z').split('\0') if p]
for base in ['dist', 'server/dist']:
    files += [p.relative_to(root).as_posix() for p in (root / base).rglob('*') if p.is_file()]
files = sorted(set(files))
for name in files:
    p = Path(name)
    if (root / p).is_symlink() or any(part in {'node_modules', '.git', 'data', 'uploads', 'managed-mitmproxy'} for part in p.parts) or (p.name.startswith('.env') and p.name != '.env.example'):
        raise SystemExit('Refusing runtime/private package input: ' + name)
manifest = {
    'version': version,
    'source_tree': git('write-tree'),
    'channel': 'local-build',
    # A release summary is written only after actual acceptance. Absence must
    # remain explicit, rather than reusing a previous release's status.
    'runtime_acceptance': json.loads((root / 'validation' / ('release-' + version + '.json')).read_text())
        if (root / 'validation' / ('release-' + version + '.json')).is_file() else {'status': 'not_recorded'},
    'files': {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files},
}
out = root / 'artifacts' / ('release-' + version)
out.mkdir(parents=True, exist_ok=True)
archive = out / ('BolaSecurityTestGate-' + version + '.zip')
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=8) as bundle:
    for name in files:
        bundle.write(root / name, 'BolaSecurityTestGate/' + name)
    bundle.writestr('BolaSecurityTestGate/RELEASE_MANIFEST.json', json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
with zipfile.ZipFile(archive) as bundle:
    assert bundle.testzip() is None
    for name, expected in manifest['files'].items():
        assert hashlib.sha256(bundle.read('BolaSecurityTestGate/' + name)).hexdigest() == expected, name
checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
(archive.with_suffix('.zip.sha256')).write_text(checksum + '  ' + archive.name + '\n')
(out / 'build-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'artifact': str(archive), 'sha256': checksum, 'source_tree': manifest['source_tree'], 'files': len(files)}, indent=2))
