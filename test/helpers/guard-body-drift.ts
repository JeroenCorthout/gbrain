/**
 * #7776 fixtures: install a "newer" body for a schema function (its live definition plus a marker comment, the shape a
 * newer gbrain's migration leaves) and read a body back, on either engine.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

export const NEWER_BODY_MARKER = '-- body installed by a newer gbrain (#7776 fixture)';

/** The live body (prosrc) of a public function, or null when it is not installed. */
export async function functionBody(engine: BrainEngine, name: string): Promise<string | null> {
  const rows = await engine.executeRaw<{ prosrc: string }>(
    `SELECT p.prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [name]);
  return rows[0]?.prosrc ?? null;
}

/** Re-creates `name` with its current definition plus NEWER_BODY_MARKER before the closing quote. */
export async function installNewerBody(engine: BrainEngine, name: string): Promise<void> {
  const [row] = await engine.executeRaw<{ def: string }>(
    `SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = $1`, [name]);
  if (!row) throw new Error(`function ${name} is not installed`);
  const end = row.def.lastIndexOf('$function$');
  await engine.runMigration(0, `${row.def.slice(0, end)}${NEWER_BODY_MARKER}\n${row.def.slice(end)}`);
}
