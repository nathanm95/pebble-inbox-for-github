// The watch app's phone side (src/pkjs/index.js): it reads this pbw's own plugin, sends the
// summary and lists to the watch, and runs the plugin's actions for the watch. Readings and
// actions here are the real plugin's (src/plugin/index.js, run by plugin.cjs's Host against the
// fake GitHub), so these check the two halves together. A small model of the watch (Watch,
// below) takes the messages as DESIGN.md says the watch does, and notes any it couldn't place.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { Host } = require('./lib/plugin.cjs');
const { FakeGitHub, TOKEN } = require('./lib/github.cjs');
const { Phone, dictionarySize, MESSAGE_KEYS, PACKAGE, ROOT } = require('./lib/app.cjs');

// Friday 20 November 2026, 14:05 in London (GMT, so the same in UTC).
const NOW = Date.UTC(2026, 10, 20, 14, 5);
const MINUTE = 60 * 1000;
const UUID = PACKAGE.pebble.uuid;
const WATCHED = ['inbox', 'notification', 'review_request', 'pull_request', 'build', 'repo'];
const CMD = { HELLO: 1, SUMMARY: 2, ITEM: 3, TIME: 4, NOTICE: 5, RESULT: 6, ACT: 7 };
const KIND = { NOTIFICATION: 1, REVIEW: 2, PR: 3, BUILD: 4, REPO: 5 };
const STATE = { NONE: 0, GOOD: 1, PENDING: 2, BAD: 3, DRAFT: 4 };
const FLAG = { UNREAD: 1, CAN_RERUN: 2, CAN_COMMENT: 4, CAN_MARK: 8, DEFAULT: 16 };
// DESIGN.md's limits (UTF-8 bytes without the NUL) and the watch's inbox.
const LIMITS = { Id: 127, Title: 100, Sub: 47, Text: 280, Notice: 159, Login: 39, Repo: 100 };
const INBOX_SIZE = 1024;
const utf8 = (s) => Buffer.byteLength(s, 'utf8');

/** The watch's end, as DESIGN.md has it: a Kind's batch shows once whole; a newer one restarts. */
class Watch {
  constructor() {
    this.summary = null;
    this.lists = {};
    this.partial = {};
    this.time = 0;
    this.notice = '';
    this.results = [];
    this.problems = [];
  }

  apply(m) {
    switch (m.Cmd) {
      case CMD.SUMMARY:
        this.summary = m;
        break;
      case CMD.ITEM: {
        if (m.Count === 0) {
          if (m.Index !== undefined) this.problems.push('an empty batch with an Index');
          this.lists[m.Kind] = [];
          delete this.partial[m.Kind];
          break;
        }
        if (m.Index === 0) this.partial[m.Kind] = [];
        const batch = this.partial[m.Kind];
        if (!batch || batch.length !== m.Index || (batch.length && batch[0].Count !== m.Count)) {
          this.problems.push(`kind ${m.Kind}: item ${m.Index} of ${m.Count} out of place`);
          break;
        }
        batch.push(m);
        if (batch.length === m.Count) {
          this.lists[m.Kind] = batch;
          delete this.partial[m.Kind];
        }
        break;
      }
      case CMD.TIME:
        this.time = m.Updated;
        break;
      case CMD.NOTICE:
        this.notice = m.Notice;
        break;
      case CMD.RESULT:
        this.results.push(m);
        break;
      default:
        this.problems.push('unknown Cmd ' + m.Cmd);
    }
  }

  item(kind, id) {
    return (this.lists[kind] || []).find((m) => m.Id === id);
  }
}

/** Lets the phone side's promises (the plugin's actions) run. */
async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * The phone side, the real plugin and the fake GitHub, joined up as the Pebble app joins them:
 * subscriptions get the plugin's readings, actions run in the plugin, and the sources an action
 * refreshes are read again and delivered. options: github (FakeGitHub knobs), storage, signedOut,
 * settings, quiet (don't deliver the first readings), invoke (stand-in for the plugin's actions).
 */
