import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../belief-history-invariance.slow.test.ts'));
