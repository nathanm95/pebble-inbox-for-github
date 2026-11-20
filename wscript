#
# Pebble build rules, plus the debug switches below.
#
import os.path

top = '.'
out = 'build'

# Debug-only switches, read from the environment so a release build never carries them
# (waf tracks DEFINES, so changing one recompiles; no `pebble clean` needed). Any of them also
# defines IFG_DEBUG, which puts DEBUG in every window's band. NEVER publish or leave in build/ a
# bundle made with these set: finish with `pebble clean && pebble build`.
#   IFG_FAKE_DICTATION="text"  Reply by voice and New issue take this as what was said, instead of
#                              opening dictation (which the emulator can't do)
#   IFG_NOJS=1                 bundle no phone JavaScript, so tools/send.py's messages are all the
#                              watch gets (and tools/send.py answers its ACTs)
STRING_FLAGS = ('IFG_FAKE_DICTATION',)
NUMBER_FLAGS = ('IFG_NOJS',)


def options(ctx):
    ctx.load('pebble_sdk')


def configure(ctx):
    ctx.load('pebble_sdk')


def debug_defines():
    defines = []
    for flag in STRING_FLAGS:
        value = os.environ.get(flag)
        if value:
            defines.append('%s="%s"' % (flag, value.replace('\\', '\\\\').replace('"', '\\"')))
    for flag in NUMBER_FLAGS:
        value = os.environ.get(flag)
        if value not in (None, ''):
            defines.append('%s=%d' % (flag, int(value)))
    if defines:
        defines.append('IFG_DEBUG=1')
    return defines


def build(ctx):
    ctx.load('pebble_sdk')

    build_worker = os.path.exists('worker_src')
    binaries = []

    cached_env = ctx.env
    for platform in ctx.env.TARGET_PLATFORMS:
        ctx.env = ctx.all_envs[platform]
        ctx.env.append_value('DEFINES', debug_defines())
        ctx.set_group(ctx.env.PLATFORM_NAME)
        app_elf = '{}/pebble-app.elf'.format(ctx.env.BUILD_DIR)
        ctx.pbl_build(source=ctx.path.ant_glob('src/c/**/*.c'), target=app_elf, bin_type='app')

        if build_worker:
            worker_elf = '{}/pebble-worker.elf'.format(ctx.env.BUILD_DIR)
            binaries.append({'platform': platform, 'app_elf': app_elf, 'worker_elf': worker_elf})
            ctx.pbl_build(source=ctx.path.ant_glob('worker_src/c/**/*.c'),
                          target=worker_elf,
                          bin_type='worker')
        else:
            binaries.append({'platform': platform, 'app_elf': app_elf})
    ctx.env = cached_env

    ctx.set_group('bundle')
    if os.environ.get('IFG_NOJS'):
        ctx.pbl_bundle(binaries=binaries)
    else:
        ctx.pbl_bundle(binaries=binaries,
                       js=ctx.path.ant_glob(['src/pkjs/**/*.js',
                                             'src/pkjs/**/*.json',
                                             'src/common/**/*.js']),
                       js_entry_file='src/pkjs/index.js')

    if debug_defines():
        # A debug build once went to the store. A debug pbw must never be published.
        print('\n' + '!' * 72)
        print('!!  DEBUG BUILD (%s): DO NOT PUBLISH.' % ', '.join(debug_defines()))
        print('!!  Rebuild with no IFG_* variables set: pebble clean && pebble build')
        print('!' * 72 + '\n')
