// Inbox for GitHub: the signed-in user's GitHub work, read with their own token (DESIGN.md is
// the contract), as seven sources in category `code`:
//
//   code/inbox           one summary: unread, reviews waiting, my PRs (and how many fail),
//                        builds failing, the newest unread notification, the login
//   code/notification    one instance per notification, instanceId = GitHub's thread id
//   code/review_request  one per pull request waiting for my review, instanceId = owner/repo#n
//   code/pull_request    one per open pull request of mine, instanceId = owner/repo#n
//   code/build           the latest build on the default branch of each chosen repo (owner/repo)
//   code/repo            the repos chosen in settings, and which one takes new issues
//   code/contributions   today, the streak, the week, the year, the last 14 days
//
// and seven actions (mark read/done, mark all read, rerun failed jobs, comment, new issue,
// refresh). Unofficial: not made by or affiliated with GitHub.
//
// Every request is a fresh run of this script, so everything lives in localStorage: the token
// (never logged, never sent anywhere but GitHub, shown back only masked), the settings, and the
// last good answer of each of the three reads below. Several sources share a read, so whichever
// asks first pays for it and the rest use what it kept:
//
//   notifications   REST, read and unread from the last three days, every X-Poll-Interval
//                   seconds (60 s if that can't be read), with If-Modified-Since so an
//                   unchanged inbox costs no rate limit
//   graph           one GraphQL query for the login, reviews, my PRs and builds, every 2 minutes
//   contributions   one GraphQL query, every 30 minutes
//
// If a read fails, the kept answer is served (with the time it was read) for up to six hours;
// a rejected token is never papered over that way.

// Device-code sign-in (github.com/login/device) instead of pasting a token. Off while ''. It
// needs an OAuth app registered with device flow enabled, and a check that its tokens (gho_)
// can read notifications, before it's switched on.
var CLIENT_ID = '';

var API = 'https://api.github.com';
var WEB = 'https://github.com';
var USER_AGENT = 'Inbox-for-GitHub-Pebble';
var API_VERSION = '2022-11-28';
var TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=notifications,repo&description=Inbox%20for%20Pebble';

var SETTINGS_KEY = 'settings.v1';
var ACCOUNT_KEY = 'account.v1';
var NOTIFICATIONS_KEY = 'notifications.v1';
var GRAPH_KEY = 'graph.v1';
var CONTRIBUTIONS_KEY = 'contributions.v1';
var FAILED_KEY = 'failed.v1';
var MARKS_KEY = 'marks.v1';
var DEMO_KEY = 'demo.v1';
var DEVICE_KEY = 'device.v1';

var ITEMS = ['inbox', 'notification', 'review_request', 'pull_request', 'build', 'repo', 'contributions'];
var SOURCES = ITEMS.map(function (item) { return 'code/' + item; });
var ACTIONS = ['mark_read', 'mark_done', 'mark_all_read', 'rerun_failed', 'comment', 'new_issue', 'refresh'];

var SECOND_MS = 1000;
var MINUTE_MS = 60 * SECOND_MS;
var HOUR_MS = 60 * MINUTE_MS;
var DAY_MS = 24 * HOUR_MS;
// GitHub asks clients to poll notifications no more often than X-Poll-Interval (usually 60 s).
var POLL_MS = 60 * SECOND_MS;
var GRAPH_MS = 2 * MINUTE_MS;
var CONTRIBUTIONS_MS = 30 * MINUTE_MS;
// After a failed read, don't try again for this long: five sources asking at the same moment
// would otherwise each wait on a dead network.
var RETRY_MS = 30 * SECOND_MS;
var STALE_MS = 6 * HOUR_MS;
// A mark read/done made here outranks GitHub's list for this long, so a list GitHub hasn't
// caught up with yet doesn't bring the notification straight back.
var MARK_MS = 5 * MINUTE_MS;
// The phone gives a plugin about 20 s per request; leave room for a second call after the first.
var FETCH_TIMEOUT_MS = 12 * SECOND_MS;

var MAX_NOTIFICATIONS = 15;
var SINCE_DAYS = 3;
var MAX_PRS = 8;
var MAX_BUILDS = 6;
var MAX_REPOS = 6;
var MAX_COMMENT_FETCHES = 5;
var MAX_LATEST = 500;
var MAX_CONTEXTS = 30;
var MAX_CHECK_NAMES = 4;
var TITLE_CUT = 80;

var NO_TOKEN = 'Sign in to GitHub in Inbox for GitHub\'s settings.';
var CLASSIC_ONLY = 'Notifications need a classic token. Paste one in Inbox for GitHub\'s settings.';
var REJECTED = 'Token rejected. Paste a new one in settings.';

// Reasons -> the watch's groups, and subject types -> words.
var GROUPS = {
  review_requested: 'Review requested',
  mention: 'Mentioned',
  team_mention: 'Mentioned',
  assign: 'Assigned',
  ci_activity: 'Builds',
};
var KINDS = {
  PullRequest: 'Pull request',
  Issue: 'Issue',
  Release: 'Release',
  Discussion: 'Discussion',
  CheckSuite: 'Build',
  Commit: 'Commit',
};
var CHECKS = { SUCCESS: 'Passing', FAILURE: 'Failing', ERROR: 'Failing', PENDING: 'Running', EXPECTED: 'Running' };
var REVIEWS = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };
// A check suite that ended in one of these has failed jobs to rerun. A cancelled one was
// stopped on purpose, so it's left alone.
var FAILED_CONCLUSIONS = ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE'];

var REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
var NUMBERED_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100})#(\d{1,9})$/;
var THREAD_PATTERN = /^\d{1,20}$/;
// Classic (ghp_), OAuth (gho_), app (ghu_, ghs_, ghr_), fine-grained (github_pat_), and the
// 40-hex tokens from before 2021.
var TOKEN_PATTERN = /^(?:gh[pousr]_[A-Za-z0-9]{20,251}|github_pat_[A-Za-z0-9_]{20,244}|[0-9a-f]{40})$/;

// ---------------------------------------------------------------- storage

function kept(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch (e) {
    return null;
  }
}

function keep(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function forget(key) {
  localStorage.removeItem(key);
}

function isRepo(name) {
  return typeof name === 'string' && REPO_PATTERN.test(name);
}

function sameRepo(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

function repoIndex(list, name) {
  for (var i = 0; i < list.length; i++) if (sameRepo(list[i], name)) return i;
  return -1;
}

/** Repo names, valid and once each, in the order given. */
function repoList(list) {
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function (name) {
    if (isRepo(name) && repoIndex(out, name) === -1) out.push(name);
  });
  return out;
}

/** What the settings page chose: { demo, participating, builds: [owner/repo], issueRepo }. */
function settings() {
  var saved = kept(SETTINGS_KEY) || {};
  return {
    demo: saved.demo === true,
    participating: saved.participating === true,
    builds: repoList(saved.builds).slice(0, MAX_BUILDS),
    issueRepo: isRepo(saved.issueRepo) ? saved.issueRepo : '',
  };
}

/** { token, login, scopes } or null when nobody is signed in. */
// The token stays in localStorage: Pebble.secureStorage can't be checked in the real app yet.
function account() {
  var saved = kept(ACCOUNT_KEY);
  return saved && typeof saved.token === 'string' && saved.token ? saved : null;
}

/** The chosen repos for code/repo: the one taking new issues first, then the build repos. */
function chosenRepos(prefs) {
  var names = [];
  if (prefs.issueRepo) names.push(prefs.issueRepo);
  prefs.builds.forEach(function (name) { if (repoIndex(names, name) === -1) names.push(name); });
  return names.slice(0, MAX_REPOS).map(function (name) {
    return { name: name, issues: !!prefs.issueRepo && sameRepo(name, prefs.issueRepo), builds: repoIndex(prefs.builds, name) !== -1 };
  });
}

/** Makes the next read of each cache go to GitHub, keeping what it has for stale serving. */
function expire(keys, dropLastModified) {
  keys.forEach(function (key) {
    var cache = kept(key);
    if (!cache) return;
    cache.expired = true;
    if (dropLastModified) delete cache.lastModified;
    keep(key, cache);
  });
  var failures = kept(FAILED_KEY) || {};
  keys.forEach(function (key) { delete failures[key]; });
  keep(FAILED_KEY, failures);
}

/** Everything read with a token, for when the token changes. */
function forgetReadings() {
  [NOTIFICATIONS_KEY, GRAPH_KEY, CONTRIBUTIONS_KEY, FAILED_KEY, MARKS_KEY].forEach(forget);
}

// ---------------------------------------------------------------- text

function tidy(text) {
  return String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
}

/** At most `max` characters, cut at a word with '…'. */
function clip(text, max) {
  var s = tidy(text);
  if (s.length <= max) return s;
  var cut = s.slice(0, max - 1);
  var space = cut.lastIndexOf(' ');
  if (space > max / 2) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.–—-]+$/, '') + '…';
}

/** A comment's Markdown as one line of plain text: no quotes, code, links, images or markup. */
function plain(markdown, max) {
  var s = String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/```[\s\S]*?(?:```|$)/g, ' [code] ')
    .replace(/^[ \t]*>.*$/gm, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&');
  return clip(s, max || MAX_LATEST);
}

/** 'RepositoryVulnerabilityAlert' -> 'Repository vulnerability alert'. */
function words(type) {
  var s = String(type || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function kindOf(type) {
  return KINDS[type] || words(type) || 'Notification';
}

function groupOf(reason) {
  return GROUPS[reason] || 'Other';
}

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many || one + 's');
}

