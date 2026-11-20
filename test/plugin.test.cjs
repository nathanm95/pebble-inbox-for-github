// The plugin (src/plugin/index.js) against a fake GitHub (test/lib/github.cjs): what it asks
// GitHub for and how often, what it makes of the answers, its actions, its settings page and its
// demo. Every envelope goes through the app's own shape checks (plugin.cjs readOk): nothing may
// be dropped.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Host, propertiesOf } = require('./lib/plugin.cjs');
const { FakeGitHub, TOKEN, API } = require('./lib/github.cjs');

const DIR = path.join(__dirname, '..');
// Friday 20 November 2026, 14:05 in London (GMT, so the same in UTC).
const NOW = Date.UTC(2026, 10, 20, 14, 5);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const at = (hhmm, day = 20) => Date.UTC(2026, 10, day, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3))) / 1000;
const ITEMS = ['inbox', 'notification', 'review_request', 'pull_request', 'build', 'repo', 'contributions'];
const ALL = ITEMS.map((item) => 'code/' + item);
const NO_TOKEN = { code: 'NOT_CONFIGURED', message: 'Sign in to GitHub in Inbox for GitHub\'s settings.' };
// Read and unread, from local midnight three days ago.
const LIST = 'GET /notifications?all=true&per_page=15&since=2026-11-17T00:00:00Z';

/** A plugin signed in as alex-kim, watching acme/api and acme/website, new issues to acme/api. */
function signedIn(options = {}) {
  const github = new FakeGitHub(options.github);
  const storage = {
    'account.v1': JSON.stringify({ token: options.token || TOKEN, login: 'alex-kim', scopes: ['notifications', 'repo'] }),
    'settings.v1': JSON.stringify({ builds: ['acme/api', 'acme/website'], issueRepo: 'acme/api', ...(options.settings || {}) }),
    ...(options.storage || {}),
  };
  const h = new Host(DIR, { now: NOW, storage, fetch: github.fetch, readSource: options.readSource });
  h.github = github;
  return h;
}

function signedOut(options = {}) {
  const github = new FakeGitHub(options.github);
  const h = new Host(DIR, { now: NOW, storage: options.storage || {}, fetch: github.fetch });
  h.github = github;
  return h;
}

const read = (h, item) => h.readOk('code', item);
const ids = (envelope) => envelope.instances.map((i) => i.instanceId);
const kept = (h, key) => JSON.parse(h.storage.get(key) || 'null');
const text = (value) => ({ shortText: { text: value } });
const both = (value, long = value) => ({ shortText: { text: value }, longText: { text: long } });
const flag = (value) => ({ boolean: { value } });
const count = (value, shortText = String(value)) => ({ numericValue: { value }, shortText: { text: shortText } });
const stamp = (seconds, shortText) => ({ timestamp: { value: seconds }, shortText: { text: shortText } });

/** Nothing the plugin logs or keeps outside its account may hold the token. */
function assertTokenKept(h, token = TOKEN) {
  assert.ok(!h.logs.join('\n').includes(token), 'the token is never logged');
  for (const [key, value] of h.storage) {
    if (key !== 'account.v1') assert.ok(!value.includes(token), key + ' doesn\'t hold the token');
  }
}

// ---------------------------------------------------------------- signed out

test('signed out: every source and action asks to sign in, and GitHub isn\'t asked anything', async () => {
  const h = signedOut();
  for (const item of ITEMS) {
    assert.deepStrictEqual((await h.read('code', item)).error, NO_TOKEN, item);
  }
  for (const [action, args] of [['mark_read', { instanceId: '1001' }], ['mark_all_read', {}], ['new_issue', { title: 'x' }]]) {
    assert.deepStrictEqual(await h.act(action, args), { ok: false, ...NO_TOKEN }, action);
  }
  assert.deepStrictEqual(h.github.requests, []);
});

test('a source it doesn\'t serve is an invalid request', async () => {
  const h = signedIn();
  const session = h.session();
  const answer = await Host.answer((done) => session.source({ category: 'code', item: 'gists' }, {
    data: (envelope) => done({ envelope }),
    error: (code, message) => done({ code, message }),
  }));
  assert.strictEqual(answer.code, 'INVALID_REQUEST');
});

// ---------------------------------------------------------------- notifications

test('notifications: unread first, then newest, by GitHub\'s thread id', async () => {
  const h = signedIn();
  const envelope = await read(h, 'notification');
  assert.deepStrictEqual(ids(envelope), ['1001', '1002', '1003', '1004', '1005', '1006', '1008', '1009', '1010', '1007']);
  assert.strictEqual(envelope.validUntilMs, NOW + MINUTE, 'X-Poll-Interval: 60');
  assert.deepStrictEqual(propertiesOf(envelope, '1001'), {
    title: both('Retry failed webhooks with backoff'),
    repo: text('acme/api'),
    kind: text('Pull request'),
    reason: text('Review requested'),
    unread: flag(true),
    number: { numericValue: { value: 42 } },
    author: text('sam-lee'),
    latest: { longText: { text: 'sam-lee: Looks good, one nit on the retry loop: Cap the delay at 30 s so a dead endpoint doesn\'t hold the queue. See the docs. [code]' } },
    updated: stamp(at('13:50'), '13:50'),
  });
  assertTokenKept(h);
});

test('notifications: reasons go to the watch\'s groups, subject types to words', async () => {
  const envelope = await read(signedIn(), 'notification');
  const row = (id) => {
    const p = propertiesOf(envelope, id);
    return [p.reason.shortText.text, p.kind.shortText.text, p.number ? p.number.numericValue.value : null, p.unread.boolean.value];
  };
  assert.deepStrictEqual(Object.fromEntries(ids(envelope).map((id) => [id, row(id)])), {
    1001: ['Review requested', 'Pull request', 42, true],
    1002: ['Mentioned', 'Issue', 118, true],
    1003: ['Builds', 'Build', null, true],
    1004: ['Assigned', 'Issue', 7, true],
    1005: ['Other', 'Pull request', 119, true],
    1006: ['Mentioned', 'Discussion', null, true],
    1007: ['Other', 'Issue', 37, false],
    1008: ['Other', 'Release', null, true],
    1009: ['Other', 'Repository vulnerability alert', null, true],
    1010: ['Mentioned', 'Issue', 45, true],
  });
  // An issue's own body when it has no comments yet, and a release's notes, read as plain text.
  assert.strictEqual(propertiesOf(envelope, '1004').latest.longText.text, 'jordan-w: What An Export menu item that writes each note as a .md file. keep front matter keep tags');
  assert.strictEqual(propertiesOf(envelope, '1008').latest.longText.text, 'sam-lee: Highlights Faster search Dark mode fixes A new export menu');
  assert.strictEqual(propertiesOf(envelope, '1002').latest.longText.text, 'priya-n: @alex-kim could you check this on Safari? It resets after a reload. screenshot');
  assert.strictEqual(propertiesOf(envelope, '1003').latest, undefined, 'a build has no comment');
});

