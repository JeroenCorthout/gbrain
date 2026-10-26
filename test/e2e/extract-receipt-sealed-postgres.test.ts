import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../extract-receipt-sealed.test.ts'));
