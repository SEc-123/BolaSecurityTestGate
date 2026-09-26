"""Authorized, isolated-device HTTPS test evidence; not UID-level attribution.

Never rewrites HTTP to HTTPS. Both TLS legs and complete messages are recorded.
Step context is frozen at requestheaders, not borrowed when a response arrives.
"""
import base64
import json
import os
import threading
import time
from datetime import datetime, timezone
from mitmproxy import http, ctx

OUTPUT_PATH = os.environ.get('BSTG_CAPTURE_OUTPUT', '')
STEP_FILE = os.environ.get('BSTG_CAPTURE_STEP_FILE', OUTPUT_PATH + '.step.json')
DIAGNOSTICS = os.environ.get('BSTG_CAPTURE_DIAGNOSTICS', OUTPUT_PATH + '.diagnostics.jsonl')
TARGET_PACKAGE = os.environ.get('BSTG_CAPTURE_TARGET_PACKAGE', '').strip()
TARGET_DEVICE = os.environ.get('BSTG_CAPTURE_DEVICE_ID', '').strip()
CAPTURE_SESSION = os.environ.get('BSTG_CAPTURE_SESSION_ID', '').strip()
ALLOWED_HOSTS = {str(x).lower() for x in json.loads(os.environ.get('BSTG_CAPTURE_ALLOWED_HOSTS', '[]'))}
ALLOW_HTTP = os.environ.get('BSTG_CAPTURE_ALLOW_HTTP') == 'true'
LOCK = threading.Lock()
BODY_LIMIT = 2 * 1024 * 1024


def iso(ts=None):
    return datetime.fromtimestamp(ts if ts is not None else time.time(), timezone.utc).isoformat()


def write_jsonl(path, record):
    if not path:
        return
    os.makedirs(os.path.dirname(os.path.abspath(path)), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, 'a', encoding='utf-8') as handle:
        handle.write(json.dumps(record, ensure_ascii=False) + '\n')
        handle.flush()


def step_context():
    try:
        with open(STEP_FILE, encoding='utf-8') as handle:
            value = json.load(handle)
        if value.get('capture_session_id') != CAPTURE_SESSION or not value.get('run_id') or not value.get('step_id'):
            return {}
        if datetime.fromisoformat(value['expires_at'].replace('Z', '+00:00')).timestamp() < time.time():
            return {}
        return value
    except (OSError, ValueError, KeyError, TypeError):
        return {}


def alpn(connection):
    value = getattr(connection, 'alpn', None)
    return value.decode('ascii', errors='replace') if isinstance(value, bytes) else value


class BstgJsonlCapture:
    def __init__(self):
        self.sequence = 0

    def diagnostic(self, code, flow=None, host=None):
        scope = flow.metadata.get('bstg_scope', {}) if flow is not None else step_context()
        record = {'event': code, 'at': iso(), 'capture_session_id': CAPTURE_SESSION,
                  'test_run_id': scope.get('run_id'), 'step_id': scope.get('step_id'),
                  'flow_id': str(flow.id) if flow is not None else None, 'host': host,
                  'device_id': TARGET_DEVICE, 'app_package': TARGET_PACKAGE}
        # Never persist TLS library errors or full URLs: they can contain secrets.
        with LOCK:
            write_jsonl(DIAGNOSTICS, record)

    def requestheaders(self, flow: http.HTTPFlow):
        flow.metadata['bstg_scope'] = step_context()

    def response(self, flow: http.HTTPFlow):
        if not all([OUTPUT_PATH, TARGET_PACKAGE, TARGET_DEVICE, CAPTURE_SESSION, ALLOWED_HOSTS]):
            return
        if flow.response is None or flow.request is None:
            return
        host = str(flow.request.host).lower()
        if host not in ALLOWED_HOSTS:
            return
        if flow.request.method == 'CONNECT':
            return
        plaintext = ALLOW_HTTP and flow.request.scheme == 'http'
        if not plaintext and (flow.request.scheme != 'https' or not flow.client_conn.tls_version):
            self.diagnostic('plaintext_or_no_client_tls', flow, host)
            return
        if not plaintext and (not flow.server_conn.tls_version or ctx.options.ssl_insecure):
            self.diagnostic('upstream_tls_not_verified', flow, host)
            return
        # raw_content=None means unavailable/streamed, not an empty body.
        if flow.request.raw_content is None or flow.response.raw_content is None:
            self.diagnostic('incomplete_streamed_body', flow, host)
            return
        try:
            request_bytes = flow.request.content
            response_bytes = flow.response.content
        except ValueError:
            self.diagnostic('body_decode_failed', flow, host)
            return
        if request_bytes is None or response_bytes is None or max(len(request_bytes), len(response_bytes)) > BODY_LIMIT:
            self.diagnostic('body_limit_or_incomplete', flow, host)
            return
        try:
            request_text = flow.request.get_text(strict=True)
            response_text = flow.response.get_text(strict=True)
        except ValueError:
            self.diagnostic('binary_body_requires_adapter', flow, host)
            return
        scope = flow.metadata.get('bstg_scope', {})
        record = {
            'flow_id': str(flow.id), 'capture_session_id': CAPTURE_SESSION,
            'test_run_id': scope.get('run_id'), 'step_id': scope.get('step_id'),
            'attribution': 'operator_isolated_device_and_host_allowlist',
            'method': flow.request.method, 'url': str(flow.request.pretty_url),
            'request_headers': dict(flow.request.headers.items()),
            'request_headers_raw': list(flow.request.headers.items(multi=True)),
            'request_raw_body_base64': base64.b64encode(flow.request.raw_content).decode('ascii'),
            'request_body_text': request_text, 'request_body_base64': base64.b64encode(request_bytes).decode('ascii'),
            'response_status': flow.response.status_code,
            'response_headers': dict(flow.response.headers.items()),
            'response_headers_raw': list(flow.response.headers.items(multi=True)),
            'response_raw_body_base64': base64.b64encode(flow.response.raw_content).decode('ascii'),
            'response_body_text': response_text, 'response_body_base64': base64.b64encode(response_bytes).decode('ascii'),
            'request_complete': True, 'response_complete': True,
            'source_tool': 'mitmproxy_real_android', 'tls_decrypted': not plaintext,
            'tls': {'client_version': flow.client_conn.tls_version, 'server_version': flow.server_conn.tls_version,
                    'upstream_verified': not ctx.options.ssl_insecure,
                    'client_alpn': alpn(flow.client_conn), 'server_alpn': alpn(flow.server_conn)},
            'app_package': TARGET_PACKAGE, 'device_id': TARGET_DEVICE,
            'started_at': iso(flow.request.timestamp_start), 'completed_at': iso(flow.response.timestamp_end),
        }
        with LOCK:
            self.sequence += 1
            record['sequence'] = self.sequence
            write_jsonl(OUTPUT_PATH, record)

    def error(self, flow: http.HTTPFlow):
        if flow.request and str(flow.request.host).lower() in ALLOWED_HOSTS:
            self.diagnostic('request_or_response_transport_error', flow, flow.request.host)

    def tls_failed_client(self, data):
        host = getattr(data.conn, 'sni', None)
        if host in ALLOWED_HOSTS:
            self.diagnostic('client_tls_handshake_failed_trust_or_pinning_possible', host=host)

    def tls_failed_server(self, data):
        host = getattr(data.conn, 'sni', None)
        if host in ALLOWED_HOSTS:
            self.diagnostic('upstream_tls_handshake_failed', host=host)


addons = [BstgJsonlCapture()]
