#!/usr/bin/env node
// Uses the real deployed frontend, native WebSocket and current authorized run.
process.env.BSTG_UX_SURFACE='web';
await import('../../tests/product-experience/live-browser-acceptance.mjs');
