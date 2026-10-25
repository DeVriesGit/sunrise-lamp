// The connect deadline and retry, against a fake Web Bluetooth device. Run: node --test test/
// (Slow on purpose: it waits out the real 10 s connect deadline.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { LampLink, LampError } from "../link.js";

function fakeDevice({ hangs }) {
  let attempts = 0;
  const char = {
    writeValueWithResponse: async () => {},
    startNotifications: async () => {},
    addEventListener() {}, removeEventListener() {},
  };
  const service = { getCharacteristic: async () => char };
  const device = {
    attempts: () => attempts,
    addEventListener() {}, removeEventListener() {},
    gatt: {
      connected: false,
      disconnect() { this.connected = false; },
      connect() {
        attempts++;
        if (attempts <= hangs) return new Promise(() => {});        // Chrome stuck: never answers
        this.connected = true;
        return Promise.resolve({ getPrimaryService: async () => service });
      },
    },
  };
  return device;
}

test("a connect that hangs once is dropped and retried, and then succeeds", { timeout: 30000 }, async () => {
  const d = fakeDevice({ hangs: 1 });
  await new LampLink(d).connect();
  assert.equal(d.attempts(), 2);
  assert.equal(d.gatt.connected, true);
});

test("a connect that always hangs gives up with a message a person can act on", { timeout: 40000 }, async () => {
  const d = fakeDevice({ hangs: 99 });
  await assert.rejects(new LampLink(d).connect(), (e) => e instanceof LampError && /tap Connect again/.test(e.message));
  assert.equal(d.attempts(), 2);
});
