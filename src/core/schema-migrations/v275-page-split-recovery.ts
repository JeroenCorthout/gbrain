import type { Migration } from './types.ts';
import { REQUEST_PROTOCOL_GUARD_FUNCTION } from '../shared-skills/persistence-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Split git layout: a page publication that writes a split page head and its
// part files records one multi-file recovery record ({ version: 2, target:
// 'page_split', files }, persistence/split-files.ts). The request protocol
// guard accepted only a version 1 record on a page request; it now also
// accepts that record. Page requests stay protocol 1 and every other check is
// unchanged. A binary that predates the split layout reads the record with
// recoveryFiles, which throws unsupported_mutation_protocol before it touches
// a file. Function DDL only: no row changes.
export const v275: Migration = {
  version: 275,
  name: 'page_split_recovery',
  idempotent: true,
  sql: `${REQUEST_PROTOCOL_GUARD_FUNCTION};`,
};
