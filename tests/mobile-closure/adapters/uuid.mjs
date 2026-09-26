// Test-only substitute for uuid v4, not a production dependency verification.
export { randomUUID as v4 } from 'node:crypto';
