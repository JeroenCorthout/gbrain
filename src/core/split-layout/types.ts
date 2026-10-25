/**
 * Split git layout (Wave B PR 5): the manifest a head file carries under `gbrain_parts` and the typed planning error.
 */

/** The frontmatter key a head file carries its manifest under, appended as its last top-level key. */
export const PARTS_KEY = 'gbrain_parts';
export const SPLIT_FORMAT = 1;

/** One part file as the manifest lists it; `path` is relative to the head's directory. */
export interface SplitManifestPart {
  path: string;
  bytes: number;
  sha256: string;
}

/**
 * `gbrain_parts`: `total_bytes` and `content_hash` describe the page body B (everything after the frontmatter
 * block), `lead_bytes` is how many bytes of B the head's body repeats, `lead_sha256` hashes the head body as written
 * (lead plus notice), and the parts concatenated in order are B.
 */
export interface SplitManifest {
  format: typeof SPLIT_FORMAT;
  total_bytes: number;
  content_hash: string;
  lead_bytes: number;
  lead_sha256: string;
  parts: SplitManifestPart[];
}

export type SplitLayoutErrorCode =
  /** The input does not start with a `---` frontmatter block that closes with a line break. */
  | 'not_a_page_file'
  /** The frontmatter block does not close within the bounded file head (FRONTMATTER_HEAD_MAX_BYTES). */
  | 'frontmatter_too_large'
  /** The page's own frontmatter already has a top-level `gbrain_parts` key, which the head reserves. */
  | 'frontmatter_has_parts_key'
  /** Nothing follows the frontmatter, so there is nothing to put in parts. */
  | 'body_empty'
  /** The frontmatter or the lead is not valid UTF-8. */
  | 'not_utf8'
  /** The body needs more parts than a four-digit index can name. */
  | 'too_many_parts'
  /** The head's file name does not end in `.md`. */
  | 'not_a_markdown_head'
  /** The rendered head does not parse back to the planned frontmatter and manifest. */
  | 'head_not_reversible'
  /** The private staged copy changed or vanished after planning. */
  | 'staged_file_changed';

/** A page the split layout cannot write; nothing was written to the page's directory. */
export class SplitLayoutError extends Error {
  constructor(readonly code: SplitLayoutErrorCode, message: string) {
    super(message);
    this.name = 'SplitLayoutError';
  }
}
