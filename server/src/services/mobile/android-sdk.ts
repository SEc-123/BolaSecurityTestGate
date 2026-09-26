import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Resolve standard SDK installs without requiring the service shell to inherit Android Studio's PATH. */
export function androidTool(name: 'adb' | 'emulator' | 'aapt' | 'apksigner', configured?: string): string {
  if (configured && configured !== name) return configured;
  const suffix = process.platform === 'win32' ? name === 'apksigner' ? '.bat' : '.exe' : '';
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'Library/Android/sdk'), path.join(os.homedir(), 'Android/Sdk'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android/Sdk')].filter(Boolean) as string[];
  for (const root of roots) {
    let dirs = [name === 'adb' ? 'platform-tools' : 'emulator'];
    if (name === 'aapt' || name === 'apksigner') {
      try { dirs = fs.readdirSync(path.join(root, 'build-tools')).sort((a,b)=>b.localeCompare(a, undefined, {numeric:true})).map(v=>`build-tools/${v}`); }
      catch { continue; }
    }
    for (const dir of dirs) {
      const candidate = path.join(root, dir, name + suffix);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return name + suffix;
}
