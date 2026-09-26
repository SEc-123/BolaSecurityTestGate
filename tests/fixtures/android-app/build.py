#!/usr/bin/env python3
"""Build a signed controlled APK using installed Android SDK tools, without Gradle downloads."""
import argparse, os, pathlib, subprocess, json, hashlib, zipfile
p=argparse.ArgumentParser();p.add_argument('--sdk',required=True);p.add_argument('--java-home',required=True);p.add_argument('--base-url',required=True);p.add_argument('--output',required=True);a=p.parse_args()
from urllib.parse import urlparse
u=urlparse(a.base_url)
if u.scheme!='https' or u.hostname not in ['localhost','127.0.0.1','10.0.2.2']:p.error('Only a controlled local HTTPS target is supported')
sdk=pathlib.Path(a.sdk).resolve();java=pathlib.Path(a.java_home).resolve();out=pathlib.Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
root=pathlib.Path(__file__).resolve().parent
build=sorted((sdk/'build-tools').iterdir(),key=lambda d:[int(x) for x in d.name.split('.') if x.isdigit()])[-1]
platform=sorted((sdk/'platforms').glob('android-*'),key=lambda d:int(d.name.split('-')[1].split('.')[0]))[-1]/'android.jar'
env={**os.environ,'JAVA_HOME':str(java),'PATH':str(java/'bin')+os.pathsep+os.environ['PATH']}
def run(args):subprocess.run([str(x) for x in args],check=True,env=env,cwd=out)
classes=out/'classes';classes.mkdir(exist_ok=True)
config=out/'BuildConfig.java';config.write_text('package com.bstg.acceptance; public final class BuildConfig { public static final String BASE_URL = '+json.dumps(a.base_url.rstrip('/'))+'; }')
run([java/'bin/javac','--release','8','-classpath',platform,'-d',classes,config,root/'src/com/bstg/acceptance/MainActivity.java'])
run([build/'d8','--lib',platform,'--output',out,*classes.rglob('*.class')])
raw=out/'unaligned.apk';run([build/'aapt','package','-f','-M',root/'AndroidManifest.xml','-I',platform,'-F',raw])
with zipfile.ZipFile(raw,'a') as z:z.write(out/'classes.dex','classes.dex')
aligned=out/'aligned.apk';run([build/'zipalign','-f','4',raw,aligned])
key=out/'acceptance.p12'
if not key.exists():run([java/'bin/keytool','-genkeypair','-keystore',key,'-alias','acceptance','-storepass','acceptance-test-only','-keypass','acceptance-test-only','-dname','CN=BSTG Local Acceptance','-keyalg','RSA','-validity','3650'])
apk=out/'bstg-acceptance.apk';run([build/'apksigner','sign','--ks',key,'--ks-pass','pass:acceptance-test-only','--out',apk,aligned]);run([build/'apksigner','verify','--verbose',apk])
print(json.dumps({'apk':str(apk),'sha256':hashlib.sha256(apk.read_bytes()).hexdigest(),'base_url':a.base_url}))
