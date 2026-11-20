// Runs a plugin's script the way the Pebble app does, with the host swapped for stubs, so tests
// can drive its sources, actions and settings page and see what an app would receive.
//
// Like the app, every request starts the script fresh: only localStorage survives between
// them, so a plugin that keeps state in a variable fails here the way it would on the phone.
// Every envelope goes through validate.cjs, the app's own checks.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { declarationFor, validateEnvelope } = require('./validate.cjs');

// Readings are formatted in the phone's time zone; pin it so tests don't depend on the machine.
process.env.TZ = 'Europe/London';

const REQUEST_TIMEOUT_MS = 5000;

// The clock the script sees. Everything else about Date is the real thing.
const CLOCK_PRELUDE = `(function (fixed) {
  var Real = Date;
  function Clock(...args) {
    if (!new.target) return new Real(fixed).toString();
    return args.length ? new Real(...args) : new Real(fixed);
  }
  Clock.now = function () { return fixed; };
  Clock.UTC = Real.UTC;
  Clock.parse = Real.parse;
  Clock.prototype = Real.prototype;
  globalThis.Date = Clock;
})(__NOW__);`;

function manifestOf(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return { pkg, pebble: pkg.pebble, plugin: pkg.pebble.plugin };
}

class Host {
  /**
   * options:
   *   now        ms since the epoch the script sees (default: the real now)
   *   storage    { key: string } to start localStorage with
   *   fetch      (url, init) => Promise<Response-like>; default fails like a dead network
   *   position   { latitude, longitude } for navigator.geolocation; absent = permission denied
   *   readSource (request) => envelope, or throws { code }; absent = no readSource at all,
   *              as in the emulator
   */
  constructor(dir, options = {}) {
    const { pebble, plugin } = manifestOf(dir);
    this.dir = dir;
    this.pebble = pebble;
    this.manifest = plugin;
    this.script = fs.readFileSync(path.join(dir, plugin.script), 'utf8');
    this.storage = new Map(Object.entries(options.storage || {}));
    this.now = options.now === undefined ? Date.now() : options.now;
    this.fetchImpl = options.fetch || (() => Promise.reject(new TypeError('fetch failed: no network in tests')));
    this.position = options.position;
    this.readSourceImpl = options.readSource;
    this.logs = [];
    this.fetched = [];
    this.refreshed = [];
    this.configPushes = [];
    this.subscribed = [];
  }

  advance(ms) {
    this.now += ms;
  }

  /** A fresh run of the script; returns the handlers it registered. */
  session() {
    const host = this;
    const handlers = {};
    const log = (level) => (...args) => host.logs.push(level + ': ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    const Pebble = {
      registerSourceHandler: (fn) => { handlers.source = fn; },
      registerActionHandler: (fn) => { handlers.action = fn; },
      registerConfigHandler: (fn) => { handlers.config = fn; },
      refreshSources: (keys) => { host.refreshed.push(...(keys || [])); },
      sendConfigMessage: (message) => { host.configPushes.push(message); },
    };
    if (host.readSourceImpl) {
      Pebble.readSource = async (request) => host.readSourceImpl(request);
      Pebble.subscribeSource = (request) => { host.subscribed.push(request.category + '/' + request.item); };
    }
    const context = {
      console: { log: log('info'), info: log('info'), warn: log('warn'), error: log('error') },
      localStorage: {
        getItem: (key) => (host.storage.has(String(key)) ? host.storage.get(String(key)) : null),
        setItem: (key, value) => { host.storage.set(String(key), String(value)); },
        removeItem: (key) => { host.storage.delete(String(key)); },
        clear: () => host.storage.clear(),
      },
      fetch: (url, init) => {
        host.fetched.push(String(url));
        return host.fetchImpl(String(url), init);
      },
      navigator: {
        geolocation: {
          getCurrentPosition(success, failure) {
            setTimeout(() => {
              if (host.position) success({ coords: { ...host.position, accuracy: 50 }, timestamp: host.now });
              else if (failure) failure({ code: 1, message: 'User denied Geolocation' });
            }, 0);
          },
        },
      },
      btoa, atob, setTimeout, clearTimeout, Pebble,
    };
    vm.createContext(context);
    vm.runInContext(CLOCK_PRELUDE.replace('__NOW__', String(host.now)), context);
    vm.runInContext(host.script, context, { filename: path.join(host.dir, host.manifest.script) });
    return handlers;
  }

