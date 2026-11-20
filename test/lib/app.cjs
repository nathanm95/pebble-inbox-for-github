// Runs the watch app's phone-side JavaScript (src/pkjs/index.js) in a vm, as the Pebble app would,
// with a stub `Pebble` the tests drive: AppMessages are recorded and acked or nacked by hand,
// source subscriptions are fed envelopes (made by the real plugin, through plugin.cjs's Host),
// and timers only run when a test moves the clock on.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', '..');
const PKJS = path.join(ROOT, 'src', 'pkjs', 'index.js');
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// As the SDK numbers them (build/js/message_keys.json): 10000 up, in package.json order.
const MESSAGE_KEYS = {};
PACKAGE.pebble.messageKeys.forEach((name, i) => { MESSAGE_KEYS[name] = 10000 + i; });

class Phone {
  /** options: { plugins: false } for a Pebble app with no plugin support. */
  constructor(options = {}) {
    this.sent = [];          // { message, ack, nack, answered }
    this.subscriptions = []; // { request, active }
    this.listeners = {};
    this.logs = [];
    this.timers = [];
    this.now = 0;
    this.nextTimer = 1;
    const phone = this;
    const Pebble = {
      addEventListener(type, fn) { (phone.listeners[type] = phone.listeners[type] || []).push(fn); },
      removeEventListener() {},
      sendAppMessage(message, ack, nack) {
        phone.sent.push({ message: JSON.parse(JSON.stringify(message)), ack, nack, answered: false });
      },
    };
    if (options.plugins !== false) {
      Pebble.subscribeToSource = (request) => {
        if (!request || !request.category || !request.item) throw new Error('category and item required');
        const sub = { request, active: true };
        phone.subscriptions.push(sub);
        return { unsubscribe() { sub.active = false; } };
      };
    }
    const log = (level) => (...args) => phone.logs.push(level + ': ' + args.join(' '));
    const context = {
      Pebble,
      console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error') },
      setTimeout: (fn, ms) => {
        const id = phone.nextTimer++;
        phone.timers.push({ id, at: phone.now + (ms || 0), fn });
        return id;
      },
      clearTimeout: (id) => { phone.timers = phone.timers.filter((t) => t.id !== id); },
    };
    vm.createContext(context);
    const source = fs.readFileSync(PKJS, 'utf8');
    const run = vm.runInContext('(function (module, exports, require) {' + source + '\n})', context, { filename: PKJS });
    const module = { exports: {} };
    run(module, module.exports, (name) => {
      if (name === 'message_keys') return MESSAGE_KEYS;
      throw new Error('cannot require ' + name);
    });
  }

  emit(type, event) {
    (this.listeners[type] || []).forEach((fn) => fn(event));
  }

  /** The Pebble app says the JS may talk to the watch. */
  ready() {
    this.emit('ready', { type: 'ready' });
    return this;
  }

  /** The watch says HELLO (by name, or by number as some phone apps deliver keys). */
  hello(byNumber) {
    this.emit('appmessage', { payload: byNumber ? { [MESSAGE_KEYS.Cmd]: 1 } : { Cmd: 1 } });
  }

  get subscription() {
    return this.subscriptions.filter((s) => s.active)[0];
  }

  /** The plugin answers the subscription, as the app's dispatcher does (a fresh copy of JSON). */
  deliver(envelope) {
    this.subscription.request.onData(JSON.parse(JSON.stringify(envelope)));
  }

  fail(error) {
    this.subscription.request.onError(JSON.parse(JSON.stringify(error)));
  }

  /** Messages sent and not yet answered. */
  waiting() {
    return this.sent.filter((s) => !s.answered);
  }

  ack() {
    const entry = this.waiting()[0];
    if (!entry) throw new Error('nothing to ack');
    entry.answered = true;
    entry.ack({});
    return entry.message;
  }

  nack() {
    const entry = this.waiting()[0];
    if (!entry) throw new Error('nothing to nack');
    entry.answered = true;
    entry.nack({ error: 'NACK' });
    return entry.message;
  }

  /** Acks every message, each as it is sent; returns them in order. */
  ackAll() {
    const acked = [];
    while (this.waiting().length) acked.push(this.ack());
    return acked;
  }

  /** Moves the clock on, running timers as they fall due. */
  tick(ms) {
    const until = this.now + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = until;
  }
}

/** The bytes an AppMessage dictionary takes on the watch: a count byte, then per tuple a 4-byte
 * key, a type byte, a 2-byte length and the value (ints 4 bytes, strings UTF-8 with a NUL). */
function dictionarySize(message) {
  let size = 1;
  for (const value of Object.values(message)) {
    size += 7 + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') + 1 : 4);
  }
  return size;
}

module.exports = { Phone, dictionarySize, MESSAGE_KEYS, PACKAGE, ROOT };
