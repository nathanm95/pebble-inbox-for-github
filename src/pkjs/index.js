// Inbox for GitHub, phone side of the watch app: reads this pbw's own plugin (src/plugin/index.js)
// the way any app reads a plugin, turns its readings into AppMessages for the watch app (src/c),
// and runs the plugin's actions for what the watch asks. It never talks to GitHub itself, and
// never sees the token. DESIGN.md is the contract with the watch.
//
// To the watch (key Cmd):
//   2 SUMMARY  Login ('' = not signed in and no demo), Unread, Reviews, Prs, Failing (my PRs
//              failing), Builds (watched repos), Broken (builds failing), Repo (issue repo)
//   3 ITEM     Kind, Index, Count, Id, Title, Sub, State, Flags, Group (notifications only),
//              Text. Index 0 starts a batch for that Kind, and the watch shows a batch once it
//              has all of it. Count 0 (no Index) is an empty list
//   4 TIME     Updated: when GitHub was read (epoch seconds)
//   5 NOTICE   Notice: why something isn't right ('' once it is)
//   6 RESULT   Act, Ok, Notice: how an ACT went
// From the watch:
//   1 HELLO    it has just started, or the phone is back: send everything again
//   7 ACT      Act, Id, Text (dictation), Repo (new issue)
//
// Sub and Text are composed here, so the watch only draws them; ages ('3h') are as of the
// reading that brought them, and move on with the next one.
//
// One message is in flight at a time and the next goes when the watch acks it. A nack, or no
// answer in 10 seconds, is tried again (3 times, a second apart). A newer batch of a Kind
// replaces what's left of an older one; a RESULT goes ahead of everything waiting, since the
// watch is showing "Sending…" until it comes.

var PLUGIN_UUID = 'adb4f7c0-171e-48a0-911a-2caa057949f9'; // this pbw: the app reads its own plugin
var CMD = { HELLO: 1, SUMMARY: 2, ITEM: 3, TIME: 4, NOTICE: 5, RESULT: 6, ACT: 7 };
var KIND = { NOTIFICATION: 1, REVIEW: 2, PR: 3, BUILD: 4, REPO: 5 };
var ACT = { MARK_READ: 1, MARK_DONE: 2, MARK_ALL_READ: 3, RERUN: 4, COMMENT: 5, NEW_ISSUE: 6, REFRESH: 7 };
var STATE = { NONE: 0, GOOD: 1, PENDING: 2, BAD: 3, DRAFT: 4 };
var FLAG = { UNREAD: 1, CAN_RERUN: 2, CAN_COMMENT: 4, CAN_MARK: 8, DEFAULT: 16 };
// The plugin's `reason` words, in the watch's Group order.
var GROUPS = ['Review requested', 'Mentioned', 'Assigned', 'Builds', 'Other'];
var GROUP_BUILDS = 3;
var GROUP_OTHER = 4;
// UTF-8 bytes, without the NUL: what the watch keeps.
var LIMITS = { id: 127, title: 100, sub: 47, text: 280, notice: 159, login: 39, repo: 100 };
var MAX_ITEMS = { 1: 15, 2: 8, 3: 8, 4: 6, 5: 6 };
var LISTS = [
  { item: 'notification', kind: KIND.NOTIFICATION },
  { item: 'review_request', kind: KIND.REVIEW },
  { item: 'pull_request', kind: KIND.PR },
  { item: 'build', kind: KIND.BUILD },
  { item: 'repo', kind: KIND.REPO }
];
// Every source the watch needs, the summary first: a problem with it is the one to tell.
var ITEMS = ['inbox', 'notification', 'review_request', 'pull_request', 'build', 'repo'];
var RETRIES = 3;
var RETRY_MS = 1000;
var ANSWER_MS = 10000;
var ACTION_TIMEOUT_MS = 30000;
var TITLE_CUT = 80;
var INT32_MAX = 2147483647;
var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var ELLIPSIS = '…';
var UPDATE_APP = 'Update the Pebble app on your phone to use Inbox for GitHub.';

var KEYS = {};
try { KEYS = require('message_keys') || {}; } catch (e) { KEYS = {}; }

var readings = {};     // item -> the plugin's latest envelope
var problems = {};     // item -> what to tell about its latest error ('' or absent: none)
var signedOut = false; // the plugin says nobody is signed in (and the demo is off)
var composed = {};     // channel -> the messages it holds now, for HELLO
var prStates = '';     // the review/PR states notifications were last composed with
var stuck = '';        // a problem with this phone app itself, outranking the plugin's

