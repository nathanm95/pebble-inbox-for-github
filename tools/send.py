#!/usr/bin/env python3
"""Talk to the watch app on a running emulator as the phone would (DESIGN.md "Watch protocol"),
without the phone's JavaScript. Needs pebble-tool's Python (libpebble2), and a build (message key
ids come from build/js/message_keys.json):

    PY=~/.local/share/uv/tools/pebble-tool/bin/python
    $PY tools/send.py [--platform gabbro] fixture        # a whole inbox: every Kind, State, Flag, Group
    $PY tools/send.py empty                               # signed in, nothing anywhere
    $PY tools/send.py signout                             # Login '' and nothing to show
    $PY tools/send.py notice "GitHub is slow to answer"   # '' clears it
    $PY tools/send.py time now-900                        # when GitHub was read
    $PY tools/send.py result 1 1 "Marked read"            # Act Ok Notice
    $PY tools/send.py raw Cmd=5 Notice=hello              # any keys
    $PY tools/send.py phone [secs] [--fail] [--delay n] [--silent]
                                                          # be the phone: HELLO -> the fixture,
                                                          # ACT -> a RESULT n s later (1 s; Ok=0
                                                          # with --fail; none with --silent)

Values in `raw`: integers (and now, now-600) go as Int32, anything else as a string; s:text
forces a string. Elsewhere ids, titles and the rest are always strings. Every message waits for the watch's ack before the next, like the phone's queue
(a nack or no answer is retried up to 3 times, a second apart).

For a fixture to stay put, build with IFG_NOJS=1 so the real phone JavaScript isn't bundled
(it would answer HELLO with what the plugin has). Everything here is made up: fictional users
(sam-lee, mia-chen, jo-park) and repositories (acme/api, acme/website, jo-park/notes-app).
"""
import json
import os
import re
import subprocess
import sys
import time
import uuid

from libpebble2.communication import PebbleConnection
from libpebble2.communication.transports.websocket import WebsocketTransport
from libpebble2.services.appmessage import AppMessageService, CString, Int32

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
APP = uuid.UUID(json.load(open(os.path.join(ROOT, 'package.json')))['pebble']['uuid'])
KEYS = json.load(open(os.path.join(ROOT, 'build', 'js', 'message_keys.json')))
NAMES = {v: k for k, v in KEYS.items()}

CMD = {'HELLO': 1, 'SUMMARY': 2, 'ITEM': 3, 'TIME': 4, 'NOTICE': 5, 'RESULT': 6, 'ACT': 7}
KIND = {'NOTIFICATION': 1, 'REVIEW': 2, 'PR': 3, 'BUILD': 4, 'REPO': 5}
ACT_NAMES = {1: 'MARK_READ', 2: 'MARK_DONE', 3: 'MARK_ALL_READ', 4: 'RERUN', 5: 'COMMENT',
             6: 'NEW_ISSUE', 7: 'REFRESH'}
NONE, GOOD, PENDING, BAD, DRAFT = range(5)
UNREAD, CAN_RERUN, CAN_COMMENT, CAN_MARK, DEFAULT = 1, 2, 4, 8, 16
G_REVIEW, G_MENTIONED, G_ASSIGNED, G_BUILDS, G_OTHER = range(5)

# ---------------------------------------------------------------- the fixture inbox

SUMMARY = dict(Login='jo-park', Unread=6, Reviews=3, Prs=4, Failing=1, Builds=3, Broken=1,
               Repo='acme/api')

# (Id, Title, Sub, State, Flags, Group, Text)
NOTIFICATIONS = [
    ('9001001', 'Retry the upload when the access token expires mid-request', 'acme/api #142 · 5m',
     PENDING, UNREAD | CAN_COMMENT | CAN_MARK, G_REVIEW,
     'Review requested · Pull request\nsam-lee: Ready for another look. I moved the retry into '
     'the client, so the worker stays simple.'),
    ('9001002', 'Login page takes six seconds on slow connections', 'acme/website #88 · 22m',
     NONE, UNREAD | CAN_COMMENT | CAN_MARK, G_MENTIONED,
     'Mentioned · Issue\nmia-chen: @jo-park could you check whether the font preload is still '
     'needed? It blocks the first paint.'),
    ('9001003', 'Roadmap for the 2.0 release', 'acme/api #301 · 2h',
     NONE, CAN_COMMENT | CAN_MARK, G_MENTIONED,
     'Mentioned · Discussion\nsam-lee: Pencilled in offline sync for March.'),
    ('9001004', 'Dark mode: code blocks lose their contrast', 'jo-park/notes-app #17 · 3h',
     NONE, UNREAD | CAN_COMMENT | CAN_MARK, G_ASSIGNED,
     'Assigned · Issue\nmia-chen: Screenshot attached. Grey on grey.'),
    ('9001005', 'CI workflow run failed for main branch', 'acme/api · 1h',
     BAD, UNREAD | CAN_MARK, G_BUILDS,
     'Builds · Build\nCI / test failed on main'),
    ('9001006', 'Bump the image library to 3.2', 'acme/website #90 · 2d',
     GOOD, CAN_COMMENT | CAN_MARK, G_REVIEW,
     'Review requested · Pull request\nChecks passing. No comments yet.'),
    ('9001007', 'WIP: move every setting into its own module, with a title long enough to need '
                'all of its hundred bytes',
     'jo-park/notes-app #23 · Nov 3',
     DRAFT, UNREAD | CAN_COMMENT | CAN_MARK, G_OTHER,
     'Subscribed · Pull request\nsam-lee: Still a draft, but the shape is there. The old '
     'settings file stays until every screen reads from the new module, which may take a while '
     'because the sync code reaches into it from three places and none of them have tests yet, '
     'so this comment runs right up to the limit.'),
    ('9001008', 'v2.4.0', 'acme/website · 4d',
     NONE, CAN_MARK, G_OTHER,
     'Release · Release\nFaster image uploads, and a fix for the logout loop.'),
    ('9001009', 'Fix typo in README', 'acme/api · Nov 3',
     NONE, UNREAD | CAN_MARK, G_OTHER,
     'Subscribed · Commit'),
]

