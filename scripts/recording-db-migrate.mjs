import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3001';
const HELP_FLAGS = new Set(['--help', '-h', '/?']);

function normalizeFlagName(raw) {
  const stripped = raw.replace(/^(--|-|\/)/, '');
  const normalized = stripped
    .replace(/-/g, '_')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase();

  const aliases = {
    baseurl: 'base_url',
    sourceprofileid: 'source_profile_id',
    targetprofileid: 'target_profile_id',
    migratetarget: 'migrate_target',
    switchtotarget: 'switch_to_target',
    exportpath: 'export_path',
  };

  return aliases[normalized] || normalized;
}

function parseArgs(argv) {
  const options = {
    baseUrl: DEFAULT_BASE_URL,
    sourceProfileId: '',
    targetProfileId: '',
    migrateTarget: false,
    switchToTarget: false,
    exportPath: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (HELP_FLAGS.has(arg)) {
      options.help = true;
      continue;
    }

    if (!arg.startsWith('-') && !arg.startsWith('/')) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }

    const [flagPart, inlineValue] = arg.split(/=(.*)/s, 2);
    const flagName = normalizeFlagName(flagPart);
    const nextValue = inlineValue ?? argv[index + 1];

    switch (flagName) {
      case 'base_url': {
        if (!nextValue || nextValue.startsWith('-') || nextValue.startsWith('/')) {
          throw new Error('Missing value for BaseUrl / --base-url');
        }
        options.baseUrl = nextValue;
        if (inlineValue === undefined) index += 1;
        break;
      }
      case 'source_profile_id': {
        if (!nextValue || nextValue.startsWith('-') || nextValue.startsWith('/')) {
          throw new Error('Missing value for SourceProfileId / --source-profile-id');
        }
        options.sourceProfileId = nextValue;
        if (inlineValue === undefined) index += 1;
        break;
      }
      case 'target_profile_id': {
        if (!nextValue || nextValue.startsWith('-') || nextValue.startsWith('/')) {
          throw new Error('Missing value for TargetProfileId / --target-profile-id');
        }
        options.targetProfileId = nextValue;
        if (inlineValue === undefined) index += 1;
        break;
      }
      case 'export_path': {
        if (!nextValue || nextValue.startsWith('-') || nextValue.startsWith('/')) {
          throw new Error('Missing value for ExportPath / --export-path');
        }
        options.exportPath = nextValue;
        if (inlineValue === undefined) index += 1;
        break;
      }
      case 'migrate_target': {
        options.migrateTarget = true;
        break;
      }
      case 'switch_to_target': {
        options.switchToTarget = true;
        break;
      }
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`BSTG recording DB migration (cross-platform)\n
Usage:\n  npm run migrate:recording -- --base-url http://127.0.0.1:3001 --target-profile-id <profile-id> --migrate-target --switch-to-target\n  npm run migrate:recording -- -BaseUrl http://127.0.0.1:3001 -TargetProfileId <profile-id> -MigrateTarget -SwitchToTarget\n
Options:\n  --base-url, -BaseUrl <url>                     BSTG backend base URL\n  --source-profile-id, -SourceProfileId <id>    Optional source DB profile\n  --target-profile-id, -TargetProfileId <id>    Optional target DB profile\n  --migrate-target, -MigrateTarget              Run /admin/db/migrate on target profile before import\n  --switch-to-target, -SwitchToTarget           Switch active DB profile after import\n  --export-path, -ExportPath <file>             Write exported payload JSON to disk\n  --help                                         Show this help\n`);
}

async function requestJson(method, url, body = undefined) {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let json = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return {
    status: response.status,
    ok: response.ok,
    json,
    raw: text,
  };
}

function assertStatus(response, allowedStatus, message) {
  if (allowedStatus.includes(response.status)) {
    return;
  }

  const details = response.json?.error || response.raw || 'Unknown error';
  throw new Error(`${message} (HTTP ${response.status}): ${details}`);
}

async function writeExportFile(exportPath, exportData) {
  const absolutePath = path.resolve(process.cwd(), exportPath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, `${JSON.stringify(exportData, null, 2)}\n`, 'utf8');
  return absolutePath;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const normalizedBaseUrl = options.baseUrl.replace(/\/+$/, '');

  const health = await requestJson('GET', `${normalizedBaseUrl}/health`);
  assertStatus(health, [200], 'Server health check failed');

  const initialStatusResponse = await requestJson('GET', `${normalizedBaseUrl}/admin/db/status`);
  assertStatus(initialStatusResponse, [200], 'Failed to load initial DB status');
  const initialStatus = initialStatusResponse.json?.data;

  if (!initialStatus) {
    throw new Error('Initial DB status payload missing data');
  }

  if (options.sourceProfileId && options.sourceProfileId !== initialStatus.activeProfileId) {
    const switchSource = await requestJson('POST', `${normalizedBaseUrl}/admin/db/switch`, {
      profile_id: options.sourceProfileId,
    });
    assertStatus(switchSource, [200], 'Failed to switch to source profile');
  }

  const exportResponse = await requestJson('POST', `${normalizedBaseUrl}/admin/db/export`);
  assertStatus(exportResponse, [200], 'Failed to export database payload');
  const exportData = exportResponse.json?.data;

  if (!exportData || typeof exportData !== 'object') {
    throw new Error('Export response payload missing data');
  }

  let exportFilePath = null;
  if (options.exportPath) {
    exportFilePath = await writeExportFile(options.exportPath, exportData);
  }

  let migrateResponse = null;
  let importResponse = null;
  let switchTargetResponse = null;

  if (options.targetProfileId) {
    if (options.migrateTarget) {
      migrateResponse = await requestJson('POST', `${normalizedBaseUrl}/admin/db/migrate`, {
        profile_id: options.targetProfileId,
      });
      assertStatus(migrateResponse, [200], 'Failed to migrate target profile');
    }

    importResponse = await requestJson('POST', `${normalizedBaseUrl}/admin/db/import`, {
      data: exportData,
      target_profile_id: options.targetProfileId,
    });
    assertStatus(importResponse, [200], 'Failed to import payload into target profile');

    if (options.switchToTarget) {
      switchTargetResponse = await requestJson('POST', `${normalizedBaseUrl}/admin/db/switch`, {
        profile_id: options.targetProfileId,
      });
      assertStatus(switchTargetResponse, [200], 'Failed to switch to target profile');
    }
  }

  const finalStatusResponse = await requestJson('GET', `${normalizedBaseUrl}/admin/db/status`);
  assertStatus(finalStatusResponse, [200], 'Failed to load final DB status');

  const exportedCounts = Object.fromEntries(
    Object.entries(exportData).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0]),
  );

  const summary = {
    source_profile_id: options.sourceProfileId || initialStatus.activeProfileId,
    target_profile_id: options.targetProfileId || null,
    exported_tables: Object.keys(exportData),
    exported_counts: exportedCounts,
    migrate_target_schema_version: migrateResponse?.json?.data?.schemaVersion ?? null,
    imported: importResponse?.json?.data?.success ?? false,
    imported_counts: importResponse?.json?.data?.counts ?? {},
    switched_to_target: Boolean(options.switchToTarget && switchTargetResponse),
    export_path: exportFilePath,
    final_status: finalStatusResponse.json?.data ?? null,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