// What the watch has of each channel ('summary', 'items1'..'items5', 'time', 'notice'), by
// signature: acked in full, or on its way.
var channels = {};
var queue = [];        // { channel, message, sig, last, rank, seq }
var inFlight = null;
var seq = 0;
var RANKS = { result: 0, summary: 1, notice: 2, time: 4 };

// ---------------------------------------------------------------- text

function utf8Length(s) {
  var n = 0;
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

/** s cut at a word (or, failing that, anywhere) with '…', to `keep` UTF-16 units at most. */
function cutAt(s, keep) {
  var cut = s.slice(0, keep);
  var last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  var space = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  if (space > keep / 2) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.–—-]+$/, '') + ELLIPSIS;
}

/** At most `bytes` bytes of UTF-8: whole if it fits, else cut at a word with '…'. */
function fit(s, bytes) {
  s = String(s === undefined || s === null ? '' : s);
  if (utf8Length(s) <= bytes) return s;
  var keep = s.length;
  var out = s;
  while (keep > 0 && utf8Length(out) > bytes) {
    keep = Math.min(keep - 1, Math.floor(keep * bytes / utf8Length(out)));
    out = cutAt(s, keep);
  }
  return out;
}

/** A whole number the watch's int32 can hold. */
function int(n) {
  n = Math.floor(Number(n));
  if (!isFinite(n)) return 0;
  return Math.max(-INT32_MAX - 1, Math.min(INT32_MAX, n));
}

/** 'now', '5m', '3h', '2d', then 'Nov 3'. */
function age(seconds, now) {
  if (!seconds) return '';
  var ms = now - seconds * 1000;
  if (ms < 60000) return 'now';
  if (ms < 3600000) return Math.floor(ms / 60000) + 'm';
  if (ms < 86400000) return Math.floor(ms / 3600000) + 'h';
  if (ms < 7 * 86400000) return Math.floor(ms / 86400000) + 'd';
  var date = new Date(seconds * 1000);
  return MONTHS[date.getMonth()] + ' ' + date.getDate();
}

/** At most `max` characters, cut at a word with '…'. */
function clip(s, max) {
  if (s.length <= max) return s;
  var cut = s.slice(0, max - 1);
  var space = cut.lastIndexOf(' ');
  if (space > max / 2) cut = cut.slice(0, space);
  return cut.replace(/[\s,;:.–—-]+$/, '') + ELLIPSIS;
}

/**
 * Dictation -> the new issue's { title, body }, as DESIGN.md has it (and the plugin does for a
 * title alone): the first sentence is the title, cut at 80 characters at a word; the rest is the
 * body, or the whole text when the title had to be cut. Done here so the title is never longer
 * than the 256 characters the action declares.
 */
function issueArgs(said) {
  var text = String(said).replace(/\s+/g, ' ').trim();
  var m = /^(.+?[.!?])(?:\s+|$)([\s\S]*)$/.exec(text);
  var first = m ? m[1] : text;
  var rest = m ? m[2].trim() : '';
  if (first.length > TITLE_CUT) return { title: clip(first, TITLE_CUT), body: text };
  var args = { title: first.replace(/\.$/, '') };
  if (rest) args.body = rest;
  return args;
}

function lines(list) {
  return list.filter(function (line) { return !!line; }).join('\n');
}

// ---------------------------------------------------------------- reading the plugin

function shape(properties, name, kind) {
  var property = properties && properties[name];
  return property && property[kind];
}

function textOf(properties, name, kind) {
  var value = shape(properties, name, kind || 'shortText');
  return value && typeof value.text === 'string' ? value.text : '';
}

function longOf(properties, name) {
  return textOf(properties, name, 'longText') || textOf(properties, name, 'shortText');
}

function numberOf(properties, name) {
  var value = shape(properties, name, 'numericValue');
  var n = value ? Number(value.value) : 0;
  return isFinite(n) && n > 0 ? int(n) : 0;
}

function flagOf(properties, name) {
  var value = shape(properties, name, 'boolean');
  return !!(value && value.value === true);
}

function secondsOf(properties, name) {
  var value = shape(properties, name, 'timestamp');
  var n = value ? Number(value.value) : 0;
  return isFinite(n) && n > 0 ? int(n) : 0;
}