async function rig(options = {}) {
  const github = new FakeGitHub(options.github);
  const storage = options.signedOut ? { ...(options.storage || {}) } : {
    'account.v1': JSON.stringify({ token: TOKEN, login: 'alex-kim', scopes: ['notifications', 'repo'] }),
    'settings.v1': JSON.stringify({ builds: ['acme/api', 'acme/website'], issueRepo: 'acme/api', ...(options.settings || {}) }),
    ...(options.storage || {}),
  };
  const host = new Host(ROOT, { now: NOW, storage, fetch: github.fetch });
  const watch = new Watch();
  let phone = null;
  const readInto = async (item) => {
    const result = await host.read('code', item);
    assert.deepStrictEqual(result.dropped, [], `the app would drop from ${item}: ${result.dropped.join('; ')}`);
    if (result.error) phone.fail(item, result.error);
    else phone.deliver(item, { pluginUuid: UUID, ...result.envelope });
  };
  phone = new Phone({
    now: NOW,
    invoke: options.invoke || (async (config) => {
      assert.strictEqual(config.plugin, UUID, 'the app only ever asks its own plugin');
      const result = await host.act(config.action, config.args);
      if (result.ok) {
        for (const key of result.refreshed || []) {
          const item = key.slice('code/'.length);
          if (WATCHED.includes(item)) await readInto(item);
        }
      }
      return result;
    }),
  });
  phone.ready();
  const readAll = async () => { for (const item of WATCHED) await readInto(item); };
  if (!options.quiet) await readAll();
  const flush = () => {
    const messages = phone.ackAll();
    messages.forEach((m) => watch.apply(m));
    return messages;
  };
  return { github, host, phone, watch, readInto, readAll, flush };
}

const items = (messages, kind) => messages.filter((m) => m.Cmd === CMD.ITEM && (kind === undefined || m.Kind === kind));

// ---------------------------------------------------------------- reading

test('on ready it subscribes to the six sources it needs, from its own plugin, and sends nothing yet', () => {
  const phone = new Phone({ now: NOW });
  assert.strictEqual(phone.subscriptions.length, 0, 'nothing before ready');
  phone.ready();
  assert.deepStrictEqual(phone.subscriptions.map((s) => [s.request.category, s.request.item, s.request.plugin]),
    WATCHED.map((item) => ['code', item, UUID]));
  assert.deepStrictEqual(phone.sent, []);
});

test('everything goes over: the summary, every list whole, then when GitHub was read', async () => {
  const { phone, watch, flush } = await rig();
  assert.strictEqual(phone.waiting().length, 1, 'one in flight until the watch acks it');
  const messages = flush();
  const summaries = messages.filter((m) => m.Cmd === CMD.SUMMARY);
  assert.deepStrictEqual(summaries, [{ Cmd: CMD.SUMMARY, Login: 'alex-kim', Unread: 9, Reviews: 3, Prs: 3, Failing: 1, Builds: 2, Broken: 1, Repo: 'acme/api' }],
    'one summary, once it can say where issues go and how many builds there are');
  assert.deepStrictEqual(watch.summary, summaries[0]);
  assert.deepStrictEqual(Object.fromEntries(Object.entries(watch.lists).map(([k, list]) => [k, list.length])), { 1: 10, 2: 3, 3: 3, 4: 2, 5: 2 });
  assert.strictEqual(watch.time, NOW / 1000);
  assert.strictEqual(messages[messages.length - 1].Cmd, CMD.TIME, 'the time after the lists it dates');
  assert.ok(!messages.some((m) => m.Cmd === CMD.NOTICE), 'no notice: there\'s nothing wrong');
  assert.deepStrictEqual(watch.problems, []);
  assert.deepStrictEqual(phone.logs, [], 'no console noise');
});

test('a notification: where it\'s from and how long ago, why, what, and the latest word', async () => {
  const { watch, flush } = await rig();
  flush();
  assert.deepStrictEqual(watch.item(KIND.NOTIFICATION, '1001'), {
    Cmd: CMD.ITEM, Kind: KIND.NOTIFICATION, Index: 0, Count: 10,
    Id: '1001',
    Title: 'Retry failed webhooks with backoff',
    Sub: 'acme/api #42 · 15m',
    State: STATE.PENDING, // its pull request is waiting on checks and review
    Flags: FLAG.UNREAD | FLAG.CAN_COMMENT | FLAG.CAN_MARK,
    Group: 0,
    Text: 'Review requested · Pull request\nsam-lee: Looks good, one nit on the retry loop: Cap the delay at 30 s so a dead endpoint doesn\'t hold the queue. See the docs. [code]',
  });
  const row = (id) => {
    const m = watch.item(KIND.NOTIFICATION, id);
    return [m.Sub, m.State, m.Flags, m.Group, m.Text.split('\n')[0]];
  };
  assert.deepStrictEqual(row('1003'), ['acme/website · 1h', STATE.BAD, FLAG.UNREAD | FLAG.CAN_MARK, 3, 'Builds · Build']);
  assert.deepStrictEqual(row('1005'), ['acme/website #119 · 4h', STATE.BAD, FLAG.UNREAD | FLAG.CAN_COMMENT | FLAG.CAN_MARK, 4, 'Other · Pull request']);
  assert.deepStrictEqual(row('1006'), ['acme/api · 5h', STATE.NONE, FLAG.UNREAD | FLAG.CAN_MARK, 1, 'Mentioned · Discussion']);
  assert.deepStrictEqual(row('1007'), ['acme/api #37 · 6m', STATE.NONE, FLAG.CAN_COMMENT | FLAG.CAN_MARK, 4, 'Other · Issue']);
  assert.deepStrictEqual(row('1002'), ['acme/website #118 · 45m', STATE.NONE, FLAG.UNREAD | FLAG.CAN_COMMENT | FLAG.CAN_MARK, 1, 'Mentioned · Issue']);
  assert.deepStrictEqual(watch.lists[KIND.NOTIFICATION].map((m) => m.Id), ['1001', '1002', '1003', '1004', '1005', '1006', '1008', '1009', '1010', '1007']);
});

