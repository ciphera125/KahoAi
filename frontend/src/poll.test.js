import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { startPolling } from "./poll.js";

// A stand-in for the browser page: visible or not, and who is told when that changes.
function fakePage(hidden = false) {
  const listeners = new Set();
  return {
    hidden: () => hidden,
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    set(v) { hidden = v; for (const cb of [...listeners]) cb(); },
    listeners: () => listeners.size,
  };
}
const flush = () => new Promise((r) => setTimeout(r, 0)); // only setInterval is faked

test("asks again every interval while the page is on screen", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let n = 0;
    const stop = startPolling(() => { n += 1; }, 5000, fakePage());
    mock.timers.tick(5000); await flush();
    mock.timers.tick(5000); await flush();
    assert.equal(n, 2);
    stop();
  } finally { mock.timers.reset(); }
});

test("asks nothing while the tab is hidden, and at once when it is shown again", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let n = 0;
    const page = fakePage(true);
    const stop = startPolling(() => { n += 1; }, 5000, page);
    mock.timers.tick(60000); await flush();
    assert.equal(n, 0); // a hidden tab costs the server nothing
    page.set(false); await flush();
    assert.equal(n, 1); // up to date the moment it is seen
    mock.timers.tick(5000); await flush();
    assert.equal(n, 2);
    page.set(true); await flush();
    mock.timers.tick(60000); await flush();
    assert.equal(n, 2); // hidden again: quiet again
    stop();
  } finally { mock.timers.reset(); }
});

test("never starts a request while the last one is still out", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let n = 0, release;
    const stop = startPolling(() => { n += 1; return new Promise((r) => { release = r; }); }, 1000, fakePage());
    mock.timers.tick(1000); await flush();
    mock.timers.tick(5000); await flush();
    assert.equal(n, 1); // a slow server is not piled on
    release(); await flush();
    mock.timers.tick(1000); await flush();
    assert.equal(n, 2);
    stop();
  } finally { mock.timers.reset(); }
});

test("a failed request does not stop the polling", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let n = 0;
    const stop = startPolling(async () => { n += 1; throw new Error("down"); }, 1000, fakePage());
    mock.timers.tick(1000); await flush();
    mock.timers.tick(1000); await flush();
    assert.equal(n, 2);
    stop();
  } finally { mock.timers.reset(); }
});

test("stopping removes the timer and the listener", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  try {
    let n = 0;
    const page = fakePage();
    const stop = startPolling(() => { n += 1; }, 1000, page);
    assert.equal(page.listeners(), 1);
    stop();
    assert.equal(page.listeners(), 0);
    mock.timers.tick(10000); await flush();
    assert.equal(n, 0);
    page.set(true); page.set(false); await flush();
    assert.equal(n, 0);
  } finally { mock.timers.reset(); }
});
