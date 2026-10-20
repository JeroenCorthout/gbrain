import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../pathological/s-7087-sync-dry-run-preview.test.ts'));
