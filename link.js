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

  /** Connect, find the lamp's service, switch replies on, set the lamp's clock. */
  connect() {
    return this.queue(async () => {
      let server;
      try {
        server = await this.device.gatt.connect();
      } catch {
        throw new LampError("Lamp not reachable. Is it switched on at the wall, and within a few metres?");
      }
      try {
        const service = await server.getPrimaryService(L.SERVICE);
        this.writeChar = await service.getCharacteristic(L.WRITE_CHAR);
        const notify = await service.getCharacteristic(L.NOTIFY_CHAR);
        notify.addEventListener("characteristicvaluechanged", this._onNotify);
        await notify.startNotifications();
      } catch {
        this.close();
        throw new LampError("That device is not a Sunrise Lamp bulb (no lamp service found).");
      }
      this.device.addEventListener("gattserverdisconnected", this._onGone);
      await this._send(L.setClock(new Date()));
    });
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
      await this.writeChar.writeValueWithResponse(packet);
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
