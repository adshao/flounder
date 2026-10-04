import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SharedSnapshotStream } from "../dist/server/shared-snapshot-stream.js";

test("shared snapshot stream computes once for all subscribers and stops when idle", async () => {
  let builds = 0;
  const stream = new SharedSnapshotStream(() => ({ sequence: ++builds }), 20);
  const first = [];
  const second = [];

  const unsubscribeFirst = stream.subscribe((snapshot) => first.push(snapshot));
  const unsubscribeSecond = stream.subscribe((snapshot) => second.push(snapshot));

  assert.equal(builds, 1, "a second subscriber must reuse the current snapshot");
  assert.deepEqual(first, [{ sequence: 1 }]);
  assert.deepEqual(second, [{ sequence: 1 }]);

  await delay(55);
  assert.ok(builds >= 2, "the shared producer should continue refreshing");
  assert.equal(first.length, builds);
  assert.deepEqual(second, first, "all subscribers should receive the same shared snapshots");

  unsubscribeFirst();
  unsubscribeSecond();
  const stoppedAt = builds;
  await delay(50);
  assert.equal(builds, stoppedAt, "the producer should stop when no subscribers remain");

  const resumed = [];
  const unsubscribeResumed = stream.subscribe((snapshot) => resumed.push(snapshot));
  assert.equal(builds, stoppedAt + 1, "a new subscriber should restart with a fresh snapshot");
  assert.deepEqual(resumed, [{ sequence: stoppedAt + 1 }]);
  unsubscribeResumed();
});

test("asynchronous snapshots leave the event loop available and never overlap", async () => {
  let builds = 0;
  let complete;
  const stream = new SharedSnapshotStream(() => {
    builds += 1;
    return new Promise((resolve) => { complete = resolve; });
  }, 20);
  const first = [];
  const second = [];
  const unsubscribeFirst = stream.subscribe((snapshot) => first.push(snapshot));
  const unsubscribeSecond = stream.subscribe((snapshot) => second.push(snapshot));

  await delay(35);
  assert.equal(builds, 1, "a pending build must not start another refresh");
  assert.deepEqual(first, [], "subscribers must not receive an incomplete snapshot");

  complete({ sequence: 1 });
  await delay(1);
  assert.deepEqual(first, [{ sequence: 1 }]);
  assert.deepEqual(second, first);
  unsubscribeFirst();
  unsubscribeSecond();
});

test("a failed asynchronous snapshot retries while subscribers remain", async () => {
  let builds = 0;
  const stream = new SharedSnapshotStream(() => {
    builds += 1;
    return builds === 1 ? Promise.reject(new Error("transient")) : Promise.resolve({ sequence: builds });
  }, 10);
  const received = [];
  const unsubscribe = stream.subscribe((snapshot) => received.push(snapshot));

  await delay(35);
  assert.ok(builds >= 2);
  assert.ok(received.length > 0);
  assert.equal(received[0].sequence, 2);
  unsubscribe();
});