function instancesOf(item) {
  var envelope = readings[item];
  return (envelope && Array.isArray(envelope.instances)) ? envelope.instances : [];
}

/** A pull request's colour: draft, then failing or changes requested, then waiting, then good. */
function prState(p) {
  if (flagOf(p, 'draft')) return STATE.DRAFT;
  var checks = textOf(p, 'checks');
  var review = textOf(p, 'review');
  if (flagOf(p, 'failing') || review === 'Changes requested') return STATE.BAD;
  if (flagOf(p, 'running') || checks === 'Running' || review === 'Review required') return STATE.PENDING;
  if (checks === 'Passing' || flagOf(p, 'approved')) return STATE.GOOD;
  return STATE.NONE;
}

/** owner/repo#n -> State, for the pull requests the plugin has told us about. */
function knownPrStates() {
  var states = {};
  ['review_request', 'pull_request'].forEach(function (item) {
    instancesOf(item).forEach(function (instance) {
      states[instance.instanceId] = prState(instance.properties || {});
    });
  });
  return states;
}

function notificationItem(instance, p, now, states) {
  var repo = textOf(p, 'repo');
  var number = numberOf(p, 'number');
  var kind = textOf(p, 'kind');
  var reason = textOf(p, 'reason');
  var group = GROUPS.indexOf(reason);
  if (group === -1) group = GROUP_OTHER;
  var key = repo + '#' + number;
  var state = number && states[key] !== undefined ? states[key] : group === GROUP_BUILDS ? STATE.BAD : STATE.NONE;
  var flags = FLAG.CAN_MARK;
  if (flagOf(p, 'unread')) flags |= FLAG.UNREAD;
  if (number && (kind === 'Pull request' || kind === 'Issue')) flags |= FLAG.CAN_COMMENT;
  var when = age(secondsOf(p, 'updated'), now);
  return {
    Sub: repo + (number ? ' #' + number : '') + (when ? ' · ' + when : ''),
    State: state,
    Flags: flags,
    Group: group,
    Text: lines([[reason, kind].filter(function (w) { return !!w; }).join(' · '), longOf(p, 'latest')])
  };
}

function prItem(kind, p) {
  var checks = textOf(p, 'checks');
  var first = kind === KIND.REVIEW
    ? [textOf(p, 'author') ? 'From ' + textOf(p, 'author') : '', checks]
    : [textOf(p, 'review'), checks];
  var flags = FLAG.CAN_COMMENT;
  if (flagOf(p, 'failing')) flags |= FLAG.CAN_RERUN;
  // Which checks: 'CI / test failed', 'Build / build running'. Passing ones go unnamed.
  var which = flagOf(p, 'failing') || flagOf(p, 'running') ? textOf(p, 'checks', 'longText') : '';
  return {
    Sub: textOf(p, 'repo') + ' #' + numberOf(p, 'number') + (checks ? ' · ' + checks : ''),
    State: prState(p),
    Flags: flags,
    Text: lines([first.filter(function (w) { return !!w; }).join(' · '), which, longOf(p, 'latest')])
  };
}

function buildItem(p) {
  var failing = flagOf(p, 'failing');
  var status = textOf(p, 'status');
  var state = failing ? STATE.BAD : flagOf(p, 'running') ? STATE.PENDING : status === 'Passing' ? STATE.GOOD : STATE.NONE;
  return {
    Sub: [textOf(p, 'branch'), status].filter(function (w) { return !!w; }).join(' · '),
    State: state,
    Flags: failing ? FLAG.CAN_RERUN : 0,
    Text: lines([textOf(p, 'status', 'longText'), longOf(p, 'commit'), textOf(p, 'updated')])
  };
}

/** One ITEM message (without its place in the batch). */
function item(kind, instance, now, states) {
  var p = instance.properties || {};
  var id = String(instance.instanceId || '');
  var title = kind === KIND.REPO ? textOf(p, 'name') || id : textOf(p, 'title') || longOf(p, 'title') || id;
  var parts;
  if (kind === KIND.NOTIFICATION) parts = notificationItem(instance, p, now, states);
  else if (kind === KIND.REVIEW || kind === KIND.PR) parts = prItem(kind, p);
  else if (kind === KIND.BUILD) parts = buildItem(p);
  else parts = { Sub: '', State: STATE.NONE, Flags: flagOf(p, 'issues') ? FLAG.DEFAULT : 0, Text: '' };
  // An id cut short would name nothing, so an item whose id doesn't fit can't be acted on.
  var idFits = utf8Length(id) <= LIMITS.id;
  var message = {
    Cmd: CMD.ITEM,
    Kind: kind,
    Id: idFits ? id : '',
    Title: fit(title, LIMITS.title),
    Sub: fit(parts.Sub, LIMITS.sub),
    State: parts.State,
    Flags: idFits ? parts.Flags : parts.Flags & (FLAG.UNREAD | FLAG.DEFAULT),
    Text: fit(parts.Text, LIMITS.text)
  };
  if (kind === KIND.NOTIFICATION) message.Group = parts.Group;
  return message;
}

