# Archive Directory

This directory contains archived files from the BSTG project that have been organized for better maintainability.

## Directory Structure

```
archive/
├── README.md                    # This file
├── documentation/               # Historical documentation and reports
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
└── temp/                        # Temporary and runtime files
    ├── tmp_doc05_live_backend.err.log
    ├── tmp_doc05_live_backend.log
    ├── tmp_doc05_live_mock.err.log
    ├── tmp_doc05_live_mock.log
    ├── tmp_doc09_runtime/
    ├── tmp_doc09_text.txt
    ├── tmp_doc_01/
    ├── tmp_doc_03/
    ├── tmp_doc_04/
    └── tmp_doc10_runtime/
```

## File Categories

### Documentation/
Historical documentation, implementation reports, and specifications that were previously in the project root:
- **Audit Reports**: Security audit findings and analysis
- **Implementation Docs**: Various implementation phase documentation
- **Specifications**: Technical specifications and design documents
- **Examples**: Code examples and implementation samples

### temp/
Temporary files generated during development and testing:
- **Runtime Logs**: Backend and mock server logs from testing
- **Test Artifacts**: Temporary files created during smoke tests
- **Document Files**: Various document processing artifacts

## Notes

- These files have been moved from the project root to improve organization
- All files are archived and no longer actively used in development
- Current documentation is maintained in the `docs/`, `docs_CH/`, and `docs_EN/` directories
- Active testing files are now organized in `tests/recording/smoke-tests/`

## Cleanup Considerations

The `temp/` directory contains files that could potentially be deleted:
- Runtime logs and test artifacts
- Temporary document processing files
- Historical test run data

Consider reviewing and cleaning up the `temp/` directory periodically to free up space.
