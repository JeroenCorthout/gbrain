/**
 * Speaker-turn and code-fence lines in conversation text, shared by evidence
 * delivery (turn-aware block cuts) and relative-date resolution.
 */
export const FENCE_LINE = /^ {0,3}(```|~~~)/;
export const SPEAKER_LINE = /^\s{0,3}(?:\*\*([^*\n:]{1,40}):\s*\*\*|\*\*([^*\n:]{1,40})\*\*\s*:|(user|assistant|human|ai|system|bot|speaker\s*\d{1,3})\s*:)/i;

/** The normalized speaker label of a SPEAKER_LINE match. */
export function speakerName(m: RegExpExecArray): string {
  return (m[1] ?? m[2] ?? m[3]).trim().toLowerCase().replace(/\s+/g, ' ');
}
