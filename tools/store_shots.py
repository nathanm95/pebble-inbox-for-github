#!/usr/bin/env python3
"""Store screenshots from the release build, with the plugin's demo data (made-up people and repos).

    python3 tools/store_shots.py [platform ...]     # default: basalt chalk diorite emery gabbro

For each platform: switch the plugin to demo mode in the emulated phone's storage, install
build/inbox-for-github.pbw (build it first with no IFG_ flags, so there's no DEBUG band), wait for
the phone half to send the inbox, then walk Home > Notifications, My pull requests > a pull
request, and Builds, saving store/<platform>_<n>_<screen>.png at the watch's native size.
flint (Pebble 2 Duo) has the same 144x168 black-and-white screen as diorite (Pebble 2), so its
set is a copy of diorite's.

Needs a running emulator per platform (`pebble install --emulator <p>` starts one), and only
touches this app's own storage.
"""
import dbm.dumb
import json
import os
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PACKAGE = json.load(open(os.path.join(ROOT, 'package.json')))['pebble']
UUID = PACKAGE['uuid']
SDK_DIR = os.path.expanduser('~/Library/Application Support/Pebble SDK')
PBW = os.path.join(ROOT, 'build', 'inbox-for-github.pbw')
STORE = os.path.join(ROOT, 'store')
PEBBLE = shutil.which('pebble') or os.path.expanduser('~/.local/bin/pebble')

# Home rows, top to bottom: Notifications, Reviews, My pull requests, Builds, New issue, Refresh.
STEPS = [
    ('1_home', []),
    ('2_notifications', ['select']),
    ('3_pulls', ['back', 'down', 'down', 'select']),
    ('4_detail', ['select']),
    ('5_builds', ['back', 'back', 'down', 'select']),
]


def active_sdk():
    out = subprocess.run([PEBBLE, 'sdk', 'list'], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if '(active)' in line:
            return line.split()[0]
    raise SystemExit('no active Pebble SDK')


def seed_demo(platform, sdk):
    """settings.v1 = {"demo": true} in this app's plugin storage on the emulated phone."""
    folder = os.path.join(SDK_DIR, sdk, platform, 'localstorage')
    os.makedirs(folder, exist_ok=True)
    db = dbm.dumb.open(os.path.join(folder, UUID), 'c')
    try:
        settings = json.loads(db.get('settings.v1', b'{}').decode() or '{}')
    except ValueError:
        settings = {}
    settings['demo'] = True
    db['settings.v1'] = json.dumps(settings)
    db.close()


def button(platform, name):
    subprocess.run([PEBBLE, 'emu-button', '--emulator', platform, 'click', name],
                   capture_output=True)
    time.sleep(0.5)


def shoot(platform, out):
    subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'shot.py'), platform, out],
                   check=True, capture_output=True)


def run(platform, sdk):
    seed_demo(platform, sdk)
    subprocess.run([PEBBLE, 'install', '--emulator', platform, PBW], check=True, capture_output=True)
    time.sleep(8)  # the plugin reads its demo data and the phone half sends it over
    for name, presses in STEPS:
        for press in presses:
            button(platform, press)
        time.sleep(1.0)
        out = os.path.join(STORE, '%s_%s.png' % (platform, name))
        shoot(platform, out)
        print(out)
    button(platform, 'back')
    button(platform, 'back')


def main():
    platforms = sys.argv[1:] or ['basalt', 'chalk', 'diorite', 'emery', 'gabbro']
    os.makedirs(STORE, exist_ok=True)
    sdk = active_sdk()
    for platform in platforms:
        run(platform, sdk)
        if platform == 'diorite':
            for name, _ in STEPS:
                shutil.copy(os.path.join(STORE, 'diorite_%s.png' % name),
                            os.path.join(STORE, 'flint_%s.png' % name))


if __name__ == '__main__':
    main()