  /** Runs one request through a handler that answers via callbacks; resolves with the answer. */
  static answer(start) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the plugin never answered')), REQUEST_TIMEOUT_MS);
      const done = (value) => { clearTimeout(timer); resolve(value); };
      Promise.resolve().then(() => start(done)).catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  /** { envelope, error, dropped, warnings } for one read of category/item. */
  async read(category, item, options = {}) {
    const declaration = declarationFor(this.manifest, category, item);
    assert.ok(declaration, `${category}/${item} isn't declared`);
    const handlers = this.session();
    assert.ok(handlers.source, 'no source handler registered');
    const request = { category, item };
    if (options.properties) request.properties = options.properties;
    if (options.iconPixelSize) request.iconPixelSize = options.iconPixelSize;
    const answer = await Host.answer((done) => handlers.source(request, {
      data: (envelope) => done({ envelope }),
      error: (code, message) => done({ error: { code, message } }),
    }));
    if (answer.error) return { error: answer.error, dropped: [], warnings: [] };
    // What crosses to the app is JSON; make sure it survives the trip unchanged.
    const envelope = JSON.parse(JSON.stringify(answer.envelope));
    return { envelope, ...validateEnvelope(envelope, declaration, options.iconPixelSize) };
  }

  /** A read that must succeed with nothing the app would drop; returns the envelope. */
  async readOk(category, item, options = {}) {
    const result = await this.read(category, item, options);
    assert.ok(!result.error, `${category}/${item} failed: ${JSON.stringify(result.error)}\n${this.logs.join('\n')}`);
    assert.deepStrictEqual(result.dropped, [], `the app would drop: ${result.dropped.join('; ')}`);
    return result.envelope;
  }

  /** { ok, text, refreshed } or { ok: false, code, message }. */
  async act(action, args = {}) {
    const declared = (this.manifest.actions || []).find((candidate) => candidate.name === action);
    assert.ok(declared, `action ${action} isn't declared`);
    const handlers = this.session();
    assert.ok(handlers.action, 'no action handler registered');
    const result = await Host.answer((done) => handlers.action({ action, args }, {
      ok: (reply) => done({ ok: true, ...(reply || {}) }),
      error: (code, message) => done({ ok: false, code, message }),
    }));
    for (const key of result.refreshed || []) {
      assert.ok(declarationFor(this.manifest, ...key.split('/')), `refreshed ${key} isn't one of this plugin's sources`);
    }
    return JSON.parse(JSON.stringify(result));
  }

  /** The plugin's reply to a message from its settings page. */
  async config(message) {
    const handlers = this.session();
    assert.ok(handlers.config, 'no config handler registered');
    const reply = await Host.answer((done) => handlers.config(message, done));
    return JSON.parse(JSON.stringify(reply === undefined ? null : reply));
  }
}

/** The instance with this id (or the first), as { property: { shape: payload } }. */
function propertiesOf(envelope, instanceId) {
  const instance = instanceId === undefined ? envelope.instances[0]
    : envelope.instances.find((candidate) => candidate.instanceId === instanceId);
  assert.ok(instance, `no instance ${instanceId}`);
  return instance.properties;
}

/** One line per reading, for eyeballing an envelope: `temperature: 12°C | 12 °C [−10..40]`. */
function describe(envelope) {
  const lines = [];
  for (const instance of envelope.instances) {
    lines.push(`[${instance.instanceId}]`);
    for (const [property, shapes] of Object.entries(instance.properties)) {
      const parts = Object.entries(shapes).map(([shape, payload]) => {
        if (shape === 'shortText' || shape === 'longText') return `${shape}="${payload.text}"`;
        if (shape === 'numericValue') {
          const range = payload.min !== undefined ? ` [${payload.min}..${payload.max}]` : '';
          return `${shape}=${payload.value}${payload.unit ? ' ' + payload.unit : ''}${range}`;
        }
        if (shape === 'timestamp') return `${shape}=${new Date(payload.value * 1000).toISOString()}`;
        if (shape === 'boolean') return `${shape}=${payload.value}`;
        if (shape === 'icon' || shape === 'image') return `${shape}=${payload.width}x${payload.height}`;
        if (shape === 'series') {
          const kinds = Object.keys(payload).filter((k) => k !== 'start' && k !== 'stepSec');
          return `series(${kinds.join(',')}) x${payload[kinds[0]].values.length} step ${payload.stepSec}s`;
        }
        return shape;
      });
      lines.push(`  ${property}: ${parts.join(' | ')}`);
    }
  }
  return lines.join('\n');
}

/** A fetch stub serving canned bodies by URL substring: { 'carbonintensity.org.uk/intensity': {...} }. */
function cannedFetch(routes) {
  return async (url) => {
    const match = Object.keys(routes).filter((key) => url.includes(key)).sort((a, b) => b.length - a.length)[0];
    if (!match) throw new TypeError('fetch failed: no canned response for ' + url);
    const body = typeof routes[match] === 'function' ? routes[match](url) : routes[match];
    if (body instanceof Error) throw body;
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(text),
      text: async () => text,
    };
  };
}

/** Pixel at (x, y) of an icon/image payload, as a palette index. */
function pixelAt(bitmap, x, y) {
  const bytes = Buffer.from(bitmap.pixels, 'base64');
  const byte = bytes[y * Math.ceil(bitmap.width / 2) + (x >> 1)];
  return x % 2 === 0 ? byte >> 4 : byte & 0x0f;
}

module.exports = { Host, cannedFetch, describe, pixelAt, propertiesOf };