/** The ITEM messages for one Kind, in the plugin's order; null until there's a reading. */
function batch(list, now) {
  if (signedOut) return [{ Cmd: CMD.ITEM, Kind: list.kind, Count: 0 }];
  if (!readings[list.item]) return null;
  var instances = instancesOf(list.item).slice(0, MAX_ITEMS[list.kind]);
  if (!instances.length) return [{ Cmd: CMD.ITEM, Kind: list.kind, Count: 0 }];
  var states = knownPrStates();
  return instances.map(function (instance, index) {
    var message = item(list.kind, instance, now, states);
    var placed = { Cmd: CMD.ITEM, Kind: list.kind, Index: index, Count: instances.length };
    Object.keys(message).forEach(function (key) { if (key !== 'Cmd' && key !== 'Kind') placed[key] = message[key]; });
    return placed;
  });
}

function summary() {
  if (signedOut) {
    return { Cmd: CMD.SUMMARY, Login: '', Unread: 0, Reviews: 0, Prs: 0, Failing: 0, Builds: 0, Broken: 0, Repo: '' };
  }
  // Wait for the repos too (they come from settings, so quickly): a summary saying there are no
  // builds and nowhere for issues would hide those rows on the watch, and the watch keeps it.
  if (!readings.inbox || (!readings.repo && !problems.repo)) return null;
  var p = (instancesOf('inbox')[0] || {}).properties || {};
  var builds = readings.build
    ? instancesOf('build').length
    : instancesOf('repo').filter(function (r) { return flagOf(r.properties, 'builds'); }).length;
  var issueRepo = instancesOf('repo').filter(function (r) { return flagOf(r.properties, 'issues'); })[0];
  return {
    Cmd: CMD.SUMMARY,
    Login: fit(textOf(p, 'login'), LIMITS.login),
    Unread: numberOf(p, 'unread'),
    Reviews: numberOf(p, 'reviews'),
    Prs: numberOf(p, 'pull_requests'),
    Failing: numberOf(p, 'failing'),
    Builds: Math.min(builds, MAX_ITEMS[KIND.BUILD]),
    Broken: numberOf(p, 'builds_failing'),
    Repo: issueRepo ? fit(issueRepo.instanceId, LIMITS.repo) : ''
  };
}

/** The plugin's message when it wrote one for people (they end in a full stop), else ours. */
function problemText(error) {
  var code = (error && error.code) || 'UNKNOWN';
  var message = String((error && error.message) || '');
  if (message.indexOf(code + ': ') === 0) message = message.slice(code.length + 2);
  if (/\.$/.test(message)) return message;
  if (code === 'PLUGIN_UNAVAILABLE') return 'Inbox for GitHub isn\'t answering on your phone. Try opening it again.';
  if (code === 'TIMEOUT') return 'Your phone is slow to answer. Try again.';
  if (code === 'RATE_LIMITED') return 'GitHub asked for a pause. Inbox for GitHub will try again.';
  if (code === 'AUTH_REQUIRED') return 'Sign in again in Inbox for GitHub\'s settings in the Pebble app.';
  return 'Couldn\'t read GitHub (' + code + ').';
}

function noticeText() {
  if (stuck) return stuck;
  if (signedOut) return '';
  for (var i = 0; i < ITEMS.length; i++) if (problems[ITEMS[i]]) return problems[ITEMS[i]];
  return '';
}

// ---------------------------------------------------------------- sending

function pump() {
  if (inFlight || !queue.length) return;
  inFlight = queue.shift();
  inFlight.attempts = 0;
  transmit(inFlight);
}

/** Whether a newer message has made this one pointless. */
function superseded(entry) {
  return entry.channel !== 'result' && channels[entry.channel].sending !== entry.sig;
}