test('pull requests: repo, number and checks; review and checks, then the latest word', async () => {
  const { watch, flush } = await rig();
  flush();
  const pick = (m) => [m.Sub, m.State, m.Flags, m.Text];
  assert.deepStrictEqual(pick(watch.item(KIND.REVIEW, 'acme/api#39')), ['acme/api #39 · Failing', STATE.BAD, FLAG.CAN_COMMENT | FLAG.CAN_RERUN, 'From jordan-w · Failing\nCI / test failed\nsam-lee requested changes']);
  assert.deepStrictEqual(pick(watch.item(KIND.REVIEW, 'acme/api#42')), ['acme/api #42 · Running', STATE.PENDING, FLAG.CAN_COMMENT, 'From sam-lee · Running\nCI / test running\nsam-lee: Ready for review. The retry loop now backs off.']);
  assert.deepStrictEqual(pick(watch.item(KIND.REVIEW, 'acme/website#121')), ['acme/website #121 · Passing', STATE.PENDING, FLAG.CAN_COMMENT, 'From priya-n · Passing']);
  assert.deepStrictEqual(pick(watch.item(KIND.PR, 'acme/website#119')), ['acme/website #119 · Failing', STATE.BAD, FLAG.CAN_COMMENT | FLAG.CAN_RERUN, 'Changes requested · Failing\nCI / test, lint; Lint / eslint; deploy/preview failed\nsam-lee: Include the lockfile hash.']);
  assert.deepStrictEqual(pick(watch.item(KIND.PR, 'sam-lee/notes-app#12')), ['sam-lee/notes-app #12 · Running', STATE.DRAFT, FLAG.CAN_COMMENT, 'No review · Running\nBuild / build running']);
  assert.deepStrictEqual(pick(watch.item(KIND.PR, 'acme/api#40')), ['acme/api #40 · Passing', STATE.GOOD, FLAG.CAN_COMMENT, 'Approved · Passing\npriya-n approved']);
  assert.ok(!('Group' in watch.item(KIND.PR, 'acme/api#40')), 'Group is for notifications only');
  assert.strictEqual(watch.item(KIND.PR, 'acme/website#119').Title, 'Fix the cache key for build assets');
});

test('builds and repos', async () => {
  const { watch, flush } = await rig();
  flush();
  assert.deepStrictEqual(watch.lists[KIND.BUILD].map((m) => [m.Id, m.Title, m.Sub, m.State, m.Flags, m.Text]), [
    ['acme/website', 'acme/website', 'main · Failing', STATE.BAD, FLAG.CAN_RERUN, 'CI failed on main\nFix the cache key\n13:02'],
    ['acme/api', 'acme/api', 'main · Passing', STATE.GOOD, 0, 'CI passed on main\nLog the request ID\n08:10'],
  ]);
  assert.deepStrictEqual(watch.lists[KIND.REPO].map((m) => [m.Id, m.Title, m.Sub, m.State, m.Flags, m.Text]), [
    ['acme/api', 'acme/api', '', STATE.NONE, FLAG.DEFAULT, ''],
    ['acme/website', 'acme/website', '', STATE.NONE, 0, ''],
  ]);
});

test('ages: now, minutes, hours, days; nothing older than three days is asked for', async () => {
  const github = new FakeGitHub();
  const base = github.notifications[3];
  const when = [['2001', '2026-11-20T14:04:30Z'], ['2002', '2026-11-20T14:00:00Z'], ['2003', '2026-11-20T11:00:00Z'],
    ['2004', '2026-11-18T09:00:00Z'], ['2005', '2026-11-03T09:00:00Z']];
  github.notifications = when.map(([id, updated]) => ({ ...base, id, updated_at: updated, subject: { ...base.subject, latest_comment_url: null } }));
  const { watch, flush } = await rig({ github });
  flush();
  assert.deepStrictEqual(watch.lists[KIND.NOTIFICATION].map((m) => m.Sub), [
    'sam-lee/notes-app #7 · now', 'sam-lee/notes-app #7 · 5m', 'sam-lee/notes-app #7 · 3h', 'sam-lee/notes-app #7 · 2d',
  ], 'the one from 3 November is before since');
});