test('GitHub is asked with the token as a bearer, its media type, API version and an app User-Agent', async () => {
  const h = signedIn();
  await read(h, 'inbox');
  assert.ok(h.github.requests.length >= 2);
  for (const request of h.github.requests) {
    assert.strictEqual(request.headers.Authorization, 'Bearer ' + TOKEN, request.url);
    assert.strictEqual(request.headers.Accept, 'application/vnd.github+json');
    assert.strictEqual(request.headers['X-GitHub-Api-Version'], '2022-11-28');
    assert.strictEqual(request.headers['User-Agent'], 'Inbox-for-GitHub-Pebble');
    assert.ok(request.url.startsWith(API + '/'), 'only the API: ' + request.url);
  }
  assert.ok(h.github.calls().includes(LIST));
  assertTokenKept(h);
});

test('latest comments: five at most per read, all at once; the rest at the next read; kept until the thread changes', async () => {
  const h = signedIn();
  let envelope = await read(h, 'notification');
  const comments = () => h.github.calls().filter((c) => c.includes('/comments/') || c.includes('/issues/7') || c.includes('/releases/'));
  assert.deepStrictEqual(comments(), [
    'GET /repos/acme/api/issues/comments/501',
    'GET /repos/acme/website/issues/comments/502',
    'GET /repos/sam-lee/notes-app/issues/7',
    'GET /repos/acme/website/issues/comments/503',
    'GET /repos/acme/website/releases/99',
  ], 'newest first; the read one (1007) and the oldest (1010) wait');
  assert.strictEqual(propertiesOf(envelope, '1010').latest, undefined);
  h.github.reset();
  h.advance(MINUTE);
  envelope = await read(h, 'notification');
  assert.deepStrictEqual(h.github.calls(), [LIST, 'GET /repos/acme/website/issues/comments/504', 'GET /repos/acme/api/issues/37']);
  assert.strictEqual(h.github.requests[0].headers['If-Modified-Since'], 'Fri, 20 Nov 2026 13:50:00 GMT');
  assert.strictEqual(propertiesOf(envelope, '1010').latest.longText.text, 'priya-n: Searching for café finds nothing.');
  // A new comment on 1002: GitHub moves its updated_at, and only that comment is read again.
  h.github.reset();
  h.github.notifications[1].updated_at = '2026-11-20T14:06:00Z';
  h.github.comments[API + '/repos/acme/website/issues/comments/502'].body = 'Fixed it, thanks!';
  h.github.lastModified = 'Fri, 20 Nov 2026 14:06:00 GMT';
  h.advance(MINUTE);
  envelope = await read(h, 'notification');
  assert.deepStrictEqual(h.github.calls(), [LIST, 'GET /repos/acme/website/issues/comments/502']);
  assert.deepStrictEqual(ids(envelope).slice(0, 2), ['1002', '1001']);
  assert.strictEqual(propertiesOf(envelope, '1002').latest.longText.text, 'priya-n: Fixed it, thanks!');
});

test('If-Modified-Since: an unchanged inbox is a 304 and kept; X-Poll-Interval is the gap', async () => {
  const h = signedIn();
  await read(h, 'notification');
  await read(h, 'notification');
  h.advance(59 * SECOND);
  await read(h, 'inbox');
  const lists = () => h.github.calls().filter((c) => c.startsWith('GET /notifications'));
  assert.strictEqual(lists().length, 1, 'not again within X-Poll-Interval, whichever source asks');
  h.advance(SECOND);
  const envelope = await read(h, 'notification');
  assert.strictEqual(lists().length, 2);
  assert.strictEqual(ids(envelope).length, 10, 'the 304 kept the list');
  assert.strictEqual(envelope.validUntilMs, NOW + 2 * MINUTE);
  // GitHub asks for longer gaps when it's busy.
  h.github.pollInterval = 180;
  h.github.lastModified = 'Fri, 20 Nov 2026 14:06:00 GMT';
  h.advance(MINUTE);
  assert.strictEqual((await read(h, 'notification')).validUntilMs, NOW + 2 * MINUTE + 3 * MINUTE);
  h.advance(2 * MINUTE);
  await read(h, 'notification');
  assert.strictEqual(lists().length, 3, 'not before 180 s');
  h.advance(MINUTE);
  await read(h, 'notification');
  assert.strictEqual(lists().length, 4);
});

test('when the host hides response headers: a 60 s gap, no If-Modified-Since, no rate-limit times', async () => {
  const h = signedIn({ github: { headers: false, pollInterval: 300 } });
  const first = await read(h, 'notification');
  assert.strictEqual(ids(first).length, 10);
  assert.strictEqual(first.validUntilMs, NOW + MINUTE);
  h.advance(MINUTE);
  await read(h, 'notification');
  const lists = h.github.requests.filter((r) => r.url.startsWith(API + '/notifications'));
  assert.strictEqual(lists.length, 2);
  assert.strictEqual(lists[1].headers['If-Modified-Since'], undefined);
  // A 403 it can't read headers for is still a rate limit when GitHub's message says so.
  h.github.rateLimited = { reset: NOW / 1000 + 600 };
  h.advance(MINUTE);
  const stale = await h.read('code', 'notification');
  assert.strictEqual(stale.envelope.instances.length, 10, 'the kept list');
  h.advance(6 * HOUR);
  assert.deepStrictEqual((await h.read('code', 'notification')).error, {
    code: 'RATE_LIMITED', message: 'GitHub asked Inbox for GitHub to slow down. It will try again.',
  });
});

test('only notifications I\'m part of: participating=true, read afresh when the setting changes', async () => {
  const h = signedIn();
  await read(h, 'notification');
  await h.config({ type: 'set', participating: true, builds: ['acme/api'], issueRepo: 'acme/api' });
  h.github.reset();
  await read(h, 'notification');
  assert.strictEqual(h.github.calls()[0], LIST + '&participating=true');
  assert.strictEqual(h.github.requests[0].headers['If-Modified-Since'], undefined, 'a different list');
});

