import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../pathological/s-7098-mirror-readonly-legacy-writers.test.ts'));
