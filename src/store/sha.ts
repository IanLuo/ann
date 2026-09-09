import { createHash } from 'node:crypto';

/**
 * The lock-time hash (journey-format v14 §14): a git blob sha over the artifact's
 * MARKER-STRIPPED content. One definition, three consumers — `lock!` (records it),
 * `present!(confirm)` (binds gate② to the content), `check` (verifies it).
 */
export const blobSha = (c: string): string =>
  createHash('sha1').update('blob ' + Buffer.byteLength(c) + '\n' + c).digest('hex');

const LOCK_MARKER = /^<!-- specs:locked:[^\n]* -->\n?/;
const DRAFT_MARKER = /^<!-- draft[^\n]* -->\n?/;

/** The lock/draft markers are not part of the hashed content — strip before hashing. */
export const stripMarkers = (c: string): string => c.replace(LOCK_MARKER, '').replace(DRAFT_MARKER, '');