test('the list: read and unread from the last three days, from local midnight, the same all day', async () => {
  const h = signedIn();
  await read(h, 'notification');
  assert.strictEqual(h.github.calls()[0], LIST);
  h.github.reset();
  h.advance(9 * 60 * MINUTE + 54 * MINUTE); // 23:59
  await read(h, 'notification');
  assert.deepStrictEqual(h.github.calls().slice(0, 1), [LIST], 'the same query all day');
  assert.strictEqual(h.github.requests[0].headers['If-Modified-Since'], 'Fri, 20 Nov 2026 13:50:00 GMT', 'so a 304 still saves it');
  h.github.reset();
  h.advance(2 * MINUTE); // 00:01 on Saturday
  await read(h, 'notification');
  assert.strictEqual(h.github.calls()[0], 'GET /notifications?all=true&per_page=15&since=2026-11-18T00:00:00Z');
  assert.strictEqual(h.github.requests[0].headers['If-Modified-Since'], undefined, 'a new day, a new list');
});

test('a read notification keeps its row, after the unread ones; the summary counts only unread', async () => {
  const h = signedIn();
  await read(h, 'notification');
  await h.act('mark_read', { instanceId: '1002' });
  h.advance(10 * MINUTE); // the mark has lapsed: this is GitHub's own list
  const envelope = await read(h, 'notification');
  assert.deepStrictEqual(ids(envelope).slice(-3), ['1010', '1007', '1002']);
  assert.strictEqual(propertiesOf(envelope, '1002').unread.boolean.value, false);
  assert.deepStrictEqual(propertiesOf(await read(h, 'inbox')).unread, count(8));
});

test('15+ only when every one of the 15 is unread and GitHub has more', async () => {
  const fifteen = (h, readOne) => Array.from({ length: 15 }, (_, i) => ({ ...h.github.notifications[2], id: String(2000 + i), unread: !(readOne && i === 14) }));
  const all = signedIn({ github: { more: true } });
  all.github.notifications = fifteen(all);
  const inbox = propertiesOf(await read(all, 'inbox'));
  assert.deepStrictEqual(inbox.unread, count(15, '15+'));
  assert.ok(inbox.status.longText.text.startsWith('15+ unread notifications.'));
  const mixed = signedIn({ github: { more: true } });
  mixed.github.notifications = fifteen(mixed, true);
  assert.deepStrictEqual(propertiesOf(await read(mixed, 'inbox')).unread, count(14), 'a read one on the page: the unread all fit');
  const last = signedIn({ github: { more: false } });
  last.github.notifications = fifteen(last);
  assert.deepStrictEqual(propertiesOf(await read(last, 'inbox')).unread, count(15), 'no next page');
});

// ---------------------------------------------------------------- pull requests and builds

test('reviews waiting: failing first, then the most recently updated', async () => {
  const h = signedIn();
  const envelope = await read(h, 'review_request');
  assert.deepStrictEqual(ids(envelope), ['acme/api#39', 'acme/api#42', 'acme/website#121']);
  assert.deepStrictEqual(propertiesOf(envelope, 'acme/api#39'), {
    title: both('Move config to environment variables'),
    repo: text('acme/api'),
    number: { numericValue: { value: 39 } },
    checks: both('Failing', 'CI / test failed'),
    failing: flag(true),
    running: flag(false),
    review: text('Changes requested'),
    approved: flag(false),
    draft: flag(false),
    author: text('jordan-w'),
    latest: { longText: { text: 'sam-lee requested changes' } },
    updated: stamp(at('16:00', 19), '16:00'),
  });
  const running = propertiesOf(envelope, 'acme/api#42');
  assert.deepStrictEqual([running.checks, running.running, running.review, running.latest.longText.text],
    [both('Running', 'CI / test running'), flag(true), text('Review required'), 'sam-lee: Ready for review. The retry loop now backs off.']);
  assert.strictEqual(envelope.validUntilMs, NOW + 2 * MINUTE);
});

test('my pull requests: checks, review, draft, and the newer of the last comment and review', async () => {
  const envelope = await read(signedIn(), 'pull_request');
  assert.deepStrictEqual(ids(envelope), ['acme/website#119', 'sam-lee/notes-app#12', 'acme/api#40']);
  const row = (id) => {
    const p = propertiesOf(envelope, id);
    return [p.checks.shortText.text, p.checks.longText.text, p.review.shortText.text, p.failing.boolean.value, p.running.boolean.value,
      p.approved.boolean.value, p.draft.boolean.value, p.latest ? p.latest.longText.text : null];
  };
  assert.deepStrictEqual(row('acme/website#119'), ['Failing', 'CI / test, lint; Lint / eslint; deploy/preview failed', 'Changes requested', true, false, false, false, 'sam-lee: Include the lockfile hash.'],
    'a cancelled job isn\'t a failure; jobs in one workflow share its name');
  assert.deepStrictEqual(row('sam-lee/notes-app#12'), ['Running', 'Build / build running', 'No review', false, true, false, true, null]);
  assert.deepStrictEqual(row('acme/api#40'), ['Passing', 'Checks passed', 'Approved', false, false, true, false, 'priya-n approved']);
});

test('builds: in the settings\' order with failing ones first; a gone repo is left out', async () => {
  const h = signedIn({ settings: { builds: ['acme/api', 'acme/gone', 'acme/website', 'acme/empty'] } });
  const envelope = await read(h, 'build');
  assert.deepStrictEqual(ids(envelope), ['acme/website', 'acme/api', 'acme/empty']);
  assert.deepStrictEqual(propertiesOf(envelope, 'acme/website'), {
    repo: text('acme/website'),
    status: both('Failing', 'CI failed on main'),
    failing: flag(true),
    running: flag(false),
    branch: text('main'),
    workflow: text('CI'),
    commit: both('3f9c2ab', 'Fix the cache key'),
    updated: stamp(at('13:02'), '13:02'),
  });
  assert.deepStrictEqual(propertiesOf(envelope, 'acme/api').status, both('Passing', 'CI passed on main'));
  assert.deepStrictEqual(propertiesOf(envelope, 'acme/empty').status, both('No checks', 'No checks on main'));
  assert.strictEqual(propertiesOf(envelope, 'acme/empty').workflow, undefined);
  const query = h.github.graphqlQueries()[0];
  assert.ok(query.includes('b0: repository(owner: "acme", name: "api")'));
  assert.ok(query.includes('b3: repository(owner: "acme", name: "empty")'));
  assert.ok(query.includes('review-requested:@me archived:false sort:updated-desc'));
});

test('no builds chosen: an empty list, without asking GitHub', async () => {
  const h = signedIn({ settings: { builds: [] } });
  assert.deepStrictEqual(ids(await read(h, 'build')), []);
  assert.deepStrictEqual(h.github.requests, []);
});

