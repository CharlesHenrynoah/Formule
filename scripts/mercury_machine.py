"""Test réel Mercury 3 : l'équipe génère une console de ventes, puis on demande au contremaître
« visualise mon tunnel de conversion comme une machine ». Mot de passe lu depuis .access (jamais affiché).
Usage : python3 scripts/mercury_machine.py <url> [fichier_access]"""
import sys, time, json, shutil
from playwright.sync_api import sync_playwright
url = sys.argv[1]
creds = None
if len(sys.argv) > 2:
    u, p = open(sys.argv[2]).read().strip().split(':', 1); creds = {'username': u, 'password': p}
OUT = 'screenshots/'
ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
with sync_playwright() as pw:
    b = pw.chromium.launch(executable_path=shutil.which('google-chrome'), args=ARGS)
    ctx = b.new_context(viewport={'width': 1600, 'height': 1000}, http_credentials=creds)
    pg = ctx.new_page(); logs = []
    pg.on('console', lambda m: logs.append(m.text) if m.type == 'error' else None)
    pg.goto(url); pg.wait_for_selector('[data-testid=prompt]'); time.sleep(1)
    print('provider :', pg.locator('[data-testid=provider]').inner_text().replace('\n', ' ')[:80])
    pg.fill('[data-testid=prompt]', 'Ma console de ventes e-commerce : suivi du chiffre d’affaires et du tunnel de conversion, simulation de prix et alerte')
    t0 = time.time(); pg.click('[data-testid=generate]')
    pg.wait_for_selector('[data-testid=agent-summary]', timeout=900000)
    pg.wait_for_selector('[data-testid=generate]', timeout=120000)
    print(f'génération : {time.time() - t0:.0f} s'); time.sleep(5)
    pg.screenshot(path=OUT + '40-mercury-console-generee.png')
    fr = pg.frame_locator('iframe[data-testid=preview]')
    fr.locator('[data-testid=agent-input]').wait_for(timeout=60000)
    t1 = time.time()
    fr.locator('[data-testid=agent-input]').fill('visualise mon tunnel de conversion comme une machine')
    fr.locator('[data-testid=agent-send]').click()
    # le contremaître répond (scène directe ou délégation evolve_app → nouvelle version)
    deadline = time.time() + 900
    while time.time() < deadline:
        time.sleep(5)
        try:
            n = fr.locator('[data-testid=scene][data-ready=true]').count()
        except Exception:
            n = 0
        if n: print(f'scène prête en {time.time() - t1:.0f} s'); break
    else:
        print('pas de scène prête après 15 min')
    time.sleep(4)
    pg.screenshot(path=OUT + '41-mercury-tunnel-machine.png')
    try:
        print('chat :', fr.locator('[data-testid=chat-log]').inner_text()[-1500:])
    except Exception as e:
        print('chat illisible', e)
    print('erreurs console :', json.dumps(logs[-8:], ensure_ascii=False)[:1500])
    b.close()
