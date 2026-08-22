#!/usr/bin/env python3
"""유저스크립트에서 확장프로그램 콘텐츠 스크립트를 생성한다.

사용법:  python3 build.py [유저스크립트경로]
기본값:  ../img-meta-viewer.user.js  →  ../imv-extension/content.js
"""
import re, sys, json, pathlib

here = pathlib.Path(__file__).resolve().parent
userjs = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here.parent / 'img-meta-viewer.user.js'
extdir = here.parent / 'imv-extension'

src = userjs.read_text(encoding='utf-8')
m = re.search(r'//\s*==/UserScript==\s*\n', src)
if not m:
    sys.exit('유저스크립트 헤더(==/UserScript==)를 찾지 못했습니다: %s' % userjs)
body = src[m.end():]
ver = re.search(r'@version\s+([\d.]+)', src).group(1)

shim = (here / 'shim.js').read_text(encoding='utf-8')
out = shim + body.rstrip() + '\n/* ===================== 유저스크립트 본문 끝 ===================== */\n})();\n'
(extdir / 'content.js').write_text(out, encoding='utf-8')

mfp = extdir / 'manifest.json'
mf = json.loads(mfp.read_text(encoding='utf-8'))
mf['version'] = ver
mfp.write_text(json.dumps(mf, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

print('content.js 생성 완료 (v%s, %dKB)' % (ver, len(out) // 1024))
