import assert from 'node:assert/strict';

const targetPolicy = await import('../../server/dist/services/security/target-policy.js');
const identifierPolicy = await import('../../server/dist/db/identifier-policy.js');
const auth = await import('../../server/dist/services/security/auth.js');
const { SqliteProvider } = await import('../../server/dist/db/sqlite-provider.js');

assert.equal(targetPolicy.isLocalHostname('localhost'), true);
assert.equal(targetPolicy.isLocalHostname('api.localhost'), true);
assert.equal(targetPolicy.isBlockedAddress('127.0.0.1'), true);
assert.equal(targetPolicy.isBlockedAddress('10.1.2.3'), true);
assert.equal(targetPolicy.isBlockedAddress('172.16.0.1'), true);
assert.equal(targetPolicy.isBlockedAddress('192.168.1.10'), true);
assert.equal(targetPolicy.isBlockedAddress('169.254.169.254'), true);
assert.equal(targetPolicy.isBlockedAddress('8.8.8.8'), false);

await assert.rejects(
  () => targetPolicy.assertSafeHttpTarget('file:///etc/passwd', 'test target'),
  /http or https/
);

await assert.rejects(
  () => targetPolicy.assertSafeHttpTarget('http://169.254.169.254/latest/meta-data', 'test target'),
  /private or metadata/
);

assert.equal(identifierPolicy.quoteSqliteIdentifier('environments'), '"environments"');
assert.throws(
  () => identifierPolicy.quoteSqliteIdentifier('environments; DROP TABLE accounts'),
  /not allowed/
);

assert.deepEqual(
  identifierPolicy.filterKnownTableData('environments', {
    name: 'Target',
    base_url: 'https://example.com',
    unknown_field: 'ignored',
  }, { dropUnknown: true }),
  {
    name: 'Target',
    base_url: 'https://example.com',
  }
);

assert.throws(
  () => identifierPolicy.filterKnownTableData('environments', { unknown_field: 'blocked' }),
  /Unknown column/
);

const status = auth.authRuntimeStatus();
assert.equal(typeof status.required, 'boolean');
assert.equal(Array.isArray(status.configured_keys), true);
assert.equal(typeof status.dev_open, 'boolean');

const provider = new SqliteProvider('security-contracts', { file: ':memory:' });
await provider.connect();
await provider.migrate();
for (const repo of Object.values(provider.repos)) {
  await repo.findAll({ limit: 1 });
  await repo.count();
}
await provider.disconnect();

console.log('[security-contracts] passed');
