/**
 * GBRA-215 L3: the ingest report namespace. A page of type ingest-report is written only by the attempt that owns it
 * (an internal report intent through the page door); every generic page mutation (put, capture, edit, append, delete,
 * restore, revert, batch, upload) is refused on one, and none may declare the type. That keeps a report's ownership
 * evidence, which undo trusts, out of any caller's reach. A brain's own files re-imported from Git are not refused.
 *
 * Report slugs (ingest/<attempt_id>) are always reserved. ingest.reserve_namespace (default off) also refuses every
 * generic mutation of any other slug under ingest/: before ingest existed those were ordinary pages, so reserving them
 * all is the owner's choice and no existing page changes behaviour by default.
 */
import { opError, type OperationError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import type { BrainEngine } from '../engine.ts';
import { INGEST_REPORT_PREFIX, INGEST_REPORT_TYPE } from './report.ts';

export const RESERVE_NAMESPACE_KEY = 'ingest.reserve_namespace';
const REPORT_SLUG = /^ingest\/a[0-9a-f]{16}$/;
const DECLARES_REPORT_TYPE = /^type:\s*["']?ingest-report["']?\s*$/m;

function refused(slug: string, why: string): OperationError {
  const attempt = slug.slice(INGEST_REPORT_PREFIX.length);
  return opError('ingest_namespace_reserved', 'Page ' + slug + ' is reserved for ingest reports; generic page writes cannot change it.',
    'Nothing was written. ' + why + ' Undo an ingest with ingest_undo (gbrain ingest-undo <attempt_id>); read a report with ingest-show.',
    { docs: 'docs/guides/ingest.md#reserved-namespace', ...(REPORT_SLUG.test(slug) ? { fix: readFix('Shows the ingest attempt this report belongs to, read-only.', { argv: ['gbrain', 'ingest-show', attempt], mcp: { tool: 'ingest', arguments: { attempt_id: attempt } } }) } : {}) });
}

/** The reserved-type and reserved-namespace check every generic page mutation passes at admission. */
export async function assertIngestNamespaceWritable(engine: BrainEngine, input: { operation: string; slug: string; existingType: string | null | undefined; params: Record<string, unknown> }): Promise<void> {
  if (input.existingType === INGEST_REPORT_TYPE) throw refused(input.slug, 'Ingest reports are written only by the ingest attempt that owns them.');
  const texts: string[] = [];
  if (typeof input.params.content === 'string') texts.push(input.params.content.slice(0, 8192));
  if (input.params.type === INGEST_REPORT_TYPE) throw refused(input.slug, 'The ingest-report page type is reserved for ingest.');
  if (Array.isArray(input.params.edits)) for (const e of input.params.edits) if (typeof (e as { new_text?: unknown })?.new_text === 'string') texts.push((e as { new_text: string }).new_text);
  if (texts.some(t => DECLARES_REPORT_TYPE.test(t))) throw refused(input.slug, 'The ingest-report page type is reserved for ingest.');
  if (!input.slug.startsWith(INGEST_REPORT_PREFIX)) return;
  if (REPORT_SLUG.test(input.slug)) throw refused(input.slug, 'Slugs of the form ingest/<attempt_id> are written only by the ingest attempt that owns them.');
  const reserve = await engine.getConfig(RESERVE_NAMESPACE_KEY);
  if (reserve != null && /^(true|1|on|yes)$/i.test(reserve.trim())) throw refused(input.slug, 'This brain reserves every slug under ingest/ for ingest reports (ingest.reserve_namespace).');
}
