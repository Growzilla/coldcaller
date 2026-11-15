import assert from "node:assert/strict";
import { test } from "node:test";
import { staysOut } from "./lead-status";

test("not-needed and skip stay out of the queue", () => {
  assert.equal(staysOut("passed"), true);
  assert.equal(staysOut("skipped"), true);
});

test("a normal wrapup can still be pulled back", () => {
  assert.equal(staysOut("queued"), false);
  assert.equal(staysOut("done"), false);
});
