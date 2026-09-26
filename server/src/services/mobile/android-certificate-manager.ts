import crypto from 'crypto';
import { spawn } from 'node:child_process';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { runCommand } from './command-runner.js';
import { isOfflineProfile } from './mobile-target-contract.js';
import type { AndroidDeviceManager } from './android-device-manager.js';
import type { MobileLabProfile } from './mobile-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');

export interface ProxyCertificateEvidence {
  ok: boolean;
  mode: string;
  provisioning: 'managed_mitmproxy' | 'configured_path' | 'manual' | 'none';
  certificate_path?: string;
  sha256?: string;
  subject?: string;
  android_ca_hash?: string;
  installed_path?: string;
  install_verified?: boolean;
  error?: string;
  diagnostics?: Record<string, unknown>;
}

function text(value: unknown): string {
  return String(value || '').trim();
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function certPath(profile: MobileLabProfile): string {
  return text(profile.config_json?.proxy_ca_certificate_path || profile.config_json?.certificate_path);
}

async function digest(filePath: string): Promise<string> {
  const bytes = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(new crypto.X509Certificate(bytes).raw).digest('hex');
}

async function certificateInfo(filePath: string): Promise<{ ok: boolean; subject?: string; android_ca_hash?: string; error?: string }> {
  const subjectResult = await runCommand('openssl', ['x509', '-in', filePath, '-noout', '-subject'], { timeoutMs: 15000 }).catch(error => ({ ok: false, stderr: String(error?.message || error) } as any));
  if (!subjectResult.ok) return { ok: false, error: `Certificate is not a readable X.509 CA file: ${subjectResult.stderr || subjectResult.stdout || 'openssl failed'}` };
  const hashResult = await runCommand('openssl', ['x509', '-in', filePath, '-subject_hash_old', '-noout'], { timeoutMs: 15000 }).catch(error => ({ ok: false, stderr: String(error?.message || error) } as any));
  if (!hashResult.ok || !text(hashResult.stdout)) return { ok: false, error: `Unable to derive Android CA hash: ${hashResult.stderr || hashResult.stdout || 'openssl failed'}` };
  return { ok: true, subject: text(subjectResult.stdout), android_ca_hash: text(hashResult.stdout).split(/\s+/)[0] };
}

async function ensureManagedMitmproxyCertificate(profile: MobileLabProfile): Promise<{ ok: boolean; path?: string; error?: string; diagnostics?: Record<string, unknown> }> {
  const configuredDirectory = text(profile.config_json?.managed_proxy_confdir);
  const confdir = path.resolve(configuredDirectory || path.resolve(process.env.BSTG_DATA_DIR || path.join(PROJECT_ROOT, 'data'), 'mobile', 'proxy-ca', profile.id.replace(/[^a-zA-Z0-9_-]/g, '_')));
  const expectedPath = path.join(confdir, 'mitmproxy-ca-cert.pem');
  try {
    await fs.access(expectedPath);
    return { ok: true, path: expectedPath, diagnostics: { confdir, reused: true } };
  } catch {
    // Start mitmdump only long enough for it to initialize its CA store. It is not
    // treated as a running proxy; the caller still has to configure/start capture.
  }

  await fs.mkdir(confdir, { recursive: true, mode: 0o700 });
  const mitmdump = text(profile.config_json?.mitmdump_path) || 'mitmdump';
  // First Python import / CA generation can exceed a fixed two-second grace.
  // Wait for a parseable certificate, and always reap this bootstrap process.
  const child = spawn(mitmdump, ['--set', `confdir=${confdir}`, '--listen-host', '127.0.0.1', '--listen-port', '0'], { stdio: ['ignore','ignore','pipe'] });
  let failure = '', closed = false;
  child.stderr.on('data', chunk => { failure = (failure + chunk.toString()).slice(-2000); });
  child.once('error', error => { failure = error.message; closed = true; });
  const exited = new Promise<void>(resolve => { child.once('close', () => { closed = true; resolve(); }); });
  const budget = Math.min(60000, Math.max(3000, Number(profile.config_json?.ca_bootstrap_timeout_ms || 30000)));
  const deadline = Date.now() + budget;
  let ready = false;
  try {
    while (!closed && Date.now() < deadline) {
      try { new crypto.X509Certificate(await fs.readFile(expectedPath)); ready = true; break; } catch { /* wait for complete PEM */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  } finally {
    if (!closed) {
      child.kill('SIGTERM');
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 1500))]);
      if (!closed) { child.kill('SIGKILL'); await exited; }
    }
  }
  return ready
    ? { ok: true, path: expectedPath, diagnostics: { confdir, generated: true, mitmdump } }
    : { ok: false, error: `测试代理未能生成 CA 证书：${failure.trim() || '等待证书初始化超时'}。请检查 mitmdump 或提供已有代理证书。`, diagnostics: { confdir, mitmdump } };
}

