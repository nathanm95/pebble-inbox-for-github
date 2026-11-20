// A stand-in for api.github.com and github.com, as the plugin's `fetch` sees them: REST
// notifications (with Last-Modified, If-Modified-Since and 304, X-Poll-Interval, Link), the
// latest-comment URLs, GraphQL (the inbox query, contributions, the rerun re-reads), /user with
// X-OAuth-Scopes, /user/repos, and the write endpoints the actions use. Every request is kept in
// `requests` so tests can see what was asked, how, and with which headers.
//
// Knobs, all plain properties a test can change between requests:
//   online            false fails every request like no signal
//   headers           false answers with no readable headers (as some hosts may)
//   token             the token GitHub accepts; anything else is a 401
//   rateLimited       { reset } answers 403 with X-RateLimit-Remaining: 0 until switched off
//   fail              { 'GET /notifications': 500, ... } answers that status for a route
//   pollInterval      X-Poll-Interval, seconds
//   more              true adds a rel="next" Link to the notifications
//   lastModified      the inbox's Last-Modified; change it to make the next GET a 200
//   scopes            X-OAuth-Scopes on /user (null: no header, like a fine-grained token)
//   markAllStatus     205, or 202 when GitHub carries on in the background
//   lag               true: marks and deletes are taken but the list doesn't show them yet
//
// Like GitHub, notifications are unread ones only unless all=true, and none older than since.

const fs = require('node:fs');
const path = require('node:path');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
const API = 'https://api.github.com';
const WEB = 'https://github.com';
// Made up, in the classic token's shape, and plainly not a real one.
const TOKEN = 'ghp_' + 'FakeTokenForTestsOnly' + '0'.repeat(11) + 'abcd';

class FakeGitHub {
  constructor(overrides = {}) {
    this.notifications = load('notifications.json');
    this.comments = load('comments.json');
    const graphql = load('graphql.json');
    this.graph = graphql.graph;
    this.builds = graphql.builds;
    this.contributions = load('graphql-contributions.json');
    this.repos = load('user-repos.json');
    this.online = true;
    this.headers = true;
    this.token = TOKEN;
    this.login = 'alex-kim';
    this.scopes = 'notifications, repo';
    this.rateLimited = null;
    this.fail = {};
    this.pollInterval = 60;
    this.more = false;
    this.lastModified = 'Fri, 20 Nov 2026 13:50:00 GMT';
    this.markAllStatus = 205;
    this.nextIssue = 131;
    this.device = { pending: 1, token: 'gho_' + 'FakeDeviceFlowToken' + '0'.repeat(13) + 'wxyz' };
    this.requests = [];
    Object.assign(this, overrides);
    this.fetch = this.fetch.bind(this);
  }

  /** The requests made, as 'METHOD path' (query kept, host dropped for the API). */
  calls() {
    return this.requests.map((r) => r.method + ' ' + r.url.replace(API, ''));
  }

  graphqlQueries() {
    return this.requests.filter((r) => r.url === API + '/graphql').map((r) => JSON.parse(r.body).query);
  }

  reset() {
    this.requests = [];
  }

  respond(status, body, headers = {}) {
    const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const response = {
      status,
      ok: status >= 200 && status < 300,
      text: async () => text,
      json: async () => JSON.parse(text),
    };
    if (this.headers) {
      const lower = {};
      for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
      response.headers = { get: (name) => (Object.prototype.hasOwnProperty.call(lower, name.toLowerCase()) ? lower[name.toLowerCase()] : null) };
    }
    return response;
  }