test('every message fits the watch: its inbox, and each field cut at a word with …', async () => {
  const github = new FakeGitHub();
  const long = 'Überarbeitung der Zwischenspeicherung für Build-Artefakte – „schneller“ und zuverlässiger 🚀 '.repeat(4);
  github.notifications[0].subject.title = long;
  github.comments['https://api.github.com/repos/acme/api/issues/comments/501'].body = 'Sieht gut aus — ein Hinweis zur Wiederholungsschleife. '.repeat(20);
  github.graph.mine.nodes[1].title = long;
  const { watch, flush } = await rig({ github });
  const messages = flush();
  for (const m of messages) {
    assert.ok(dictionarySize(m) <= INBOX_SIZE, `${dictionarySize(m)} bytes > ${INBOX_SIZE}`);
    for (const [key, limit] of Object.entries(LIMITS)) {
      if (typeof m[key] === 'string') assert.ok(utf8(m[key]) <= limit, `${key}: ${utf8(m[key])} > ${limit}`);
    }
    for (const value of Object.values(m)) {
      if (typeof value === 'number') assert.ok(Number.isInteger(value) && value >= -(2 ** 31) && value < 2 ** 31, 'int32: ' + value);
    }
  }
  const first = watch.item(KIND.NOTIFICATION, '1001');
  assert.ok(first.Title.endsWith('…') && utf8(first.Title) > 80, first.Title);
  assert.ok(long.startsWith(first.Title.slice(0, -1) + ' '), 'cut at a word');
  assert.ok(first.Text.endsWith('…') && utf8(first.Text) > 250, utf8(first.Text) + ' ' + first.Text);
  assert.ok(!/�/.test(first.Text + first.Title), 'no broken characters');
  assert.ok(watch.item(KIND.PR, 'acme/website#119').Title.endsWith('…'));
});

test('an id too long for the watch: the item shows, but can\'t be acted on', async () => {
  const github = new FakeGitHub();
  const name = 'a-very-long-organisation-name-for-tests/' + 'r'.repeat(100);
  github.graph.mine.nodes[1].repository.nameWithOwner = name;
  const { watch, flush } = await rig({ github });
  flush();
  const m = watch.lists[KIND.PR].find((x) => x.Title === 'Fix the cache key for build assets');
  assert.strictEqual(m.Id, '');
  assert.strictEqual(m.Flags & (FLAG.CAN_COMMENT | FLAG.CAN_RERUN), 0);
  assert.strictEqual(m.State, STATE.BAD);
});

// ---------------------------------------------------------------- sending

test('the same readings again send nothing; a change sends only its list', async () => {
  const { phone, host, github, readAll, readInto, flush } = await rig();
  flush();
  await readAll();
  assert.deepStrictEqual(phone.ackAll(), [], 'nothing changed');
  host.advance(2 * MINUTE);
  github.graph.mine.nodes[0].reviewDecision = 'CHANGES_REQUESTED';
  await readInto('pull_request');
  const sent = flush();
  assert.deepStrictEqual([...new Set(sent.map((m) => m.Cmd + '/' + (m.Kind || '')))], ['3/3']);
  assert.strictEqual(sent.length, 3);
});

test('ages move on with the next reading of their own list, not with every other source', async () => {
  const { phone, readInto, flush } = await rig();
  flush();
  phone.tick(10 * MINUTE);
  await readInto('build');
  assert.deepStrictEqual(phone.ackAll(), [], 'a build reading doesn\'t resend the notifications');
  await readInto('notification');
  const sent = flush();
  assert.ok(items(sent, KIND.NOTIFICATION).length === 10);
  assert.strictEqual(items(sent, KIND.NOTIFICATION)[0].Sub, 'acme/api #42 · 25m');
});

test('a newer batch replaces what\'s left of an older one', async () => {
  const { phone, host, github, readInto, watch } = await rig({ quiet: true });
  await readInto('notification');
  watch.apply(phone.ack());
  watch.apply(phone.ack());
  host.advance(MINUTE);
  github.lastModified = 'Fri, 20 Nov 2026 14:06:00 GMT';
  github.notifications = github.notifications.slice(0, 3);
  await readInto('notification');
  const rest = phone.ackAll();
  rest.forEach((m) => watch.apply(m));
  // Item 2 of the old batch was already in flight; then the new one, whole.
  assert.deepStrictEqual(items(rest).map((m) => [m.Index, m.Count]), [[2, 10], [0, 3], [1, 3], [2, 3]]);
  assert.deepStrictEqual(watch.lists[KIND.NOTIFICATION].map((m) => m.Id), ['1001', '1002', '1003']);
  assert.deepStrictEqual(watch.problems, []);
});