/** 'sam-lee: Looks good' for a comment with words, '' for one without. */
function latestText(latest) {
  if (!latest || !latest.text) return '';
  return latest.author ? latest.author + ': ' + latest.text : latest.text;
}

function pad(n) {
  return (n < 10 ? '0' : '') + n;
}

function timeText(ms, style) {
  var date = new Date(ms);
  if (style === '12h') {
    var h = date.getHours() % 12 || 12;
    return h + ':' + pad(date.getMinutes()) + (date.getHours() < 12 ? 'am' : 'pm');
  }
  return pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function stamp(ms, style) {
  return { timestamp: { value: Math.floor(ms / 1000) }, shortText: { text: timeText(ms, style) } };
}

/** 24h unless the user's Pebble settings say 12h; the emulator can't say, so 24h there. */
async function clock(subscribe) {
  if (typeof Pebble.readSource !== 'function') return '24h';
  var units = { category: 'preferences', item: 'units' };
  try {
    if (subscribe && typeof Pebble.subscribeSource === 'function') Pebble.subscribeSource(units);
    var p = (await Pebble.readSource(units)).instances[0].properties;
    return p.clock.shortText.text === '12h' ? '12h' : '24h';
  } catch (e) {
    return '24h';
  }
}

function mask(token) {
  var t = String(token || '');
  var underscore = t.lastIndexOf('_', 12);
  var head = underscore > 0 ? t.slice(0, underscore + 1) : '';
  return head + '…' + t.slice(-4);
}

// ---------------------------------------------------------------- talking to GitHub

/** A response header, or null if it's missing or the host doesn't let the script read it. */
function headerOf(response, name) {
  try {
    if (response && response.headers && typeof response.headers.get === 'function') {
      var value = response.headers.get(name);
      return value === undefined || value === null ? null : String(value);
    }
  } catch (e) {
    // Some hosts hide headers; everything that uses them has a fallback.
  }
  return null;
}

function withTimeout(promise, ms) {
  if (typeof setTimeout !== 'function') return promise;
  var timer;
  var timeout = new Promise(function (resolve, reject) {
    timer = setTimeout(function () {
      var error = new Error('no answer in ' + ms + ' ms');
      error.name = 'TimeoutError';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, timeout]).then(function (value) {
    clearTimeout(timer);
    return value;
  }, function (error) {
    clearTimeout(timer);
    throw error;
  });
}

/** The URL without its query, for logs. */
function where(url) {
  return String(url).split('?')[0];
}

/**
 * One request. Never rejects; resolves with { status, body, header(name), problem }, where
 * problem is null on success (2xx or 304), else one of 'offline', 'blocked', 'timeout',
 * 'token' (401), 'rate', 'forbidden', 'missing', 'gone', 'invalid', 'http', with `message`
 * (GitHub's own) and `resetAt` (when a rate limit lifts, ms) where known.
 *
 * options: token, headers, body (an object is sent as JSON, a string as a form), accept.
 */
async function call(method, url, options) {
  options = options || {};
  var github = url.indexOf(API + '/') === 0;
  var headers = { 'User-Agent': USER_AGENT, Accept: options.accept || 'application/vnd.github+json' };
  if (github) headers['X-GitHub-Api-Version'] = API_VERSION;
  if (github && options.token) headers.Authorization = 'Bearer ' + options.token;
  Object.keys(options.headers || {}).forEach(function (name) { headers[name] = options.headers[name]; });
  var init = { method: method, headers: headers };
  if (options.body !== undefined) {
    if (typeof options.body === 'string') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = options.body;
    } else {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }
  }
  var response;
  try {
    response = await withTimeout(fetch(url, init), FETCH_TIMEOUT_MS);
  } catch (e) {
    var name = e && e.name;
    console.error(method + ' ' + where(url) + ' failed: ' + (name || 'error'));
    return { status: 0, body: null, header: function () { return null; }, problem: name === 'NotAllowedError' ? 'blocked' : name === 'TimeoutError' ? 'timeout' : 'offline' };
  }
  var status = Number(response.status) || 0;
  var raw = '';
  try {
    raw = await response.text();
  } catch (e) {
    raw = '';
  }
  var body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch (e) {
      body = null;
    }
  }
  var result = {
    status: status,
    body: body,
    header: function (name) { return headerOf(response, name); },
    problem: null,
    message: body && typeof body.message === 'string' ? body.message : '',
  };
  if ((status >= 200 && status < 300) || status === 304) return result;
  console.error('HTTP ' + status + ' from ' + method + ' ' + where(url));
  if (status === 401) result.problem = 'token';
  else if (status === 403 || status === 429) {
    var remaining = result.header('X-RateLimit-Remaining');
    var retry = Number(result.header('Retry-After'));
    if (remaining === '0' || retry > 0 || /rate limit/i.test(result.message)) {
      result.problem = 'rate';
      var reset = Number(result.header('X-RateLimit-Reset'));
      if (retry > 0) result.resetAt = Date.now() + retry * SECOND_MS;
      else if (reset > 0) result.resetAt = reset * SECOND_MS;
    } else {
      result.problem = 'forbidden';
    }
  } else if (status === 404) result.problem = 'missing';
  else if (status === 410) result.problem = 'gone';
  else if (status === 422) result.problem = 'invalid';
  else result.problem = 'http';
  return result;
}

/** What went wrong, as kept with a failed read: just the facts, no functions. */
function trouble(result, extra) {
  var t = { problem: result.problem, status: result.status || 0, message: clip(result.message || '', 200) };
  if (result.resetAt) t.resetAt = result.resetAt;
  return Object.assign(t, extra || {});
}

/** A problem as an error for a source or action: { code, message }. */
function errorOf(t) {
  switch (t.problem) {
    case 'token':
      return { code: 'AUTH_REQUIRED', message: REJECTED };
    case 'classic':
      return { code: 'AUTH_REQUIRED', message: CLASSIC_ONLY };
    case 'rate':
      return {
        code: 'RATE_LIMITED',
        message: t.resetAt ? 'GitHub\'s rate limit is used up until ' + timeText(t.resetAt, '24h') + '.' : 'GitHub asked Inbox for GitHub to slow down. It will try again.',
      };
    case 'blocked':
      return { code: 'PLUGIN_UNAVAILABLE', message: 'Inbox for GitHub is waiting to be allowed to connect to api.github.com.' };
    case 'timeout':
      return { code: 'TIMEOUT', message: 'GitHub is slow to answer. Inbox for GitHub will try again.' };
    case 'offline':
      return { code: 'PLUGIN_UNAVAILABLE', message: 'Couldn\'t reach GitHub. Check the phone is online.' };
    case 'forbidden':
      return { code: 'PERMISSION_DENIED', message: 'GitHub refused' + (t.message ? ': ' + t.message : '.') };
    case 'data':
      return { code: 'PLUGIN_UNAVAILABLE', message: 'GitHub\'s answer couldn\'t be read' + (t.message ? ': ' + t.message : '.') };
    default:
      return { code: 'PLUGIN_UNAVAILABLE', message: 'GitHub answered with an error (HTTP ' + t.status + ').' };
  }
}

/** A rejected or wrong-kind token isn't hidden behind an old answer; everything else is. */
function servesStale(t) {
  return t.problem !== 'token' && t.problem !== 'classic';
}

function restMs(t, now) {
  if (t.problem === 'rate' && t.resetAt) return Math.min(Math.max(t.resetAt - now, RETRY_MS), HOUR_MS);
  return RETRY_MS;
}

/**
 * A kept read, fresh or read again. `fits(cache)` says whether a kept answer was read for what
 * is asked now (settings change the query); `gapOf(cache)` how long one lasts; `read(cache)`
 * reads GitHub, given the kept answer if it fits, and resolves with { data, meta } or
 * { problem }. Resolves with { at, data, validUntil, stale, problem } or { problem }.
 */
async function reading(key, now, fits, gapOf, read) {
  var cache = kept(key);
  var usable = !!(cache && cache.data && typeof cache.at === 'number' && cache.at <= now && fits(cache));
  if (usable && !cache.expired && now - cache.at < gapOf(cache)) {
    return { at: cache.at, data: cache.data, validUntil: cache.at + gapOf(cache) };
  }
  var failures = kept(FAILED_KEY) || {};
  var failed = failures[key];
  var resting = !!(failed && failed.at <= now && now < failed.until);
  var result = resting ? { problem: failed.problem } : await read(usable ? cache : null);
  if (!result.problem) {
    var entry = Object.assign({ at: now, data: result.data }, result.meta || {});
    keep(key, entry);
    if (failed) {
      failures = kept(FAILED_KEY) || {};
      delete failures[key];
      keep(FAILED_KEY, failures);
    }
    return { at: now, data: result.data, validUntil: now + gapOf(entry) };
  }
  var until = resting ? failed.until : now + restMs(result.problem, now);
  if (!resting) {
    failures = kept(FAILED_KEY) || {};
    failures[key] = { at: now, until: until, problem: result.problem };
    keep(FAILED_KEY, failures);
  }
  if (usable && now - cache.at < STALE_MS && servesStale(result.problem)) {
    return { at: cache.at, data: cache.data, validUntil: Math.max(until, now + RETRY_MS), stale: true, problem: result.problem };
  }
  return { problem: result.problem };
}

// ---------------------------------------------------------------- notifications

/**
 * Read ones too (all=true), so marking one read keeps its row, but only from the last three
 * days. `since` is local midnight three days ago, the same all day, so the query is the same
 * from one read to the next and If-Modified-Since can still save the read.
 */
function notificationsQuery(prefs, now) {
  var today = new Date(now);
  var since = new Date(today.getFullYear(), today.getMonth(), today.getDate() - SINCE_DAYS);
  return '/notifications?all=true&per_page=' + MAX_NOTIFICATIONS +
    '&since=' + since.toISOString().replace(/\.\d{3}Z$/, 'Z') +
    (prefs.participating ? '&participating=true' : '');
}

function numberOf(subjectUrl) {
  var m = /\/(?:issues|pulls)\/(\d+)$/.exec(String(subjectUrl || ''));
  return m ? Number(m[1]) : 0;
}

/** One of GitHub's notification threads, as kept. */
function parseThread(n) {
  if (!n || (typeof n.id !== 'string' && typeof n.id !== 'number')) return null;
  var subject = n.subject || {};
  var repo = n.repository && typeof n.repository.full_name === 'string' ? n.repository.full_name : '';
  var updated = Date.parse(n.updated_at);
  return {
    id: String(n.id),
    title: tidy(subject.title) || kindOf(subject.type),
    type: String(subject.type || ''),
    number: numberOf(subject.url),
    repo: repo,
    reason: String(n.reason || ''),
    unread: n.unread === true,
    updated: isFinite(updated) ? updated : 0,
    commentUrl: typeof subject.latest_comment_url === 'string' && subject.latest_comment_url.indexOf(API + '/') === 0 ? subject.latest_comment_url : '',
    commentKey: (subject.latest_comment_url || '') + '|' + (n.updated_at || ''),
    latest: null,
  };
}

/** A comment, issue, pull request or release from latest_comment_url, as { author, text }. */
function parseComment(body) {
  if (!body || typeof body !== 'object') return null;
  var who = (body.user && body.user.login) || (body.author && body.author.login) || '';
  var said = typeof body.body === 'string' ? body.body : body.commit && body.commit.message ? body.commit.message : '';
  return { author: String(who), text: plain(said, MAX_LATEST) };
}

function threadOrder(a, b) {
  if (a.unread !== b.unread) return a.unread ? -1 : 1;
  return b.updated - a.updated;
}

/** Up to five threads' latest comments that aren't kept yet, newest first, all at once. */
async function fetchComments(threads, token) {
  var wanted = threads.slice().sort(threadOrder).filter(function (t) { return t.commentUrl && !t.latest; }).slice(0, MAX_COMMENT_FETCHES);
  var answers = await Promise.all(wanted.map(function (t) { return call('GET', t.commentUrl, { token: token }); }));
  wanted.forEach(function (t, i) {
    if (!answers[i].problem) t.latest = parseComment(answers[i].body);
  });
}

async function readNotifications(acct, prefs, now) {
  var query = notificationsQuery(prefs, now);
  return reading(NOTIFICATIONS_KEY, now,
    function (cache) { return cache.query === query; },
    function (cache) { return Math.max(Number(cache.pollMs) || POLL_MS, POLL_MS); },
    async function (cache) {
      var headers = {};
      if (cache && cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;
      var r = await call('GET', API + query, { token: acct.token, headers: headers });
      if (r.problem) {
        // GitHub's notifications API refuses fine-grained tokens.
        var fineGrained = acct.token.indexOf('github_pat_') === 0 || /personal access token/i.test(r.message);
        if (r.problem === 'forbidden' && fineGrained) return { problem: trouble(r, { problem: 'classic' }) };
        return { problem: trouble(r) };
      }
      var threads;
      var lastModified = r.header('Last-Modified');
      if (r.status === 304 && cache) {
        threads = cache.data.threads;
        lastModified = lastModified || cache.lastModified;
      } else if (Array.isArray(r.body)) {
        var known = {};
        ((cache && cache.data.threads) || []).forEach(function (t) { if (t.latest) known[t.commentKey] = t.latest; });
        threads = r.body.map(parseThread).filter(Boolean);
        threads.forEach(function (t) { t.latest = known[t.commentKey] || null; });
      } else {
        return { problem: { problem: 'data', status: r.status, message: '' } };
      }
      await fetchComments(threads, acct.token);
      var poll = Number(r.header('X-Poll-Interval'));
      return {
        data: { threads: threads, more: /rel="next"/.test(r.header('Link') || '') || (r.status === 304 && cache ? !!cache.data.more : false) },
        meta: { query: query, lastModified: lastModified || null, pollMs: poll > 0 ? poll * SECOND_MS : POLL_MS },
      };
    });
}

/** Marks made here: { ids: { id: { state: 'read'|'done', at } }, allReadAt }, young ones only. */
function marks(now) {
  var saved = kept(MARKS_KEY) || {};
  var ids = {};
  Object.keys(saved.ids || {}).forEach(function (id) {
    var own = saved.ids[id];
    if (own && now - own.at < MARK_MS) ids[id] = own;
  });
  var allReadAt = saved.allReadAt && now - saved.allReadAt < MARK_MS ? saved.allReadAt : 0;
  return { ids: ids, allReadAt: allReadAt };
}

function mark(id, state, now) {
  var m = marks(now);
  if (id) m.ids[id] = { state: state, at: now };
  else m.allReadAt = now;
  keep(MARKS_KEY, m);
}

/** The threads as the user sees them: marks applied, unread first, newest first, 15 at most. */
function visibleThreads(threads, now) {
  var m = marks(now);
  return (threads || []).filter(function (t) {
    var own = m.ids[t.id];
    return !(own && own.state === 'done');
  }).map(function (t) {
    var own = m.ids[t.id];
    var read = (own && own.state === 'read') || (m.allReadAt && t.updated <= m.allReadAt);
    return read && t.unread ? Object.assign({}, t, { unread: false }) : t;
  }).sort(threadOrder).slice(0, MAX_NOTIFICATIONS);
}

// ---------------------------------------------------------------- the GraphQL reads

// A pull request's checks come from its head commit's rollup: each check run (a job, named
// 'workflow / job' as GitHub shows it) or commit status, for naming the failing and running ones.
var PR_FIELDS = 'number title url isDraft updatedAt reviewDecision author { login } repository { nameWithOwner } ' +
  'commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: ' + MAX_CONTEXTS + ') { nodes { __typename ' +
  '... on CheckRun { name status conclusion checkSuite { workflowRun { workflow { name } } } } ' +
  '... on StatusContext { context state } } } } } } } ' +
  'comments(last: 1) { nodes { author { login } bodyText createdAt } } ' +
  'latestReviews(last: 1) { nodes { author { login } state bodyText submittedAt } }';
var BUILD_FIELDS = 'nameWithOwner defaultBranchRef { name target { ... on Commit { abbreviatedOid messageHeadline committedDate ' +
  'statusCheckRollup { state } checkSuites(last: 20) { nodes { status conclusion workflowRun { databaseId workflow { name } } } } } } }';
var SEARCH_REVIEWS = 'is:open is:pr review-requested:@me archived:false sort:updated-desc';
var SEARCH_MINE = 'is:open is:pr author:@me archived:false sort:updated-desc';

function splitRepo(name) {
  var at = name.indexOf('/');
  return { owner: name.slice(0, at), name: name.slice(at + 1) };
}

/** Owner and name as GraphQL string literals; REPO_PATTERN keeps them to safe characters. */
function repoArgs(name) {
  var r = splitRepo(name);
  return 'owner: ' + JSON.stringify(r.owner) + ', name: ' + JSON.stringify(r.name);
}

function graphQuery(builds) {
  var parts = [
    'viewer { login }',
    'reviews: search(query: ' + JSON.stringify(SEARCH_REVIEWS) + ', type: ISSUE, first: ' + MAX_PRS + ') { issueCount nodes { ... on PullRequest { ' + PR_FIELDS + ' } } }',
    'mine: search(query: ' + JSON.stringify(SEARCH_MINE) + ', type: ISSUE, first: ' + MAX_PRS + ') { issueCount nodes { ... on PullRequest { ' + PR_FIELDS + ' } } }',
  ];
  builds.forEach(function (name, i) {
    parts.push('b' + i + ': repository(' + repoArgs(name) + ') { ' + BUILD_FIELDS + ' }');
  });
  return 'query { ' + parts.join(' ') + ' }';
}

function nodes(connection) {
  return connection && Array.isArray(connection.nodes) ? connection.nodes.filter(Boolean) : [];
}

function checksOf(rollup) {
  return (rollup && CHECKS[rollup.state]) || 'No checks';
}

/** The workflow a reader most wants named: a failed one, else a running one, else any. */
function workflowOf(suites) {
  var named = suites.filter(function (s) { return s.workflowRun && s.workflowRun.workflow && s.workflowRun.workflow.name; });
  var pick = named.filter(function (s) { return FAILED_CONCLUSIONS.indexOf(s.conclusion) !== -1; })[0] ||
    named.filter(function (s) { return s.status && s.status !== 'COMPLETED'; })[0] || named[0];
  return pick ? String(pick.workflowRun.workflow.name) : '';
}

var REVIEW_VERBS = { APPROVED: 'approved', CHANGES_REQUESTED: 'requested changes', COMMENTED: 'commented', DISMISSED: 'had a review dismissed' };

/** The newer of a pull request's last comment and last review, as { author, text, at }. */
function latestOf(pr) {
  var comment = nodes(pr.comments)[0];
  var review = nodes(pr.latestReviews)[0];
  var candidates = [];
  if (comment) {
    candidates.push({ author: (comment.author && comment.author.login) || '', text: clip(comment.bodyText, MAX_LATEST), at: Date.parse(comment.createdAt) || 0 });
  }
  if (review) {
    var who = (review.author && review.author.login) || '';
    candidates.push({
      author: who,
      // A review with nothing written still says something: 'sam-lee approved'.
      text: clip(review.bodyText, MAX_LATEST),
      verb: REVIEW_VERBS[review.state] || 'reviewed',
      at: Date.parse(review.submittedAt) || 0,
    });
  }
  candidates.sort(function (a, b) { return b.at - a.at; });
  var latest = candidates[0];
  if (!latest) return null;
  if (!latest.text && latest.verb) return { author: '', text: (latest.author ? latest.author + ' ' : 'Someone ') + latest.verb, at: latest.at };
  return { author: latest.author, text: latest.text, at: latest.at };
}

var RUN_FAILED = ['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'];
var RUN_WAITING = ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED'];

/** The failing and the running checks in a rollup, by name: { failed: [..], running: [..] }. */
function checkNames(rollup) {
  var out = { failed: [], running: [] };
  nodes(rollup && rollup.contexts).forEach(function (c) {
    var name;
    var into = null;
    if (c.__typename === 'StatusContext' || c.context !== undefined) {
      name = tidy(c.context);
      if (c.state === 'FAILURE' || c.state === 'ERROR') into = out.failed;
      else if (c.state === 'PENDING' || c.state === 'EXPECTED') into = out.running;
    } else {
      var run = c.checkSuite && c.checkSuite.workflowRun;
      var workflow = run && run.workflow && run.workflow.name ? tidy(run.workflow.name) : '';
      name = (workflow ? workflow + ' / ' : '') + tidy(c.name);
      if (RUN_FAILED.indexOf(c.conclusion) !== -1) into = out.failed;
      else if (RUN_WAITING.indexOf(c.status) !== -1) into = out.running;
    }
    if (into && name && into.indexOf(name) === -1) into.push(name);
  });
  return out;
}

/**
 * 'CI / test, lint; Docs / build failed': names under one workflow share it, four at most and
 * then how many more.
 */
function namesText(names, verb) {
  var shown = names.slice(0, MAX_CHECK_NAMES);
  var groups = [];
  shown.forEach(function (name) {
    var at = name.indexOf(' / ');
    var workflow = at === -1 ? '' : name.slice(0, at);
    var job = at === -1 ? name : name.slice(at + 3);
    var group = workflow ? groups.filter(function (g) { return g.workflow === workflow; })[0] : null;
    if (group) group.jobs.push(job);
    else groups.push({ workflow: workflow, jobs: [job] });
  });
  var text = groups.map(function (g) { return (g.workflow ? g.workflow + ' / ' : '') + g.jobs.join(', '); }).join('; ');
  if (names.length > shown.length) text += ' and ' + (names.length - shown.length) + ' more';
  return text + ' ' + verb;
}

/** checks.longText: which checks failed, or are running; else how they stand. */
function checksText(checks, names) {
  if (checks === 'Failing') return names.failed.length ? namesText(names.failed, 'failed') : 'Checks failed';
  if (checks === 'Running') return names.running.length ? namesText(names.running, 'running') : 'Checks running';
  if (checks === 'Passing') return 'Checks passed';
  return 'No checks';
}

function parsePr(node) {
  if (!node || typeof node.number !== 'number' || !node.repository) return null;
  var repo = String(node.repository.nameWithOwner || '');
  if (!repo) return null;
  var commit = nodes(node.commits)[0];
  commit = commit && commit.commit;
  var rollup = commit && commit.statusCheckRollup;
  var checks = checksOf(rollup);
  var updated = Date.parse(node.updatedAt);
  return {
    id: repo + '#' + node.number,
    repo: repo,
    number: node.number,
    title: tidy(node.title),
    author: (node.author && node.author.login) || '',
    draft: node.isDraft === true,
    checks: checks,
    checksLong: checksText(checks, checkNames(rollup)),
    review: REVIEWS[node.reviewDecision] || 'No review',
    latest: latestOf(node),
    updated: isFinite(updated) ? updated : 0,
  };
}

function parseBuild(repo) {
  if (!repo || !repo.nameWithOwner) return null;
  var branch = repo.defaultBranchRef;
  var commit = branch && branch.target;
  var suites = commit ? nodes(commit.checkSuites) : [];
  var committed = commit ? Date.parse(commit.committedDate) : NaN;
  return {
    repo: String(repo.nameWithOwner),
    branch: branch ? String(branch.name || '') : '',
    checks: checksOf(commit && commit.statusCheckRollup),
    workflow: workflowOf(suites),
    oid: commit && commit.abbreviatedOid ? String(commit.abbreviatedOid) : '',
    headline: commit ? tidy(commit.messageHeadline) : '',
    committed: isFinite(committed) ? committed : 0,
  };
}

function prOrder(a, b) {
  var fa = a.checks === 'Failing';
  var fb = b.checks === 'Failing';
  if (fa !== fb) return fa ? -1 : 1;
  return b.updated - a.updated;
}

/** GraphQL answers 200 even when it fails; this finds the failures in its body. */
function graphTrouble(r) {
  if (r.problem) return trouble(r);
  var body = r.body;
  var errors = body && Array.isArray(body.errors) ? body.errors : [];
  if (errors.some(function (e) { return e && e.type === 'RATE_LIMITED'; })) {
    return trouble({ problem: 'rate', status: r.status, message: errors[0].message, resetAt: Number(r.header('X-RateLimit-Reset')) * SECOND_MS || 0 });
  }
  if (!body || !body.data) {
    return { problem: 'data', status: r.status, message: clip(errors.length && errors[0].message ? errors[0].message : '', 200) };
  }
  return null;
}

async function graph(token, query) {
  var r = await call('POST', API + '/graphql', { token: token, body: { query: query } });
  var problem = graphTrouble(r);
  return problem ? { problem: problem } : { data: r.body.data };
}

async function readGraph(acct, prefs, now) {
  var key = prefs.builds.join(',');
  return reading(GRAPH_KEY, now,
    function (cache) { return cache.buildsKey === key; },
    function () { return GRAPH_MS; },
    async function () {
      var answer = await graph(acct.token, graphQuery(prefs.builds));
      if (answer.problem) return answer;
      var d = answer.data;
      if (!d.viewer || !d.viewer.login) return { problem: { problem: 'data', status: 200, message: '' } };
      var builds = [];
      prefs.builds.forEach(function (name, i) {
        // A repo that's gone or out of the token's reach comes back null: leave it out.
        var build = parseBuild(d['b' + i]);
        if (build) builds.push(build);
      });
      var list = function (search) {
        return { count: Number(search && search.issueCount) || 0, prs: nodes(search).map(parsePr).filter(Boolean) };
      };
      return { data: { login: String(d.viewer.login), reviews: list(d.reviews), mine: list(d.mine), builds: builds }, meta: { buildsKey: key } };
    });
}

var CONTRIBUTIONS_QUERY = 'query { viewer { contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } } }';

async function readContributions(acct, now) {
  return reading(CONTRIBUTIONS_KEY, now,
    function () { return true; },
    function () { return CONTRIBUTIONS_MS; },
    async function () {
      var answer = await graph(acct.token, CONTRIBUTIONS_QUERY);
      if (answer.problem) return answer;
      var calendar = answer.data.viewer && answer.data.viewer.contributionsCollection && answer.data.viewer.contributionsCollection.contributionCalendar;
      if (!calendar || !Array.isArray(calendar.weeks)) return { problem: { problem: 'data', status: 200, message: '' } };
      var days = [];
      calendar.weeks.forEach(function (week) {
        ((week && week.contributionDays) || []).forEach(function (day) {
          if (day && /^\d{4}-\d{2}-\d{2}$/.test(day.date)) days.push({ date: day.date, count: Number(day.contributionCount) || 0 });
        });
      });
      if (!days.length) return { problem: { problem: 'data', status: 200, message: '' } };
      // The streak needs the whole year; the readings only the last two weeks.
      return { data: { total: Number(calendar.totalContributions) || 0, streak: streakOf(days), days: days.slice(-14) } };
    });
}

// ---------------------------------------------------------------- readings

function text(value) {
  return { shortText: { text: value } };
}

function both(short, long) {
  return { shortText: { text: short }, longText: { text: long } };
}

function flag(value) {
  return { boolean: { value: !!value } };
}

function count(n, shortText) {
  return { numericValue: { value: n }, shortText: { text: shortText === undefined ? String(n) : shortText } };
}

function notificationInstance(t, style) {
  var p = {
    title: both(t.title, t.title),
    repo: text(t.repo),
    kind: text(kindOf(t.type)),
    reason: text(groupOf(t.reason)),
    unread: flag(t.unread),
  };
  if (t.number) p.number = { numericValue: { value: t.number } };
  if (t.latest && t.latest.author) p.author = text(t.latest.author);
  var latest = latestText(t.latest);
  if (latest) p.latest = { longText: { text: latest } };
  if (t.updated) p.updated = stamp(t.updated, style);
  return { instanceId: t.id, properties: p };
}

function prInstance(pr, style) {
  var p = {
    title: both(pr.title, pr.title),
    repo: text(pr.repo),
    number: { numericValue: { value: pr.number } },
    checks: both(pr.checks, pr.checksLong || checksText(pr.checks, { failed: [], running: [] })),
    failing: flag(pr.checks === 'Failing'),
    running: flag(pr.checks === 'Running'),
    review: text(pr.review),
    approved: flag(pr.review === 'Approved'),
    draft: flag(pr.draft),
  };
  if (pr.author) p.author = text(pr.author);
  var latest = latestText(pr.latest);
  if (latest) p.latest = { longText: { text: latest } };
  if (pr.updated) p.updated = stamp(pr.updated, style);
  return { instanceId: pr.id, properties: p };
}

var BUILD_WORDS = { Passing: 'passed', Failing: 'failed', Running: 'running' };

function buildInstance(b, style) {
  var what = b.workflow || 'Checks';
  var long = b.checks === 'No checks' ? 'No checks on ' + (b.branch || 'the default branch') : what + ' ' + BUILD_WORDS[b.checks] + ' on ' + (b.branch || 'the default branch');
  var p = {
    repo: text(b.repo),
    status: both(b.checks, long),
    failing: flag(b.checks === 'Failing'),
    running: flag(b.checks === 'Running'),
  };
  if (b.branch) p.branch = text(b.branch);
  if (b.workflow) p.workflow = text(b.workflow);
  if (b.headline) p.commit = both(b.oid || b.headline, b.headline);
  if (b.committed) p.updated = stamp(b.committed, style);
  return { instanceId: b.repo, properties: p };
}

/** Builds in the settings' order, failing ones first, six at most. */
function arrangeBuilds(builds, order) {
  return builds.slice(0, MAX_BUILDS).map(function (b, i) {
    var at = repoIndex(order, b.repo);
    return { b: b, at: at === -1 ? order.length + i : at };
  }).sort(function (x, y) {
    var fx = x.b.checks === 'Failing';
    var fy = y.b.checks === 'Failing';
    if (fx !== fy) return fx ? -1 : 1;
    return x.at - y.at;
  }).map(function (x) { return x.b; });
}

function repoInstance(r) {
  return { instanceId: r.name, properties: { name: text(r.name), issues: flag(r.issues), builds: flag(r.builds) } };
}

/**
 * The summary. Either half may be missing (n or g null, with why in nProblem/gProblem); the
 * numbers it can't know are left out rather than shown as nought.
 */
function inboxInstance(n, g, login, at, style, nProblem) {
  var p = {};
  var long = [];
  var unread = 0;
  if (n) {
    var unreadThreads = n.threads.filter(function (t) { return t.unread; });
    unread = unreadThreads.length;
    // The list holds read ones too, so there are more unread than it shows only when every one
    // of the 15 is unread and GitHub has another page.
    var more = n.more && unread >= MAX_NOTIFICATIONS;
    p.unread = count(unread, more ? unread + '+' : String(unread));
    long.push(unread ? (more ? unread + '+' : unread) + ' unread notification' + (unread === 1 && !more ? '' : 's') : 'No unread notifications');
    var newest = unreadThreads[0];
    if (newest) {
      var place = newest.repo + (newest.number ? ' #' + newest.number : '');
      var said = latestText(newest.latest);
      p.latest = both(newest.title, place + ': ' + newest.title + (said ? ' — ' + said : ''));
    }
  } else if (nProblem) {
    long.push(errorOf(nProblem).message.replace(/\.$/, ''));
  }
  var failing = 0;
  var broken = 0;
  var reviews = 0;
  if (g) {
    reviews = g.reviews.count;
    var mine = g.mine.count;
    failing = g.mine.prs.filter(function (pr) { return pr.checks === 'Failing'; }).length;
    broken = g.builds.filter(function (b) { return b.checks === 'Failing'; }).length;
    p.reviews = count(reviews);
    p.pull_requests = count(mine);
    p.failing = count(failing);
    p.builds_failing = count(broken);
    long.push(reviews ? plural(reviews, 'pull request') + ' waiting for your review' : 'No reviews waiting');
    long.push(mine ? plural(mine, 'open pull request') + ' of yours' + (failing ? ', ' + failing + ' failing' : '') : 'No open pull requests of yours');
    if (g.builds.length) long.push(broken ? broken + ' of ' + plural(g.builds.length, 'build') + ' failing' : 'No builds failing');
  }
  var status;
  if (failing + broken) status = (failing + broken) + ' failing';
  else if (reviews) status = reviews + ' to review';
  else if (unread) status = unread + ' unread';
  else status = 'All clear';
  p.status = both(status, long.join('. ') + '.');
  if (login) p.login = text(login);
  p.updated = stamp(at, style);
  return { instanceId: 'inbox', properties: p };
}

/** Days with contributions in a row, back from today, or from yesterday while today is still 0:
 * a streak isn't broken until the day is over. */
function streakOf(days) {
  var last = days.length - 1;
  var streak = 0;
  for (var i = last >= 0 && days[last].count > 0 ? last : last - 1; i >= 0 && days[i].count > 0; i--) streak++;
  return streak;
}

/** today = the calendar's last day; week = the last 7 days; daily = the last 14. */
function contributionsInstance(c, at, style) {
  var days = c.days;
  var today = days[days.length - 1].count;
  var streak = typeof c.streak === 'number' ? c.streak : streakOf(days);
  var week = days.slice(-7).reduce(function (sum, d) { return sum + d.count; }, 0);
  var daily = days.slice(-14);
  var first = daily[0].date.split('-').map(Number);
  return {
    instanceId: 'contributions',
    properties: {
      today: count(today),
      streak: { numericValue: { value: streak, unit: 'days' }, shortText: { text: streak + 'd' } },
      week: count(week),
      year: count(c.total),
      daily: {
        series: {
          start: Math.floor(new Date(first[0], first[1] - 1, first[2]).getTime() / 1000),
          stepSec: 86400,
          numericValue: { values: daily.map(function (d) { return d.count; }) },
        },
      },
      updated: stamp(at, style),
    },
  };
}

// ---------------------------------------------------------------- serving sources

/** Everything one source needs: { instances, validUntil } or { error: { code, message } }. */
async function serve(item, now, style) {
  var prefs = settings();
  if (prefs.demo) return demoServe(item, now, style, prefs);
  var acct = account();
  if (!acct) return { error: { code: 'NOT_CONFIGURED', message: NO_TOKEN } };
  if (item === 'repo') {
    return { instances: chosenRepos(prefs).map(repoInstance), validUntil: now + HOUR_MS };
  }
  if (item === 'notification') {
    var n = await readNotifications(acct, prefs, now);
    if (n.problem && !n.data) return { error: errorOf(n.problem) };
    return { instances: visibleThreads(n.data.threads, now).map(function (t) { return notificationInstance(t, style); }), validUntil: n.validUntil };
  }
  if (item === 'contributions') {
    var c = await readContributions(acct, now);
    if (c.problem && !c.data) return { error: errorOf(c.problem) };
    return { instances: [contributionsInstance(c.data, c.at, style)], validUntil: c.validUntil };
  }
  if (item === 'build' && !prefs.builds.length) return { instances: [], validUntil: now + HOUR_MS };
  if (item === 'inbox') {
    var reads = await Promise.all([readNotifications(acct, prefs, now), readGraph(acct, prefs, now)]);
    var notes = reads[0];
    var g = reads[1];
    var nData = notes.data ? { threads: visibleThreads(notes.data.threads, now), more: notes.data.more } : null;
    var gData = g.data || null;
    // A rejected token, or nothing at all to show, is an error; half an inbox is still an inbox.
    var rejected = [notes.problem, g.problem].filter(function (p) { return p && p.problem === 'token'; })[0];
    if (rejected) return { error: errorOf(rejected) };
    if (!nData && !gData) return { error: errorOf(g.problem || notes.problem) };
    var at = Math.min(nData ? notes.at : Infinity, gData ? g.at : Infinity);
    var validUntil = Math.min(nData ? notes.validUntil : Infinity, gData ? g.validUntil : Infinity, notes.problem || g.problem ? now + RETRY_MS * 2 : Infinity);
    var login = gData ? gData.login : acct.login || '';
    return { instances: [inboxInstance(nData, gData, login, at, style, nData ? null : notes.problem)], validUntil: validUntil };
  }
  var graphRead = await readGraph(acct, prefs, now);
  if (graphRead.problem && !graphRead.data) return { error: errorOf(graphRead.problem) };
  var d = graphRead.data;
  var instances;
  if (item === 'build') {
    instances = arrangeBuilds(d.builds, prefs.builds).map(function (b) { return buildInstance(b, style); });
  } else {
    var list = item === 'review_request' ? d.reviews.prs : d.mine.prs;
    instances = list.slice().sort(prOrder).slice(0, MAX_PRS).map(function (pr) { return prInstance(pr, style); });
  }
  return { instances: instances, validUntil: graphRead.validUntil };
}

Pebble.registerSourceHandler(async function (request, respond) {
  var item = request && request.category === 'code' ? request.item : null;
  if (ITEMS.indexOf(item) === -1) {
    respond.error('INVALID_REQUEST', 'Inbox for GitHub serves ' + SOURCES.join(', ') + '.');
    return;
  }
  var style = await clock(true);
  var answer = await serve(item, Date.now(), style);
  if (answer.error) {
    respond.error(answer.error.code, answer.error.message);
    return;
  }
  respond.data({ validUntilMs: answer.validUntil, instances: answer.instances });
});

// ---------------------------------------------------------------- actions

var NOTIFICATION_SOURCES = ['code/notification', 'code/inbox'];
var PR_SOURCES = ['code/review_request', 'code/pull_request', 'code/build', 'code/inbox'];

/** owner/repo#n or a notification id -> { repo, number }, or { error }. */
function commentTarget(id, threads) {
  var m = NUMBERED_PATTERN.exec(String(id || ''));
  if (m) return { repo: m[1], number: Number(m[2]) };
  if (!THREAD_PATTERN.test(String(id || ''))) return { error: 'instanceId has to be a notification id or owner/repo#number.' };
  var thread = (threads || []).filter(function (t) { return t.id === String(id); })[0];
  if (!thread) return { error: 'That notification isn\'t in the inbox any more.' };
  if (!thread.number || (thread.type !== 'Issue' && thread.type !== 'PullRequest')) {
    return { error: 'Only issues and pull requests take comments from here.' };
  }
  return { repo: thread.repo, number: thread.number, title: thread.title };
}

/**
 * Dictated text -> { title, body }: the first sentence is the title, cut at 80 characters at a
 * word; the rest is the body, or the whole text when the title had to be cut.
 */
function issueParts(title, body) {
  var said = tidy(title);
  var more = String(body || '').trim();
  if (more) return { title: clip(said, 256), body: more };
  var m = /^(.+?[.!?])(?:\s+|$)([\s\S]*)$/.exec(said);
  var first = m ? m[1] : said;
  var rest = m ? m[2].trim() : '';
  if (first.length > TITLE_CUT) return { title: clip(first, TITLE_CUT), body: said };
  return { title: first.replace(/\.$/, ''), body: rest };
}

function failure(respond, t, what) {
  var e = errorOf(t);
  if (t.problem === 'missing') e = { code: 'INVALID_ARGS', message: 'GitHub couldn\'t find ' + what + '.' };
  if (t.problem === 'gone') e = { code: 'INVALID_ARGS', message: 'GitHub says ' + what + ' are turned off or gone.' };
  if (t.problem === 'invalid') e = { code: 'INVALID_ARGS', message: 'GitHub wouldn\'t take that' + (t.message ? ': ' + t.message : '.') };
  if (t.problem === 'forbidden') e = { code: 'PERMISSION_DENIED', message: 'GitHub refused' + (t.message ? ': ' + t.message : '.') + ' The token may need the repo scope.' };
  respond.error(e.code, e.message);
}

function cachedThreads() {
  var cache = kept(NOTIFICATIONS_KEY);
  return cache && cache.data && Array.isArray(cache.data.threads) ? cache.data.threads : [];
}

/** The failed GitHub Actions runs on a pull request's head, or a repo's default branch. */
async function failedRuns(token, target) {
  var suites = 'checkSuites(first: 50) { nodes { status conclusion workflowRun { databaseId workflow { name } } } }';
  var query = target.number
    ? 'query { repository(' + repoArgs(target.repo) + ') { pullRequest(number: ' + target.number + ') { commits(last: 1) { nodes { commit { ' + suites + ' } } } } } }'
    : 'query { repository(' + repoArgs(target.repo) + ') { defaultBranchRef { target { ... on Commit { ' + suites + ' } } } } }';
  var answer = await graph(token, query);
  if (answer.problem) return answer;
  var repo = answer.data.repository;
  var commit = null;
  if (repo && target.number) commit = repo.pullRequest && nodes(repo.pullRequest.commits)[0] && nodes(repo.pullRequest.commits)[0].commit;
  else if (repo) commit = repo.defaultBranchRef && repo.defaultBranchRef.target;
  if (!repo || (target.number && !repo.pullRequest)) return { problem: { problem: 'missing', status: 404, message: '' } };
  var failed = (commit ? nodes(commit.checkSuites) : []).filter(function (s) { return FAILED_CONCLUSIONS.indexOf(s.conclusion) !== -1; });
  var runs = [];
  failed.forEach(function (s) {
    var id = s.workflowRun && s.workflowRun.databaseId;
    if (id && runs.every(function (r) { return r.id !== id; })) runs.push({ id: id, name: (s.workflowRun.workflow && s.workflowRun.workflow.name) || '' });
  });
  return { runs: runs, failedSuites: failed.length };
}

async function rerun(acct, args, respond) {
  var id = String(args.instanceId || '');
  var m = NUMBERED_PATTERN.exec(id);
  var target = m ? { repo: m[1], number: Number(m[2]) } : isRepo(id) ? { repo: id, number: 0 } : null;
  if (!target) return respond.error('INVALID_ARGS', 'instanceId has to be owner/repo#number or owner/repo.');
  var found = await failedRuns(acct.token, target);
  var what = target.number ? target.repo + ' #' + target.number : target.repo;
  if (found.problem) return failure(respond, found.problem, what);
  if (!found.runs.length) {
    return respond.ok({ text: found.failedSuites ? 'The failed checks on ' + what + ' aren\'t GitHub Actions runs, so they can\'t be rerun from here' : 'Nothing has failed', refreshed: [] });
  }
  var answers = await Promise.all(found.runs.map(function (run) {
    var r = splitRepo(target.repo);
    return call('POST', API + '/repos/' + r.owner + '/' + r.name + '/actions/runs/' + run.id + '/rerun-failed-jobs', { token: acct.token });
  }));
  var started = found.runs.filter(function (run, i) { return !answers[i].problem; });
  if (!started.length) return failure(respond, trouble(answers[0]), 'those runs');
  expire([GRAPH_KEY]);
  var said = started.length === 1
    ? 'Rerunning failed jobs' + (started[0].name ? ' in ' + started[0].name : '') + ' on ' + what
    : 'Rerunning failed jobs in ' + started.length + ' runs on ' + what;
  if (started.length < found.runs.length) said += ' (' + (found.runs.length - started.length) + ' refused)';
  respond.ok({ text: said, refreshed: PR_SOURCES });
}

async function act(name, args, respond) {
  var now = Date.now();
  if (name === 'refresh') {
    expire([NOTIFICATIONS_KEY, GRAPH_KEY, CONTRIBUTIONS_KEY]);
    Pebble.refreshSources(SOURCES);
    respond.ok({ text: 'Refreshing', refreshed: SOURCES });
    return;
  }
  var prefs = settings();
  if (prefs.demo) return demoAct(name, args, now, respond, prefs);
  var acct = account();
  if (!acct) return respond.error('NOT_CONFIGURED', NO_TOKEN);
  switch (name) {
    case 'mark_read':
    case 'mark_done': {
      var id = String(args.instanceId || '');
      if (!THREAD_PATTERN.test(id)) return respond.error('INVALID_ARGS', 'instanceId has to be a notification id.');
      var title = (cachedThreads().filter(function (t) { return t.id === id; })[0] || {}).title;
      var r = await call(name === 'mark_read' ? 'PATCH' : 'DELETE', API + '/notifications/threads/' + id, { token: acct.token });
      if (r.problem) return failure(respond, trouble(r), 'that notification');
      mark(id, name === 'mark_read' ? 'read' : 'done', now);
      expire([NOTIFICATIONS_KEY], true);
      var verb = name === 'mark_read' ? 'Marked read' : 'Done';
      respond.ok({ text: title ? verb + ': ' + title : verb, refreshed: NOTIFICATION_SOURCES });
      return;
    }
    case 'mark_all_read': {
      var all = await call('PUT', API + '/notifications', { token: acct.token, body: { read: true } });
      if (all.problem) return failure(respond, trouble(all), 'the notifications');
      mark(null, 'read', now);
      expire([NOTIFICATIONS_KEY], true);
      // 202: too many for GitHub to do at once, so it carries on in the background.
      respond.ok({ text: all.status === 202 ? 'GitHub is marking them all read' : 'Marked all read', refreshed: NOTIFICATION_SOURCES });
      return;
    }
    case 'rerun_failed':
      return rerun(acct, args, respond);
    case 'comment': {
      var body = String(args.text === undefined ? '' : args.text).trim();
      if (!body) return respond.error('INVALID_ARGS', 'There\'s nothing to say.');
      if (body.length > 2000) return respond.error('INVALID_ARGS', 'A comment from here can be 2000 characters at most.');
      var target = commentTarget(args.instanceId, cachedThreads());
      if (target.error) return respond.error('INVALID_ARGS', target.error);
      var place = target.repo + ' #' + target.number;
      var parts = splitRepo(target.repo);
      var posted = await call('POST', API + '/repos/' + parts.owner + '/' + parts.name + '/issues/' + target.number + '/comments', { token: acct.token, body: { body: body } });
      if (posted.problem) return failure(respond, trouble(posted), place);
      expire([NOTIFICATIONS_KEY, GRAPH_KEY], true);
      respond.ok({ text: 'Replied on ' + place, refreshed: NOTIFICATION_SOURCES.concat(['code/review_request', 'code/pull_request']) });
      return;
    }
    case 'new_issue': {
      var repo = args.repo === undefined || args.repo === '' ? prefs.issueRepo : String(args.repo);
      if (!repo) return respond.error('INVALID_ARGS', 'Choose a repository for new issues in Inbox for GitHub\'s settings.');
      var chosen = chosenRepos(prefs).filter(function (r) { return sameRepo(r.name, repo); })[0];
      if (!chosen) return respond.error('INVALID_ARGS', repo + ' isn\'t one of the repositories chosen in settings.');
      var issue = issueParts(args.title, args.body);
      if (!issue.title) return respond.error('INVALID_ARGS', 'An issue needs a title.');
      var at = splitRepo(chosen.name);
      var made = await call('POST', API + '/repos/' + at.owner + '/' + at.name + '/issues', { token: acct.token, body: { title: issue.title, body: issue.body } });
      if (made.problem) return failure(respond, trouble(made), 'issues on ' + chosen.name);
      var number = made.body && made.body.number;
      respond.ok({ text: 'Opened #' + number + ' on ' + chosen.name + ': ' + issue.title, refreshed: [] });
      return;
    }
    default:
      respond.error('INVALID_REQUEST', 'Unknown action ' + name);
  }
}

Pebble.registerActionHandler(async function (request, respond) {
  var name = request && request.action;
  if (ACTIONS.indexOf(name) === -1) {
    respond.error('INVALID_REQUEST', 'Unknown action ' + name);
    return;
  }
  await act(name, (request && request.args) || {}, respond);
});

// ---------------------------------------------------------------- demo mode
//
// Fictional people and repositories, built relative to now, for the store screenshots, the
// emulator and trying the app without a token. Actions change the demo's own state.

var DEMO_LOGIN = 'alex-kim';
var DEMO_BUILDS = ['acme/website', 'acme/api', 'alex-kim/notes-app'];
var DEMO_ISSUE_REPO = 'acme/website';
var DEMO_RERUN_MS = 2 * MINUTE_MS;
var DEMO_DAYS = [4, 0, 2, 6, 3, 0, 1, 5, 2, 7, 3, 0, 4, 2, 6, 1, 3, 8, 2, 5, 4];
var DEMO_YEAR = 1287;

function demoState() {
  var saved = kept(DEMO_KEY) || {};
  return {
    read: Array.isArray(saved.read) ? saved.read : [],
    done: Array.isArray(saved.done) ? saved.done : [],
    allReadAt: Number(saved.allReadAt) || 0,
    replies: saved.replies && typeof saved.replies === 'object' ? saved.replies : {},
    reruns: saved.reruns && typeof saved.reruns === 'object' ? saved.reruns : {},
    issues: Number(saved.issues) || 0,
  };
}

/** The demo's notifications, PRs, builds and contributions, as the real reads would keep them. */
function demoWorld(now) {
  var state = demoState();
  var ago = function (minutes) { return now - minutes * MINUTE_MS; };
  var said = function (author, words) { return { author: author, text: words }; };
  var reply = function (id, latest) {
    return state.replies[id] ? { author: DEMO_LOGIN, text: state.replies[id] } : latest;
  };
  // A rerun runs for two minutes, then passes.
  var rerunChecks = function (id, checks) {
    var at = state.reruns[id];
    if (!at) return checks;
    return now - at < DEMO_RERUN_MS ? 'Running' : 'Passing';
  };
  var threads = [
    ['9001', 'Retry failed webhooks with backoff', 'PullRequest', 'acme/api', 42, 'review_requested', 12, said('sam-lee', 'Ready for review. The retry loop now backs off up to 30 s.')],
    ['9002', 'Dark mode toggle forgets its setting', 'Issue', 'acme/website', 118, 'mention', 38, said('priya-n', '@alex-kim could you check this on Safari? It resets after a reload.')],
    ['9003', 'CI workflow run failed for main branch', 'CheckSuite', 'acme/website', 0, 'ci_activity', 55, null],
    ['9004', 'Export notes as Markdown', 'Issue', 'alex-kim/notes-app', 7, 'assign', 130, said('jordan-w', 'Assigning this to you since you wrote the exporter.')],
    ['9005', 'Fix the cache key for build assets', 'PullRequest', 'acme/website', 119, 'comment', 190, said('sam-lee', 'Looks good, one nit on the cache key: include the lockfile hash.')],
    ['9006', 'RFC: versioned endpoints', 'Discussion', 'acme/api', 0, 'mention', 300, said('priya-n', 'I\'d like @alex-kim\'s view on path vs header versioning.')],
    ['9007', 'Rate limit headers missing on 429', 'Issue', 'acme/api', 37, 'state_change', 26 * 60, said('jordan-w', 'Closed in #41.')],
    ['9008', 'v2.4.0', 'Release', 'acme/website', 0, 'subscribed', 3 * 24 * 60, said('sam-lee', 'Faster search, dark mode fixes and a new export menu.')],
  ].map(function (row) {
    var id = row[0];
    var updated = ago(row[6]);
    var unread = row[6] < 24 * 60 && state.read.indexOf(id) === -1 && !(state.allReadAt && updated <= state.allReadAt);
    return {
      id: id, title: row[1], type: row[2], repo: row[3], number: row[4], reason: row[5],
      unread: unread, updated: updated, latest: reply(id, row[7]),
    };
  }).filter(function (t) { return state.done.indexOf(t.id) === -1; });

  // `jobs`: the checks that are failing or running; a rerun's jobs run, then pass.
  var pr = function (repo, number, title, author, draft, checks, review, minutes, latest, jobs) {
    var id = repo + '#' + number;
    var current = rerunChecks(id, checks);
    var names = { failed: current === 'Failing' ? jobs || [] : [], running: current === 'Running' ? jobs || [] : [] };
    return {
      id: id, repo: repo, number: number, title: title, author: author, draft: draft,
      checks: current, checksLong: checksText(current, names), review: review, updated: ago(minutes),
      latest: reply(id, latest),
    };
  };
  var reviews = [
    pr('acme/api', 42, 'Retry failed webhooks with backoff', 'sam-lee', false, 'Running', 'Review required', 12, said('sam-lee', 'Ready for review. The retry loop now backs off up to 30 s.'), ['CI / test']),
    pr('acme/website', 121, 'Add pagination to search results', 'priya-n', false, 'Passing', 'Review required', 95, said('priya-n', 'Ten results a page, with the page in the URL.')),
    pr('acme/api', 39, 'Move config to environment variables', 'jordan-w', false, 'Failing', 'Changes requested', 400, said('', 'sam-lee requested changes'), ['CI / test']),
  ];
  var mine = [
    pr('acme/website', 119, 'Fix the cache key for build assets', DEMO_LOGIN, false, 'Failing', 'Changes requested', 190, said('sam-lee', 'Looks good, one nit on the cache key: include the lockfile hash.'), ['CI / test', 'CI / lint']),
    pr('acme/api', 40, 'Add a request ID to every log line', DEMO_LOGIN, false, 'Passing', 'Approved', 240, said('', 'priya-n approved')),
    pr('alex-kim/notes-app', 12, 'Sync notes over WebDAV', DEMO_LOGIN, true, 'Running', 'No review', 30, null, ['Build / build']),
    pr('acme/website', 117, 'Lazy-load images below the fold', DEMO_LOGIN, false, 'Passing', 'Review required', 26 * 60, null),
  ];
  var build = function (repo, checks, workflow, oid, headline, minutes) {
    return { repo: repo, branch: 'main', checks: rerunChecks(repo, checks), workflow: workflow, oid: oid, headline: headline, committed: ago(minutes) };
  };
  var builds = [
    build('acme/website', 'Failing', 'CI', '3f9c2ab', 'Fix the cache key', 55),
    build('acme/api', 'Passing', 'CI', 'a17d04e', 'Log the request ID', 240),
    build('alex-kim/notes-app', 'Running', 'Build', 'c0ffee1', 'Start on WebDAV sync', 30),
  ];
  var today = new Date(now);
  var days = DEMO_DAYS.map(function (n, i) {
    var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (DEMO_DAYS.length - 1 - i), 12);
    return { date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()), count: n };
  });
  return {
    notifications: { threads: threads, more: false },
    graph: { login: DEMO_LOGIN, reviews: { count: reviews.length, prs: reviews }, mine: { count: mine.length, prs: mine }, builds: builds },
    contributions: { total: DEMO_YEAR, days: days },
    prefs: { builds: DEMO_BUILDS, issueRepo: DEMO_ISSUE_REPO },
  };
}

