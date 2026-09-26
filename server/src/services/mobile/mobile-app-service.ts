import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { runCommand } from './command-runner.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../../..');
const DEFAULT_UPLOAD_DIR = path.resolve(PROJECT_ROOT, 'mobile-lab/uploads');

export interface ImportedMobileApp {
  id: string;
  filename: string;
  original_filename: string;
  apk_path: string;
  apk_source: string;
  sha256: string;
  signer_sha256?: string;
  signature_verified: boolean;
  size_bytes: number;
  package_name?: string;
  launch_activity?: string;
  app_label?: string;
  native_abis?: string[];
  inspect_status: 'detected' | 'partial' | 'not_available';
  inspect_summary: string;
}

export interface MobileApkAttestation {
  apk_path: string;
  sha256: string;
  size_bytes: number;
  package_name?: string;
  launch_activity?: string;
  signer_sha256?: string;
  native_abis?: string[];
  signature_verified: boolean;
  inspect_status: ImportedMobileApp['inspect_status'];
  inspect_summary: string;
}

function sanitizeFilename(filename: string): string {
  const base = path.basename(String(filename || 'app.apk')).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return base.toLowerCase().endsWith('.apk') ? base : `${base}.apk`;
}

function extractAaptValue(text: string, name: string): string | undefined {
  const re = new RegExp(`${name}='([^']+)'`);
  return text.match(re)?.[1];
}

async function inspectWithAapt(apkPath: string, aaptPath?: string): Promise<Pick<ImportedMobileApp, 'package_name' | 'launch_activity' | 'app_label' | 'native_abis' | 'inspect_status' | 'inspect_summary'>> {
  const configured = aaptPath || process.env.BSTG_MOBILE_AAPT_PATH || process.env.AAPT_PATH || '';
  const candidates = configured ? [configured] : ['aapt'];
  for (const command of candidates) {
    const result = await runCommand(command, ['dump', 'badging', apkPath], { timeoutMs: 20000 }).catch(error => ({ ok: false, stdout: '', stderr: String(error?.message || error) } as any));
    if (!result.ok) continue;
    const stdout = String(result.stdout || '');
    const package_name = stdout.match(/^package:\s+name='([^']+)'/m)?.[1];
    const launch_activity = stdout.match(/^launchable-activity:\s+name='([^']+)'/m)?.[1];
    const label = stdout.match(/^application-label(?:-[^:]+)?:'([^']+)'/m)?.[1];
    const app_label = label || extractAaptValue(stdout, 'label');
    const native_abis = Array.from(stdout.matchAll(/^native-code:\s+(.+)$/gm)).flatMap(match => Array.from(match[1].matchAll(/'([^']+)'/g)).map(item => item[1]));
    const detected = Boolean(package_name || launch_activity || app_label);
    return {
      package_name,
      launch_activity,
      app_label,
      native_abis,
      inspect_status: detected && package_name ? 'detected' : detected ? 'partial' : 'not_available',
      inspect_summary: detected
        ? 'APK metadata detected. Agent will use this automatically during the Android assessment.'
        : 'APK saved, but metadata was not available from local tools. Agent will detect the package after install when possible.',
    };
  }
  return {
    inspect_status: 'not_available',
    native_abis: [],
    inspect_summary: 'APK saved. Local aapt was not available, so Agent will detect the package after install when possible.',
  };
}