test('a nack is tried again a second later, three times; then the batch waits for HELLO', async () => {
  const { phone, readInto } = await rig({ quiet: true });
  await readInto('build');
  phone.ack();
  assert.strictEqual(phone.nack().Index, 1);
  assert.strictEqual(phone.waiting().length, 0, 'not straight away');
  phone.tick(999);
  assert.strictEqual(phone.waiting().length, 0);
  phone.tick(1);
  assert.strictEqual(phone.waiting()[0].message.Index, 1, 'the same item again');
  phone.nack();
  phone.tick(1000);
  phone.nack();
  phone.tick(1000);
  assert.strictEqual(phone.nack().Index, 1, 'the third retry');
  phone.tick(60000);
  assert.strictEqual(phone.waiting().length, 0, 'given up');
  phone.hello();
  assert.deepStrictEqual(items(phone.ackAll()).map((m) => m.Index), [0, 1]);
});

test('no answer in 10 seconds counts as a nack', async () => {
  const { phone, readInto } = await rig({ quiet: true });
  await readInto('repo');
  phone.tick(10000);
  assert.strictEqual(phone.waiting().length, 1, 'still the first, unanswered');
  phone.tick(1000);
  assert.deepStrictEqual(phone.waiting().map((s) => s.message.Index), [0, 0], 'and the same item sent again');
});

test('HELLO sends everything again: summary, every list from item 0, the time; a notice only if there is one', async () => {
  const { phone, flush } = await rig();
  flush();
  phone.hello();
  const again = phone.ackAll();
  assert.strictEqual(again[0].Cmd, CMD.SUMMARY);
  assert.deepStrictEqual([1, 2, 3, 4, 5].map((k) => items(again, k).length), [10, 3, 3, 2, 2]);
  assert.ok(!again.some((m) => m.Cmd === CMD.NOTICE));
  assert.deepStrictEqual(again[again.length - 1], { Cmd: CMD.TIME, Updated: NOW / 1000 });
  phone.hello(true); // keyed by number
  assert.strictEqual(phone.ackAll().length, again.length);
  const early = new Phone({ now: NOW }).ready();
  early.hello();
  assert.deepStrictEqual(early.sent, [], 'nothing to send before the plugin answers');
});

// ---------------------------------------------------------------- acting

test('each ACT runs the plugin\'s action, and its RESULT goes ahead of anything waiting', async () => {
  const answers = { mark_read: { ok: true, text: 'Marked read: Retry failed webhooks with backoff' } };
  const { phone, flush, readInto } = await rig({ invoke: async (config) => answers[config.action] || { ok: true, text: 'did ' + config.action } });
  flush();
  phone.invoked.length = 0;
  const acts = [
    [{ Act: 1, Id: '1001' }, 'mark_read', { instanceId: '1001' }],
    [{ Act: 2, Id: '1001' }, 'mark_done', { instanceId: '1001' }],
    [{ Act: 3, Id: '' }, 'mark_all_read', {}],
    [{ Act: 4, Id: 'acme/website#119' }, 'rerun_failed', { instanceId: 'acme/website#119' }],
    [{ Act: 5, Id: '1002', Text: 'Fixed on Safari.' }, 'comment', { instanceId: '1002', text: 'Fixed on Safari.' }],
    [{ Act: 6, Id: '', Text: 'The login page is slow. It takes ten seconds on 3G.', Repo: 'acme/website' }, 'new_issue',
      { title: 'The login page is slow', body: 'It takes ten seconds on 3G.', repo: 'acme/website' }],
    [{ Act: 6, Id: '', Text: 'Search ignores accents', Repo: '' }, 'new_issue', { title: 'Search ignores accents' }],
    [{ Act: 7, Id: '' }, 'refresh', {}],
  ];
  for (const [payload, action, args] of acts) {
    phone.fromWatch({ Cmd: CMD.ACT, ...payload }, true);
    await settle();
    assert.deepStrictEqual(phone.invoked.pop(), { plugin: UUID, action, args, timeoutMs: 30000 });
    const result = phone.ack();
    assert.deepStrictEqual([result.Cmd, result.Act, result.Ok], [CMD.RESULT, payload.Act, 1], action);
  }
  // A RESULT jumps the queue: a list is waiting behind the summary in flight.
  phone.hello();
  phone.fromWatch({ Cmd: CMD.ACT, Act: 1, Id: '1001' });
  await settle();
  assert.strictEqual(phone.ack().Cmd, CMD.SUMMARY, 'already in flight');
  assert.deepStrictEqual(phone.ack(), { Cmd: CMD.RESULT, Act: 1, Ok: 1, Notice: 'Marked read: Retry failed webhooks with backoff' });
  await readInto('repo');
});