export async function provisionProxyCertificate(profile: MobileLabProfile): Promise<ProxyCertificateEvidence> {
  if (isOfflineProfile(profile)) return { ok: true, mode: 'offline_simulator', provisioning: 'none', install_verified: true, diagnostics: { simulated: true } };
  if (profile.proxy_type === 'none') return { ok: true, mode: profile.certificate_mode, provisioning: 'none' };
  const provisioningMode = text(profile.config_json?.certificate_provisioning || 'managed_mitmproxy');
  let filePath = certPath(profile);
  let provisioning: ProxyCertificateEvidence['provisioning'] = 'configured_path';
  if (!filePath && provisioningMode === 'managed_mitmproxy') {
    const generated = await ensureManagedMitmproxyCertificate(profile);
    if (!generated.ok || !generated.path) return { ok: false, mode: profile.certificate_mode, provisioning: 'managed_mitmproxy', error: generated.error, diagnostics: generated.diagnostics };
    filePath = generated.path;
    provisioning = 'managed_mitmproxy';
  }
  if (!filePath) return { ok: false, mode: profile.certificate_mode, provisioning: 'manual', error: 'Strict HTTPS capture requires proxy_ca_certificate_path or certificate_provisioning=managed_mitmproxy.' };
  try {
    const [sha256, info] = await Promise.all([digest(filePath), certificateInfo(filePath)]);
    if (!info.ok) return { ok: false, mode: profile.certificate_mode, provisioning, certificate_path: filePath, sha256, error: info.error };
    const expectedDigest = text(profile.config_json?.proxy_ca_sha256);
    if (expectedDigest && expectedDigest.toLowerCase() !== sha256.toLowerCase()) {
      return { ok: false, mode: profile.certificate_mode, provisioning, certificate_path: filePath, sha256, subject: info.subject, android_ca_hash: info.android_ca_hash, error: `Proxy CA digest mismatch: expected ${expectedDigest}, received ${sha256}.` };
    }
    return { ok: true, mode: profile.certificate_mode, provisioning, certificate_path: filePath, sha256, subject: info.subject, android_ca_hash: info.android_ca_hash };
  } catch (error: any) {
    return { ok: false, mode: profile.certificate_mode, provisioning, certificate_path: filePath, error: `Unable to read proxy CA: ${error?.message || String(error)}` };
  }
}

