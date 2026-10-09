#!/usr/bin/env python3
"""Pack the game into ONE html file (plus the assets/ folder) for hosting that wants a single page.
Usage: python3 tools/bundle.py OUTPUT.html [--embed]
Normal use does not need this: just serve the folder.
--embed also puts every picture from assets/ inside the page (as data: addresses), so the one file is the whole game.

Feature modules: every id listed in Creek.CONFIG.modules (src/config.js) is built in from src/mod-<id>.js.
At run time main.js skips loading a module that is already registered, so the single file never asks the server
for src/mod-*.js for those. Modules NOT listed in the config can still be loaded from src/ with ?mods= / ?addmods=
if that folder is hosted next to the page."""
import sys, re, os, base64, json
root = __file__.rsplit('/tools/', 1)[0]
rd = lambda p: open(root + '/' + p, encoding='utf-8').read()
html = rd('index.html')
body = html.split('<body>')[1].split('<script')[0].strip()
css = rd('style.css')

# the module ids named in the config, in order (the line "modules: ['a', 'b'],")
config = rd('src/config.js')
m = re.search(r'^\s*modules\s*:\s*\[([^\]]*)\]', config, re.M)
mods = re.findall(r'''['"]([\w-]+)['"]''', m.group(1)) if m else []
mod_src, built = [], []
for mid in mods:
    try:
        mod_src.append(rd('src/mod-%s.js' % mid)); built.append(mid)
    except IOError:
        sys.stderr.write('warning: module "%s" is listed in config.js but src/mod-%s.js does not exist; skipping it\n' % (mid, mid))

order = ['config', 'core', 'world', 'river-core', 'river-calib', 'sim', 'shade', 'render', 'game', 'ui', 'story']
embed = '--embed' in sys.argv
assets_js = ''
if embed:
    pics = {}
    for folder in ('assets/pictures', 'assets/extras'):
        d = os.path.join(root, folder)
        if os.path.isdir(d):
            for name in sorted(os.listdir(d)):
                if name.lower().endswith(('.jpg', '.jpeg', '.png')):
                    mime = 'image/png' if name.lower().endswith('.png') else 'image/jpeg'
                    pics[folder + '/' + name] = 'data:%s;base64,%s' % (mime, base64.b64encode(open(os.path.join(d, name), 'rb').read()).decode('ascii'))
    assets_js = 'Creek.ASSETS = ' + json.dumps(pics) + ';\n'
parts = [rd('src/%s.js' % n) for n in order]
parts.insert(1, assets_js) if assets_js else None          # right after config.js, which creates Creek
js = '\n'.join(parts + mod_src + [rd('src/main.js')])
worker = 'self.window = self;\n' + rd('src/config.js') + '\n' + rd('src/world.js') + \
    '\nonmessage = function (e) { const d = e.data, r = Creek.generateSlab(d.dx, d.j0, d.j1); postMessage(r, [r.T.buffer, r.M.buffer]); };\n'
assert '</script' not in worker and '</script' not in js
out = ('<title>Creek Care</title>\n<meta name="theme-color" content="#f1e7cf">\n<style>\n' + css + '\n</style>\n' + body +
       '\n<script type="text/plain" id="worker-src">\n' + worker + '\n</script>\n<script>\n' + js + '\n</script>\n')
open(sys.argv[1], 'w', encoding='utf-8').write(out)
print('wrote', sys.argv[1], len(out), 'bytes', '(modules built in: %s)' % (', '.join(built) or 'none'))