test('an ACT that can\'t be done answers Ok 0 and says why', async () => {
  const { phone, flush } = await rig({ invoke: async () => ({ ok: false, code: 'AUTH_REQUIRED', message: 'Token rejected. Paste a new one in settings.' }) });
  flush();
  phone.invoked.length = 0;
  phone.fromWatch({ Cmd: CMD.ACT, Act: 5, Id: '1002', Text: '' });
  phone.fromWatch({ Cmd: CMD.ACT, Act: 9, Id: '' });
  phone.fromWatch({ Cmd: CMD.ACT, Act: 1, Id: '' });
  await settle();
  assert.deepStrictEqual(phone.invoked, [], 'nothing to ask the plugin');
  assert.deepStrictEqual(phone.ackAll(), [
    { Cmd: CMD.RESULT, Act: 5, Ok: 0, Notice: 'Nothing was said.' },
    { Cmd: CMD.RESULT, Act: 9, Ok: 0, Notice: 'The watch asked for something this phone app doesn\'t know.' },
    { Cmd: CMD.RESULT, Act: 1, Ok: 0, Notice: 'That notification has no id.' },
  ]);
  phone.fromWatch({ Cmd: CMD.ACT, Act: 2, Id: '1001' });
  await settle();
  assert.deepStrictEqual(phone.ack(), { Cmd: CMD.RESULT, Act: 2, Ok: 0, Notice: 'Token rejected. Paste a new one in settings.' });
  // The host's own errors aren't written for people; the phone says it in its words.
  const host = await rig({ invoke: async () => ({ ok: false, code: 'TIMEOUT', message: 'no response in 30000ms' }) });
  host.flush();
  host.phone.fromWatch({ Cmd: CMD.ACT, Act: 7, Id: '' });
  await settle();
  assert.deepStrictEqual(host.phone.ack(), { Cmd: CMD.RESULT, Act: 7, Ok: 0, Notice: 'Your phone is slow to answer. Try again.' });
});

test('mark read on the watch, through the real plugin: RESULT, then the list and count follow', async () => {
  const { phone, watch, flush, github } = await rig();
  flush();
  phone.fromWatch({ Cmd: CMD.ACT, Act: 1, Id: '1001', Text: '', Repo: '' }, true);
  await settle();
  flush();
  assert.ok(github.calls().includes('PATCH /notifications/threads/1001'));
  assert.deepStrictEqual(watch.results, [{ Cmd: CMD.RESULT, Act: 1, Ok: 1, Notice: 'Marked read: Retry failed webhooks with backoff' }]);
  assert.strictEqual(watch.item(KIND.NOTIFICATION, '1001').Flags & FLAG.UNREAD, 0);
  assert.strictEqual(watch.summary.Unread, 8);
  assert.deepStrictEqual(watch.problems, []);
});

test('new issue and rerun from the watch, through the real plugin', async () => {
  const { phone, watch, flush, github } = await rig();
  flush();
  phone.fromWatch({ Cmd: CMD.ACT, Act: 6, Id: '', Text: 'The login page is slow. It takes ten seconds on 3G.', Repo: '' });
  await settle();
  phone.fromWatch({ Cmd: CMD.ACT, Act: 4, Id: 'acme/website#119' });
  await settle();
  flush();
  assert.deepStrictEqual(watch.results.map((r) => [r.Act, r.Ok, r.Notice]), [
    [6, 1, 'Opened #131 on acme/api: The login page is slow'],
    [4, 1, 'Rerunning failed jobs in 2 runs on acme/website #119'],
  ]);
  assert.ok(github.calls().includes('POST /repos/acme/api/issues'));
});

// ---------------------------------------------------------------- signed out, demo, problems

