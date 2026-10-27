import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../split-layout-lifecycle.test.ts'));