async function inspectApkSigner(apkPath: string, apksignerPath?: string): Promise<{ signature_verified: boolean; signer_sha256?: string }> {
  const configured = apksignerPath || process.env.BSTG_MOBILE_APKSIGNER_PATH || process.env.APKSIGNER_PATH || '';
  const candidates = configured ? [configured] : ['apksigner'];
  for (const command of candidates) {
    const result = await runCommand(command, ['verify', '--verbose', '--print-certs', apkPath], { timeoutMs: 30000 }).catch(() => null);
    if (!result?.ok) continue;
    const allOutput = `${result.stdout || ''}\n${result.stderr || ''}`;
    const signer_sha256 = allOutput.match(/Signer #1 certificate SHA-256 digest:\s*([A-Fa-f0-9:]+)/)?.[1]?.replace(/:/g, '').toLowerCase();
    return { signature_verified: true, signer_sha256 };
  }
  return { signature_verified: false };
}

export async function attestMobileApk(apkPath: string, tools: { aapt_path?: string; apksigner_path?: string } = {}): Promise<MobileApkAttestation> {
  const [bytes, stat, inspected, signing] = await Promise.all([
    fs.readFile(apkPath),
    fs.stat(apkPath),
    inspectWithAapt(apkPath, tools.aapt_path),
    inspectApkSigner(apkPath, tools.apksigner_path),
  ]);
  return {
    apk_path: apkPath,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    size_bytes: stat.size,
    package_name: inspected.package_name,
    launch_activity: inspected.launch_activity,
    signer_sha256: signing.signer_sha256,
    native_abis: inspected.native_abis,
    signature_verified: signing.signature_verified,
    inspect_status: inspected.inspect_status,
    inspect_summary: inspected.inspect_summary,
  };
}

export async function importMobileApp(input: { filename: string; base64: string; apk_source?: string }, tools: { aapt_path?: string; apksigner_path?: string } = {}): Promise<ImportedMobileApp> {
  if (!input.base64 || typeof input.base64 !== 'string') throw new Error('APK file content is required');
  const original = sanitizeFilename(input.filename || 'app.apk');
  const encoded = input.base64.replace(/^data:[^,]+,/, '').replace(/\s/g, '');
  const maximumBytes = 64 * 1024 * 1024;
  if (encoded.length > Math.ceil(maximumBytes / 3) * 4) throw new Error('APK exceeds the 64 MiB upload limit; use an operator-controlled server path for larger packages.');
  if (!/^[a-zA-Z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error('APK content is not valid base64.');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('Uploaded file is not an APK/ZIP container.');
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const id = sha256.slice(0, 16);
  const filename = `${id}-${original}`;
  const uploadDir = path.resolve(process.env.BSTG_MOBILE_UPLOAD_DIR || DEFAULT_UPLOAD_DIR);
  await fs.mkdir(uploadDir, { recursive: true });
  const apkPath = path.join(uploadDir, filename);
  await fs.writeFile(apkPath, buffer, { mode: 0o600 });
  const attestation = await attestMobileApk(apkPath, tools);
  const imported: ImportedMobileApp = {
    id,
    filename,
    original_filename: original,
    apk_path: apkPath,
    apk_source: String(input.apk_source || 'upload_api'),
    sha256,
    signer_sha256: attestation.signer_sha256,
    native_abis: attestation.native_abis,
    signature_verified: attestation.signature_verified,
    size_bytes: attestation.size_bytes,
    package_name: attestation.package_name,
    launch_activity: attestation.launch_activity,
    inspect_status: attestation.inspect_status,
    inspect_summary: attestation.inspect_summary,
  };
  await fs.writeFile(path.join(uploadDir, `${id}.asset.json`), JSON.stringify(imported), { mode: 0o600 });
  return imported;
}

export async function getImportedMobileApp(id: string): Promise<ImportedMobileApp> {
  if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('请重新上传有效的应用文件。');
  const uploadDir = path.resolve(process.env.BSTG_MOBILE_UPLOAD_DIR || DEFAULT_UPLOAD_DIR);
  const app = JSON.parse(await fs.readFile(path.join(uploadDir, `${id}.asset.json`), 'utf8')) as ImportedMobileApp;
  if (app.id !== id || path.dirname(path.resolve(app.apk_path)) !== uploadDir) throw new Error('应用文件信息无效，请重新上传。');
  const hash = crypto.createHash('sha256').update(await fs.readFile(app.apk_path)).digest('hex');
  if (hash !== app.sha256) throw new Error('应用文件已改变，请重新上传并验证。');
  return app;
}
