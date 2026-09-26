#!/usr/bin/env bash
# No Gradle dependency download; uses an already installed SDK + Java 17.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${ANDROID_SDK_ROOT:?Set ANDROID_SDK_ROOT}" "${BSTG_LAB_BASE_URL:?Set real HTTPS lab URL reachable by proxy}" "${BSTG_LAB_PROXY_CA:?Path to PUBLIC mitmproxy CA PEM}"
API="${BSTG_ANDROID_API:-35}"; BT="${BSTG_ANDROID_BUILD_TOOLS:-35.0.0}"
TOOLS="$ANDROID_SDK_ROOT/build-tools/$BT"; ANDROID="$ANDROID_SDK_ROOT/platforms/android-$API/android.jar"
for x in aapt2 d8 apksigner zipalign; do test -x "$TOOLS/$x" || { echo "Missing SDK tool $TOOLS/$x" >&2; exit 1; }; done
test -f "$ANDROID"; test -f "$BSTG_LAB_PROXY_CA"
command -v javac >/dev/null; command -v keytool >/dev/null; command -v zip >/dev/null
OUT="${BSTG_LAB_BUILD_DIR:-$HERE/build}"; mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"
# Never erase another build silently; choose a fresh directory.
test ! -e "$OUT/work" || { echo "Build work exists; select a fresh BSTG_LAB_BUILD_DIR" >&2; exit 1; }
mkdir -p "$OUT/work/res/raw" "$OUT/work/java" "$OUT/work/classes" "$OUT/work/dex"
cp -R "$HERE/native-app/res/." "$OUT/work/res/"; cp "$BSTG_LAB_PROXY_CA" "$OUT/work/res/raw/lab_proxy_ca.pem"
export OUT
python3 - <<'PY'
import json,os,pathlib,urllib.parse
base=os.environ['BSTG_LAB_BASE_URL'].rstrip('/'); u=urllib.parse.urlparse(base)
assert u.scheme=='https' and u.hostname and not u.username and not u.query and not u.fragment and u.path in ('','/'), 'HTTPS origin required'
port=int(os.environ.get('BSTG_LAB_PROXY_PORT','18080')); assert 1<=port<=65535
host=os.environ.get('BSTG_LAB_PROXY_HOST','127.0.0.1')
p=pathlib.Path(os.environ['OUT'])/'work/java/com/bstg/httpslab'; p.mkdir(parents=True,exist_ok=True)
(p/'LabConfig.java').write_text('package com.bstg.httpslab; public final class LabConfig { public static final String BASE_URL='+json.dumps(base)+'; public static final String PROXY_HOST='+json.dumps(host)+'; public static final int PROXY_PORT='+str(port)+'; }\n')
PY
"$TOOLS/aapt2" compile --dir "$OUT/work/res" -o "$OUT/work/resources.zip"
"$TOOLS/aapt2" link -o "$OUT/work/unsigned.apk" --manifest "$HERE/native-app/AndroidManifest.xml" -I "$ANDROID" --java "$OUT/work/java" "$OUT/work/resources.zip"
mapfile -t SOURCES < <(find "$HERE/native-app/src" "$OUT/work/java" -name '*.java' -print)
javac -encoding UTF-8 --release 8 -cp "$ANDROID" -d "$OUT/work/classes" "${SOURCES[@]}"
(cd "$OUT/work/classes" && jar cf "$OUT/work/classes.jar" .)
"$TOOLS/d8" --lib "$ANDROID" --min-api 26 --output "$OUT/work/dex" "$OUT/work/classes.jar"
(cd "$OUT/work/dex" && zip -q "$OUT/work/unsigned.apk" classes*.dex)
"$TOOLS/zipalign" -f 4 "$OUT/work/unsigned.apk" "$OUT/work/aligned.apk"
keytool -genkeypair -keystore "$OUT/debug-only.p12" -storetype PKCS12 -storepass android -keypass android -alias debug-only -keyalg RSA -keysize 2048 -validity 365 -dname 'CN=BSTG Test Fixture, O=Authorized Lab, C=US'
"$TOOLS/apksigner" sign --ks "$OUT/debug-only.p12" --ks-key-alias debug-only --ks-pass pass:android --key-pass pass:android --out "$OUT/bstg-https-lab.apk" "$OUT/work/aligned.apk"
"$TOOLS/apksigner" verify --verbose --print-certs "$OUT/bstg-https-lab.apk"
echo "Test-only APK: $OUT/bstg-https-lab.apk (never distribute the private debug key)"
