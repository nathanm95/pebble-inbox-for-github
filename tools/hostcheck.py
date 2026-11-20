#!/usr/bin/env python3
"""Load built plugin pbws into pypkjs (the emulator's phone runtime) and read every source.

    tools/hostcheck.sh [--at LAT,LON] [--secs N] [--js FILE] [--storage UUID KEY VALUE] build/x.pbw ...
    tools/hostcheck.sh --app [--secs N] build/london-lines.pbw

This catches what the Node tests can't: the real host parsing the manifest, running the
script under its own JavaScript engine (quickjs-ng, not V8), and delivering envelopes to a
subscribing app. pypkjs prints "Plugin manifest problem (the phone app will refuse this)"
for a manifest the app would reject.

With no --js, a subscriber reads each source of the given pbws once (asking for 32px
bitmaps) and logs DATA/ERROR lines. --js runs your own PebbleKit JS instead.

--app runs the (first) pbw's own watch-app JavaScript (pebble-js-app.js), with its uuid and
message keys, against its own plugin, and plays the watch's end of AppMessage: every message is
logged as an APPMESSAGE line and acked 50 ms later, and the watch says HELLO halfway through.

Adapted from pypkjs's tests/plugin_harness.py (MIT, (c) 2015 Pebble Technology). It has to
run under pebble-tool's Python, which has pypkjs installed; tools/hostcheck.sh does that.
"""

import argparse
import dbm.dumb
import json
import logging
import os
import sys
import tempfile
import zipfile
from uuid import UUID

import pypkjs  # noqa: F401  (gevent monkey-patching, before anything else)
import gevent
from unittest import mock

from pypkjs.javascript.runtime import JSRuntime
from pypkjs.plugins.builtin import FixtureStore, builtin_plugins
from pypkjs.plugins.registry import PluginRegistry
from pypkjs.runner import Runner
from pypkjs.runner.config_pages import ConfigPages

SUBSCRIBER_JS = r'''
var wanted = %s;
Pebble.addEventListener('ready', function () {
  var plugins = Pebble.enumeratePlugins().filter(function (p) { return wanted.indexOf(p.uuid) !== -1; });
  plugins.forEach(function (plugin) {
    console.log('PLUGIN ' + plugin.name + ' sources=' + plugin.sources.length + ' actions=' + plugin.actions.length);
    plugin.sources.forEach(function (source) {
      source.items.forEach(function (item) {
        var key = source.category + '/' + item;
        Pebble.subscribeToSource({
          category: source.category, item: item, plugin: plugin.uuid,
          iconPixelSize: { w: 32, h: 32 },
          onData: function (envelope) {
            var summary = envelope.instances.map(function (instance) {
              var p = instance.properties;
              var shown = Object.keys(p).map(function (name) {
                var shapes = p[name];
                var text = shapes.shortText ? shapes.shortText.text
                  : shapes.numericValue ? shapes.numericValue.value
                  : shapes.timestamp ? shapes.timestamp.value
                  : shapes.boolean ? shapes.boolean.value : Object.keys(shapes).join('+');
                return name + '=' + text;
              });
              return instance.instanceId + ' {' + shown.join(', ') + '}';
            });
            console.log('DATA ' + key + ' ' + envelope.instances.length + ' instance(s): ' + summary.join(' ; '));
          },
          onError: function (err) { console.log('ERROR ' + key + ' ' + err.code + ' ' + (err.message || '')); },
        });
      });
    });
  });
});
'''


class CheckRunner(object):
    """The slice of pypkjs's Runner that plugins use."""
    _load_plugin = Runner._load_plugin
    _load_config_page = Runner._load_config_page
    app_title = Runner.app_title
    is_plugin_only = staticmethod(Runner.is_plugin_only)
    plugin_list = Runner.plugin_list
    _pbw_cache_dir = Runner._pbw_cache_dir

    def __init__(self, persist_dir, location):
        self.persist_dir = persist_dir
        self.block_private_addresses = False
        self.location = location
        self.logger = logging.getLogger('hostcheck')
        self.logs = []
        self.previous_app_uuid = None
        self.plugins = PluginRegistry()
        self.plugin_fixtures = FixtureStore(None, self.log_output)
        for plugin in builtin_plugins(self.plugin_fixtures, self):
            self.plugins.register(plugin)
        self.appmessage = mock.MagicMock()
        self.pbws = {}
        self.config_page_files = {}
        self.config_pages = ConfigPages(self)
        self.js = None
        self.running_uuid = None

    def launch_app(self, uuid):
        self.log_output('LAUNCH %s' % uuid)

    def log_output(self, message):
        self.logs.append(message)
        print(message, flush=True)

    def load(self, path):
        with zipfile.ZipFile(path) as z:
            appinfo = json.loads(z.open('appinfo.json').read())
            uuid = UUID(appinfo['uuid'])
            self._load_plugin(z, uuid, appinfo)
            self._load_config_page(z, uuid, appinfo)
            self.pbws[uuid] = Runner.PBW(uuid, None, appinfo, {}, [])
        return str(uuid)


