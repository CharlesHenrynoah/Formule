"""Capture de l'onglet « Chat app » (contremaître hébergé par le studio) avec un échange.
Usage : python3 scripts/screenshot_app_chat.py <url> "<titre app>" "<ordre>" <sortie.png> [fichier_access]"""
import sys, time, json, shutil
from playwright.sync_api import sync_playwright
url, title, order, out = sys.argv[1:5]
creds = None
if len(sys.argv) > 5:
    u, p = open(sys.argv[5]).read().strip().split(':', 1); creds = {'username': u, 'password': p}
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=shutil.which('google-chrome'), args=ARGS)
    pg = b.new_context(viewport={'width': 1600, 'height': 1000}, http_credentials=creds).new_page(); errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(url); pg.wait_for_selector('[data-testid=prompt]'); time.sleep(1)
    pg.get_by_text(title).first.click(); time.sleep(6)
    fr = pg.frame_locator('iframe[data-testid=preview]')
    print('chat interne masqué :', fr.locator('[data-testid=chat]').count() == 0 or not fr.locator('[data-testid=chat]').first.is_visible())
    pg.click('[data-testid=tab-app-chat]'); time.sleep(1)
    pg.fill('[data-testid=app-chat-input]', order); t1 = time.time()
    pg.click('[data-testid=app-chat-send]')
    time.sleep(3)
    for _ in range(60):
        time.sleep(3)
        if pg.locator('[data-testid=app-chat-send] .animate-spin').count() == 0 and time.time() - t1 > 6: break
    print(f'réponse en {time.time() - t1:.0f} s')
    time.sleep(4)
    pg.screenshot(path=out)
    print('fil :', pg.locator('[data-testid=app-chat-log]').inner_text()[-1500:])
    print('erreurs :', json.dumps(errs[-6:], ensure_ascii=False)[:1000])
    b.close()
