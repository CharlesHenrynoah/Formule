"""Captures du studio shadcn + panneau d'équipe d'agents.
Usage : python3 scripts/screenshots_agent.py <url> <préfixe> "<prompt>" [fichier_access]
Le mot de passe éventuel est lu depuis le fichier .access et n'est jamais affiché."""
import sys, time
from playwright.sync_api import sync_playwright

url, prefix, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
creds = None
if len(sys.argv) > 4:
    u, p = open(sys.argv[4]).read().strip().split(':', 1)
    creds = {'username': u, 'password': p}
OUT = 'screenshots/'

with sync_playwright() as pw:
    b = pw.chromium.launch(channel='chrome')
    ctx = b.new_context(viewport={'width': 1600, 'height': 960}, http_credentials=creds, device_scale_factor=1)
    pg = ctx.new_page()
    pg.goto(url); pg.wait_for_selector('[data-testid=prompt]'); time.sleep(1)
    if prefix.startswith('14'):
        pg.screenshot(path=OUT + '14-studio-shadcn-accueil.png')
    pg.fill('[data-testid=prompt]', prompt)
    t0 = time.time()
    pg.click('[data-testid=generate]')
    # en cours : panneau agent pendant le travail du Développeur
    try:
        pg.wait_for_selector('[data-testid=agent-cli]', timeout=240000); time.sleep(1.2)
        pg.screenshot(path=OUT + f'{prefix}-agent-en-cours.png')
    except Exception as e:
        print('pas de capture en cours', e)
    pg.wait_for_selector('[data-testid=agent-summary]', timeout=600000)
    pg.wait_for_selector('[data-testid=generate]', timeout=60000)
    print(f'génération : {time.time() - t0:.1f} s')
    time.sleep(4)
    pg.screenshot(path=OUT + f'{prefix}-agent-termine.png')
    # brief données déplié en haut du panneau
    pg.locator('[data-testid=agent-brief]').first.scroll_into_view_if_needed(); time.sleep(0.5)
    pg.locator('[data-testid=agent-panel]').screenshot(path=OUT + f'{prefix}-brief-data-engineer.png')
    # aperçu seul
    pg.locator('[data-testid=preview]').screenshot(path=OUT + f'{prefix}-app-shadcn.png')
    # code source
    pg.click('[data-testid=tab-code]'); time.sleep(1)
    pg.screenshot(path=OUT + f'{prefix}-code-source.png')
    b.close()
