/**
 * Operator dismissed this lead from the cockpit ("Not needed") or an earlier skip.
 * A GHL pull, a call-log import, and the review ranker must not put it back on the queue.
 * "Later" is different: that lead stays `queued` and returns when the snooze ends.
 */
export function staysOut(status: string): boolean {
  return status === "passed" || status === "skipped";
}
