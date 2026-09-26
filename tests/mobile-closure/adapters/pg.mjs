// PostgreSQL is deliberately unavailable in adapter mode. Never simulate success.
class Pool { constructor() { throw new Error('PostgreSQL is not exercised by the SQLite adapter suite.'); } }
export { Pool }; export default { Pool };