  async fetch(url, init = {}) {
    const method = (init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    this.requests.push({ method, url, headers, body: init.body });
    if (!this.online) throw new TypeError('fetch failed: ' + url);
    const route = method + ' ' + url.replace(API, '').replace(WEB, 'web:').split('?')[0];
    for (const [pattern, status] of Object.entries(this.fail)) {
      if (route === pattern || route.startsWith(pattern + '/')) return this.respond(status, { message: 'Server Error' });
    }
    if (url.startsWith(WEB + '/')) return this.web(method, url, init);
    if (!url.startsWith(API + '/')) throw new TypeError('fetch failed: not GitHub: ' + url);
    if (headers.Authorization !== 'Bearer ' + this.token) {
      return this.respond(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' });
    }
    if (this.rateLimited) {
      return this.respond(403, { message: 'API rate limit exceeded for user ID 1.' }, {
        'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': String(this.rateLimited.reset),
      });
    }
    return this.api(method, url, init, headers);
  }

  api(method, url, init, headers) {
    const where = url.slice(API.length);
    const pathOnly = where.split('?')[0];
    const body = init.body ? JSON.parse(init.body) : null;
    if (method === 'GET' && pathOnly === '/notifications') {
      if (this.token.startsWith('github_pat_')) {
        return this.respond(403, { message: 'Resource not accessible by personal access token' });
      }
      if (headers['If-Modified-Since'] && headers['If-Modified-Since'] === this.lastModified) {
        return this.respond(304, undefined, { 'Last-Modified': this.lastModified, 'X-Poll-Interval': this.pollInterval });
      }
      const query = new URLSearchParams(where.split('?')[1] || '');
      const since = query.get('since') ? Date.parse(query.get('since')) : 0;
      const list = this.notifications
        .filter((n) => query.get('all') === 'true' || n.unread)
        .filter((n) => Date.parse(n.updated_at) >= since);
      const extra = this.more ? { Link: `<${API}/notifications?per_page=15&page=2>; rel="next", <${API}/notifications?per_page=15&page=3>; rel="last"` } : {};
      return this.respond(200, list, { 'Last-Modified': this.lastModified, 'X-Poll-Interval': this.pollInterval, ...extra });
    }
    if (method === 'GET' && this.comments[url]) return this.respond(200, this.comments[url]);
    if (method === 'POST' && pathOnly === '/graphql') return this.graphql(body.query);
    if (method === 'GET' && pathOnly === '/user') {
      return this.respond(200, { login: this.login, id: 1 }, this.scopes === null ? {} : { 'X-OAuth-Scopes': this.scopes });
    }
    if (method === 'GET' && pathOnly === '/user/repos') return this.respond(200, this.repos);
    let m;
    if ((m = /^\/notifications\/threads\/(\d+)$/.exec(pathOnly))) {
      if (!this.notifications.some((n) => n.id === m[1])) return this.respond(404, { message: 'Not Found' });
      if (method === 'PATCH') {
        this.changed((list) => list.map((n) => (n.id === m[1] ? { ...n, unread: false } : n)));
        return this.respond(205);
      }
      if (method === 'DELETE') {
        this.changed((list) => list.filter((n) => n.id !== m[1]));
        return this.respond(204);
      }
    }
    if (method === 'PUT' && pathOnly === '/notifications') {
      this.changed((list) => list.map((n) => ({ ...n, unread: false })));
    }
    if (method === 'PUT' && pathOnly === '/notifications') return this.respond(this.markAllStatus, this.markAllStatus === 202 ? { message: 'Unread notifications couldn\'t be marked in a single request. Notifications are being marked as read in the background.' } : undefined);
    if (method === 'POST' && (m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(pathOnly))) {
      return this.respond(201, {});
    }
    if (method === 'POST' && (m = /^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/.exec(pathOnly))) {
      return this.respond(201, { id: 9999, body: body.body, user: { login: this.login } });
    }
    if (method === 'POST' && (m = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(pathOnly))) {
      if (m[1] === 'acme/no-issues') return this.respond(410, { message: 'Issues are disabled for this repo' });
      return this.respond(201, { number: this.nextIssue++, title: body.title, body: body.body });
    }
    return this.respond(404, { message: 'Not Found' });
  }

  /** A write to the inbox: the list changes, and so does its Last-Modified (unless lagging). */
  changed(change) {
    if (this.lag) return;
    this.notifications = change(this.notifications);
    this.lastModified = 'Fri, 20 Nov 2026 14:0' + (this.writes = (this.writes || 0) + 1) + ':00 GMT';
  }

  graphql(query) {
    if (query.includes('contributionsCollection')) return this.respond(200, this.contributions);
    let m;
    if ((m = /repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ pullRequest\(number: (\d+)\)/.exec(query))) {
      const pr = [...this.graph.reviews.nodes, ...this.graph.mine.nodes].find((p) => p.repository.nameWithOwner === m[1] + '/' + m[2] && p.number === Number(m[3]));
      if (!pr) return this.respond(200, { data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest with the number of ' + m[3] + '.' }] });
      return this.respond(200, { data: { repository: { pullRequest: { commits: pr.commits } } } });
    }
    if ((m = /^query \{ repository\(owner: "([^"]+)", name: "([^"]+)"\) \{ defaultBranchRef/.exec(query))) {
      const build = this.builds[m[1] + '/' + m[2]];
      if (!build) return this.respond(200, { data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository.' }] });
      return this.respond(200, { data: { repository: { defaultBranchRef: { target: { checkSuites: build.defaultBranchRef.target.checkSuites } } } } });
    }
    const data = { viewer: { login: this.login }, reviews: this.graph.reviews, mine: this.graph.mine };
    const errors = [];
    for (const [, alias, owner, name] of query.matchAll(/(b\d+): repository\(owner: "([^"]+)", name: "([^"]+)"\)/g)) {
      data[alias] = this.builds[owner + '/' + name] || null;
      if (!data[alias]) errors.push({ type: 'NOT_FOUND', path: [alias], message: `Could not resolve to a Repository with the name '${owner}/${name}'.` });
    }
    return this.respond(200, errors.length ? { data, errors } : { data });
  }

  web(method, url, init) {
    const form = Object.fromEntries(String(init.body || '').split('&').filter(Boolean).map((p) => p.split('=').map(decodeURIComponent)));
    if (method === 'POST' && url === WEB + '/login/device/code') {
      return this.respond(200, { device_code: 'dc-123', user_code: 'WDJB-MJHT', verification_uri: WEB + '/login/device', expires_in: 900, interval: 5 });
    }
    if (method === 'POST' && url === WEB + '/login/oauth/access_token') {
      if (form.device_code !== 'dc-123') return this.respond(200, { error: 'incorrect_device_code' });
      if (this.device.pending > 0) {
        this.device.pending--;
        return this.respond(200, { error: 'authorization_pending' });
      }
      this.token = this.device.token;
      return this.respond(200, { access_token: this.device.token, token_type: 'bearer', scope: 'notifications,repo' });
    }
    return this.respond(404, 'Not Found');
  }
}

module.exports = { FakeGitHub, TOKEN, API };