function demoServe(item, now, style) {
  var w = demoWorld(now);
  var validUntil = now + MINUTE_MS;
  var threads = w.notifications.threads.slice().sort(threadOrder).slice(0, MAX_NOTIFICATIONS);
  var instances;
  switch (item) {
    case 'inbox':
      instances = [inboxInstance({ threads: threads, more: false }, w.graph, DEMO_LOGIN, now, style)];
      break;
    case 'notification':
      instances = threads.map(function (t) { return notificationInstance(t, style); });
      break;
    case 'review_request':
    case 'pull_request':
      instances = (item === 'review_request' ? w.graph.reviews.prs : w.graph.mine.prs).slice().sort(prOrder).map(function (pr) { return prInstance(pr, style); });
      break;
    case 'build':
      instances = arrangeBuilds(w.graph.builds, w.prefs.builds).map(function (b) { return buildInstance(b, style); });
      break;
    case 'repo':
      instances = chosenRepos(w.prefs).map(repoInstance);
      validUntil = now + HOUR_MS;
      break;
    default:
      instances = [contributionsInstance(w.contributions, now, style)];
  }
  return { instances: instances, validUntil: validUntil };
}

function demoAct(name, args, now, respond) {
  var state = demoState();
  var w = demoWorld(now);
  var save = function () { keep(DEMO_KEY, state); };
  var thread = function (id) { return w.notifications.threads.filter(function (t) { return t.id === String(id); })[0]; };
  var allPrs = w.graph.reviews.prs.concat(w.graph.mine.prs);
  switch (name) {
    case 'mark_read':
    case 'mark_done': {
      var t = thread(args.instanceId);
      if (!t) return respond.error('INVALID_ARGS', 'Demo: that notification isn\'t in the inbox any more.');
      state[name === 'mark_read' ? 'read' : 'done'].push(t.id);
      save();
      respond.ok({ text: 'Demo: ' + (name === 'mark_read' ? 'Marked read: ' : 'Done: ') + t.title, refreshed: NOTIFICATION_SOURCES });
      return;
    }
    case 'mark_all_read':
      state.allReadAt = now;
      save();
      respond.ok({ text: 'Demo: Marked all read', refreshed: NOTIFICATION_SOURCES });
      return;
    case 'rerun_failed': {
      var id = String(args.instanceId || '');
      var failing = allPrs.concat(w.graph.builds.map(function (b) { return { id: b.repo, checks: b.checks }; }))
        .filter(function (x) { return x.id === id; })[0];
      if (!failing) return respond.error('INVALID_ARGS', 'Demo: there\'s no ' + (id || 'such item') + ' in the demo.');
      if (failing.checks !== 'Failing') return respond.ok({ text: 'Demo: Nothing has failed', refreshed: [] });
      state.reruns[id] = now;
      save();
      respond.ok({ text: 'Demo: Rerunning failed jobs in CI on ' + id.replace('#', ' #'), refreshed: PR_SOURCES });
      return;
    }
    case 'comment': {
      var body = tidy(args.text);
      if (!body) return respond.error('INVALID_ARGS', 'There\'s nothing to say.');
      var target = commentTarget(args.instanceId, w.notifications.threads);
      if (target.error) return respond.error('INVALID_ARGS', 'Demo: ' + target.error);
      var key = target.repo + '#' + target.number;
      // The reply shows on the notification and on the pull request it's about.
      state.replies[String(args.instanceId)] = clip(body, MAX_LATEST);
      state.replies[key] = clip(body, MAX_LATEST);
      w.notifications.threads.forEach(function (t) {
        if (t.repo === target.repo && t.number === target.number) state.replies[t.id] = clip(body, MAX_LATEST);
      });
      save();
      respond.ok({ text: 'Demo: Replied on ' + target.repo + ' #' + target.number, refreshed: NOTIFICATION_SOURCES.concat(['code/review_request', 'code/pull_request']) });
      return;
    }
    case 'new_issue': {
      var repo = args.repo ? String(args.repo) : DEMO_ISSUE_REPO;
      if (repoIndex(DEMO_BUILDS, repo) === -1) return respond.error('INVALID_ARGS', 'Demo: ' + repo + ' isn\'t one of the demo\'s repositories.');
      var issue = issueParts(args.title, args.body);
      if (!issue.title) return respond.error('INVALID_ARGS', 'An issue needs a title.');
      state.issues += 1;
      save();
      respond.ok({ text: 'Demo: Opened #' + (130 + state.issues) + ' on ' + repo + ': ' + issue.title, refreshed: [] });
      return;
    }
    default:
      respond.error('INVALID_REQUEST', 'Unknown action ' + name);
  }
}

