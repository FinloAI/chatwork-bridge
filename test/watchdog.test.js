import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "../scripts/watchdog.mjs";
test("watchdog ignores transient failures and limits restart rate over seven days", () => {
  let state = {};
  let restarts = [];
  for (let minute = 1; minute <= 7 * 24 * 60; minute++) {
    const result = decide(state, false, minute * 60000);
    state = result.state;
    if (result.restart) restarts.push(minute);
  }
  assert.equal(restarts[0], 3);
  assert.equal(restarts[1] - restarts[0], 3);
  assert.equal(restarts.at(-1) - restarts.at(-2), 30);
  assert.ok(restarts.length < 350);
  state = decide({}, false, 60000).state;
  assert.equal(decide(state, true, 120000).state.failures, 0);
  assert.equal(decide({}, true, 60000).restart, false);
});
