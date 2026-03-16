# Recording Smoke Tests

This directory contains automated smoke tests for the BSTG recording functionality and Burp Suite integration.

## Test Files

### Individual Test Scripts
- `tmp_recording_doc03_smoke.ps1` - Basic recording functionality test
- `tmp_recording_doc05_smoke.ps1` - Workflow recording test (login → list → detail → submit)
- `tmp_recording_doc06_smoke.ps1` - API interface recording test (3 independent interfaces)
- `tmp_recording_doc07_smoke.ps1` - Field extraction and account write-back test
- `tmp_recording_doc08_smoke.ps1` - Formal publishing and source tracing test
- `tmp_recording_doc09_smoke.ps1` - Exception recovery and retry test
- `tmp_recording_doc10_smoke.ps1` - Complete integration and performance test

### Mock Servers
- `tmp_recording_mock_server.js` - General mock server
- `tmp_recording_doc05_mock_server.js` - Doc05 specific mock server
- `tmp_recording_doc06_mock_server.js` - Doc06 specific mock server
- `tmp_recording_doc07_mock_server.js` - Doc07 specific mock server
- `tmp_recording_doc08_mock_server.js` - Doc08 specific mock server

### Result Files
- `tmp_recording_doc08_result.json` - Doc08 test results
- `tmp_recording_doc09_result.json` - Doc09 test results
- `tmp_recording_doc10_result.json` - Doc10 test results

### Log Files
- `tmp_recording_*.log` - Test execution logs
- `tmp_recording_*.err.log` - Error logs

## Running Tests

### Run All Tests (Complete Regression)
```bash
npm run smoke:recording:doc10
```

### Run Only Doc10 Test (Skip Historical Tests)
```bash
npm run smoke:recording:doc10:focus
```

### Run Individual Tests
```bash
powershell -ExecutionPolicy Bypass -File tests/recording/smoke-tests/tmp_recording_doc03_smoke.ps1
```

## Test Coverage

| Test | Purpose | Coverage |
|------|---------|----------|
| doc03 | Basic recording functionality | Session creation, event capture |
| doc05 | Workflow recording | Multi-step workflows, token injection |
| doc06 | API recording | Independent API templates |
| doc07 | Field extraction | Variable binding, account write-back |
| doc08 | Publishing | Workflow/template publishing, tracing |
| doc09 | Exception handling | Retry logic, error recovery |
| doc10 | Integration | Performance, migration, complete regression |

## Notes

- All scripts use relative paths and can be run from any location
- Log files are generated in this directory during test execution
- Results are saved to JSON files for analysis
- Tests require the BSTG backend server to be running
- Port conflicts may occur if multiple tests run simultaneously
