# Inbox for GitHub — design

A Pebble watch app with its own plugin in one pbw (like London Lines and BBC Headlines): your
GitHub inbox on the watch, and the same readings for any watchface that reads plugins.
**Unofficial: not made by or affiliated with GitHub.** No GitHub logo anywhere (GitHub's brand
rules: brand.github.com/foundations/logo); the icon is a plain inbox tray.

Decisions (2026-11-20):
- Name **Inbox for GitHub**, kept clear of GitHub's "don't suggest you are GitHub" rule: the
  store text and settings say unofficial, and no GitHub logo is used.
- Sign-in: **paste a classic personal access token** (scopes `notifications` + `repo`). GitHub's
  docs say the notifications API works only with a classic PAT. A device-code sign-in is built
  behind `CLIENT_ID` in `src/plugin/index.js`, **off while it is ''** — it needs an OAuth app
  registered (device flow enabled) and a check that its token reads notifications.
- Watches: **basalt, chalk, diorite, emery, flint, gabbro** (no aplite: no mic, 24 KB).
- Actions: **mark read / done, mark all read, rerun failed jobs (hold to confirm), reply by
  voice, new issue by voice.** No approving PRs, no workflow dispatch.

## Pieces

| File | What |
|---|---|
| `src/plugin/index.js` | The plugin: every GitHub call, the token, caching, sources, actions, settings-page handler. Runs on the phone only. |
| `src/pkjs/index.js` | The watch app's phone half: subscribes to this pbw's own plugin, turns readings into AppMessages, runs actions for the watch with `Pebble.invokeAction`. Never talks to GitHub itself. |
| `src/config.html` | Bundled settings page; talks only to the plugin (`Pebble.sendMessage('plugin', msg)`). |
| `src/c/*` | The watch app. |
| `test/` | Node tests: plugin (fake GitHub), app JS (fake plugin), shape validation (`test/lib/*.cjs` copied from London Lines). |

The token lives only in the plugin's localStorage on the phone (`Pebble.secureStorage` exists in
pypkjs but can't be checked in the real app yet). It is never sent to the watch,
never shown back in full in settings (only `ghp_…abcd`), never logged.

## GitHub calls (plugin)

- REST `https://api.github.com`, headers `Authorization: Bearer <token>`,
  `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`,
  `User-Agent: Inbox-for-GitHub-Pebble`.
