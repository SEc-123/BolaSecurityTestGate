#!/usr/bin/env python3
"""Start BSTG with an existing local Android/browser lab. Never installs/downloads.

The configuration is a trusted local file, not content from an APK or website.
Existing services are borrowed; shutdown stops only children started here.
"""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import time
import urllib.request
from urllib.parse import urlsplit

p = argparse.ArgumentParser()
p.add_argument('--config', required=True)
a = p.parse_args()
config = json.loads(Path(a.config).resolve().read_text())
root = Path(__file__).resolve().parents[2]
runtime = Path(config['runtime_directory']).resolve()
state = Path(config.get('state_directory', root / 'artifacts/local-lab')).resolve()
state.mkdir(parents=True, exist_ok=True, mode=0o700)
node = config['node_path']
sdk = runtime / 'android-sdk'
adb = sdk / 'platform-tools/adb'
serial = config['adb_serial']
if not re.fullmatch(r'emulator-\d+', serial):
    p.error('This launcher requires a dedicated local AVD serial')
port = int(config.get('port', 19440))
worker_port = int(config.get('worker_port', 19446))
appium_port = int(config.get('appium_port', 14723))
proxy_port = int(config.get('proxy_port', 19445))
if any(not 1024 <= number <= 65535 for number in [port, worker_port, appium_port, proxy_port]):
    p.error('All local service ports must be between 1024 and 65535')
if len({port, worker_port, appium_port, proxy_port}) != 4:
    p.error('Service ports must be distinct')
for binary in [Path(node), adb, sdk / 'emulator/emulator', runtime / 'appium/node_modules/.bin/appium', runtime / 'mitmproxy-venv/bin/mitmdump', root / 'server/dist/index.js']:
    if not binary.is_file():
        p.error('Required existing tool/build is missing: ' + str(binary))
env = dict(os.environ, ANDROID_HOME=str(sdk), ANDROID_AVD_HOME=str(runtime / 'avds'),
           APPIUM_HOME=str(runtime / 'appium-home'), JAVA_HOME=config['java_home'],
           BSTG_MITMDUMP_PATH=str(runtime / 'mitmproxy-venv/bin/mitmdump'),
           BSTG_DATA_DIR=str(state / 'data'), BSTG_HOST='127.0.0.1', PORT=str(port),
           BSTG_BROWSER_MODE='headless', BSTG_BROWSER_EXPOSE_NETWORK='<loopback>')
env['PATH'] = str(Path(node).parent) + os.pathsep + env['PATH']
if config.get('ai_timeout_ms') is not None:
    ai_timeout = int(config['ai_timeout_ms'])
    if not 1000 <= ai_timeout <= 1200000:
        p.error('ai_timeout_ms must be between 1000 and 1200000')
    env['BSTG_AI_TIMEOUT_MS'] = env['BSTG_AI_MIN_TIMEOUT_MS'] = str(ai_timeout)
if config.get('ai_reasoning_effort') is not None:
    effort = config['ai_reasoning_effort']
    if effort not in {'none', 'minimal', 'low', 'medium', 'high', 'xhigh'}:
        p.error('Unsupported ai_reasoning_effort')
    env['BSTG_AI_REASONING_EFFORT'] = effort

if config.get('target_ca'):
    env['NODE_EXTRA_CA_CERTS'] = str(Path(config['target_ca']).resolve())
children, logs = [], []

def request(url, data=None):
    req = urllib.request.Request(url, data=None if data is None else json.dumps(data).encode(),
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=4) as response:
        return json.load(response)

def ready(url):
    try:
        return bool(request(url))
    except Exception:
        return False

def run_adb(*args):
    result = subprocess.run([str(adb), '-s', serial, *args], env=env, capture_output=True, text=True, timeout=10)
    return result.stdout.strip() if result.returncode == 0 else ''