// ---------------------------------------------------------------- settings page

/** The token's scopes from X-OAuth-Scopes, or null when GitHub (or the host) doesn't say. */
function scopesOf(r) {
  var header = r.header('X-OAuth-Scopes');
  if (header === null) return null;
  return header.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

function warningsFor(token, scopes) {
  var warnings = [];
  if (token.indexOf('github_pat_') === 0) {
    warnings.push('This is a fine-grained token. GitHub\'s notifications API only works with a classic token, so notifications won\'t show. Pull requests and builds still will.');
    return warnings;
  }
  if (!scopes) return warnings;
  var has = function (scope) { return scopes.indexOf(scope) !== -1; };
  if (!has('notifications') && !has('repo')) warnings.push('This token has neither the notifications nor the repo scope, so notifications won\'t show.');
  if (!has('repo')) warnings.push('Without the repo scope, private repositories and rerunning failed jobs won\'t work.');
  return warnings;
}

function publicSettings(prefs) {
  return { demo: prefs.demo, participating: prefs.participating, builds: prefs.builds, issueRepo: prefs.issueRepo };
}

/** Everything the page shows. `user` is a /user answer already in hand, if any. */
async function pageState(user) {
  var prefs = settings();
  var acct = account();
  var reply = {
    settings: publicSettings(prefs),
    signedIn: !!acct,
    deviceSignIn: !!CLIENT_ID,
    tokenUrl: TOKEN_URL,
    limits: { builds: MAX_BUILDS },
    repos: [],
  };
  if (!acct) return reply;
  var answers = await Promise.all([
    user || call('GET', API + '/user', { token: acct.token }),
    call('GET', API + '/user/repos?sort=pushed&per_page=30', { token: acct.token }),
  ]);
  var me = answers[0];
  var info = { login: acct.login || '', masked: mask(acct.token), scopes: acct.scopes || null, warnings: [] };
  if (me.problem) {
    info.problem = me.problem === 'token' ? 'GitHub rejected this token. Paste a new one.' : errorOf(trouble(me)).message;
  } else if (me.body && me.body.login) {
    info.login = String(me.body.login);
    info.scopes = scopesOf(me);
    if (info.login !== acct.login || JSON.stringify(info.scopes) !== JSON.stringify(acct.scopes || null)) {
      keep(ACCOUNT_KEY, Object.assign({}, acct, { login: info.login, scopes: info.scopes }));
    }
  }
  info.warnings = warningsFor(acct.token, info.scopes);
  reply.account = info;
  var repos = answers[1];
  var listed = [];
  if (!repos.problem && Array.isArray(repos.body)) {
    repos.body.forEach(function (r) {
      if (r && isRepo(r.full_name) && !r.archived) listed.push({ name: r.full_name, private: r.private === true, issues: r.has_issues !== false });
    });
  } else if (repos.problem) {
    reply.reposError = errorOf(trouble(repos)).message;
  }
  // Chosen repos stay on the page even once they're not among the 30 most recently pushed.
  chosenRepos(prefs).forEach(function (r) {
    if (!listed.some(function (l) { return sameRepo(l.name, r.name); })) listed.push({ name: r.name, private: false, issues: true });
  });
  reply.repos = listed;
  return reply;
}

async function signIn(token) {
  var t = String(token || '').trim();
  if (!TOKEN_PATTERN.test(t)) {
    return Object.assign(await pageState(), { error: 'That doesn\'t look like a GitHub token. Classic tokens start with ghp_.' });
  }
  var me = await call('GET', API + '/user', { token: t });
  if (me.problem === 'token') return Object.assign(await pageState(), { error: 'GitHub didn\'t accept that token. Check it was copied whole and hasn\'t expired.' });
  if (me.problem) return Object.assign(await pageState(), { error: errorOf(trouble(me)).message });
  if (!me.body || !me.body.login) return Object.assign(await pageState(), { error: 'GitHub\'s answer couldn\'t be read.' });
  forgetReadings();
  keep(ACCOUNT_KEY, { token: t, login: String(me.body.login), scopes: scopesOf(me) });
  Pebble.refreshSources(SOURCES);
  return Object.assign(await pageState(me), { saved: true });
}

function signOut() {
  forget(ACCOUNT_KEY);
  forget(DEVICE_KEY);
  forgetReadings();
  Pebble.refreshSources(SOURCES);
}

function choose(message) {
  var before = settings();
  var builds = repoList(message.builds).slice(0, MAX_BUILDS);
  var issueRepo = isRepo(message.issueRepo) ? message.issueRepo : '';
  var prefs = {
    demo: message.demo === true,
    participating: message.participating === true,
    builds: builds,
    issueRepo: issueRepo,
  };
  // Each time the demo is switched on it starts afresh.
  if (prefs.demo && !before.demo) forget(DEMO_KEY);
  keep(SETTINGS_KEY, prefs);
  Pebble.refreshSources(SOURCES);
  return publicSettings(prefs);
}

/** Device flow: github.com/login/device/code, then the page asks again every `interval` s. */
async function deviceStart() {
  if (!CLIENT_ID) return { error: 'Signing in this way isn\'t switched on. Paste a token instead.' };
  var r = await call('POST', WEB + '/login/device/code', {
    accept: 'application/json',
    body: 'client_id=' + encodeURIComponent(CLIENT_ID) + '&scope=' + encodeURIComponent('notifications repo'),
  });
  var b = r.body || {};
  if (r.problem || !b.device_code || !b.user_code) return { error: 'GitHub couldn\'t start a sign-in. Paste a token instead.' };
  var interval = Math.max(Number(b.interval) || 5, 5);
  keep(DEVICE_KEY, { code: b.device_code, until: Date.now() + (Number(b.expires_in) || 900) * SECOND_MS, interval: interval });
  return { userCode: String(b.user_code), verificationUri: String(b.verification_uri || WEB + '/login/device'), interval: interval };
}

async function devicePoll() {
  var d = kept(DEVICE_KEY);
  if (!CLIENT_ID || !d || Date.now() > d.until) {
    forget(DEVICE_KEY);
    return { device: 'expired' };
  }
  var r = await call('POST', WEB + '/login/oauth/access_token', {
    accept: 'application/json',
    body: 'client_id=' + encodeURIComponent(CLIENT_ID) + '&device_code=' + encodeURIComponent(d.code) +
      '&grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:device_code'),
  });
  var b = r.body || {};
  if (typeof b.access_token === 'string' && b.access_token) {
    forget(DEVICE_KEY);
    return Object.assign(await signIn(b.access_token), { device: 'done' });
  }
  if (b.error === 'authorization_pending') return { device: 'pending', interval: d.interval };
  if (b.error === 'slow_down') {
    d.interval = Math.max(Number(b.interval) || d.interval + 5, d.interval + 5);
    keep(DEVICE_KEY, d);
    return { device: 'pending', interval: d.interval };
  }
  forget(DEVICE_KEY);
  if (b.error === 'access_denied') return { device: 'denied' };
  if (b.error === 'expired_token') return { device: 'expired' };
  return { device: 'failed', error: r.problem ? errorOf(trouble(r)).message : 'GitHub couldn\'t finish the sign-in.' };
}

Pebble.registerConfigHandler(async function (message, respond) {
  switch (message && message.type) {
    case 'load':
      respond(await pageState());
      return;
    case 'token':
      respond(await signIn(message.token));
      return;
    case 'signout':
      signOut();
      respond(await pageState());
      return;
    case 'set':
      respond({ ok: true, settings: choose(message) });
      return;
    case 'device_start':
      respond(await deviceStart());
      return;
    case 'device_poll':
      respond(await devicePoll());
      return;
    default:
      respond({ error: 'unknown message type' });
  }
});
