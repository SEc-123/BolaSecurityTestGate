# BSTG Project Structure

## 📁 Clean Project Organization

The BSTG project has been reorganized for better maintainability and clarity.

### 🚀 Core Project Files (Root Level)
```
BSTG/
├── .env                          # Environment variables
├── .gitignore                    # Git ignore rules
├── README.md                     # Main project documentation
├── USER_GUIDE.md                 # Comprehensive user guide
├── package.json                  # NPM dependencies and scripts
├── package-lock.json             # NPM lock file
├── index.html                    # Main HTML entry point
├── vite.config.ts                # Vite configuration
├── tailwind.config.js            # Tailwind CSS configuration
├── postcss.config.js             # PostCSS configuration
├── eslint.config.js              # ESLint configuration
├── tsconfig.json                 # TypeScript configuration
├── tsconfig.app.json             # TypeScript app configuration
└── tsconfig.node.json            # TypeScript Node.js configuration
```

### 🏗️ Core Directories
```
├── src/                          # Frontend source code
├── server/                       # Backend source code
├── cli/                          # CLI tools
├── burp-recorder-plugin/         # Burp Suite extension
├── scripts/                      # Build and utility scripts
├── tests/                        # Test files
│   └── recording/                # Recording-specific tests
│       └── smoke-tests/          # Smoke test scripts
├── docs/                         # English documentation
├── docs_CH/                      # Chinese documentation
├── docs_EN/                      # English documentation (alternative)
├── dist/                         # Build output
├── data/                         # Data files
└── archive/                      # Historical notes and archived material
```

### 📦 Archive Directory
```
archive/
├── README.md                     # Archive documentation
├── documentation/                # Historical documentation
│   ├── B0_AUDIT_REPORT.md
│   ├── Bola_Security_Test_Gate_Full_Spec.md
│   ├── COMPLETION_SUMMARY.md
│   ├── GLOBAL_VARIABLE_AND_CLI_IMPLEMENTATION.md
│   ├── IMPLEMENTATION_COMPLETE.md
│   ├── IMPLEMENTATION_EXAMPLES.ts
│   ├── INCREMENTAL_UPDATES.md
│   ├── P0_COMPLETE_IMPLEMENTATION.md
│   ├── P0_CRITICAL_FIXES_VERIFIED.md
│   ├── P0_STABILITY_FIXES_COMPLETE.md
│   ├── PHASE_1_2_IMPLEMENTATION_COMPLETE.md
│   ├── PROJECT_LOGIC_TREE (1).md
│   ├── VALUE_MODE_AND_SUITES_FIX_COMPLETE.md
│   └── VALUE_MODE_RAW_REQUEST_SYNC_COMPLETE.md
└── temp/                         # Temporary and runtime files
    ├── tmp_doc05_live_*
    ├── tmp_doc09_*
    ├── tmp_doc_*
    └── tmp_doc10_runtime/
```

## 🧪 Test Organization

### Recording Tests
```
tests/recording/smoke-tests/
├── README.md                     # Test documentation
├── tmp_recording_doc03_smoke.ps1 # Basic recording test
├── tmp_recording_doc05_smoke.ps1 # Workflow recording test
├── tmp_recording_doc06_smoke.ps1 # API interface test
├── tmp_recording_doc07_smoke.ps1 # Field extraction test
├── tmp_recording_doc08_smoke.ps1 # Publishing test
├── tmp_recording_doc09_smoke.ps1 # Exception recovery test
├── tmp_recording_doc10_smoke.ps1 # Complete integration test
├── tmp_recording_*.js            # Mock servers
├── tmp_recording_*.log           # Test logs
└── tmp_recording_doc*_result.json # Test results
```

## 🚀 Running Tests

```bash
# Complete test suite
npm run smoke:recording:doc10

# Doc10 only (skip historical)
npm run smoke:recording:doc10:focus

# Individual tests
powershell -ExecutionPolicy Bypass -File tests/recording/smoke-tests/tmp_recording_doc03_smoke.ps1
```

## 📝 Key Improvements

1. **Clean Root Directory**: Only essential configuration and documentation files remain
2. **Organized Tests**: All recording tests moved to dedicated structure
3. **Archive System**: Historical files properly archived with documentation
4. **Clear Separation**: Active development vs archived content
5. **Maintainable Structure**: Easy to navigate and understand

## 🔄 Migration Notes

- All recording test scripts have been updated with relative paths
- Package.json scripts updated to reference new locations
- Documentation updated with new file paths
- No functional changes - only organizational improvements

The project is now much cleaner and easier to navigate while maintaining all functionality.

## 🧭 Execution Object Model

A few similarly named objects appear in the repository, but they serve different purposes:

- `test_run_drafts`: recording-derived API draft objects, not yet formal executions
- `test_run_presets`: reusable launch presets published from API drafts
- `test_runs`: tracked execution records used primarily for API template runs and also reused by workflow runs

Key implementation files:

- `src/pages/PreconfiguredRuns.tsx` — review, publish, and promote recording-derived API drafts
- `src/pages/TestRuns.tsx` — launch and inspect formal runs
- `server/src/routes/run.ts` — run-launch entry points for template, workflow, preset, and suite
- `server/src/services/template-runner.ts` — updates `test_runs` for template execution
- `server/src/services/workflow-runner.ts` — updates `test_runs` for workflow execution
- `server/src/services/recording-service.ts` — promotes API drafts into templates, presets, or formal test runs