def start(name, argv, child_env=None):
    log = (state / (name + '.log')).open('w')
    logs.append(log)
    process = subprocess.Popen(list(map(str, argv)), cwd=root, env=child_env or env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    children.append(process)
    return process

def wait_for(check, timeout, label):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if any(child.poll() is not None for child in children):
            raise RuntimeError('A started service exited; see logs in ' + str(state))
        if check():
            return
        time.sleep(0.5)
    raise RuntimeError(label + ' did not become ready; see logs in ' + str(state))

def reachable_worker(endpoint):
    try:
        url = urlsplit(endpoint)
        if url.scheme != 'ws' or url.hostname != '127.0.0.1' or url.port != worker_port:
            return False
        with socket.create_connection((url.hostname, url.port), timeout=1):
            return True
    except Exception:
        return False

def worker_from_log():
    log = state / 'browser.log'
    if not log.is_file():
        return ''
    matches = re.findall(r'BSTG_BROWSER_WS_ENDPOINT=(ws://\S+)', log.read_text())
    return matches[-1] if matches else ''

def interrupted(_signal, _frame):
    raise KeyboardInterrupt

signal.signal(signal.SIGTERM, interrupted)

try:
    if ready(f'http://127.0.0.1:{port}/health'):
        raise RuntimeError('BSTG port is already in use; open the existing instance or choose another port')
    if run_adb('get-state') != 'device':
        if not re.fullmatch(r'emulator-\d+', serial):
            raise RuntimeError('Configured physical device is offline; connect it explicitly')
        start('emulator', [sdk / 'emulator/emulator', '-avd', config['avd_name'], '-port', serial.split('-')[1],
                           '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot', '-writable-system', '-gpu', 'swiftshader_indirect', '-memory', '2048'])
    wait_for(lambda: run_adb('shell', 'getprop', 'sys.boot_completed') == '1', 180, 'Android')
    appium_url = f'http://127.0.0.1:{appium_port}'
    if not ready(appium_url + '/status'):
        start('appium', [runtime / 'appium/node_modules/.bin/appium', '--address', '127.0.0.1', '--port', appium_port])
        wait_for(lambda: ready(appium_url + '/status'), 60, 'Appium')
    endpoint = config.get('browser_ws_endpoint') or worker_from_log()
    if not reachable_worker(endpoint):
        worker_env = dict(env, BSTG_RUNTIME_IMAGE=config['browser_image'], BSTG_WORKER_PORT=str(worker_port))
        if config.get('target_ca'):
            worker_env['BSTG_WORKER_CA'] = env['NODE_EXTRA_CA_CERTS']
        start('browser', [node, root / 'scripts/live-browser/local-container-runtime.mjs'], worker_env)
        wait_for(lambda: reachable_worker(worker_from_log()), 60, 'Browser worker')
        endpoint = worker_from_log()
    env['BSTG_BROWSER_WS_ENDPOINT'] = endpoint
    start('server', [node, root / 'scripts/start-server.mjs'])
    url = f'http://127.0.0.1:{port}'
    wait_for(lambda: ready(url + '/health'), 60, 'BSTG')
    profile_id = 'local-android-lab'
    profiles = request(url + '/api/mobile/profiles')['data']
    if not any(item['id'] == profile_id for item in profiles):
        request(url + '/api/mobile/profiles', {
            'id': profile_id, 'name': '本机 Android 测试环境', 'device_name': config.get('device_name', serial),
            'runtime_type': 'local_avd',
            'adb_serial': serial, 'android_api_level': int(config['android_api_level']),
            'appium_server_url': appium_url, 'proxy_type': 'mitmproxy', 'proxy_host': '127.0.0.1',
            'proxy_port': proxy_port, 'certificate_mode': 'preinstalled_system_ca', 'is_enabled': True,
            'config_json': {'managed_proxy': True, 'mitm_proxy_mode': 'regular',
                            'allow_system_ca_install': config.get('allow_system_ca_install') is True,
                            **({'upstream_ca_certificate_path': env['NODE_EXTRA_CA_CERTS']} if config.get('target_ca') else {})}})
    (state / 'ready.json').write_text(json.dumps({'url': url, 'device': serial, 'profile_id': profile_id}, indent=2))
    print('BSTG ready: ' + url + '  (Ctrl+C stops services started by this launcher)', flush=True)
    while True:
        if any(child.poll() is not None for child in children):
            raise RuntimeError('A service exited; see logs in ' + str(state))
        time.sleep(1)
except KeyboardInterrupt:
    pass
finally:
    for child in reversed(children):
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
    for log in logs:
        log.close()