test('one GraphQL query every two minutes serves the summary, reviews, my PRs and builds', async () => {
  const h = signedIn();
  for (const item of ['inbox', 'review_request', 'pull_request', 'build']) await read(h, item);
  h.advance(2 * MINUTE - 1);
  for (const item of ['inbox', 'review_request', 'pull_request', 'build']) await read(h, item);
  assert.strictEqual(h.github.graphqlQueries().length, 1);
  h.advance(1);
  await read(h, 'build');
  assert.strictEqual(h.github.graphqlQueries().length, 2);
  // A new choice of builds is a new query at once.
  await h.config({ type: 'set', builds: ['acme/website'], issueRepo: '' });
  assert.deepStrictEqual(ids(await read(h, 'build')), ['acme/website']);
  assert.strictEqual(h.github.graphqlQueries().length, 3);
});

test('repos: the one taking issues first, then the build repos, six at most', async () => {
  const h = signedIn({ settings: { builds: ['acme/website', 'acme/a', 'acme/b', 'acme/c', 'acme/d', 'acme/e'], issueRepo: 'acme/api' } });
  const envelope = await read(h, 'repo');
  assert.deepStrictEqual(ids(envelope), ['acme/api', 'acme/website', 'acme/a', 'acme/b', 'acme/c', 'acme/d']);
  assert.deepStrictEqual(propertiesOf(envelope, 'acme/api'), { name: text('acme/api'), issues: flag(true), builds: flag(false) });
  assert.deepStrictEqual(propertiesOf(envelope, 'acme/website'), { name: text('acme/website'), issues: flag(false), builds: flag(true) });
  assert.deepStrictEqual(h.github.requests, [], 'settings alone');
});

// ---------------------------------------------------------------- summary and contributions

test('the inbox: one summary of all of it', async () => {
  const h = signedIn();
  const envelope = await read(h, 'inbox');
  assert.deepStrictEqual(ids(envelope), ['inbox']);
  assert.deepStrictEqual(propertiesOf(envelope), {
    unread: count(9),
    latest: both('Retry failed webhooks with backoff', 'acme/api #42: Retry failed webhooks with backoff — sam-lee: Looks good, one nit on the retry loop: Cap the delay at 30 s so a dead endpoint doesn\'t hold the queue. See the docs. [code]'),
    reviews: count(3),
    pull_requests: count(3),
    failing: count(1),
    builds_failing: count(1),
    status: both('2 failing', '9 unread notifications. 3 pull requests waiting for your review. 3 open pull requests of yours, 1 failing. 1 of 2 builds failing.'),
    login: text('alex-kim'),
    updated: stamp(NOW / 1000, '14:05'),
  });
  assert.strictEqual(envelope.validUntilMs, NOW + MINUTE, 'as soon as either half is due');
});

test('the inbox when all is quiet', async () => {
  const h = signedIn({ settings: { builds: [] } });
  h.github.notifications = [];
  h.github.graph.reviews = { issueCount: 0, nodes: [] };
  h.github.graph.mine = { issueCount: 0, nodes: [] };
  const inbox = propertiesOf(await read(h, 'inbox'));
  assert.deepStrictEqual(inbox.status, both('All clear', 'No unread notifications. No reviews waiting. No open pull requests of yours.'));
  assert.strictEqual(inbox.latest, undefined);
});

test('contributions: today, the streak, the week, the year and the last 14 days', async () => {
  const h = signedIn();
  const envelope = await read(h, 'contributions');
  assert.deepStrictEqual(propertiesOf(envelope), {
    today: count(3),
    streak: { numericValue: { value: 5, unit: 'days' }, shortText: { text: '5d' } },
    week: count(18),
    year: count(1234),
    daily: { series: { start: Date.UTC(2026, 10, 7) / 1000, stepSec: 86400, numericValue: { values: [0, 3, 2, 0, 1, 5, 2, 1, 0, 4, 2, 7, 1, 3] } } },
    updated: stamp(NOW / 1000, '14:05'),
  });
  h.advance(30 * MINUTE - 1);
  await read(h, 'contributions');
  assert.strictEqual(h.github.graphqlQueries().length, 1, 'every 30 minutes at most');
  h.advance(1);
  await read(h, 'contributions');
  assert.strictEqual(h.github.graphqlQueries().length, 2);
});

test('a streak isn\'t broken until the day is over, and can be longer than two weeks', async () => {
  const quiet = signedIn();
  const weeks = quiet.github.contributions.data.viewer.contributionsCollection.contributionCalendar.weeks;
  weeks[weeks.length - 1].contributionDays.slice(-1)[0].contributionCount = 0;
  const today = propertiesOf(await read(quiet, 'contributions'));
  assert.deepStrictEqual([today.today.numericValue.value, today.streak.numericValue.value], [0, 4]);

  const busy = signedIn();
  busy.github.contributions.data.viewer.contributionsCollection.contributionCalendar.weeks.forEach((week) => {
    week.contributionDays.forEach((day) => { day.contributionCount = 2; });
  });
  assert.strictEqual(propertiesOf(await read(busy, 'contributions')).streak.numericValue.value, 34);
});

// ---------------------------------------------------------------- when things go wrong

test('a rejected token is said at once, never hidden behind a kept answer', async () => {
  const h = signedIn();
  await read(h, 'notification');
  await read(h, 'pull_request');
  h.github.token = 'ghp_revoked';
  h.advance(5 * MINUTE);
  const rejected = { code: 'AUTH_REQUIRED', message: 'Token rejected. Paste a new one in settings.' };
  for (const item of ['notification', 'pull_request', 'inbox', 'contributions']) {
    assert.deepStrictEqual((await h.read('code', item)).error, rejected, item);
  }
});

test('a fine-grained token: notifications say they need a classic token; the rest still works', async () => {
  const token = 'github_pat_' + 'FakeFineGrained0000000' + '_' + 'z'.repeat(59);
  const h = signedIn({ token, github: { token } });
  const classic = { code: 'AUTH_REQUIRED', message: 'Notifications need a classic token. Paste one in Inbox for GitHub\'s settings.' };
  assert.deepStrictEqual((await h.read('code', 'notification')).error, classic);
  const inbox = propertiesOf(await read(h, 'inbox'));
  assert.strictEqual(inbox.unread, undefined, 'not nought: unknown');
  assert.deepStrictEqual(inbox.reviews, count(3));
  assert.ok(inbox.status.longText.text.startsWith('Notifications need a classic token. Paste one in Inbox for GitHub\'s settings. 3 pull requests'), inbox.status.longText.text);
  assert.strictEqual(ids(await read(h, 'pull_request')).length, 3);
  assertTokenKept(h, token);
});

