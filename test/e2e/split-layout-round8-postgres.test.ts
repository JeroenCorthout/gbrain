import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../split-layout-round8.test.ts'));
