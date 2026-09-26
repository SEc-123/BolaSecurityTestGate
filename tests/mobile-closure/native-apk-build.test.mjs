/** Synthetic source-collection regression only: no SDK, APK, Java, or device execution. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('native APK build passes each Java source as one argument on the system Bash', {
  skip: process.platform === 'win32' ? 'The build script targets Linux/macOS Bash.' : false,
}, t => {
  const script = readFileSync(new URL('../../examples/appium-https/build-native-apk.sh', import.meta.url), 'utf8');
  // Execute the production collection and javac call, bounded by adjacent SDK stages.
  // Extracting this slice keeps the regression independent of real SDK/Java tools.
  const compilation = script.match(/^"\$TOOLS\/aapt2" link[^\n]*\n([\s\S]*?)^\(cd "\$OUT\/work\/classes" && jar /m)?.[1];
  assert.ok(compilation, 'the source-collection and javac stage must be found');

  const temporary = mkdtempSync(path.join(os.tmpdir(), 'bstg native sources '));
  t.after(() => rmSync(temporary, { recursive: true, force: true }));
  const here = path.join(temporary, 'reference app');
  const out = path.join(temporary, 'generated build');
  const android = path.join(temporary, 'sdk directory/android.jar');
  const argumentsFile = path.join(temporary, 'javac arguments');
  const sources = [
    path.join(here, 'native-app/src/Main.java'),
    path.join(here, 'native-app/src/source directory/With Spaces.java'),
    path.join(here, 'native-app/src/source directory/With\tTab\\Slash\nNewline.java'),
    path.join(out, 'work/java/com/bstg/httpslab/LabConfig.java'),
    path.join(out, 'work/java/generated sources/R.java'),
  ];
  for (const filename of sources) {
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, '// synthetic source fixture\n');
  }
  writeFileSync(path.join(here, 'native-app/src/ignored.txt'), 'not Java');

  const version = spawnSync('/bin/bash', ['--version'], { encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  t.diagnostic(version.stdout.split('\n')[0]);
  const child = spawnSync('/bin/bash', ['--noprofile', '--norc', '-c', `
set -euo pipefail
javac() { printf '%s\\0' "$@" > "$ARGUMENTS_FILE"; }
${compilation}
`], {
    encoding: 'utf8',
    timeout: 10000,
    env: { PATH: '/usr/bin:/bin', HERE: here, OUT: out, ANDROID: android, ARGUMENTS_FILE: argumentsFile },
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const args = readFileSync(argumentsFile, 'utf8').split('\0');
  assert.equal(args.pop(), '', 'the javac spy must terminate each argument');
  assert.deepEqual(args.slice(0, 8), ['-encoding', 'UTF-8', '--release', '8', '-cp', android, '-d', path.join(out, 'work/classes')]);
  assert.deepEqual(args.slice(8).sort(), sources.sort(), 'include native and generated Java sources exactly once without splitting paths');
});