test('rate limited: the kept answer is served until GitHub lets it ask again', async () => {
  const h = signedIn();
  await read(h, 'notification');
  const reset = NOW / 1000 + 20 * 60;
  h.github.rateLimited = { reset };
  h.advance(2 * MINUTE);
  const kept1 = await read(h, 'notification');
  assert.strictEqual(ids(kept1).length, 10);
  assert.strictEqual(kept1.validUntilMs, reset * 1000, 'try again when the limit lifts');
  const asked = h.github.requests.length;
  h.advance(5 * MINUTE);
  await read(h, 'notification');
  assert.strictEqual(h.github.requests.length, asked, 'no asking while it\'s limited');
  const fresh = signedIn({ github: { rateLimited: { reset } } });
  assert.deepStrictEqual((await fresh.read('code', 'pull_request')).error, { code: 'RATE_LIMITED', message: 'GitHub\'s rate limit is used up until 14:25.' });
});

test('offline: the last answer is served with its own time for six hours, then an error', async () => {
  const h = signedIn();
  await read(h, 'inbox');
  h.github.online = false;
  h.advance(10 * MINUTE);
  const kept1 = propertiesOf(await read(h, 'inbox'));
  assert.deepStrictEqual(kept1.updated, stamp(NOW / 1000, '14:05'), 'when GitHub was read');
  assert.deepStrictEqual(kept1.unread, count(9));
  // Straight after a failure, another source doesn't wait on the network again.
  const asked = h.github.requests.length;
  h.advance(10 * SECOND);
  await read(h, 'pull_request');
  assert.strictEqual(h.github.requests.length, asked);
  h.advance(6 * HOUR);
  assert.deepStrictEqual((await h.read('code', 'inbox')).error, { code: 'PLUGIN_UNAVAILABLE', message: 'Couldn\'t reach GitHub. Check the phone is online.' });
  const never = signedIn({ github: { online: false } });
  assert.strictEqual((await never.read('code', 'build')).error.code, 'PLUGIN_UNAVAILABLE');
});

test('GitHub\'s own errors: a 502, and a GraphQL answer that is only errors', async () => {
  const h = signedIn({ github: { fail: { 'GET /notifications': 502 } } });
  assert.deepStrictEqual((await h.read('code', 'notification')).error, { code: 'PLUGIN_UNAVAILABLE', message: 'GitHub answered with an error (HTTP 502).' });
  const g = signedIn();
  g.github.graphql = () => g.github.respond(200, { errors: [{ type: 'INTERNAL', message: 'Something went wrong while executing your query.' }] });
  assert.deepStrictEqual((await g.read('code', 'pull_request')).error, {
    code: 'PLUGIN_UNAVAILABLE', message: 'GitHub\'s answer couldn\'t be read: Something went wrong while executing your query.',
  });
});

test('half an inbox is still an inbox: notifications down, pull requests up', async () => {
  const h = signedIn({ github: { fail: { 'GET /notifications': 503 } } });
  const inbox = propertiesOf(await read(h, 'inbox'));
  assert.strictEqual(inbox.unread, undefined);
  assert.deepStrictEqual(inbox.pull_requests, count(3));
  assert.ok(inbox.status.longText.text.startsWith('GitHub answered with an error (HTTP 503). 3 pull requests'));
});

// ---------------------------------------------------------------- actions

test('mark read: PATCH the thread; it shows read at once, even before GitHub\'s list catches up', async () => {
  const h = signedIn({ github: { lag: true } });
  await read(h, 'notification');
  h.github.reset();
  const result = await h.act('mark_read', { instanceId: '1001' });
  assert.deepStrictEqual(result, { ok: true, text: 'Marked read: Retry failed webhooks with backoff', refreshed: ['code/notification', 'code/inbox'] });
  assert.deepStrictEqual(h.github.calls(), ['PATCH /notifications/threads/1001']);
  h.github.reset();
  const envelope = await read(h, 'notification');
  assert.deepStrictEqual(h.github.calls().slice(0, 1), [LIST], 'read again at once');
  assert.strictEqual(h.github.requests[0].headers['If-Modified-Since'], undefined);
  assert.strictEqual(propertiesOf(envelope, '1001').unread.boolean.value, false, 'GitHub still says unread; the mark wins');
  assert.deepStrictEqual(ids(envelope).slice(-2), ['1007', '1001'], 'among the read ones, newest first');
  assert.deepStrictEqual(propertiesOf(await read(h, 'inbox')).unread, count(8));
});

test('done: DELETE the thread, and it leaves the list, even before GitHub\'s list catches up', async () => {
  const h = signedIn({ github: { lag: true } });
  await read(h, 'notification');
  assert.deepStrictEqual(await h.act('mark_done', { instanceId: '1002' }), { ok: true, text: 'Done: Dark mode toggle forgets its setting', refreshed: ['code/notification', 'code/inbox'] });
  assert.ok(h.github.calls().includes('DELETE /notifications/threads/1002'));
  assert.ok(!ids(await read(h, 'notification')).includes('1002'));
  // Five minutes on, GitHub's own list is the truth again.
  h.advance(5 * MINUTE);
  assert.ok(ids(await read(h, 'notification')).includes('1002'), 'the lagging fake still lists it');
});

test('mark read and done check the id, and say when GitHub has no such thread', async () => {
  const h = signedIn();
  assert.deepStrictEqual(await h.act('mark_read', { instanceId: '../user' }), { ok: false, code: 'INVALID_ARGS', message: 'instanceId has to be a notification id.' });
  assert.deepStrictEqual(await h.act('mark_done', { instanceId: '424242' }), { ok: false, code: 'INVALID_ARGS', message: 'GitHub couldn\'t find that notification.' });
});

test('mark all read: PUT {read: true}; everything shows read', async () => {
  const h = signedIn();
  await read(h, 'notification');
  h.github.reset();
  assert.deepStrictEqual(await h.act('mark_all_read', {}), { ok: true, text: 'Marked all read', refreshed: ['code/notification', 'code/inbox'] });
  assert.deepStrictEqual(h.github.calls(), ['PUT /notifications']);
  assert.deepStrictEqual(JSON.parse(h.github.requests[0].body), { read: true });
  const envelope = await read(h, 'notification');
  assert.ok(envelope.instances.every((i) => i.properties.unread.boolean.value === false));
  h.github.markAllStatus = 202;
  assert.strictEqual((await h.act('mark_all_read', {})).text, 'GitHub is marking them all read');
});

