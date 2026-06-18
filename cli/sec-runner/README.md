# sec-runner CLI

CLI tool for running security gate checks in CI/CD pipelines.

## Installation

### Local Development

```bash
cd cli/sec-runner
npm install
npm run build
```

### Direct Execution

```bash
node cli/sec-runner/dist/index.js run --suite P0 --env staging
```

### NPM Link (Optional)

```bash
cd cli/sec-runner
npm link
sec-runner run --suite P0 --env staging
```

## Usage

### Basic Command

```bash
sec-runner run --suite <SUITE> --env <ENVIRONMENT> [OPTIONS]
```

### Required Arguments

- `--suite <suite>`: Test suite name (e.g., P0, P1, regression)
- `--env <environment>`: Environment name (e.g., staging, production)

### Optional Arguments

- `--git <sha>`: Git commit SHA for traceability
- `--pipeline <url>`: CI pipeline URL for reference
- `--base-url <url>`: API base URL (default: from `SEC_RUNNER_BASE_URL` env var or `http://localhost:3001/api`)
- `--api-key <key>`: API key for authentication (default: from `SEC_RUNNER_API_KEY` env var)
- `--out <directory>`: Output directory for artifacts (default: `./artifacts`)
- `--report`: Generate markdown report (default: true)
- `--fail-on-warn`: Fail (exit 1) on WARN decision (default: false)

## Exit Codes

- `0`: PASS or WARN (unless `--fail-on-warn` is set)
- `1`: BLOCK or validation error
- `3`: Internal server error
- `4`: Invalid arguments

## Environment Variables

- `SEC_RUNNER_BASE_URL`: Default API base URL
- `SEC_RUNNER_API_KEY`: Default API key for authentication

## Output Artifacts

When `--out` is specified, the following files are generated:

- `gate-result.json`: Full gate check result in JSON format
- `gate-summary.md`: Human-readable markdown summary

## Examples

### Basic Usage

```bash
sec-runner run --suite P0 --env staging
```

### With Git SHA and Pipeline URL

```bash
sec-runner run \
  --suite P0 \
  --env production \
  --git $CI_COMMIT_SHA \
  --pipeline $CI_PIPELINE_URL
```

### Custom Output Directory

```bash
sec-runner run \
  --suite regression \
  --env staging \
  --out ./security-reports
```

### Fail on Warning

```bash
sec-runner run \
  --suite P0 \
  --env staging \
  --fail-on-warn
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Security Gate Check

on:
  pull_request:
  push:
    branches: [main, develop]

jobs:
  security-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install sec-runner
        run: |
          cd cli/sec-runner
          npm install
          npm run build

      - name: Run Security Gate
        env:
          SEC_RUNNER_BASE_URL: ${{ secrets.SEC_RUNNER_BASE_URL }}
          SEC_RUNNER_API_KEY: ${{ secrets.SEC_RUNNER_API_KEY }}
        run: |
          node cli/sec-runner/dist/index.js run \
            --suite P0 \
            --env staging \
            --git ${{ github.sha }} \
            --pipeline ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }} \
            --out ./artifacts

      - name: Upload Artifacts
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: security-gate-results
          path: ./artifacts/
```

### GitLab CI

```yaml
security-gate:
  stage: test
  image: node:20
  script:
    - cd cli/sec-runner
    - npm install
    - npm run build
    - cd ../..
    - |
      node cli/sec-runner/dist/index.js run \
        --suite P0 \
        --env staging \
        --git $CI_COMMIT_SHA \
        --pipeline $CI_PIPELINE_URL \
        --out ./artifacts
  artifacts:
    when: always
    paths:
      - artifacts/
    reports:
      dotenv: artifacts/gate-result.json
  variables:
    SEC_RUNNER_BASE_URL: $SEC_RUNNER_BASE_URL
    SEC_RUNNER_API_KEY: $SEC_RUNNER_API_KEY
```

### Jenkins

```groovy
pipeline {
    agent any

    environment {
        SEC_RUNNER_BASE_URL = credentials('sec-runner-base-url')
        SEC_RUNNER_API_KEY = credentials('sec-runner-api-key')
    }

    stages {
        stage('Security Gate Check') {
            steps {
                dir('cli/sec-runner') {
                    sh 'npm install'
                    sh 'npm run build'
                }

                sh """
                    node cli/sec-runner/dist/index.js run \
                        --suite P0 \
                        --env staging \
                        --git ${env.GIT_COMMIT} \
                        --pipeline ${env.BUILD_URL} \
                        --out ./artifacts
                """
            }
        }
    }

    post {
        always {
            archiveArtifacts artifacts: 'artifacts/**', allowEmptyArchive: true
        }
    }
}
```

### CircleCI

```yaml
version: 2.1

jobs:
  security-gate:
    docker:
      - image: cimg/node:20.0
    steps:
      - checkout
      - run:
          name: Install Dependencies
          command: |
            cd cli/sec-runner
            npm install
            npm run build
      - run:
          name: Run Security Gate
          command: |
            node cli/sec-runner/dist/index.js run \
              --suite P0 \
              --env staging \
              --git $CIRCLE_SHA1 \
              --pipeline $CIRCLE_BUILD_URL \
              --out ./artifacts
          environment:
            SEC_RUNNER_BASE_URL: $SEC_RUNNER_BASE_URL
            SEC_RUNNER_API_KEY: $SEC_RUNNER_API_KEY
      - store_artifacts:
          path: ./artifacts

workflows:
  security-checks:
    jobs:
      - security-gate
```

## Troubleshooting

### Connection Refused

If you see "Connection refused" errors:

1. Check that `SEC_RUNNER_BASE_URL` is set correctly
2. Verify the security testing server is running and accessible
3. Check network connectivity and firewall rules

### Authentication Failed

If you see authentication errors:

1. Verify `SEC_RUNNER_API_KEY` is set correctly
2. Check that the API key has not expired
3. Confirm the API key has the necessary permissions

### Exit Code 3 or 4

If the CLI exits with code 3 or 4:

1. Check the error message in the output
2. Verify all required arguments are provided
3. Review server logs for internal errors

## Development

### Build

```bash
npm run build
```

### Watch Mode

```bash
npm run dev
```

### Local Testing

```bash
# Set environment variables
export SEC_RUNNER_BASE_URL=http://localhost:3001/api
export SEC_RUNNER_API_KEY=your-api-key

# Run the CLI
node dist/index.js run --suite P0 --env staging --out ./test-artifacts
```

## License

MIT