- **Notifications**: `GET /notifications?all=true&per_page=15&since=<local midnight 3 days ago>`
  (`&participating=true` if the setting is on). Read ones are fetched too, so "Mark read" keeps a
  row (without its unread dot) and only "Done" removes it; unread first, then read, each newest
  first. `since` only changes at midnight, so If-Modified-Since keeps working. `inbox.unread`
  counts unread ones only ("15+" when all 15 fetched are unread and there's a next page). A read
  or done mark beats GitHub's list for 5 minutes, so a lagging list doesn't bring a row back. Send `If-Modified-Since: <last Last-Modified>`; a 304 costs no rate limit — keep the cached
  list. Obey `X-Poll-Interval` (seconds, usually 60) as the minimum gap. If headers can't be read
  (host limits), fall back to a 60 s minimum. For each thread whose `updated_at` changed, fetch
  `subject.latest_comment_url` (if any) for author + body (cache by url+updated_at; at most 5
  fetches per read; the rest show without a comment until next read).
  Reasons → group: `review_requested`→Review requested; `mention`,`team_mention`→Mentioned;
  `assign`→Assigned; `ci_activity`→Builds; everything else→Other. The `reason` property carries
  the group's words, and the phone maps them back to Group.
  Subject types → kind: PullRequest→Pull request, Issue→Issue, Release→Release,
  Discussion→Discussion, CheckSuite→Build, Commit→Commit, else the type.
  Number = trailing digits of `subject.url` when it is an issues/pulls URL.
- **One GraphQL query** (`POST /graphql`) for reviews, my PRs, builds and the login, at most
  every 2 minutes:
  - `viewer { login }`
  - `reviews: search(query: "is:open is:pr review-requested:@me archived:false sort:updated-desc", type: ISSUE, first: 8)`
  - `mine: search(query: "is:open is:pr author:@me archived:false sort:updated-desc", type: ISSUE, first: 8)`
  - per PR: `number title url isDraft updatedAt reviewDecision author{login} repository{nameWithOwner}`
    `commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:30){...}}}}}` — the
    contexts (Actions jobs and commit statuses) name the failing/running checks for
    `checks.longText` ("CI / test, lint failed"; up to four names, then "and N more"; cancelled
    isn't failed). The rerun action reads the check suites' workflow runs itself.
    The latest comment/review for `latest` (`comments(last:1){nodes{author{login} bodyText createdAt}}`,
    `latestReviews(last:1){nodes{author{login} state bodyText submittedAt}}` — the newer wins;
    `latest` reads "sam-lee: Looks good…", or "sam-lee approved" for a review with no text).
  - per chosen build repo (aliases `b0`..`b5`): `repository(owner:, name:) { nameWithOwner defaultBranchRef { name target { ... on Commit { messageHeadline committedDate statusCheckRollup{state} checkSuites(last:20){nodes{status conclusion workflowRun{databaseId workflow{name}}}} } } } }`
  - Rollup state → checks: SUCCESS→Passing, FAILURE/ERROR→Failing, PENDING/EXPECTED→Running,
    none→No checks. reviewDecision → review: APPROVED→Approved, CHANGES_REQUESTED→Changes
    requested, REVIEW_REQUIRED→Review required, null→No review.
- **Contributions**: a separate GraphQL query, at most every 30 minutes:
  `viewer { contributionsCollection { contributionCalendar { totalContributions weeks { contributionDays { date contributionCount } } } } }`.
  today = last day; streak = consecutive days with >0 ending today (or yesterday if today is 0 —
  a streak isn't broken until the day is over); week = last 7 days; daily = last 14 days.
- **Actions**:
  - mark_read: `PATCH /notifications/threads/{id}` (205). mark_done: `DELETE /notifications/threads/{id}` (204).
  - mark_all_read: `PUT /notifications` body `{"read": true}` (202/205).
  - rerun_failed: re-read the PR/branch head's check suites; for each failed suite with a
    `workflowRun.databaseId`, `POST /repos/{o}/{r}/actions/runs/{id}/rerun-failed-jobs` (201).
    Text: "Rerunning 2 failed jobs' runs" / "Nothing has failed".
  - comment: notification id → its subject's owner/repo + number (from the cached list; an
    `owner/repo#n` id is used as it is); `POST /repos/{o}/{r}/issues/{n}/comments` `{body}`.
  - new_issue: repo = args.repo (must be one of code/repo) or the settings' issue repo.
    Dictated text: title = first sentence, cut at 80 characters at a word; body = the rest (or
    the whole text when it was cut). `POST /repos/{o}/{r}/issues` `{title, body}`. Text answer
    includes `#<number>`.
  - refresh: forget the cache times, then `Pebble.refreshSources(all)`.
  - Every action answers `respond.ok({ text, refreshed: [...] })` or `respond.error(code, msg)`.
    After a write, clear the cache times of what it changed so the refresh shows it.
- **Errors**: 401 → "Token rejected. Paste a new one in settings." 403 with
  `X-RateLimit-Remaining: 0` → RATE_LIMITED. 403 on notifications with a fine-grained token
  (`github_pat_`) → "Notifications need a classic token". Network → PLUGIN_UNAVAILABLE. Keep
  the last good answer and serve it (with its time) for up to 6 hours, as London Lines does.
- **No token** → every source answers `respond.error('NOT_CONFIGURED', 'Sign in to GitHub in Inbox for GitHub's settings.')`
  unless demo mode is on.
- **Demo mode** (`settings.demo`): sources serve `DEMO` data (fictional users/repos: `sam-lee`,
  `acme/website`, `acme/api`, `notes-app`; never real people or real data) built relative to now;
  actions change the demo state in localStorage and answer like the real ones ("Demo: …").
  Used for the store screenshots, emulator tests and trying the app without a token.

## Plugin sources (category `code`)

As declared in package.json. Ordering:
- notification: unread first, then by updated desc; at most 15.
- review_request / pull_request: failing first, then updated desc; at most 8 each.
- build: settings order; failing ones first. At most 6 repos.
- repo: settings order; at most 6.
`shortText` stays short (≤ ~7 chars where it's a number-like value: "12", "3 open" is fine as
shortText of a count). `updated.shortText` = "HH:MM" in the phone's clock style (24h default).

## Settings page

Sections: **Account** (token box + Save; link to
`https://github.com/settings/tokens/new?scopes=notifications,repo&description=Inbox%20for%20Pebble`;
shows "Signed in as @login", the token's scopes from `X-OAuth-Scopes`, warnings: fine-grained
token → notifications won't work; no `repo` → private repos and reruns won't work; Sign out),
**Inbox** (only notifications I'm part of — `participating`, default off),
**Repositories** (the user's 30 most recently pushed repos via `GET /user/repos?sort=pushed&per_page=30`,
each with a Builds switch (max 6) and a radio for "New issues go here"),
**Demo** (show demo data), **About** ("Unofficial. Not made by or affiliated with GitHub.
GitHub is a trademark of GitHub, Inc.").
Device-code sign-in appears only when `CLIENT_ID` is set.

## Watch protocol (AppMessage; keys in package.json `messageKeys`)

Cmd values (same numbers in `src/c/inbox.h` and `src/pkjs/index.js`):

| Cmd | Dir | Keys |
|---|---|---|
| 1 HELLO | watch→phone | — (send everything again) |
| 2 SUMMARY | phone→watch | Login (str, '' = not signed in and not demo), Unread, Reviews, Prs, Failing (my PRs failing), Builds (watched repos), Broken (builds failing), Repo (issue repo, '' none) |
| 3 ITEM | phone→watch | Kind, Index, Count, Id, Title, Sub, State, Flags, Group, Text. Index 0 starts a batch for that Kind; the watch shows a Kind's batch once whole. Count 0 (no Index) = empty list for that Kind. |
| 4 TIME | phone→watch | Updated (epoch s, latest of the readings) |
| 5 NOTICE | phone→watch | Notice ('' clears) |
| 6 RESULT | phone→watch | Act (echo), Ok (1/0), Notice (what happened, ≤ 159 bytes) |
| 7 ACT | watch→phone | Act, Id (instance id; '' for MARK_ALL/NEW_ISSUE/REFRESH), Text (dictation, ≤ 400 bytes), Repo (NEW_ISSUE) |

Kind: 1 NOTIFICATION, 2 REVIEW, 3 PR, 4 BUILD, 5 REPO (issue targets: Title = owner/repo,
Flags bit 16 = default).
Act: 1 MARK_READ, 2 MARK_DONE, 3 MARK_ALL_READ, 4 RERUN, 5 COMMENT, 6 NEW_ISSUE, 7 REFRESH.
State: 0 NONE (grey), 1 GOOD (green: passing/approved), 2 PENDING (amber: running/review
required), 3 BAD (red: failing/changes requested), 4 DRAFT (grey, hollow).
For a notification: the State of its pull request when that PR is in the review or my-PR lists;
a ci_activity one is BAD; else NONE. PR/review State, first match wins: DRAFT; BAD (failing or
changes requested); PENDING (running or review required); GOOD (passing or approved).
Flags: 1 UNREAD, 2 CAN_RERUN, 4 CAN_COMMENT, 8 CAN_MARK, 16 DEFAULT.
Group (notifications only): 0 Review requested, 1 Mentioned, 2 Assigned, 3 Builds, 4 Other.

Limits (UTF-8 bytes without NUL; the phone cuts at a word with "…"): Id 127, Title 100,
Sub 47, Text 280, Notice 159, Login 39, Repo 100. Lists: NOTIFICATION 15, REVIEW 8, PR 8,
BUILD 6, REPO 6.

Sub (composed by the phone): notification "acme/api #42 · 3h"; PR/review "acme/api #42 ·
Failing"; build "main · Passing"; repo "" . Ages: "now", "5m", "3h", "2d", "Nov 3".
Text (composed by the phone, \n-separated lines): notification "Review requested · Pull
request\nsam-lee: Looks good, one nit on the retry loop…"; PR "Changes requested · Failing\n
CI / test failed\nsam-lee: …"; review "From sam-lee · Running\n…"; build "CI failed on main\n
Fix the cache key\n14:02".

Sending: one message in flight; next on ack; nack/timeout retried 3× a second apart (London
Lines' queue). A newer batch of a Kind replaces what's left of the older one.
INBOX 1024, OUTBOX 576 on the watch (an ACT with a 127-byte Id and 400 bytes of dictation needs 560).

## Watch app

- **Home** (MenuLayer under a header band "INBOX" + "@login" or the update time): rows
  Notifications ("12 unread" / "All read"), Reviews ("3 waiting" / "None waiting"),
  My pull requests ("4 open · 1 failing"), Builds ("2 repos · 1 failing"; hidden when no repos),
  New issue ("to acme/api"; hidden when no issue repo or no mic), Refresh. A coloured count
  badge on the right of each row (red when something is failing). Not signed in (Login '' and no
  data) → a message window: "Sign in to GitHub in the Pebble app: Inbox for GitHub › Settings."
  Notice shows under the header when set.
- **List** (MenuLayer): one per Kind. Notifications in sections by Group (headers drawn centred on
  round), unread rows get a dot, a final row "Mark all read" (hold Select to confirm). Rows: Title
  (bold, clipped) + Sub; a state mark on the left: ✓ GOOD (green), ✗ BAD (red), ● PENDING
  (amber), ○ NONE, dashed ○ DRAFT. On B&W the marks are the shapes alone.
  Empty list → "Nothing here" centred.
- **Detail** (ScrollLayer): band coloured by State, labelled with the kind (or the notification's
  group) over the end of Sub after its last " · " ("Failing", "5m"); the rest of Sub
  ("acme/api #145") goes under the Title, which is wrapped in full; then Text.
  Select → ActionMenu with what Flags allow: Mark read (unread items only), Done, Reply by voice,
  Rerun failed jobs. A successful mark read / done / mark all read changes the watch at once.
  Rerun → confirm window "Rerun failed jobs on acme/api #42? Hold Select" (long click sends).
- **Reply / New issue**: DictationSession with the built-in confirmation; New issue first picks a
  repo when there's more than one (Kind REPO list; it sends the repo item's Id). Then "Sending…", then the RESULT's Notice for
  3 s with a short vibe (double on failure). Dictation unavailable → "Dictation isn't available".
- **Touch** (emery, gabbro): `app_touch_navigation_enable(true)` as London Lines does.
- Debug flags (wscript DEFINES from env; any of them adds "DEBUG" to every band; never published):
  `IFG_FAKE_DICTATION="text"` returns that transcript instead of opening dictation;
  `IFG_NOJS=1` bundles no phone JS, so `tools/send.py` (a fake phone) owns the watch.
- Saved across launches: SUMMARY and the last update time (persist key 1), so Home opens with
  numbers and "UPDATED hh:mm" at once. The band says "NO PHONE" while the phone is away.
- Redraw once a minute (ages, "updated" time); a HELLO the phone missed is resent on that tick.
  The only other timer is a one-shot while an action runs (30 s for the phone's answer, then the
  3 s result). No accel, no animation.

## Testing

- `npm test`: Node tests, no network (fake fetch for GitHub; fake plugin host for the app JS).
- `npm run hostcheck` / `appcheck`: pypkjs (quickjs-ng), no emulator; seed demo mode with
  `--storage adb4f7c0-171e-48a0-911a-2caa057949f9 settings.v1 '{"demo":true}'`.
- Emulators: install, then drive with `pebble emu-button`, capture with `tools/shot.py`.
  `tools/send.py` (pebble-tool's Python) plays the phone: a fixture inbox, `empty`, `signout`,
  `notice`, `result`, and `phone` which answers HELLO and ACT.