REVIEWS = [
    ('acme/api#142', 'Retry the upload when the access token expires mid-request',
     'acme/api #142 · Running', PENDING, CAN_COMMENT, 0,
     'From sam-lee · Running\nsam-lee: Ready for another look. I moved the retry into the client.'),
    ('acme/api#139', 'Add rate limiting to the public search endpoint',
     'acme/api #139 · Failing', BAD, CAN_COMMENT | CAN_RERUN, 0,
     'From mia-chen · Failing\nCI / lint failed\nmia-chen: Lint dislikes the new file; fixing.'),
    ('acme/website#90', 'Bump the image library to 3.2', 'acme/website #90 · Passing',
     GOOD, CAN_COMMENT, 0, 'From sam-lee · Passing'),
]

PRS = [
    ('acme/api#145', 'Cache the dashboard queries for five minutes', 'acme/api #145 · Failing',
     BAD, CAN_COMMENT | CAN_RERUN, 0,
     'Changes requested · Failing\nCI / test failed\nsam-lee: The cache key needs the team '
     'too, or two teams see each other\'s numbers.'),
    ('jo-park/notes-app#22', 'Show the sync status in the menu bar',
     'jo-park/notes-app #22 · Running', PENDING, CAN_COMMENT, 0,
     'Review required · Running'),
    ('acme/website#91', 'Tidy the onboarding copy', 'acme/website #91 · Approved',
     GOOD, CAN_COMMENT, 0, 'Approved · Passing\nmia-chen: Lovely. Ship it.'),
    ('jo-park/notes-app#23', 'Experiment: offline mode', 'jo-park/notes-app #23 · Draft',
     DRAFT, CAN_COMMENT, 0, 'Draft · No checks'),
]

BUILDS = [
    ('acme/api', 'acme/api', 'main · Failing', BAD, CAN_RERUN, 0,
     'CI failed on main\nFix the cache key\n14:02'),
    ('acme/website', 'acme/website', 'main · Running', PENDING, 0, 0,
     'Deploy running on main\nTidy the onboarding copy\n14:20'),
    ('jo-park/notes-app', 'jo-park/notes-app', 'main · Passing', GOOD, 0, 0,
     'CI passed on main\nRelease 1.3\nYesterday 18:40'),
]

REPOS = [
    ('acme/api', 'acme/api', '', NONE, DEFAULT, 0, ''),
    ('acme/website', 'acme/website', '', NONE, 0, 0, ''),
    ('jo-park/notes-app', 'jo-park/notes-app', '', NONE, 0, 0, ''),
]

LISTS = [('NOTIFICATION', NOTIFICATIONS), ('REVIEW', REVIEWS), ('PR', PRS), ('BUILD', BUILDS),
         ('REPO', REPOS)]

# ---------------------------------------------------------------- the link


def pypkjs_port(platform=None):
    ps = subprocess.run(['ps', 'ax', '-o', 'command'], capture_output=True, text=True).stdout
    for line in ps.splitlines():
        m = re.search(r'pypkjs .*--port (\d+)', line)
        if m and (not platform or '/%s ' % platform in line + ' ' or '/%s/' % platform in line):
            return m.group(1)
    sys.exit('no emulator running' + (' for ' + platform if platform else ''))


def parse(v):
    """A value typed on the command line: a number (or now, now-600) or a string."""
    if v.startswith('s:'):
        return v[2:]
    m = re.fullmatch(r'now([+-]\d+)?', v)
    if m:
        return int(time.time()) + int(m.group(1) or 0)
    if re.fullmatch(r'-?\d+', v):
        return int(v)
    return v


