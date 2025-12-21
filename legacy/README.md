# Legacy Code - ⚠️ DO NOT USE ⚠️

This folder contains **DEPRECATED** code that has been replaced by the new backend server architecture.

## 🚨 CRITICAL WARNINGS

1. **DO NOT USE** any code from this directory in production
2. **DO NOT IMPORT** or reference any files from this directory
3. **DO NOT DEPLOY** these functions - they contain deprecated features
4. **DO NOT COPY** code patterns without understanding the differences

## Contents

### supabase-functions/
Original Supabase Edge Functions that have been migrated to the Express backend server:

- `execute-test/` - Migrated to `POST /api/run/template`
- `execute-workflow/` - Migrated to `POST /api/run/workflow`
- `sec-runner-run/` - Migrated to gate runner service
- `template-variable-bulk-update/` - Migrated to `POST /api/template-variables/bulk-update`
- `template-variable-search/` - Migrated to `POST /api/template-variables/search`

## Why Keep This?

- Historical reference for understanding original implementation
- Useful for comparison during debugging
- May contain patterns that could be needed for future features

## Build Exclusion

This folder is automatically excluded from:
- TypeScript compilation (not in tsconfig include paths)
- Vite bundling (not under src/)
- Production builds

## Known Deprecated Features in Legacy Code

The legacy functions implement features that are **NO LONGER SUPPORTED**:

1. **`independent` binding strategy** - Removed from type definitions. Only `per_account` and `anchor_attacker` are supported.
2. **Baseline comparison** (`enable_baseline`, `baseline_config`) - Feature removed from current implementation.
3. **Legacy error handling patterns** - Replaced with proper execution error tracking.

## Do Not Import

The code in this folder should NOT be imported or referenced by any frontend or backend code.
If you find any imports from this folder, they should be removed and replaced with the proper backend API calls.

## Current Implementation Location

For the latest implementation, see:
- `server/src/services/template-runner.ts` - API template execution
- `server/src/services/workflow-runner.ts` - Workflow execution with proper strategy support
- `server/src/services/gate-runner.ts` - CI/CD gate policy evaluation
