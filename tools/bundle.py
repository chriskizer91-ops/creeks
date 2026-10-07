#!/usr/bin/env python3
"""Pack the game into ONE html file (plus the assets/ folder) for hosting that wants a single page.
Usage: python3 tools/bundle.py OUTPUT.html
Normal use does not need this: just serve the folder."""
import sys, re
root = __file__.rsplit('/tools/', 1)[0]
rd = lambda p: open(root + '/' + p, encoding='utf-8').read()
html = rd('index.html')
body = html.split('<body>')[1].split('<script')[0].strip()
css = rd('style.css')
order = ['config', 'world', 'sim', 'render', 'game', 'ui', 'story', 'main']
js = '\n'.join(rd('src/%s.js' % n) for n in order)
worker = 'self.window = self;\n' + rd('src/config.js') + '\n' + rd('src/world.js') + \
    '\nonmessage = function (e) { const d = e.data, r = Creek.generateSlab(d.dx, d.j0, d.j1); postMessage(r, [r.T.buffer, r.M.buffer]); };\n'
assert '</script' not in worker and '</script' not in js
out = ('<title>Creek Care</title>\n<meta name="theme-color" content="#f1e7cf">\n<style>\n' + css + '\n</style>\n' + body +
       '\n<script type="text/plain" id="worker-src">\n' + worker + '\n</script>\n<script>\n' + js + '\n</script>\n')
open(sys.argv[1], 'w', encoding='utf-8').write(out)
print('wrote', sys.argv[1], len(out), 'bytes')
