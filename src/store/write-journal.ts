/**
 * THE WRITE JOURNAL (leg 12/20) — what the engine has written and NOT yet committed,
 * per project root, for this process.
 *
 * The store notes each tracked file it puts on disk, at the write site, where the path is
 * already computed (`join(node.dir, 'events.jsonl')`). The SURFACE takes the journal after
 * a write command and commits exactly those paths. That is the whole mechanism: a FACT
 * about what was written, never a `git status` scan — a scan would sweep an unrelated
 * change (another agent's in-flight work in the same checkout, a stray edit) into the
 * engine's commit.
 *
 * WHY PROCESS-SCOPED AND NOT A FIELD ON THE STORE. The store is constructed per CONTEXT,
 * and a binding may build several per gesture: the service's `POST /api/approve` and
 * `POST /api/drive` run the operator action and the driver in-process, each over its own
 * context, so a per-instance journal would be unreachable from the one place that knows
 * the request finished — and the UI is exactly where the operator accepts gates. One
 * journal per root means ONE call site per binding and no write path left behind.
 *
 * This module is pure state — no git, no I/O — so it lives at L0 beside the writer and
 * the surface does the committing (L0 must not learn to run git).
 */

/** ONE FILE THE SINGLE WRITER PUT ON DISK, IN THIS INVOCATION. `type`/`gate` carry the
 *  EVENT's own shape so a commit message is derived, never guessed. */
export interface WriteRecord {
  path: string;   // absolute — the file the writer appended/wrote
  node: string;   // the node it belongs to ('' for a whole-journey write)
  type: string;   // the event type that landed, or 'node.json' for the contract write
  gate?: string;  // the gate, when the event carried one
  /** The tracked tree the write belongs to — the commit SUBJECT's noun (leg 12/10:
   *  the ideas area is engine-written, tracked and committed, but it is not the
   *  journey). Absent means `journey`, which is every write the store makes. */
  scope?: string;
}

/** root → what it has written since the last take. */
const journals = new Map<string, WriteRecord[]>();

/** Note ONE tracked file the writer just put on disk. Deduped on the whole record, so a
 *  re-write of the same path does not read as two things happening. */
export function noteWrite(root: string, rec: WriteRecord): void {
  const j = journals.get(root);
  if (!j) {
    journals.set(root, [rec]);
    return;
  }
  if (!j.some((w) => w.path === rec.path && w.type === rec.type && w.gate === rec.gate)) j.push(rec);
}

/** TAKE the journal for a root — returns what was written and CLEARS it, so a long-lived
 *  daemon never re-commits what it already committed, and a read or a refused write takes
 *  back an empty list. The surface's commit step is the only caller. */
export function takeWritten(root: string): WriteRecord[] {
  const j = journals.get(root) ?? [];
  journals.delete(root);
  return j;
}

/** Drop a root's journal without committing — the test seam, so a unit test never leaks
 *  its writes into the next one. */
export function clearWritten(root: string): void {
  journals.delete(root);
}