class FakeWatch(object):
    """The watch's end of AppMessage, for --app: logs each message and acks it."""

    def __init__(self, runner, uuid, app_keys):
        self.runner = runner
        self.uuid = uuid
        self.app_keys = app_keys
        self.names = {number: name for name, number in app_keys.items()}
        self.handlers = {}
        self.tid = 0

    def register_handler(self, event, handler):
        self.handlers[event] = handler
        return event

    def unregister_handler(self, event):
        self.handlers.pop(event, None)

    def send_message(self, uuid, dictionary):
        self.tid += 1
        shown = {}
        for key, value in dictionary.items():
            value = value.value
            if isinstance(value, str) and len(value) > 60:
                value = value[:57] + '...'
            shown[self.names.get(key, key)] = value
        self.runner.log_output('APPMESSAGE ' + json.dumps(shown, ensure_ascii=False))
        gevent.spawn_later(0.05, self.handlers['ack'], self.tid, uuid)
        return self.tid

    def hello(self):
        self.runner.log_output('WATCH says HELLO')
        self.handlers['appmessage'](0, self.uuid, {self.app_keys['Cmd']: 1})


class CheckRuntime(JSRuntime):
    def log_output(self, message):
        self.runner.log_output(message)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('pbws', nargs='+')
    parser.add_argument('--at', help='LAT,LON for geolocation')
    parser.add_argument('--secs', type=float, default=8)
    parser.add_argument('--js', help='PebbleKit JS to run instead of the default subscriber')
    parser.add_argument('--app', action='store_true',
                        help="run the pbw's own watch-app JS against its plugin, acking its AppMessages")
    parser.add_argument('--storage', nargs=3, action='append', default=[], metavar=('UUID', 'KEY', 'VALUE'),
                        help="seed a pbw's localStorage first, e.g. what its settings page would have saved")
    args = parser.parse_args()

    location = None
    if args.at:
        latitude, longitude = (float(v) for v in args.at.split(','))
        location = {'latitude': latitude, 'longitude': longitude}
    persist = tempfile.mkdtemp(prefix='hostcheck-')
    # pypkjs keeps each pbw's localStorage in a dbm.dumb file named for its uuid.
    os.makedirs(os.path.join(persist, 'localstorage'), exist_ok=True)
    for uuid, key, value in args.storage:
        with dbm.dumb.open(os.path.join(persist, 'localstorage', str(UUID(uuid))), 'c') as store:
            store[key] = value
    runner = CheckRunner(persist, location)
    uuids = [runner.load(path) for path in args.pbws]
    pbw = mock.MagicMock()
    watch = None
    if args.app:
        with zipfile.ZipFile(args.pbws[0]) as z:
            pbw.manifest = json.loads(z.open('appinfo.json').read())
            src = z.open('pebble-js-app.js').read().decode('utf-8')
        pbw.uuid = UUID(pbw.manifest['uuid'])
        watch = runner.appmessage = FakeWatch(runner, pbw.uuid, pbw.manifest['appKeys'])
    elif args.js:
        with open(args.js) as f:
            src = f.read()
    else:
        src = SUBSCRIBER_JS % json.dumps(uuids)
    if not args.app:
        pbw.uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
        pbw.manifest = {'appKeys': {}, 'capabilities': [], 'shortName': 'hostcheck', 'manifestVersion': 2}
    runtime = CheckRuntime(mock.MagicMock(), pbw, runner, persist_dir=persist)
    greenlet = gevent.spawn(runtime.run, src)
    if watch:
        gevent.sleep(args.secs / 2)
        watch.hello()
        gevent.sleep(args.secs / 2)
    else:
        gevent.sleep(args.secs)
    runtime.stop()
    greenlet.join(5)
    sys.stdout.flush()
    # quickjs-ng can deadlock at interpreter shutdown (see pypkjs's harness), so leave hard.
    os._exit(0)


if __name__ == '__main__':
    main()