export async function installAndVerifyProxyCertificate(profile: MobileLabProfile, android: AndroidDeviceManager, certificate: ProxyCertificateEvidence): Promise<ProxyCertificateEvidence> {
  if (!certificate.ok || profile.proxy_type === 'none' || isOfflineProfile(profile)) return certificate;
  const mode = profile.certificate_mode;
  if (mode === 'manual_verified') {
    const verified = bool(profile.config_json?.manual_certificate_verified) && text(profile.config_json?.manual_certificate_evidence);
    return verified
      ? { ...certificate, install_verified: true, diagnostics: { ...certificate.diagnostics, manual_certificate_evidence: text(profile.config_json?.manual_certificate_evidence) } }
      : { ...certificate, ok: false, install_verified: false, error: 'manual_verified certificate mode requires manual_certificate_verified=true and manual_certificate_evidence.' };
  }
  if (mode === 'debug_overrides_user_ca' || mode === 'preinstalled_user_ca') {
    return { ...certificate, ok: false, install_verified: false, error: `${mode} cannot be verified generically by ADB. Use a debug test build with a documented trust override and set certificate_mode=manual_verified with evidence, or use a rootable local AVD with preinstalled_system_ca.` };
  }
  if (mode !== 'preinstalled_system_ca') return { ...certificate, ok: false, install_verified: false, error: `Unsupported certificate_mode for strict real E2E: ${mode}.` };
  if (certificate.android_ca_hash && certificate.sha256) {
    const stores = Number(profile.android_api_level || 0) >= 34 ? ['/apex/com.android.conscrypt/cacerts'] : ['/system/etc/security/cacerts'];
    for (const store of stores) {
      const existing = await android.runAdb(['shell', 'cat', `${store}/${certificate.android_ca_hash}.0`], 10000);
      try {
        const fingerprint = crypto.createHash('sha256').update(new crypto.X509Certificate(existing.stdout).raw).digest('hex');
        if (existing.ok && fingerprint === certificate.sha256) return { ...certificate, installed_path: `${store}/${certificate.android_ca_hash}.0`, install_verified: true, diagnostics: { ...certificate.diagnostics, already_installed: true } };
      } catch { /* Not the expected readable certificate. */ }
    }
  }
  if (Number(profile.android_api_level || 0) >= 34) return { ...certificate, ok: false, install_verified: false, error: 'Android 14+ trust store provisioning must be performed in the authorized lab image or documented debug build; copying into /system is not accepted as proof of effective trust.' };
  if (profile.runtime_type !== 'local_avd' && bool(profile.config_json?.allow_system_ca_install)) return { ...certificate, ok: false, install_verified: false, error: 'Automatic root/system CA changes are restricted to explicitly authorized local AVD profiles.' };
  if (!bool(profile.config_json?.allow_system_ca_install)) {
    return { ...certificate, ok: false, install_verified: false, error: 'System CA installation is disabled. Set allow_system_ca_install=true only for an authorized, rootable local AVD.' };
  }
  if (!certificate.certificate_path || !certificate.android_ca_hash) return { ...certificate, ok: false, install_verified: false, error: 'Certificate path or Android CA hash is unavailable.' };

  const remoteTemp = `/data/local/tmp/bstg-proxy-ca-${certificate.android_ca_hash}.0`;
  const remoteStore = `/system/etc/security/cacerts/${certificate.android_ca_hash}.0`;
  const root = await android.runAdb(['root'], 30000);
  if (!root.ok || !/restarting adbd as root|already running as root/i.test(`${root.stdout}\n${root.stderr}`)) {
    return { ...certificate, ok: false, install_verified: false, error: `ADB root is required for managed system CA installation on a local AVD: ${root.stderr || root.stdout}` };
  }
  await android.waitForDevice(30000);
  let remount = await android.runAdb(['remount'], 30000);
  const needsReboot = (result: {stdout: string; stderr: string}) => /now reboot|reboot.*take effect|reboot is required/i.test(`${result.stdout} ${result.stderr}`);
  if (remount.ok && needsReboot(remount)) {
    // Authorized dedicated AVD only (validated above). adb remount may return 0
    // after disabling verity even though the store is still read-only.
    // AOSP's AVD remount procedure also disables AVB verification before reboot;
    // verity alone can leave API 29/30 images in a vbmeta digest boot loop.
    // https://android.googlesource.com/device/generic/car/+/refs/heads/main/tools/remount.sh
    if (Number(profile.android_api_level || 0) >= 29) {
      const avb = await android.runAdb(['shell', 'avbctl', 'disable-verification'], 15000);
      if (!avb.ok) return { ...certificate, ok:false, install_verified:false, error:`测试镜像无法完成 AVB 准备，未继续重启：${avb.stderr || avb.stdout}` };
    }
    const reboot = await android.runAdb(['reboot'], 15000);
    if (!reboot.ok) return { ...certificate, ok:false, install_verified:false, error:'测试模拟器需要重启才能写入证书，但重启失败。' };
    await android.runAdb(['wait-for-disconnect'], 15000);
    const boot = await android.waitForDevice(Math.min(240000, Math.max(90000, Number(profile.config_json?.device_wait_timeout_ms || 90000))));
    if (!boot.ok) return { ...certificate, ok:false, install_verified:false, error:'测试模拟器重启后未就绪，证书尚未安装。', diagnostics:{...certificate.diagnostics,boot} };
    await android.runAdb(['root'], 30000);
    await android.waitForDevice(30000);
    remount = await android.runAdb(['remount'], 30000);
  }
  if (!remount.ok || needsReboot(remount)) return { ...certificate, ok: false, install_verified: false, error: `Unable to remount authorized AVD system partition: ${remount.stderr || remount.stdout}` };
  const push = await android.runAdb(['push', certificate.certificate_path, remoteTemp], 30000);
  if (!push.ok) return { ...certificate, ok: false, install_verified: false, error: `Unable to push proxy CA to AVD: ${push.stderr || push.stdout}` };
  const install = await android.runAdb(['shell', 'cp', remoteTemp, remoteStore], 30000);
  const chmod = await android.runAdb(['shell', 'chmod', '644', remoteStore], 15000);
  const verify = await android.runAdb(['shell', 'cat', remoteStore], 15000);
  let verifiedDigest = '';
  try { verifiedDigest = crypto.createHash('sha256').update(new crypto.X509Certificate(verify.stdout).raw).digest('hex'); } catch {}
  const installed = install.ok && chmod.ok && verify.ok && verifiedDigest === certificate.sha256;
  return installed
    ? { ...certificate, installed_path: remoteStore, install_verified: true, diagnostics: { ...certificate.diagnostics, adb_root: root.stdout || root.stderr, remount: remount.stdout || remount.stderr } }
    : { ...certificate, ok: false, installed_path: remoteStore, install_verified: false, error: `Proxy CA could not be verified in the Android system trust store: ${(!install.ok && (install.stderr || install.stdout)) || (!chmod.ok && (chmod.stderr || chmod.stdout)) || verify.stderr || verify.stdout}` };
}
