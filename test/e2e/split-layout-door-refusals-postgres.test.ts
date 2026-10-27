import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../split-layout-door-refusals.test.ts'));