test('signed out: an empty summary and empty lists, so the watch shows how to sign in; then signing in fills it', async () => {
  const { phone, watch, host, readAll, flush } = await rig({ signedOut: true });
  const messages = flush();
  assert.deepStrictEqual(messages, [
    { Cmd: CMD.SUMMARY, Login: '', Unread: 0, Reviews: 0, Prs: 0, Failing: 0, Builds: 0, Broken: 0, Repo: '' },
    ...[1, 2, 3, 4, 5].map((kind) => ({ Cmd: CMD.ITEM, Kind: kind, Count: 0 })),
  ], 'no time and no notice: the watch has its own sign-in message');
  await host.config({ type: 'token', token: TOKEN });
  await readAll();
  flush();
  assert.strictEqual(watch.summary.Login, 'alex-kim');
  assert.strictEqual(watch.lists[KIND.NOTIFICATION].length, 10);
  assert.strictEqual(watch.notice, '');
  assert.deepStrictEqual(watch.problems, []);
  // Signing out again empties the watch.
  await host.config({ type: 'signout' });
  await readAll();
  flush();
  assert.strictEqual(watch.summary.Login, '');
  assert.deepStrictEqual(Object.values(watch.lists).map((l) => l.length), [0, 0, 0, 0, 0]);
  assert.deepStrictEqual(phone.logs, []);
});

test('demo: the made-up account shows like a real one', async () => {
  const { watch, flush } = await rig({ signedOut: true, storage: { 'settings.v1': JSON.stringify({ demo: true }) } });
  flush();
  assert.deepStrictEqual(watch.summary, { Cmd: CMD.SUMMARY, Login: 'alex-kim', Unread: 6, Reviews: 3, Prs: 4, Failing: 1, Builds: 3, Broken: 1, Repo: 'acme/website' });
  assert.strictEqual(watch.lists[KIND.NOTIFICATION].length, 8);
  assert.deepStrictEqual(watch.lists[KIND.REPO].map((m) => [m.Title, m.Flags]), [['acme/website', FLAG.DEFAULT], ['acme/api', 0], ['alex-kim/notes-app', 0]]);
});

test('a problem is a notice on the watch, in the plugin\'s words; good readings clear it', async () => {
  const { phone, watch, github, host, readAll, flush } = await rig({ github: { online: false } });
  const sent = flush();
  assert.deepStrictEqual(sent.filter((m) => m.Cmd !== CMD.ITEM || m.Kind !== KIND.REPO),
    [{ Cmd: CMD.NOTICE, Notice: 'Couldn\'t reach GitHub. Check the phone is online.' }], 'only the repos, which come from settings');
  assert.strictEqual(watch.summary, null, 'no summary of nothing');
  await readAll();
  assert.deepStrictEqual(phone.ackAll(), [], 'the same problem isn\'t sent twice');
  github.online = true;
  host.advance(MINUTE);
  await readAll();
  flush();
  assert.strictEqual(watch.notice, '');
  assert.strictEqual(watch.summary.Unread, 9);
  github.token = 'ghp_revoked';
  host.advance(5 * MINUTE);
  await readAll();
  flush();
  assert.strictEqual(watch.notice, 'Token rejected. Paste a new one in settings.');
  assert.strictEqual(watch.summary.Unread, 9, 'the lists stay, with the notice above them');
});

test('notices: a host error in its own words is put in ours; a code prefix is dropped', async () => {
  const { phone, flush } = await rig({ quiet: true });
  flush();
  phone.fail('inbox', { code: 'PLUGIN_UNAVAILABLE', message: 'No plugin for code/inbox' });
  assert.deepStrictEqual(phone.ack(), { Cmd: CMD.NOTICE, Notice: 'Inbox for GitHub isn\'t answering on your phone. Try opening it again.' });
  phone.fail('inbox', { code: 'RATE_LIMITED', message: 'RATE_LIMITED: GitHub\'s rate limit is used up until 14:25.' });
  assert.deepStrictEqual(phone.ack(), { Cmd: CMD.NOTICE, Notice: 'GitHub\'s rate limit is used up until 14:25.' });
});

test('a fine-grained token: the lists that work, and a notice about the one that doesn\'t', async () => {
  const token = 'github_pat_' + 'FakeFineGrained0000000' + '_' + 'z'.repeat(59);
  const { watch, flush } = await rig({ github: { token }, storage: { 'account.v1': JSON.stringify({ token, login: 'alex-kim' }) } });
  flush();
  assert.strictEqual(watch.notice, 'Notifications need a classic token. Paste one in Inbox for GitHub\'s settings.');
  assert.strictEqual(watch.summary.Unread, 0);
  assert.strictEqual(watch.summary.Reviews, 3);
  assert.strictEqual(watch.lists[KIND.NOTIFICATION], undefined, 'no notifications list at all');
  assert.strictEqual(watch.lists[KIND.PR].length, 3);
});

