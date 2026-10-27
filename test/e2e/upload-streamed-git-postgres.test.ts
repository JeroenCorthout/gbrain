import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../large-pages/upload-streamed-git.test.ts'));
