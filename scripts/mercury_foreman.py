"""Ouvre une app déjà générée dans le studio et donne un ordre à son contremaître (Mercury 3), avec captures.
Usage : python3 scripts/mercury_foreman.py <url> "<titre app>" "<ordre>" <préfixe> [fichier_access]"""
import sys, time, json, shutil
from playwright.sync_api import sync_playwright
url, title, order, prefix = sys.argv[1:5]
creds = None
if len(sys.argv) > 5:
    u, p = open(sys.argv[5]).read().strip().split(':', 1); creds = {'username': u, 'password': p}
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=shutil.which('google-chrome'), args=ARGS)
    pg = b.new_context(viewport={'width': 1600, 'height': 1000}, http_credentials=creds).new_page(); errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.goto(url); pg.wait_for_selector('[data-testid=prompt]'); time.sleep(1)
    pg.get_by_text(title).first.click(); time.sleep(8)
    pg.screenshot(path=f'screenshots/{prefix}-app.png')
    fr = pg.frame_locator('iframe[data-testid=preview]')
    print('scènes initiales :', fr.locator('[data-testid=scene]').count())
    inp = fr.locator('[data-testid=agent-input]')
    if not inp.count(): inp = fr.get_by_placeholder('Ordre au contremaître', exact=False)
    inp.first.fill(order); t1 = time.time()
    send = fr.locator('[data-testid=agent-send]')
    if not send.count(): send = fr.get_by_role('button', name='Envoyer')
    send.first.click()
    for _ in range(60):
        time.sleep(5)
        busy = send.first.inner_text().strip() == '…'
        if not busy and time.time() - t1 > 10: break
    print(f'réponse en {time.time() - t1:.0f} s ; scènes prêtes :', fr.locator('[data-testid=scene][data-ready=true]').count())
    time.sleep(6)
    pg.screenshot(path=f'screenshots/{prefix}-ordre.png')
    print('app (fin) :', fr.locator('body').inner_text()[-1800:])
    print('erreurs :', json.dumps(errs[-6:], ensure_ascii=False)[:1200])
    b.close()