test('an old Pebble app without plugins: a notice to update it, and actions say the same', async () => {
  const phone = new Phone({ plugins: false, now: NOW }).ready();
  const update = 'Update the Pebble app on your phone to use Inbox for GitHub.';
  assert.deepStrictEqual(phone.ack(), { Cmd: CMD.NOTICE, Notice: update });
  phone.fromWatch({ Cmd: CMD.ACT, Act: 7, Id: '' });
  assert.deepStrictEqual(phone.ack(), { Cmd: CMD.RESULT, Act: 7, Ok: 0, Notice: update });
  phone.hello();
  assert.deepStrictEqual(phone.ackAll(), [{ Cmd: CMD.NOTICE, Notice: update }]);
});

// ---------------------------------------------------------------- the contract

test('the phone, DESIGN.md and the watch agree: uuid, message keys, numbers and limits', () => {
  const pkjs = fs.readFileSync(path.join(ROOT, 'src', 'pkjs', 'index.js'), 'utf8');
  assert.strictEqual(/PLUGIN_UUID = '([^']+)'/.exec(pkjs)[1], UUID, 'it reads its own plugin');
  const keys = PACKAGE.pebble.messageKeys;
  const code = pkjs.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const used = new Set([...code.matchAll(/\b([A-Z][a-z]+):/g)].map((m) => m[1]));
  for (const key of used) assert.ok(keys.includes(key), key + ' is a message key');
  for (const key of ['Cmd', 'Act', 'Id', 'Text', 'Repo']) assert.ok(code.includes('\'' + key + '\''), 'it reads ' + key + ' from the watch');
  const object = (name) => JSON.parse(new RegExp('var ' + name + ' = (\\{[^}]+\\})').exec(pkjs)[1].replace(/(\w+):/g, '"$1":'));
  assert.deepStrictEqual(object('CMD'), CMD);
  assert.deepStrictEqual(object('KIND'), KIND);
  assert.deepStrictEqual(object('STATE'), STATE);
  assert.deepStrictEqual(object('FLAG'), FLAG);
  assert.deepStrictEqual(object('ACT'), { MARK_READ: 1, MARK_DONE: 2, MARK_ALL_READ: 3, RERUN: 4, COMMENT: 5, NEW_ISSUE: 6, REFRESH: 7 });
  assert.deepStrictEqual(object('LIMITS'), { id: 127, title: 100, sub: 47, text: 280, notice: 159, login: 39, repo: 100 });
  assert.deepStrictEqual(object('MAX_ITEMS'), { 1: 15, 2: 8, 3: 8, 4: 6, 5: 6 });
  // The watch app (src/c), when it's there: the same numbers, every key read, room for the lists.
  const header = path.join(ROOT, 'src', 'c', 'inbox.h');
  if (!fs.existsSync(header)) return;
  const h = fs.readFileSync(header, 'utf8');
  const c = fs.readdirSync(path.join(ROOT, 'src', 'c')).filter((f) => /\.[ch]$/.test(f))
    .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'c', f), 'utf8')).join('\n');
  const value = (name) => {
    const m = new RegExp('\\b' + name + '\\s*=\\s*(\\d+)').exec(h) || new RegExp('#define ' + name + ' (\\d+)').exec(h);
    assert.ok(m, name + ' in inbox.h');
    return Number(m[1]);
  };
  for (const [prefix, table] of [['CMD', CMD], ['KIND', KIND], ['STATE', STATE], ['FLAG', FLAG], ['ACT', object('ACT')]]) {
    for (const [name, number] of Object.entries(table)) assert.strictEqual(value(prefix + '_' + name), number, prefix + '_' + name);
  }
  for (const [name, limit] of Object.entries(object('LIMITS'))) assert.strictEqual(value(name.toUpperCase() + '_MAX'), limit, name);
  for (const key of keys) assert.ok(c.includes('MESSAGE_KEY_' + key), 'the watch uses ' + key);
  const inbox = /#define INBOX_SIZE (\d+)/.exec(c);
  if (inbox) assert.ok(Number(inbox[1]) >= INBOX_SIZE, 'the watch\'s inbox');
  assert.strictEqual(MESSAGE_KEYS.Cmd, 10000);
});

test('a long dictation for a new issue: the title is cut at 80 characters at a word, and the body keeps every word', async () => {
  const { phone, flush } = await rig({ invoke: async () => ({ ok: true, text: 'Opened #131' }) });
  flush();
  const said = 'when I open the settings page on my phone after signing in with a new token the list of repositories takes a long time to appear and sometimes it never does '.repeat(2).trim();
  phone.fromWatch({ Cmd: CMD.ACT, Act: 6, Id: '', Text: said, Repo: '' });
  await settle();
  const args = phone.invoked[0].args;
  assert.ok(args.title.length <= 80 && args.title.endsWith('…'), args.title);
  assert.ok(said.startsWith(args.title.slice(0, -1) + ' '), 'cut at a word');
  assert.strictEqual(args.body, said);
});