test('rerun failed jobs on a pull request: every failed Actions run on its head commit', async () => {
  const h = signedIn();
  await read(h, 'pull_request');
  h.github.reset();
  const result = await h.act('rerun_failed', { instanceId: 'acme/website#119' });
  assert.deepStrictEqual(result, { ok: true, text: 'Rerunning failed jobs in 2 runs on acme/website #119', refreshed: ['code/review_request', 'code/pull_request', 'code/build', 'code/inbox'] });
  assert.deepStrictEqual(h.github.calls(), [
    'POST /graphql',
    'POST /repos/acme/website/actions/runs/9201/rerun-failed-jobs',
    'POST /repos/acme/website/actions/runs/9202/rerun-failed-jobs',
  ]);
  assert.ok(h.github.graphqlQueries()[0].includes('pullRequest(number: 119)'));
  await read(h, 'pull_request');
  assert.strictEqual(h.github.graphqlQueries().length, 2, 'the pull requests are read again');
});

test('rerun failed jobs on a build, on a build that\'s passing, and on something that isn\'t there', async () => {
  const h = signedIn();
  assert.strictEqual((await h.act('rerun_failed', { instanceId: 'acme/website' })).text, 'Rerunning failed jobs in CI on acme/website');
  assert.ok(h.github.calls().includes('POST /repos/acme/website/actions/runs/9301/rerun-failed-jobs'));
  h.github.reset();
  assert.deepStrictEqual(await h.act('rerun_failed', { instanceId: 'acme/api' }), { ok: true, text: 'Nothing has failed', refreshed: [] });
  assert.deepStrictEqual(h.github.calls(), ['POST /graphql']);
  assert.deepStrictEqual(await h.act('rerun_failed', { instanceId: 'acme/api#999' }), { ok: false, code: 'INVALID_ARGS', message: 'GitHub couldn\'t find acme/api #999.' });
  assert.strictEqual((await h.act('rerun_failed', { instanceId: 'not a repo' })).code, 'INVALID_ARGS');
});

test('comment: on a notification\'s issue or pull request, or on owner/repo#n', async () => {
  const h = signedIn();
  await read(h, 'notification');
  h.github.reset();
  assert.deepStrictEqual(await h.act('comment', { instanceId: '1002', text: 'Checked on Safari 18: fixed.' }), {
    ok: true, text: 'Replied on acme/website #118', refreshed: ['code/notification', 'code/inbox', 'code/review_request', 'code/pull_request'],
  });
  assert.deepStrictEqual(h.github.calls(), ['POST /repos/acme/website/issues/118/comments']);
  assert.deepStrictEqual(JSON.parse(h.github.requests[0].body), { body: 'Checked on Safari 18: fixed.' });
  assert.strictEqual((await h.act('comment', { instanceId: 'acme/api#42', text: 'LGTM' })).text, 'Replied on acme/api #42');
  assert.deepStrictEqual(await h.act('comment', { instanceId: '1006', text: 'Path versioning.' }), { ok: false, code: 'INVALID_ARGS', message: 'Only issues and pull requests take comments from here.' });
  assert.deepStrictEqual(await h.act('comment', { instanceId: '777', text: 'hi' }), { ok: false, code: 'INVALID_ARGS', message: 'That notification isn\'t in the inbox any more.' });
  assert.strictEqual((await h.act('comment', { instanceId: '1002', text: '   ' })).code, 'INVALID_ARGS');
});

test('new issue: the first sentence is the title, the rest the body; to the chosen repo', async () => {
  const h = signedIn();
  const result = await h.act('new_issue', { title: 'The login page is slow. It takes ten seconds on 3G.' });
  assert.deepStrictEqual(result, { ok: true, text: 'Opened #131 on acme/api: The login page is slow', refreshed: [] });
  assert.deepStrictEqual(h.github.calls(), ['POST /repos/acme/api/issues']);
  assert.deepStrictEqual(JSON.parse(h.github.requests[0].body), { title: 'The login page is slow', body: 'It takes ten seconds on 3G.' });
  // A long first sentence is cut at a word, and the body keeps every word.
  h.github.reset();
  const long = 'When you search for a word with an accent like café the results page shows nothing at all even though there are matches';
  await h.act('new_issue', { title: long, repo: 'acme/website' });
  const sent = JSON.parse(h.github.requests[0].body);
  assert.strictEqual(h.github.calls()[0], 'POST /repos/acme/website/issues');
  assert.strictEqual(sent.title, 'When you search for a word with an accent like café the results page shows…');
  assert.ok(sent.title.length <= 80);
  assert.strictEqual(sent.body, long);
  // Given a body, the title is taken as it is.
  h.github.reset();
  await h.act('new_issue', { title: 'Crash on start. Again.', body: 'Since 2.4.0.' });
  assert.deepStrictEqual(JSON.parse(h.github.requests[0].body), { title: 'Crash on start. Again.', body: 'Since 2.4.0.' });
});

test('new issue: only to a chosen repo, and not when none takes issues', async () => {
  const h = signedIn();
  assert.deepStrictEqual(await h.act('new_issue', { title: 'x', repo: 'someone/else' }), { ok: false, code: 'INVALID_ARGS', message: 'someone/else isn\'t one of the repositories chosen in settings.' });
  const none = signedIn({ settings: { issueRepo: '' } });
  assert.deepStrictEqual(await none.act('new_issue', { title: 'x' }), { ok: false, code: 'INVALID_ARGS', message: 'Choose a repository for new issues in Inbox for GitHub\'s settings.' });
  const off = signedIn({ settings: { issueRepo: 'acme/no-issues' } });
  assert.deepStrictEqual(await off.act('new_issue', { title: 'x' }), { ok: false, code: 'INVALID_ARGS', message: 'GitHub says issues on acme/no-issues are turned off or gone.' });
});

test('refresh: everything is read again now', async () => {
  const h = signedIn();
  for (const item of ['inbox', 'contributions']) await read(h, item);
  h.github.reset();
  assert.deepStrictEqual(await h.act('refresh', {}), { ok: true, text: 'Refreshing', refreshed: ALL });
  assert.deepStrictEqual(h.refreshed, ALL);
  await read(h, 'inbox');
  await read(h, 'contributions');
  assert.deepStrictEqual(h.github.calls().filter((c) => !c.includes('/comments/') && !c.includes('/issues/') && !c.includes('/releases/')),
    [LIST, 'POST /graphql', 'POST /graphql']);
  assert.strictEqual(h.github.requests[0].headers['If-Modified-Since'], 'Fri, 20 Nov 2026 13:50:00 GMT', 'a 304 is still free');
});

test('an action it doesn\'t have', async () => {
  const h = signedIn();
  const session = h.session();
  const answer = await Host.answer((done) => session.action({ action: 'approve', args: {} }, {
    ok: () => done({ ok: true }),
    error: (code) => done({ code }),
  }));
  assert.strictEqual(answer.code, 'INVALID_REQUEST');
});

