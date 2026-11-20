# Inbox for GitHub

Your GitHub inbox on a Pebble watch, and a plugin that puts the same readings on any watchface.

**Unofficial.** Not made by, endorsed by or affiliated with GitHub. GitHub is a trademark of
GitHub, Inc.

## What it does

On the watch (Pebble Time, Time Round, Pebble 2, 2 Duo, Time 2 and Round 2):

- **Notifications**, grouped into Review requested, Mentioned, Assigned, Builds and Other, with
  the latest comment. Mark one read, mark it done, or mark them all read.
- **Review requests** and **your pull requests**, with their checks (passing, failing, running)
  and review state. Rerun a pull request's failed jobs (hold Select to confirm).
- **Builds**: the latest checks on the default branch of up to six repositories you pick.
- **Reply by voice** to an issue or pull request, and **open a new issue by voice**.

As a plugin, for any watchface or app that reads plugins (category `code`): `code/inbox` (a
summary), `code/notification`, `code/review_request`, `code/pull_request`, `code/build`,
`code/repo` and `code/contributions` (today, streak, week, the last 14 days). See
[DESIGN.md](DESIGN.md) for every property and action.

## Signing in

In the Pebble app, open Inbox for GitHub's settings and paste a **classic** personal access
token with the `notifications` and `repo` scopes
([make one here](https://github.com/settings/tokens/new?scopes=notifications,repo&description=Inbox%20for%20Pebble)).
GitHub's notifications API only accepts classic tokens; fine-grained tokens can't read
notifications. The token stays on your phone and is only ever sent to GitHub.

Want a look first? Settings has a demo mode with made-up data.

## Building

Needs the Pebble SDK 4.44 or later (plugins need manifest v2).

```sh
pebble build          # build/inbox-for-github.pbw
npm test              # Node tests: the plugin against a fake GitHub, the phone half against a fake plugin
npm run hostcheck     # every source in pypkjs (the emulator's phone runtime); add
                      # --storage adb4f7c0-171e-48a0-911a-2caa057949f9 settings.v1 '{"demo":true}'
npm run appcheck      # the phone half talking to its own plugin, with the harness as the watch
```

`tools/send.py` plays the phone for the emulator (build with `IFG_NOJS=1` first). Debug flags
are listed in DESIGN.md; never publish a build made with one.

## Licence

MIT. See [LICENSE](LICENSE).