function finished(entry, ok) {
  var channel = channels[entry.channel];
  if (channel && entry.sig === channel.sending) {
    if (ok && entry.last) channel.sent = entry.sig;
    if (!ok || entry.last) channel.sending = null;
    // Given up: the rest of this batch can't make a whole one now.
    if (!ok) queue = queue.filter(function (other) { return !(other.channel === entry.channel && other.sig === entry.sig); });
  }
  inFlight = null;
  pump();
}

function transmit(entry) {
  entry.attempts++;
  var settled = false;
  var watchdog = setTimeout(function () { settle(false); }, ANSWER_MS);
  function settle(ok) {
    if (settled) return;
    settled = true;
    clearTimeout(watchdog);
    if (ok || entry.attempts > RETRIES || superseded(entry)) {
      finished(entry, ok);
      return;
    }
    setTimeout(function () {
      if (superseded(entry)) finished(entry, false);
      else transmit(entry);
    }, RETRY_MS);
  }
  try {
    Pebble.sendAppMessage(entry.message, function () { settle(true); }, function () { settle(false); });
  } catch (e) {
    settle(false);
  }
}

function rankOf(channel) {
  return RANKS[channel] !== undefined ? RANKS[channel] : 3;
}

/** Puts a channel's messages on the queue, replacing what's left of its older ones. */
function post(channel, messages, force) {
  composed[channel] = messages;
  var sig = JSON.stringify(messages);
  var state = channels[channel] || (channels[channel] = { sent: null, sending: null });
  if (!force && (sig === state.sent || sig === state.sending)) return;
  state.sending = sig;
  queue = queue.filter(function (entry) { return entry.channel !== channel; });
  messages.forEach(function (message, i) {
    queue.push({ channel: channel, message: message, sig: sig, last: i === messages.length - 1, rank: rankOf(channel), seq: seq++ });
  });
  queue.sort(function (a, b) { return a.rank - b.rank || a.seq - b.seq; });
  pump();
}

/** A RESULT for the watch, ahead of anything waiting. */
function result(act, ok, text) {
  var message = { Cmd: CMD.RESULT, Act: int(act), Ok: ok ? 1 : 0, Notice: fit(text, LIMITS.notice) };
  queue.push({ channel: 'result', message: message, sig: 'result' + seq, last: true, rank: RANKS.result, seq: seq++ });
  queue.sort(function (a, b) { return a.rank - b.rank || a.seq - b.seq; });
  pump();
}

// The watch starts with no notice, so '' needs no sending until there's been another.
channels.notice = { sent: JSON.stringify([{ Cmd: CMD.NOTICE, Notice: '' }]), sending: null };

/**
 * Sends what changed. `lists` are the Kinds whose readings are new; the others keep the
 * messages they were composed with (and their ages), so a reading of one source doesn't resend
 * every list. Notifications are composed again when the pull requests' states change, since
 * they take their colour from them.
 */
function update(lists) {
  var now = Date.now();
  var top = summary();
  if (top) post('summary', [top]);
  var states = JSON.stringify(knownPrStates());
  if (states !== prStates) {
    prStates = states;
    if (lists.indexOf(KIND.NOTIFICATION) === -1) lists = lists.concat([KIND.NOTIFICATION]);
  }
  LISTS.forEach(function (list) {
    if (lists.indexOf(list.kind) === -1 && composed['items' + list.kind]) return;
    var messages = batch(list, now);
    if (messages) post('items' + list.kind, messages);
  });
  // The time dates the summary and lists, so it goes once there's a summary, and after them.
  var updated = secondsOf(((instancesOf('inbox')[0] || {}).properties) || {}, 'updated');
  if (updated && top && !signedOut) post('time', [{ Cmd: CMD.TIME, Updated: updated }]);
  post('notice', [{ Cmd: CMD.NOTICE, Notice: fit(noticeText(), LIMITS.notice) }]);
}

function kindOfItem(name) {
  var list = LISTS.filter(function (l) { return l.item === name; })[0];
  return list ? [list.kind] : [];
}

// ---------------------------------------------------------------- the plugin's answers

function onData(name, envelope) {
  readings[name] = envelope;
  problems[name] = '';
  if (signedOut) {
    // Signed in (or the demo switched on): every list starts again from what arrives.
    signedOut = false;
    LISTS.forEach(function (list) { if (!readings[list.item]) delete composed['items' + list.kind]; });
    update(LISTS.map(function (l) { return l.kind; }));
    return;
  }
  update(kindOfItem(name));
}

