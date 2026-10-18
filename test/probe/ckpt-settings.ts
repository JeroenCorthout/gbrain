import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { mkdtempSync } from 'node:fs'; import { tmpdir } from 'node:os'; import { join } from 'node:path';
configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
const e = new PGLiteEngine(); await e.connect({ database_path: mkdtempSync(join(tmpdir(), 'ckpt-')) }); await e.initSchema();
console.log(await e.executeRaw("SELECT current_setting('max_wal_size') mw, current_setting('wal_segment_size') ws, current_setting('checkpoint_completion_target') t, pg_wal_lsn_diff(pg_current_wal_lsn(), redo_lsn)::float8 AS since_redo FROM pg_control_checkpoint()"));
await e.disconnect(); process.exit(0);