// ---------------------------------------------------------------- demo

test('demo: every source, from made-up people and repos, without asking GitHub', async () => {
  const h = signedOut({ storage: { 'settings.v1': JSON.stringify({ demo: true }) } });
  const inbox = propertiesOf(await read(h, 'inbox'));
  assert.deepStrictEqual([inbox.login.shortText.text, inbox.unread.numericValue.value, inbox.reviews.numericValue.value, inbox.failing.numericValue.value],
    ['alex-kim', 6, 3, 1]);
  assert.strictEqual(ids(await read(h, 'notification')).length, 8);
  assert.deepStrictEqual(ids(await read(h, 'pull_request')), ['acme/website#119', 'alex-kim/notes-app#12', 'acme/api#40', 'acme/website#117']);
  assert.deepStrictEqual(ids(await read(h, 'build')), ['acme/website', 'acme/api', 'alex-kim/notes-app']);
  assert.deepStrictEqual(ids(await read(h, 'repo')), ['acme/website', 'acme/api', 'alex-kim/notes-app']);
  assert.strictEqual(propertiesOf(await read(h, 'contributions')).year.numericValue.value, 1287);
  assert.deepStrictEqual(h.github.requests, []);
});

test('demo: actions change the demo, and say so', async () => {
  const h = signedOut({ storage: { 'settings.v1': JSON.stringify({ demo: true }) } });
  assert.strictEqual((await h.act('mark_read', { instanceId: '9001' })).text, 'Demo: Marked read: Retry failed webhooks with backoff');
  assert.strictEqual(propertiesOf(await read(h, 'notification'), '9001').unread.boolean.value, false);
  await h.act('mark_done', { instanceId: '9002' });
  assert.ok(!ids(await read(h, 'notification')).includes('9002'));
  assert.strictEqual((await h.act('rerun_failed', { instanceId: 'acme/website' })).text, 'Demo: Rerunning failed jobs in CI on acme/website');
  assert.strictEqual(propertiesOf(await read(h, 'build'), 'acme/website').status.shortText.text, 'Running');
  h.advance(2 * MINUTE);
  assert.strictEqual(propertiesOf(await read(h, 'build'), 'acme/website').status.shortText.text, 'Passing');
  assert.strictEqual((await h.act('rerun_failed', { instanceId: 'acme/api' })).text, 'Demo: Nothing has failed');
  assert.strictEqual((await h.act('comment', { instanceId: '9001', text: 'On it.' })).text, 'Demo: Replied on acme/api #42');
  assert.strictEqual(propertiesOf(await read(h, 'review_request'), 'acme/api#42').latest.longText.text, 'alex-kim: On it.');
  assert.strictEqual((await h.act('new_issue', { title: 'Dark mode flickers. On Android only.' })).text, 'Demo: Opened #131 on acme/website: Dark mode flickers');
  assert.strictEqual((await h.act('mark_all_read', {})).text, 'Demo: Marked all read');
  assert.strictEqual(propertiesOf(await read(h, 'inbox')).unread.numericValue.value, 0);
  assert.deepStrictEqual(h.github.requests, []);
  // Switched off and on again, the demo starts afresh.
  await h.config({ type: 'set', demo: false, builds: [], issueRepo: '' });
  await h.config({ type: 'set', demo: true, builds: [], issueRepo: '' });
  assert.strictEqual(propertiesOf(await read(h, 'inbox')).unread.numericValue.value, 6);
});

test('demo wins over a token, so the screenshots never show a real account', async () => {
  const h = signedIn({ settings: { demo: true } });
  assert.strictEqual(propertiesOf(await read(h, 'inbox')).login.shortText.text, 'alex-kim');
  assert.deepStrictEqual(h.github.requests, []);
});

// ---------------------------------------------------------------- settings page

test('settings: signed out, there\'s nothing to show but the choices', async () => {
  const h = signedOut();
  assert.deepStrictEqual(await h.config({ type: 'load' }), {
    settings: { demo: false, participating: false, builds: [], issueRepo: '' },
    signedIn: false,
    deviceSignIn: false,
    tokenUrl: 'https://github.com/settings/tokens/new?scopes=notifications,repo&description=Inbox%20for%20Pebble',
    limits: { builds: 6 },
    repos: [],
  });
  assert.deepStrictEqual(h.github.requests, []);
});

test('settings: pasting a token checks it with GitHub, keeps it, and only ever shows it masked', async () => {
  const h = signedOut();
  const bad = await h.config({ type: 'token', token: 'hunter2' });
  assert.strictEqual(bad.error, 'That doesn\'t look like a GitHub token. Classic tokens start with ghp_.');
  assert.deepStrictEqual(h.github.requests, []);
  const wrong = await h.config({ type: 'token', token: 'ghp_' + 'w'.repeat(36) });
  assert.strictEqual(wrong.error, 'GitHub didn\'t accept that token. Check it was copied whole and hasn\'t expired.');
  assert.strictEqual(wrong.signedIn, false);
  const reply = await h.config({ type: 'token', token: '  ' + TOKEN + '\n' });
  assert.strictEqual(reply.saved, true);
  assert.strictEqual(reply.signedIn, true);
  assert.deepStrictEqual(reply.account, { login: 'alex-kim', masked: 'ghp_…abcd', scopes: ['notifications', 'repo'], warnings: [] });
  assert.deepStrictEqual(reply.repos, [
    { name: 'acme/website', private: false, issues: true },
    { name: 'sam-lee/notes-app', private: false, issues: true },
    { name: 'acme/api', private: true, issues: true },
    { name: 'alex-kim/dotfiles', private: false, issues: false },
  ], 'the 30 most recently pushed, archived ones left out');
  assert.ok(h.github.calls().includes('GET /user/repos?sort=pushed&per_page=30'));
  assert.ok(!JSON.stringify(reply).includes(TOKEN), 'the page never gets the token back');
  assert.deepStrictEqual(h.refreshed, ALL);
  assert.strictEqual(kept(h, 'account.v1').token, TOKEN);
  assert.ok(propertiesOf(await read(h, 'inbox')).unread);
  assertTokenKept(h);
});

