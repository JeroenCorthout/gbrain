/**
 * Wave C 1E (spec §5, §10 1E; §17 eng-r3-outside-9): a paged read of a segmented page is pinned to the whole rendered
 * view, and every window is authorized again.
 *
 * 1. Protects: the markdown view's size and sha256 are keyed by the exact rendered view (head, so metadata and tags,
 *    the withdrawal overlay, audience and body generation), so a same-length metadata edit and a same-length overlay
 *    change (a withdrawal, which moves no page revision) each report the sha256 of the bytes served; a paged read that
 *    an append overtakes reads on to the end on its pinned generation without revision_changed (get_page and the thin
 *    client's printPagedPage, which no longer restarts), with the size it started with; a live pin keeps its generation
 *    through version pruning and a segment sweep, and an expired pin lets the sweep collect it and the read refuses
 *    rather than return a short body; a remote caller's pinned read stops when the page turns private, is deleted,
 *    leaves the caller's grant, or when another principal presents the cursor; gbrain's thin client pages the markdown
 *    in windows over the HTTP default egress cap while other remote callers keep it.
 * 2. Fails when: the digest cache is keyed by page revision (master: a withdrawal of the same length serves the cached
 *    sha256 of the bytes before it); a cursor binds the read to the page revision (master: revision_changed after an
 *    append, and printPagedPage pages the page twice); pins are not a GC root, or a pin survives its expiry; the pin is
 *    used without get_page's authorization of the window, or by another caller; paged windows stay at 1 MiB.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. Remote calls go through dispatchToolCall (remote: true,
 *    HTTP transport, the egress backstop included).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { renderFactsTable } from '../../src/core/facts-fence.ts';
import { decodeCursor, encodeCursor, MAX_WINDOW_BYTES } from '../../src/core/page-window/window.ts';
import { pagedReadWork, printPagedPage } from '../../src/cli/page-render.ts';
import { openAppendBrain, type AppendBrain } from '../helpers/append-brain.ts';
import { factRow } from '../helpers/segmented-privacy-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const ALPHA = 'zzclaim alpha one';
const BRAVO = 'zzclaim bravo one';

function filler(bytes: number, tag: string): string {
  const parts: string[] = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const part = `## Section ${tag} ${i}\n\n${`Public notes on launch planning and roadmap review for week ${i}. `.repeat(30)}\n\n`;
    parts.push(part);
    n += part.length;
  }
  return parts.join('');
}
const content = (title: string) => `---\ntitle: ${title}\ntype: note\n---\n\n${renderFactsTable([factRow(ALPHA), factRow(BRAVO)])}\n\n${filler(1_500_000, 'a')}`;

type Caller = { remote?: boolean; principal?: string; sources?: string[]; thin?: boolean };
type Reply = { isError: boolean; body: Record<string, any> };

for (const kind of testBackends()) {
  describe(`segmented reads pinned to the rendered view (${kind})`, () => {
    let brain: AppendBrain;
    let n = 0;

    const get = async (params: Record<string, unknown>, c: Caller = {}): Promise<Reply> => {
      const remote = c.remote !== false;
      const principal = c.principal ?? 'pin-client';
      const res = await dispatchToolCall(brain.engine, 'get_page', params, {
        remote, config: { engine: kind } as never, sourceId: 'default', logger: { info() {}, warn() {}, error() {} },
        ...(remote ? { transport: 'http', ...(c.thin !== false ? { thinClient: true } : {}), auth: { token: 'fixture', clientId: principal,
          principal: { kind: 'oauth_client', id: principal }, scopes: ['read'], sourceId: c.sources?.[0] ?? 'default', allowedSources: c.sources ?? ['default'] } as never } : {}),
      });
      return { isError: res.isError === true, body: JSON.parse((res.content[0] as { text: string }).text) };
    };
    const code = (r: Reply) => r.body.error?.code ?? r.body.code ?? r.body.error;
    const markdown = (slug: string, extra: Record<string, unknown>, c?: Caller) => get({ slug, body: 'window', view: 'markdown', ...extra }, c);
    const append = async (slug: string, text: string) => {
      const res = await brain.call('append_page', { slug, text, request_id: randomUUID() });
      expect(res.isError).toBe(false);
    };
    const revision = async (slug: string) => (await get({ slug, body: 'none' }, { remote: false })).body.revision as string;
    /**
     * A fresh segmented page for one test, appended to once so its metadata is what every later append keeps (the
     * first write through append_page stamps the writer's trust tier into the head, a metadata change).
     */
    const seed = async (title = 'Pinned probe A') => {
      const slug = `notes/pin-probe-${++n}`;
      await brain.seed(slug, content(title));
      await append(slug, '\n\nFirst appended turn.\n');
      expect((await brain.body(slug)).storage).toBe('segmented');
      return slug;
    };
    /** Page the markdown view from `first` to its end; returns every reply. */
    const pageOn = async (slug: string, first: Reply, c?: Caller) => {
      const replies = [first];
      for (let r = first; r.body.next_cursor;) {
        r = await markdown(slug, { cursor: r.body.next_cursor }, c);
        replies.push(r);
        if (r.isError) break;
      }
      return replies;
    };
    const text = (replies: Reply[]) => replies.map(r => r.body.window?.text ?? '').join('');

    beforeAll(async () => { brain = await openAppendBrain(kind); }, 600_000);
    afterAll(() => brain.close(), 120_000);

    test('eng-r3-outside-9: a same-length overlay change (a withdrawal, no revision change) reports the sha256 of the bytes served', async () => {
      const slug = await seed();
      const withdraw = (claim: string) => brain.engine.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash, withdrawn_at)
        VALUES ('default', 'world', $1, gbrain_fact_fingerprint($2), '2026-01-02T00:00:00Z')`, [slug, claim]);
      await withdraw(ALPHA);
      for (const c of [{ remote: false }, {}] as Caller[]) {
        await brain.engine.executeRaw('DELETE FROM fact_withdrawals WHERE subject=$1', [slug]);
        await withdraw(ALPHA);
        const before = await revision(slug);
        const one = text(await pageOn(slug, await markdown(slug, { max_bytes: 4 * 1024 * 1024 }, c), c));
        const first = await markdown(slug, { bytes: { offset: 0, length: 64 } }, c);
        expect(first.body.size.sha256).toBe(sha(one));
        await brain.engine.executeRaw('DELETE FROM fact_withdrawals WHERE subject=$1', [slug]);
        await withdraw(BRAVO);
        expect(await revision(slug)).toBe(before);
        const replies = await pageOn(slug, await markdown(slug, { max_bytes: 4 * 1024 * 1024 }, c), c);
        const two = text(replies);
        expect(Buffer.byteLength(two)).toBe(Buffer.byteLength(one));
        expect(two).not.toBe(one);
        expect(replies[0]!.body.size.total_bytes).toBe(Buffer.byteLength(two));
        expect(replies[0]!.body.size.sha256).toBe(sha(two));
      }
    }, 300_000);

    test('eng-r3-outside-9: a same-length metadata edit changes the digest to the sha256 of the new bytes', async () => {
      const slug = await seed('Pinned probe A');
      for (const c of [{ remote: false }, {}] as Caller[]) {
        const one = await pageOn(slug, await markdown(slug, { max_bytes: 4 * 1024 * 1024 }, c), c);
        expect(one[0]!.body.size.sha256).toBe(sha(text(one)));
      }
      await brain.engine.executeRaw("UPDATE pages SET title='Pinned probe B' WHERE source_id='default' AND slug=$1", [slug]);
      for (const c of [{ remote: false }, {}] as Caller[]) {
        const two = await pageOn(slug, await markdown(slug, { max_bytes: 4 * 1024 * 1024 }, c), c);
        expect(text(two)).toContain('Pinned probe B');
        expect(two[0]!.body.size.sha256).toBe(sha(text(two)));
      }
    }, 300_000);

    test('trusted and remote readers of one page keep their own cached digest, so neither re-hashes the page for the other', async () => {
      const slug = await seed();
      const id = Number((await brain.engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]))[0]!.id);
      for (const c of [{ remote: false }, {}] as Caller[]) await markdown(slug, { bytes: { offset: 0, length: 64 } }, c);
      const rows = await brain.engine.executeRaw<{ audience: string }>("SELECT audience FROM page_view_digests WHERE page_id=$1 AND view='markdown' ORDER BY audience", [id]);
      expect(rows.map(r => r.audience)).toEqual(['remote', 'trusted']);
    }, 300_000);

    test('an append mid-read continues the pinned read to its end without revision_changed', async () => {
      const slug = await seed();
      for (const c of [{}, { remote: false }] as Caller[]) {
        const whole = text(await pageOn(slug, await markdown(slug, { max_bytes: 4 * 1024 * 1024 }, c), c));
        const first = await markdown(slug, { max_bytes: 256 * 1024 }, c);
        expect(first.isError).toBe(false);
        expect(decodeCursor(first.body.next_cursor)?.pin).toMatch(/^[0-9a-f]{32}$/);
        const pinnedRevision = first.body.revision;
        await append(slug, `\n\nAppended turn ${randomUUID()} after the read began.\n`);
        expect(await revision(slug)).not.toBe(pinnedRevision);
        const replies = await pageOn(slug, first, c);
        expect(replies.filter(r => r.isError).map(r => r.body)).toEqual([]);
        expect(replies.length).toBeGreaterThan(2);
        for (const r of replies) expect(r.body.revision).toBe(pinnedRevision);
        expect(replies.at(-1)!.body.pinned?.page_revision).toBe(await revision(slug));
        expect(text(replies)).toBe(whole);
        expect(sha(text(replies))).toBe(first.body.size.sha256);
        expect(replies.slice(1).every(r => r.body.edit_target === undefined)).toBe(true);
      }
    }, 300_000);

    test('the thin client prints a page across an append in one pass, without restarting', async () => {
      const slug = await seed();
      const whole = text(await pageOn(slug, await markdown(slug, { max_bytes: 4 * 1024 * 1024 }), {}));
      let calls = 0;
      const out: string[] = [];
      Object.assign(pagedReadWork, { spooled: 0, replayed: 0 });
      await printPagedPage(async params => {
        const r = await markdown(slug, { ...params, ...(params.cursor === undefined ? { max_bytes: 256 * 1024 } : {}) });
        if (r.isError) throw Object.assign(new Error(r.body.error?.message ?? 'error'), { detail: r.body.error });
        if (++calls === 1) await append(slug, '\n\nAppended while the thin client paged.\n');
        return r.body;
      }, { slug }, async t => { out.push(t); });
      expect(out.join('')).toBe(whole);
      expect(pagedReadWork.spooled).toBe(calls);
      expect(pagedReadWork.replayed).toBe(calls);
    }, 300_000);

    test('a live pin keeps its generation through version pruning and a sweep; an expired one does not, and the read refuses', async () => {
      const slug = await seed();
      const [{ id }] = await brain.engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]);
      const first = await markdown(slug, { max_bytes: 256 * 1024 });
      const pin = decodeCursor(first.body.next_cursor)!.pin!;
      const [{ g }] = await brain.engine.executeRaw<{ g: string }>('SELECT body_generation::text AS g FROM page_read_pins WHERE token=$1', [pin]);
      await append(slug, '\n\nAppended before the versions are pruned.\n');
      await brain.engine.executeRaw('DELETE FROM page_versions WHERE page_id=$1', [id]);
      await brain.engine.sweepSegments({ pageId: Number(id) });
      const closed = async () => Number((await brain.engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM page_body_manifest
        WHERE page_id=$1 AND staging_id IS NULL AND gen_from <= $2 AND gen_to > $2`, [id, g]))[0]!.n);
      expect(await closed()).toBeGreaterThan(0);
      const second = await markdown(slug, { cursor: first.body.next_cursor });
      expect(second.isError).toBe(false);
      expect(second.body.revision).toBe(first.body.revision);
      await brain.engine.executeRaw("UPDATE page_read_pins SET expires_at = now() - interval '1 second' WHERE token=$1", [pin]);
      await brain.engine.sweepSegments({ pageId: Number(id) });
      expect(await closed()).toBe(0);
      expect(Number((await brain.engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_read_pins WHERE token=$1', [pin]))[0]!.n)).toBe(0);
      const third = await markdown(slug, { cursor: second.body.next_cursor });
      expect(third.isError).toBe(true);
      expect(code(third)).toBe('revision_changed');
      expect(third.body.window).toBeUndefined();
    }, 300_000);

    describe('remote=true: every window is authorized again, so a pinned read stops on revocation', () => {
      /** A remote paged read with a pin, overtaken by an append: the next cursor would continue it. */
      const overtaken = async () => {
        const slug = await seed();
        const first = await markdown(slug, { max_bytes: 256 * 1024 });
        expect(decodeCursor(first.body.next_cursor)?.pin).toBeDefined();
        await append(slug, '\n\nAppended before the revocation.\n');
        const go = await markdown(slug, { cursor: first.body.next_cursor });
        expect(go.isError).toBe(false);
        expect(go.body.pinned).toBeDefined();
        return { slug, cursor: go.body.next_cursor as string };
      };
      const refused = (r: Reply, codes: string[]) => {
        expect(r.isError).toBe(true);
        expect(codes).toContain(code(r));
        expect(JSON.stringify(r.body)).not.toContain('Public notes on launch planning');
      };

      test('the page turns private', async () => {
        const { slug, cursor } = await overtaken();
        await brain.engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"visibility":"private"}'::jsonb WHERE source_id='default' AND slug=$1`, [slug]);
        refused(await markdown(slug, { cursor }), ['page_not_found']);
      }, 300_000);

      test('the page is deleted', async () => {
        const { slug, cursor } = await overtaken();
        await brain.engine.executeRaw("UPDATE pages SET deleted_at = now() WHERE source_id='default' AND slug=$1", [slug]);
        refused(await markdown(slug, { cursor }), ['page_not_found']);
      }, 300_000);

      test("the source leaves the caller's grant", async () => {
        const { slug, cursor } = await overtaken();
        await brain.engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other-src', 'other-src') ON CONFLICT DO NOTHING");
        refused(await markdown(slug, { cursor }, { sources: ['other-src'] }), ['page_not_found', 'permission_denied', 'source_not_granted']);
      }, 300_000);

      test('another principal presents the cursor', async () => {
        const { slug, cursor } = await overtaken();
        refused(await markdown(slug, { cursor }, { principal: 'other-client' }), ['revision_changed']);
      }, 300_000);

      test('a trusted pin never continues a remote read', async () => {
        const slug = await seed();
        const first = await markdown(slug, { max_bytes: 256 * 1024 }, { remote: false });
        await append(slug, '\n\nAppended before a remote caller presents a trusted cursor.\n');
        refused(await markdown(slug, { cursor: first.body.next_cursor }), ['revision_changed']);
      }, 300_000);
    });

    test("gbrain's thin client pages the markdown in windows over the HTTP default cap; other remote callers keep it", async () => {
      const slug = await seed();
      const thin = await markdown(slug, { max_bytes: 4 * 1024 * 1024 });
      expect(thin.isError).toBe(false);
      expect(thin.body.window.byte_end - thin.body.window.byte_start).toBeGreaterThan(MAX_WINDOW_BYTES);
      const plain = await markdown(slug, { max_bytes: 4 * 1024 * 1024 }, { thin: false });
      expect(plain.isError).toBe(false);
      expect(plain.body.window.byte_end - plain.body.window.byte_start).toBeLessThanOrEqual(MAX_WINDOW_BYTES);
    }, 300_000);
  });
}

test('cursors: an unpinned cursor keeps its gpw1 form; a pinned one round-trips and a malformed pin is not a cursor', () => {
  const base = { page_id: 7, revision: 'r', view: 'markdown' as const, offset: 10, max_bytes: 20 };
  expect(encodeCursor(base).startsWith('gpw1.')).toBe(true);
  expect(decodeCursor(encodeCursor(base))).toEqual(base);
  const pinned = { ...base, pin: 'a'.repeat(32) };
  expect(encodeCursor(pinned).startsWith('gpw2.')).toBe(true);
  expect(decodeCursor(encodeCursor(pinned))).toEqual(pinned);
  expect(decodeCursor(`gpw2.${Buffer.from(JSON.stringify([7, 'r', 'markdown', 10, 20, 'not-a-pin'])).toString('base64url')}`)).toBeNull();
});
