# Recording Tests

This directory contains all automated tests for the BSTG recording functionality and Burp Suite integration.

## Directory Structure

```
tests/recording/
├── README.md                           # This file
└── smoke-tests/                        # Smoke test scripts and files
    ├── README.md                       # Smoke test documentation
    ├── tmp_recording_doc03_smoke.ps1   # Basic recording functionality test
    ├── tmp_recording_doc05_smoke.ps1   # Workflow recording test
    ├── tmp_recording_doc06_smoke.ps1   # API interface recording test
    ├── tmp_recording_doc07_smoke.ps1   # Field extraction test
    ├── tmp_recording_doc08_smoke.ps1   # Publishing and tracing test
    ├── tmp_recording_doc09_smoke.ps1   # Exception recovery test
    ├── tmp_recording_doc10_smoke.ps1   # Complete integration test
    ├── tmp_recording_mock_server.js    # General mock server
    ├── tmp_recording_doc05_mock_server.js
    ├── tmp_recording_doc06_mock_server.js
    ├── tmp_recording_doc07_mock_server.js
    ├── tmp_recording_doc08_mock_server.js
    ├── tmp_recording_*.log              # Test execution logs
    ├── tmp_recording_*.err.log          # Error logs
    └── tmp_recording_doc*_result.json  # Test results
```

## Running Tests

### Complete Test Suite
```bash
npm run smoke:recording:doc10
```

### Doc10 Only (Skip Historical Tests)
```bash
npm run smoke:recording:doc10:focus
```

### Individual Tests
```bash
powershell -ExecutionPolicy Bypass -File tests/recording/smoke-tests/tmp_recording_doc03_smoke.ps1
```

## Migration Notes

All recording test files have been moved from the project root to this organized structure:
- **Old location**: `tmp_recording_*.ps1` (in project root)
- **New location**: `tests/recording/smoke-tests/tmp_recording_*.ps1`

All scripts have been updated to use relative paths and work correctly from the new location.

## Remaining Files

Some log files remain locked in the project root:
- `tmp_recording_backend.err.log`
- `tmp_recording_backend.log` 
- `tmp_recording_doc03_backend.err.log`
- `tmp_recording_doc03_backend.log`
- `tmp_recording_doc08_backend.err.log`
- `tmp_recording_doc08_backend.log`

These are likely locked by running processes and can be cleaned up once the processes are stopped.
