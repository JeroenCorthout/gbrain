import type { Migration } from './types.ts';
import { REQUEST_PROTOCOL_GUARD_SQL } from '../shared-skills/persistence-schema.ts';

export const v275: Migration = {
  // GBRA-190 G4 (D2): one publication may write several pages (a withdrawal strikes its claim on every page that
  // carries it) and commit them in one Git commit. Such a request is a page target at protocol 2, so a binary that
  // predates it leaves it untouched, and its recovery record is version 3 (several page files), which those binaries
  // refuse unread (recovery-version.ts). Only the trigger function is replaced: no table, column or row changes.
  version: 275,
  name: 'multi_page_publication_protocol',
  idempotent: true,
  sql: REQUEST_PROTOCOL_GUARD_SQL + ';',
};
