#!/usr/bin/env python3
"""Regenerate/check the source checksum inventory after staging intended inputs.

Never includes untracked runtime files. The manifest excludes its own checksum.
"""
import argparse
import hashlib
from pathlib import Path
import subprocess

MANIFEST_NAME = 'MANIFEST_SHA256.txt'


def render_source_manifest(root):
    tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=root).decode().split('\0')
    names = sorted({name for name in tracked if name and name != MANIFEST_NAME})
    for name in names:
        if (root / name).is_symlink():
            raise ValueError('Refusing symlink in source inventory: ' + name)
    return ''.join(hashlib.sha256((root / name).read_bytes()).hexdigest() + '  ' + name + '\n' for name in names)


def check_source_manifest(root):
    expected = render_source_manifest(root)
    inventory = root / MANIFEST_NAME
    if not inventory.is_file() or inventory.read_text() != expected:
        raise SystemExit('Source checksum inventory is stale. Stage intended source files, run '
                         '`python3 scripts/source_manifest.py`, stage MANIFEST_SHA256.txt, then package again.')
    return expected.count('\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Verify without writing')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if args.check:
        print('Verified source inventory: %d files' % check_source_manifest(root))
    else:
        rendered = render_source_manifest(root)
        (root / MANIFEST_NAME).write_text(rendered)
        print('Updated source inventory: %d files; stage MANIFEST_SHA256.txt before packaging' % rendered.count('\n'))


if __name__ == '__main__':
    main()