class Link:
    def __init__(self, platform):
        self.pebble = PebbleConnection(WebsocketTransport('ws://localhost:%s/' % pypkjs_port(platform)))
        self.pebble.connect()
        self.pebble.run_async()
        self.svc = AppMessageService(self.pebble)
        self.acks = []
        self.inbox = []
        self.svc.register_handler('ack', lambda tid, *a: self.acks.append(('ack', tid)))
        self.svc.register_handler('nack', lambda tid, *a: self.acks.append(('nack', tid)))
        self.svc.register_handler('appmessage', self._received)

    def _received(self, tid, app_uuid, data):
        if app_uuid == APP:
            self.inbox.append({NAMES.get(k, k): v for k, v in data.items()})

    def send(self, fields, quiet=False):
        msg = {KEYS[k]: Int32(v) if isinstance(v, int) else CString(v) for k, v in fields.items()}
        result = 'timeout'
        for attempt in range(3):
            n = len(self.acks)
            self.svc.send_message(APP, msg)
            for _ in range(60):
                if len(self.acks) > n:
                    break
                time.sleep(0.05)
            result = self.acks[n][0] if len(self.acks) > n else 'timeout'
            if result == 'ack':
                break
            time.sleep(1)
        if not quiet or result != 'ack':
            shown = ' '.join('%s=%s' % (k, (v if not isinstance(v, str) or len(v) < 40 else v[:37] + '...'))
                             for k, v in fields.items())
            print('%-7s %s' % (result, shown))
        return result == 'ack'


def send_list(link, kind, items):
    if not items:
        link.send({'Cmd': CMD['ITEM'], 'Kind': KIND[kind], 'Count': 0})
        return
    for i, (id_, title, sub, state, flags, group, text) in enumerate(items):
        link.send({'Cmd': CMD['ITEM'], 'Kind': KIND[kind], 'Index': i, 'Count': len(items),
                   'Id': id_, 'Title': title, 'Sub': sub, 'State': state, 'Flags': flags,
                   'Group': group, 'Text': text}, quiet=True)
    print('ok      %s: %d items' % (kind, len(items)))


def send_fixture(link):
    link.send(dict(Cmd=CMD['SUMMARY'], **SUMMARY))
    for kind, items in LISTS:
        send_list(link, kind, items)
    link.send({'Cmd': CMD['TIME'], 'Updated': int(time.time())})
    link.send({'Cmd': CMD['NOTICE'], 'Notice': ''})


def send_empty(link, login):
    link.send(dict(Cmd=CMD['SUMMARY'], Login=login, Unread=0, Reviews=0, Prs=0, Failing=0,
                   Builds=0, Broken=0, Repo=''))
    for kind, _ in LISTS:
        send_list(link, kind, [])
    link.send({'Cmd': CMD['TIME'], 'Updated': int(time.time())})


ANSWERS = {1: 'Marked read', 2: 'Marked done', 3: 'Marked 6 notifications read',
           4: 'Rerunning failed jobs in 2 runs on acme/api #145', 5: 'Replied on acme/api #142',
           6: 'Opened acme/api #146', 7: 'Up to date'}


def phone(link, secs, fail, delay, silent):
    """Answers the watch as the phone would, for `secs` seconds."""
    end = time.time() + secs
    while time.time() < end:
        while link.inbox:
            msg = link.inbox.pop(0)
            print('watch:  %s' % ' '.join('%s=%r' % kv for kv in msg.items()))
            if msg.get('Cmd') == CMD['HELLO']:
                send_fixture(link)
            elif msg.get('Cmd') == CMD['ACT']:
                act = msg.get('Act', 0)
                print('        ACT %s' % ACT_NAMES.get(act, act))
                time.sleep(delay)
                if silent:
                    continue
                if fail:
                    link.send({'Cmd': CMD['RESULT'], 'Act': act, 'Ok': 0,
                               'Notice': 'GitHub said no: the token has no repo scope'})
                else:
                    link.send({'Cmd': CMD['RESULT'], 'Act': act, 'Ok': 1,
                               'Notice': ANSWERS.get(act, 'Done')})
        time.sleep(0.1)


def main():
    args = sys.argv[1:]
    platform = None
    if args and args[0] == '--platform':
        platform, args = args[1], args[2:]
    if not args:
        sys.exit(__doc__)
    link = Link(platform)
    command, rest = args[0], args[1:]
    if command == 'fixture':
        send_fixture(link)
    elif command == 'empty':
        send_empty(link, 'jo-park')
    elif command == 'signout':
        send_empty(link, '')
        link.send({'Cmd': CMD['NOTICE'], 'Notice': "Sign in to GitHub in Inbox for GitHub's settings."})
    elif command == 'notice':
        link.send({'Cmd': CMD['NOTICE'], 'Notice': rest[0] if rest else ''})
    elif command == 'time':
        link.send({'Cmd': CMD['TIME'], 'Updated': parse(rest[0] if rest else 'now')})
    elif command == 'result':
        link.send({'Cmd': CMD['RESULT'], 'Act': int(rest[0]), 'Ok': int(rest[1]),
                   'Notice': rest[2] if len(rest) > 2 else ''})
    elif command == 'raw':
        link.send({k: parse(v) for k, v in (a.split('=', 1) for a in rest)})
    elif command == 'phone':
        secs = int(rest[0]) if rest and rest[0].isdigit() else 600
        delay = float(rest[rest.index('--delay') + 1]) if '--delay' in rest else 1
        phone(link, secs, '--fail' in rest, delay, '--silent' in rest)
    else:
        sys.exit(__doc__)
    time.sleep(0.3)


if __name__ == '__main__':
    main()
