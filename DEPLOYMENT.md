# BSTG Deployment

## Deployment model

Deploy BSTG as a single full-stack Node service from the project root:

- Frontend builds to `dist/`
- Backend builds to `server/dist/`
- Backend serves the frontend, `/api/*`, `/admin/*`, and SPA fallback routes

## Recommended one-click deployment

### Windows

PowerShell:

```powershell
./deploy.ps1
```

CMD:

```cmd
deploy.cmd
```

Foreground mode:

```powershell
./deploy.ps1 -Foreground
```

### Linux / macOS

```bash
./deploy.sh
```

Foreground mode:

```bash
node ./scripts/deploy-full.mjs up --foreground
```

## Stop the service

### Windows

```powershell
./stop.ps1
```

### Linux / macOS

```bash
./stop.sh
```

## What the deploy scripts do

1. Stop any stale BSTG process from a previous deployment
2. Remove bundled `node_modules` and old build output by default
3. Reinstall root dependencies and server dependencies on the current machine
4. Verify the native SQLite runtime (`better-sqlite3`) with a real `:memory:` open/query/close cycle
5. Build frontend and backend
6. Audit frontend API usage against backend route registration
7. Start the server
8. Retry health checks until the service is ready
9. Verify:
   - frontend `/`
   - SPA fallback route
   - key `/api/*` routes
   - key `/admin/*` routes
   - JSON 404 behavior for unknown API routes

## Why the scripts clean by default

This package may include `node_modules` built on a different operating system.
That is unsafe for native modules such as `better-sqlite3`.

Examples:

- Windows-built `server/node_modules` will fail on Linux with `invalid ELF header`
- Linux-built `server/node_modules` will fail on Windows with a DLL/ABI load error

So the deploy scripts **clean and reinstall dependencies on the target machine by default**.

If you intentionally want to skip cleaning, use:

### Windows

```powershell
./deploy.ps1 -NoClean
```

### Linux / macOS

```bash
node ./scripts/deploy-full.mjs up --background --no-clean
```

Use `--no-clean` only if you know the bundled dependencies were built on the same OS + architecture + Node ABI as the target machine.

## Logs and process files

The deploy scripts write:

- `logs/server.out.log`
- `logs/server.err.log`
- `.bstg-server.pid`

If deployment fails after the server starts, check these logs first.

## Manual deployment

If you do not want to use the one-click scripts:

```bash
npm install
npm run build
npm run route:audit
npm run check:deploy
npm start
```

On Windows, run these commands in PowerShell or CMD from the project root.

## Useful validation commands

Route audit:

```bash
npm run route:audit
```

Post-deploy HTTP verification:

```bash
npm run check:deploy
```

Runtime/native dependency verification:

```bash
node ./scripts/verify-runtime.mjs
```

## Environment notes

- Default server port: `3001`
- Override base URL for deployment checks with `BSTG_BASE_URL`
- Disable frontend hosting only if you intentionally want backend-only mode:

```bash
SERVE_FRONTEND=false
```

## Important note about SQLite native modules

Do **not** copy `server/node_modules` across operating systems.
Always reinstall on the target OS before starting the app.
