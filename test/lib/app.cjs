// Runs the watch app's phone-side JavaScript (src/pkjs/index.js) in a vm, as the Pebble app would,
// with a stub `Pebble` the tests drive: AppMessages are recorded and acked or nacked by hand,
// source subscriptions (one per item) are fed envelopes and actions are run (both by the real
// plugin, through plugin.cjs's Host, when a test wires them up), and timers only run when a test
// moves the clock on.

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
  /**
   * options:
   *   plugins  false for a Pebble app with no plugin support
   *   invoke   (config) => Promise<result> for Pebble.invokeAction; default: every action is ok
   *   now      ms since the epoch the script's Date sees (moves with tick); default the real now
   */
  constructor(options = {}) {
    this.sent = [];          // { message, ack, nack, answered }
    this.subscriptions = []; // { request, active }
    this.invoked = [];       // each Pebble.invokeAction config, in order
    this.invokeImpl = options.invoke || (async () => ({ ok: true, text: 'ok' }));
    this.listeners = {};
    this.logs = [];
    this.timers = [];
    this.now = 0;
    this.epoch = options.now === undefined ? Date.now() : options.now;
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
      Pebble.invokeAction = (config) => {
        if (!config || !config.plugin || !config.action) throw new Error('plugin and action required');
        phone.invoked.push(JSON.parse(JSON.stringify(config)));
        return phone.invokeImpl(JSON.parse(JSON.stringify(config)));
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
    // The script's clock: the epoch given, moved on by tick().
    vm.runInContext(`(function (phone) {
      var Real = Date;
      function Clock(...args) {
        if (!new.target) return new Real(phone()).toString();
        return args.length ? new Real(...args) : new Real(phone());
      }
      Clock.now = function () { return phone(); };
      Clock.UTC = Real.UTC;
      Clock.parse = Real.parse;
      Clock.prototype = Real.prototype;
      globalThis.Date = Clock;
    })`, context)(() => phone.epoch + phone.now);
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

  /** A message from the watch, by key name (or by number with byNumber). */
  fromWatch(payload, byNumber) {
    if (!byNumber) return this.emit('appmessage', { payload });
    const numbered = {};
    for (const [key, value] of Object.entries(payload)) numbered[MESSAGE_KEYS[key]] = value;
    return this.emit('appmessage', { payload: numbered });
  }

  /** The active subscription to code/<item>. */
  subscriptionFor(item) {
    const sub = this.subscriptions.filter((s) => s.active && s.request.item === item)[0];
    if (!sub) throw new Error('no subscription to ' + item);
    return sub;
  }

  /** The plugin answers a subscription, as the app's dispatcher does (a fresh copy of JSON). */
  deliver(item, envelope) {
    this.subscriptionFor(item).request.onData(JSON.parse(JSON.stringify(envelope)));
  }

  fail(item, error) {
    this.subscriptionFor(item).request.onError(JSON.parse(JSON.stringify(error)));
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
