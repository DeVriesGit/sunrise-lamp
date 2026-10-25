// One Web Bluetooth connection to one lamp - the browser twin of the Android app's LampLink.kt.
//
// Rules carried over from the app (each was learned on the hardware):
//  - ONE operation in flight at a time. Chrome rejects a second GATT write started before the
//    first finished ("GATT operation already in progress"), so everything runs through queue().
//  - Set the lamp's clock on every connect - the alarm runs on the lamp's own clock.
//  - Wait 700 ms after a write before reading back; sooner returns the PREVIOUS state (Smart Home).
//  - Never hold the lamp idle: it may accept only one connection at a time.
import * as L from "./lamp.js";

const SETTLE_MS = 700;
const REPLY_TIMEOUT_MS = 3000;

/** A failure worded for the person holding the phone, not for a log. */
export class LampError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONNECT_TIMEOUT_MS = 10000;
const STEP_TIMEOUT_MS = 8000;

/**
 * A Bluetooth promise with a deadline. Android Chrome can leave gatt.connect() (and the steps after
 * it) pending for ever when an earlier connection went stale - the page then showed "Connecting..."
 * indefinitely (his report, 25 Oct 2026). Rejects with a TimeoutError after ms.
 */
function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timeout"), { name: "TimeoutError" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class LampLink {
  constructor(device) {
    this.device = device;        // a BluetoothDevice the person picked in Chrome's chooser
    this.writeChar = null;
    this.seq = 0;
    this.chain = Promise.resolve();
    this.assembler = new L.ReplyAssembler();
    this.replies = [];           // complete replies not yet consumed
    this.waiter = null;          // resolves when the next reply arrives
    this.onDisconnected = null;
    this._onNotify = (e) => {
      const v = e.target.value;  // a DataView
      const packet = Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      const whole = this.assembler.feed(packet);
      if (whole) { this.replies.push(whole); this.waiter?.(); }
    };
    this._onGone = () => this.onDisconnected?.();
  }

  /** Run fn after everything queued before it - one Bluetooth operation at a time. */
  queue(fn) {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * Connect, find the lamp's service, switch replies on, set the lamp's clock. Every step has a
   * deadline; a first attempt that stalls is dropped and tried once more before giving up.
   */
  connect() {
    return this.queue(async () => {
      try {
        await this._open();
      } catch (first) {
        if (first instanceof LampError && first.final) throw first;
        this.close();                 // drop whatever Chrome is stuck on, then one clean retry
        await sleep(600);
        try {
          await this._open();
        } catch (second) {
          this.close();
          if (second instanceof LampError) throw second;
          throw new LampError("The lamp didn't answer. Check it is switched on at the wall and within a few " +
            "metres, then tap Connect again.");
        }
      }
    });
  }

  async _open() {
    const server = await withTimeout(this.device.gatt.connect(), CONNECT_TIMEOUT_MS);
    let service;
    try {
      service = await withTimeout(server.getPrimaryService(L.SERVICE), STEP_TIMEOUT_MS);
    } catch (e) {
      if (e.name === "TimeoutError") throw e;
      throw Object.assign(new LampError("That device is not a Sunrise Lamp bulb (no lamp service found)."), { final: true });
    }
    this.writeChar = await withTimeout(service.getCharacteristic(L.WRITE_CHAR), STEP_TIMEOUT_MS);
    const notify = await withTimeout(service.getCharacteristic(L.NOTIFY_CHAR), STEP_TIMEOUT_MS);
    notify.removeEventListener("characteristicvaluechanged", this._onNotify);
    notify.addEventListener("characteristicvaluechanged", this._onNotify);
    await withTimeout(notify.startNotifications(), STEP_TIMEOUT_MS);
    this.device.addEventListener("gattserverdisconnected", this._onGone);
    await this._send(L.setClock(new Date()));
  }

  readState() { return this.queue(() => this._query()); }

  readTimers() { return this.queue(() => this._timers()); }

  /** Switch the lamp, let it settle, and read back what it actually did. */
  setPower(on) {
    return this.queue(async () => {
      await this._send(L.power(on));
      await sleep(SETTLE_MS);
      return this._query();
    });
  }

  /**
   * Write all six slots, settle, and return what the lamp actually STORED. The caller checks
   * the read-back - and a stored slot is still not proof it will fire (Smart Home rule).
   */
  writeTimers(slots) {
    return this.queue(async () => {
      // 102 bytes in one write. The Android app asked for big packets (MTU 247) first; a web
      // page cannot, so this relies on the phone having negotiated one (Android 14+ does so
      // by itself). If the lamp refuses, say so plainly rather than "lost the lamp".
      await this._send(L.setTimers(slots), "The lamp refused the alarm write. Tell Claude: 'long write refused'.");
      await sleep(SETTLE_MS);
      return this._timers();
    });
  }

  /** Send commands in order, with no read-back - for the colour wheel and sliders while dragged. */
  sendCommands(list) {
    return this.queue(async () => { for (const inner of list) await this._send(inner); });
  }

  // Skip pushed EA-81 statuses; wait for the 81 answer, which carries the whites.
  _query() {
    return this._request(L.QUERY_STATE, (p) => { const s = L.parseState(p); return s && s.warm !== null ? s : null; });
  }

  _timers() { return this._request(L.QUERY_TIMERS, (p) => L.parseTimers(p)); }

  /** Send a command and wait for the first reply that accept() turns into a value. */
  async _request(command, accept) {
    this.replies = [];                         // drop pushes left over from earlier commands
    await this._send(command);
    const deadline = Date.now() + REPLY_TIMEOUT_MS;
    for (;;) {
      while (this.replies.length) {
        const p = L.payloadOf(this.replies.shift());
        const v = p && accept(p);
        if (v) return v;
      }
      const left = deadline - Date.now();
      if (left <= 0) throw new LampError("The lamp did not answer. Move closer and tap Reconnect.");
      await new Promise((r) => { this.waiter = r; setTimeout(r, left); });
      this.waiter = null;
    }
  }

  async _send(inner, failure = "Lost the lamp. Tap Reconnect.") {
    if (!this.writeChar || !this.device.gatt.connected) throw new LampError("Not connected.");
    const packet = new Uint8Array(L.wrap(++this.seq, inner));
    try {
      await withTimeout(this.writeChar.writeValueWithResponse(packet), STEP_TIMEOUT_MS);
    } catch {
      throw new LampError(failure);
    }
  }

  /** Hang up. */
  close() {
    this.device.removeEventListener("gattserverdisconnected", this._onGone);
    this.onDisconnected = null;
    try { if (this.device.gatt.connected) this.device.gatt.disconnect(); } catch { /* already gone */ }
    this.writeChar = null;
  }
}