function onError(name, error) {
  if (error && error.code === 'NOT_CONFIGURED') {
    // Nobody is signed in: the watch shows its own sign-in message, with nothing behind it.
    var already = signedOut;
    signedOut = true;
    readings = {};
    problems = {};
    update(already ? [] : LISTS.map(function (l) { return l.kind; }));
    return;
  }
  problems[name] = problemText(error);
  update([]);
}

function subscribe() {
  if (typeof Pebble.subscribeToSource !== 'function' || typeof Pebble.invokeAction !== 'function') {
    stuck = UPDATE_APP;
    update([]);
    return;
  }
  ITEMS.forEach(function (name) {
    try {
      Pebble.subscribeToSource({
        category: 'code',
        item: name,
        plugin: PLUGIN_UUID,
        onData: function (envelope) { onData(name, envelope); },
        onError: function (error) { onError(name, error); }
      });
    } catch (e) {
      onError(name, { code: 'PLUGIN_UNAVAILABLE', message: String(e) });
    }
  });
}

// ---------------------------------------------------------------- what the watch asks

function invoke(action, args) {
  try {
    return Promise.resolve(Pebble.invokeAction({ plugin: PLUGIN_UUID, action: action, args: args, timeoutMs: ACTION_TIMEOUT_MS }))
      .then(function (answer) { return answer || { ok: false, code: 'UNKNOWN' }; })
      .catch(function (e) { return { ok: false, code: 'UNKNOWN', message: String(e) }; });
  } catch (e) {
    return Promise.resolve({ ok: false, code: 'UNKNOWN', message: String(e) });
  }
}

/** An ACT as the plugin's action and its arguments, or { problem } when it can't be one. */
function actionFor(act, id, text, repo) {
  switch (act) {
    case ACT.MARK_READ:
    case ACT.MARK_DONE:
      if (!id) return { problem: 'That notification has no id.' };
      return { action: act === ACT.MARK_READ ? 'mark_read' : 'mark_done', args: { instanceId: id } };
    case ACT.MARK_ALL_READ:
      return { action: 'mark_all_read', args: {} };
    case ACT.RERUN:
      if (!id) return { problem: 'That has no id to rerun.' };
      return { action: 'rerun_failed', args: { instanceId: id } };
    case ACT.COMMENT:
      if (!id) return { problem: 'That has no id to reply to.' };
      if (!text) return { problem: 'Nothing was said.' };
      return { action: 'comment', args: { instanceId: id, text: text } };
    case ACT.NEW_ISSUE: {
      if (!text) return { problem: 'Nothing was said.' };
      var args = issueArgs(text);
      if (repo) args.repo = repo;
      return { action: 'new_issue', args: args };
    }
    case ACT.REFRESH:
      return { action: 'refresh', args: {} };
    default:
      return { problem: 'The watch asked for something this phone app doesn\'t know.' };
  }
}

function run(act, id, text, repo) {
  if (typeof Pebble.invokeAction !== 'function') {
    result(act, false, UPDATE_APP);
    return;
  }
  var call = actionFor(act, id, text, repo);
  if (call.problem) {
    result(act, false, call.problem);
    return;
  }
  invoke(call.action, call.args).then(function (answer) {
    if (answer.ok) result(act, true, answer.text || 'Done');
    else result(act, false, problemText(answer));
  });
}

function field(payload, name) {
  return payload[name] !== undefined ? payload[name] : payload[KEYS[name]];
}

function stringField(payload, name) {
  var value = field(payload, name);
  return value === undefined || value === null ? '' : String(value).trim();
}

Pebble.addEventListener('ready', function () {
  subscribe();
});

Pebble.addEventListener('appmessage', function (e) {
  var payload = (e && e.payload) || {};
  switch (Number(field(payload, 'Cmd'))) {
    case CMD.HELLO:
      // The summary first: it's what Home shows.
      ['summary', 'notice', 'items1', 'items2', 'items3', 'items4', 'items5', 'time'].forEach(function (channel) {
        if (!composed[channel] || (channel === 'notice' && !noticeText())) return;
        post(channel, composed[channel], true);
      });
      break;
    case CMD.ACT:
      run(int(field(payload, 'Act')), stringField(payload, 'Id'), stringField(payload, 'Text'), stringField(payload, 'Repo'));
      break;
  }
});
