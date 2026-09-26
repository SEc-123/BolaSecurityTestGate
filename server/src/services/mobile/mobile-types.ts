export type MobileRuntimeType = 'local_avd' | 'docker' | 'redroid' | 'remote' | 'manual';
export type MobileProxyType = 'internal_burp' | 'external_burp' | 'mitmproxy' | 'none';
export type MobileCertificateMode = 'preinstalled_user_ca' | 'preinstalled_system_ca' | 'debug_overrides_user_ca' | 'manual_verified' | 'unknown';
export type MobileSessionStatus = 'created' | 'starting' | 'ready' | 'running' | 'blocked' | 'failed' | 'stopped';
export type MobileCaptureStatus = 'unknown' | 'not_started' | 'http_only' | 'https_decrypted' | 'tls_not_decrypted' | 'cert_not_trusted' | 'pinning_suspected' | 'no_traffic' | 'imported';

export interface MobileLabProfile {
  id: string;
  name: string;
  description?: string;
  runtime_type: MobileRuntimeType;
  android_api_level?: number;
  device_name?: string;
  adb_serial?: string;
  appium_server_url?: string;
  proxy_type: MobileProxyType;
  proxy_host?: string;
  proxy_port?: number;
  certificate_mode: MobileCertificateMode;
  config_json: Record<string, any>;
  is_enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface MobileSession {
  id: string;
  scan_run_id?: string;
  profile_id: string;
  device_id?: string;
  app_package?: string;
  app_activity?: string;
  apk_path?: string;
  apk_source?: string;
  apk_sha256?: string;
  apk_signer_sha256?: string;
  apk_package_name?: string;
  apk_launch_activity?: string;
  apk_native_abis?: string[];
  certificate_evidence?: Record<string, any>;
  status: MobileSessionStatus;
  capture_status: MobileCaptureStatus;
  screen_stream_url?: string;
  recording_session_id?: string;
  health_json: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

export interface MobileActionRecord {
  id: string;
  session_id: string;
  scan_run_id?: string;
  task_id?: string;
  sequence: number;
  action_type: string;
  input_json: Record<string, any>;
  result_json: Record<string, any>;
  screenshot_artifact_id?: string;
  status: string;
  created_at?: string;
  updated_at?: string;
}

export interface MobileUiNode {
  index: number;
  className?: string;
  text?: string;
  resourceId?: string;
  contentDesc?: string;
  bounds?: [number, number, number, number];
  clickable?: boolean;
  enabled?: boolean;
  password?: boolean;
  input?: boolean;
}

export interface MobileObservation {
  session_id: string;
  observed_at?: string;
  device_id?: string;
  package?: string;
  activity?: string;
  screenshot_base64?: string;
  ui_tree: MobileUiNode[];
  suggested_actions: Array<Record<string, any>>;
  health?: Record<string, any>;
}

export interface NormalizedHttpFlow {
  test_run_id?: string;
  step_id?: string;
  completed_at?: string;
  request_complete?: boolean;
  response_complete?: boolean;
  request_headers_raw?: Array<[string, string]>;
  response_headers_raw?: Array<[string, string]>;
  request_raw_body_base64?: string;
  response_raw_body_base64?: string;
  request_body_base64?: string;
  response_body_base64?: string;
  tls?: { client_version?: string; server_version?: string; upstream_verified?: boolean; client_alpn?: string; server_alpn?: string };
  sequence?: number;
  flow_id?: string;
  capture_session_id?: string;
  attribution?: string;
  method: string;
  url: string;
  request_headers?: Record<string, any>;
  request_body_text?: string;
  response_status?: number;
  response_headers?: Record<string, any>;
  response_body_text?: string;
  source_tool?: string;
  tls_decrypted?: boolean;
  app_package?: string;
  device_id?: string;
  started_at?: string;
}

export interface MobileHealthCheck {
  status: 'ready' | 'blocked' | 'warning';
  checks: Array<{ name: string; ok: boolean; status?: string; details?: Record<string, any>; message?: string }>;
  capture_status: MobileCaptureStatus;
  summary: string;
}