test('settings: warnings for a token without the repo scope, and for a fine-grained one', async () => {
  const h = signedIn({ github: { scopes: 'notifications' } });
  assert.deepStrictEqual((await h.config({ type: 'load' })).account.warnings, ['Without the repo scope, private repositories and rerunning failed jobs won\'t work.']);
  h.github.scopes = 'read:user';
  assert.deepStrictEqual((await h.config({ type: 'load' })).account.warnings, [
    'This token has neither the notifications nor the repo scope, so notifications won\'t show.',
    'Without the repo scope, private repositories and rerunning failed jobs won\'t work.',
  ]);
  const token = 'github_pat_' + 'A'.repeat(22) + '_' + 'b'.repeat(59);
  const fine = signedIn({ token, github: { token, scopes: null } });
  const account = (await fine.config({ type: 'load' })).account;
  assert.strictEqual(account.masked, 'github_pat_…bbbb');
  assert.strictEqual(account.scopes, null);
  assert.match(account.warnings[0], /^This is a fine-grained token\. GitHub's notifications API only works with a classic token/);
});

test('settings: a token GitHub no longer takes shows as rejected', async () => {
  const h = signedIn();
  h.github.token = 'ghp_other';
  const reply = await h.config({ type: 'load' });
  assert.strictEqual(reply.signedIn, true);
  assert.strictEqual(reply.account.problem, 'GitHub rejected this token. Paste a new one.');
});

test('settings: choices are checked, six builds at most, and the watch updates at once', async () => {
  const h = signedIn();
  const reply = await h.config({
    type: 'set', demo: 'yes', participating: true, issueRepo: 'acme/website',
    builds: ['acme/api', 'acme/api', 'bad name', 7, 'a/b', 'a/c', 'a/d', 'a/e', 'a/f', 'a/g'],
  });
  assert.deepStrictEqual(reply, { ok: true, settings: { demo: false, participating: true, builds: ['acme/api', 'a/b', 'a/c', 'a/d', 'a/e', 'a/f'], issueRepo: 'acme/website' } });
  assert.deepStrictEqual(h.refreshed, ALL);
  assert.deepStrictEqual((await h.config({ type: 'set', issueRepo: '../../etc' })).settings.issueRepo, '');
});

test('settings: chosen repos stay listed when they\'re no longer among the most recently pushed', async () => {
  const h = signedIn({ settings: { builds: ['acme/legacy'], issueRepo: 'acme/api' } });
  const reply = await h.config({ type: 'load' });
  assert.deepStrictEqual(reply.repos.map((r) => r.name), ['acme/website', 'sam-lee/notes-app', 'acme/api', 'alex-kim/dotfiles', 'acme/legacy']);
});

test('settings: signing out forgets the token and everything read with it', async () => {
  const h = signedIn();
  await read(h, 'inbox');
  const reply = await h.config({ type: 'signout' });
  assert.strictEqual(reply.signedIn, false);
  for (const key of ['account.v1', 'notifications.v1', 'graph.v1']) assert.strictEqual(h.storage.has(key), false, key);
  assert.deepStrictEqual((await h.read('code', 'inbox')).error, NO_TOKEN);
  assert.deepStrictEqual(h.refreshed, ALL);
});

test('settings: device sign-in is off while CLIENT_ID is empty', async () => {
  const h = signedOut();
  assert.deepStrictEqual(await h.config({ type: 'device_start' }), { error: 'Signing in this way isn\'t switched on. Paste a token instead.' });
  assert.deepStrictEqual(await h.config({ type: 'device_poll' }), { device: 'expired' });
  assert.deepStrictEqual(h.github.requests, []);
});

test('settings: with a CLIENT_ID, the device flow signs in', async () => {
  const h = signedOut();
  h.script = h.script.replace('var CLIENT_ID = \'\';', 'var CLIENT_ID = \'Iv1.0000000000000000\';');
  const start = await h.config({ type: 'device_start' });
  assert.deepStrictEqual(start, { userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', interval: 5 });
  assert.strictEqual(h.github.requests[0].headers.Accept, 'application/json');
  assert.strictEqual(h.github.requests[0].headers.Authorization, undefined);
  assert.strictEqual(h.github.requests[0].body, 'client_id=Iv1.0000000000000000&scope=notifications%20repo');
  assert.deepStrictEqual(await h.config({ type: 'device_poll' }), { device: 'pending', interval: 5 });
  const done = await h.config({ type: 'device_poll' });
  assert.strictEqual(done.device, 'done');
  assert.strictEqual(done.saved, true);
  assert.strictEqual(done.account.login, 'alex-kim');
  assert.strictEqual(done.account.masked, 'gho_…wxyz');
  assert.ok(propertiesOf(await read(h, 'inbox')).login);
});

test('settings: an unknown message', async () => {
  assert.deepStrictEqual(await signedOut().config({ type: 'nope' }), { error: 'unknown message type' });
});

// ---------------------------------------------------------------- shapes and the manifest

test('times follow the user\'s 12-hour clock when the app can say', async () => {
  const units = { instances: [{ instanceId: 'units', properties: { clock: { shortText: { text: '12h' } } } }] };
  const h = signedIn({ readSource: () => units });
  assert.strictEqual(propertiesOf(await read(h, 'inbox')).updated.shortText.text, '2:05pm');
  assert.ok(h.subscribed.includes('preferences/units'));
});

test('the only long short texts are words, never a count, a time or a commit', async () => {
  for (const h of [signedIn(), signedOut({ storage: { 'settings.v1': JSON.stringify({ demo: true }) } })]) {
    const warned = new Set();
    for (const item of ITEMS) {
      const result = await h.read('code', item);
      assert.deepStrictEqual(result.dropped, [], item);
      result.warnings.forEach((w) => warned.add(w.split(':')[0].split('.').pop()));
    }
    for (const property of warned) {
      assert.ok(['title', 'repo', 'kind', 'reason', 'author', 'review', 'checks', 'status', 'latest', 'login', 'name', 'branch', 'workflow'].includes(property), property);
    }
  }
});

test('the manifest: a watch app carrying the code sources and actions, GitHub only, no aplite', () => {
  const { pebble } = require('../package.json');
  assert.strictEqual(pebble.displayName, 'Inbox for GitHub');
  assert.deepStrictEqual(pebble.watchapp, { watchface: false });
  assert.ok(!pebble.targetPlatforms.includes('aplite'));
  assert.strictEqual(pebble.plugin.script, 'src/plugin/index.js');
  assert.strictEqual(pebble.configPage, 'src/config.html');
  assert.deepStrictEqual(pebble.plugin.sources.flatMap((s) => s.items.map((item) => s.category + '/' + item)), ALL);
  assert.deepStrictEqual(pebble.plugin.actions.map((a) => a.name), ['mark_read', 'mark_done', 'mark_all_read', 'rerun_failed', 'comment', 'new_issue', 'refresh']);
  assert.deepStrictEqual(pebble.usesPermissions, [{ name: 'Internet', parameters: { domains: ['api.github.com', 'github.com'] } }]);
  assert.match(pebble.plugin.description, /Unofficial: not made by or affiliated with GitHub\./);
});
