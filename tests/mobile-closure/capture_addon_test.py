"""Production addon logic with explicit HTTPFlow/mitmproxy module TEST DOUBLES.
This is not a claim of executing mitmproxy or Android TLS handshakes.
"""
import importlib.util, json, os, pathlib, sys, tempfile, types, unittest, time
from unittest.mock import patch
from datetime import datetime, timezone
ADDON=pathlib.Path(__file__).resolve().parents[2]/'scripts/mobile-lab/mitm-jsonl-capture.py'
class Headers(dict):
    def items(self, multi=False):
        return list(super().items()) + ([('set-cookie','second=2')] if multi and 'set-cookie' in self else [])
class CaptureAddonTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.output=pathlib.Path(self.temp.name)/'nested'/'flows.jsonl'
        self.env=patch.dict(os.environ,{'BSTG_CAPTURE_OUTPUT':str(self.output),'BSTG_CAPTURE_TARGET_PACKAGE':'test.app','BSTG_CAPTURE_DEVICE_ID':'test-device','BSTG_CAPTURE_SESSION_ID':'nonce','BSTG_CAPTURE_ALLOWED_HOSTS':'["api.example.test"]'})
        self.env.start();self.addCleanup(self.env.stop)
        fake=types.ModuleType('mitmproxy');fake.http=types.SimpleNamespace(HTTPFlow=object);fake.ctx=types.SimpleNamespace(options=types.SimpleNamespace(ssl_insecure=False))
        with patch.dict(sys.modules,{'mitmproxy':fake}):
            spec=importlib.util.spec_from_file_location('addon_under_test',ADDON)
            self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)
        self.addon=self.module.BstgJsonlCapture()
    def flow(self):
        request=types.SimpleNamespace(host='api.example.test',method='GET',scheme='https',pretty_url='https://api.example.test/orders',headers=Headers(),raw_content=b'',content=b'',get_text=lambda strict=False:'',timestamp_start=time.time())
        response=types.SimpleNamespace(status_code=200,headers=Headers(),raw_content=b'{}',content=b'{}',get_text=lambda strict=False:'{}',timestamp_end=time.time())
        return types.SimpleNamespace(id='flow-id',metadata={},request=request,response=response,client_conn=types.SimpleNamespace(tls_version='TLSv1.3'),server_conn=types.SimpleNamespace(tls_version='TLSv1.3'))
    def records(self):
        return [json.loads(line) for line in self.output.read_text().splitlines()] if self.output.exists() else []
    def scope(self,step='step',expires=60):
        value={'run_id':'run','step_id':step,'capture_session_id':'nonce','expires_at':datetime.fromtimestamp(time.time()+expires,timezone.utc).isoformat()}
        path=pathlib.Path(self.module.STEP_FILE);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(value))
    def test_completed_tls_response_contains_scope_and_both_tls_legs(self):
        self.scope();f=self.flow();self.addon.requestheaders(f);self.addon.response(f);r=self.records()[0]
        self.assertEqual(r['capture_session_id'],'nonce');self.assertEqual(r['device_id'],'test-device');self.assertEqual(r['test_run_id'],'run');self.assertEqual(r['step_id'],'step')
        self.assertTrue(r['tls']['upstream_verified']);self.assertTrue(r['request_complete']);self.assertTrue(r['response_complete']);self.assertEqual(self.output.stat().st_mode & 0o777,0o600)
    def test_wrong_host_is_discarded(self):
        f=self.flow();f.request.host='other.example.test';self.addon.response(f);self.assertEqual(self.records(),[])
    def test_cleartext_is_not_promoted_to_tls(self):
        f=self.flow();f.client_conn.tls_version=None;self.addon.response(f);self.assertEqual(self.records(),[])
    def test_reverse_http_is_never_rewritten_to_https(self):
        f=self.flow();f.request.scheme='http';f.request.pretty_url='http://api.example.test/orders';self.addon.response(f);self.assertEqual(self.records(),[])
    def test_connect_is_not_an_application_response(self):
        f=self.flow();f.request.method='CONNECT';self.addon.response(f);self.assertEqual(self.records(),[])
    def test_incomplete_response_is_not_captured(self):
        f=self.flow();f.response=None;self.addon.response(f);self.assertEqual(self.records(),[])
    def test_streamed_body_is_not_an_empty_complete_body(self):
        f=self.flow();f.response.raw_content=None;self.addon.response(f);self.assertEqual(self.records(),[])
    def test_oversized_decoded_payload_is_not_truncated_into_evidence(self):
        f=self.flow();f.response.content=b'x'*(2*1024*1024+1);self.addon.response(f);self.assertEqual(self.records(),[])
    def test_missing_capture_nonce_disables_capture(self):
        self.module.CAPTURE_SESSION='';self.addon.response(self.flow());self.assertEqual(self.records(),[])
    def test_sequence_is_monotonic_and_host_matching_case_insensitive(self):
        f=self.flow();f.request.host='API.EXAMPLE.TEST';self.addon.response(f);self.addon.response(f);self.assertEqual([r['sequence'] for r in self.records()],[1,2])
    def test_no_upstream_tls_blocks_even_when_client_tls_exists(self):
        f=self.flow();f.server_conn.tls_version=None;self.addon.response(f);self.assertEqual(self.records(),[])
    def test_insecure_upstream_blocks(self):
        self.module.ctx.options.ssl_insecure=True;self.addon.response(self.flow());self.assertEqual(self.records(),[])
    def test_late_response_keeps_original_request_step(self):
        self.scope('first');f=self.flow();self.addon.requestheaders(f);self.scope('second');self.addon.response(f);self.assertEqual(self.records()[0]['step_id'],'first')
    def test_expired_step_is_not_attributed(self):
        self.scope(expires=-1);f=self.flow();self.addon.requestheaders(f);self.addon.response(f);self.assertIsNone(self.records()[0]['step_id'])
    def test_missing_step_is_not_attributed_to_latest_response_time(self):
        f=self.flow();self.addon.requestheaders(f);self.scope('later');self.addon.response(f);self.assertIsNone(self.records()[0]['step_id'])
    def test_duplicate_headers_and_original_encoded_body_are_preserved(self):
        f=self.flow();f.response.headers['set-cookie']='first=1';f.response.raw_content=b'encoded';self.addon.response(f);r=self.records()[0];self.assertEqual(len(r['response_headers_raw']),2);self.assertEqual(r['response_raw_body_base64'],'ZW5jb2RlZA==')
    def test_tls_client_failure_creates_diagnostic_not_success(self):
        self.scope();self.addon.tls_failed_client(types.SimpleNamespace(conn=types.SimpleNamespace(sni='api.example.test')));self.assertEqual(self.records(),[])
        d=json.loads(pathlib.Path(self.module.DIAGNOSTICS).read_text());self.assertIn('handshake_failed',d['event']);self.assertEqual(d['step_id'],'step')
    def test_transport_error_is_diagnostic_not_fabricated_response(self):
        f=self.flow();self.addon.error(f);self.assertEqual(self.records(),[]);self.assertTrue(pathlib.Path(self.module.DIAGNOSTICS).exists())
if __name__=='__main__':unittest.main(verbosity=2)
