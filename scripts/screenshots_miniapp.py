"""Captures « mini-SaaS » : app générée (front + backend MCP + sous-agent), onglets Backend MCP et Agent.
Usage : python3 scripts/screenshots_miniapp.py <url> <préfixe> "<prompt>" [fichier.csv|json à importer]"""
import sys, time
from playwright.sync_api import sync_playwright

url, prefix, prompt = sys.argv[1], sys.argv[2], sys.argv[3]
data_file = sys.argv[4] if len(sys.argv) > 4 else None
OUT = 'screenshots/'

def frame(pg):
    return pg.frame_locator('[data-testid=preview]')

with sync_playwright() as pw:
    b = pw.chromium.launch(channel='chrome')
    pg = b.new_context(viewport={'width': 1600, 'height': 980}).new_page()
    pg.goto(url); pg.wait_for_selector('[data-testid=prompt]'); time.sleep(1)
    if data_file:
        pg.set_input_files('[data-testid=dataset-input]', data_file); time.sleep(0.8)
    pg.fill('[data-testid=prompt]', prompt)
    t0 = time.time()
    pg.click('[data-testid=generate]')
    try:
        pg.wait_for_selector('[data-testid=agent-contract]', timeout=300000); time.sleep(1)
        pg.screenshot(path=OUT + f'{prefix}-contrat-en-cours.png')
    except Exception as e:
        print('pas de capture du contrat', e)
    pg.wait_for_selector('[data-testid=agent-summary]', timeout=900000)
    pg.wait_for_selector('[data-testid=generate]', timeout=120000)
    print(f'génération : {time.time() - t0:.1f} s')
    time.sleep(5)
    pg.screenshot(path=OUT + f'{prefix}-studio-app.png')
    pg.locator('[data-testid=preview]').screenshot(path=OUT + f'{prefix}-apercu.png')
    # Fonction « intelligente » : l'agent de l'app agit via son backend MCP
    f = frame(pg)
    try:
        btn = f.get_by_role('button').filter(has_text='Ajoute').first
        if btn.count():
            btn.click()
        else:
            inp = f.locator('input').last
            inp.fill('Résume mes données et propose une amélioration'); inp.press('Enter')
        time.sleep(1.5)
        if pg.locator('[data-testid=confirm-dialog]').count():
            pg.screenshot(path=OUT + f'{prefix}-confirmation-agent.png')
            pg.get_by_role('button', name='Autoriser').click()
        time.sleep(9)
        pg.locator('[data-testid=preview]').screenshot(path=OUT + f'{prefix}-agent-dans-app.png')
    except Exception as e:
        print('agent dans app :', e)
    # Onglet Backend MCP : outils + schémas + test manuel
    pg.click('[data-testid=tab-backend]'); pg.wait_for_selector('[data-testid=backend-panel]', timeout=30000); time.sleep(1)
    tools = pg.locator('[data-testid=backend-tool]')
    for i in range(tools.count()):
        if 'stat' in tools.nth(i).inner_text().lower() or 'list' in tools.nth(i).inner_text().lower():
            tools.nth(i).click(); break
    time.sleep(0.5)
    pg.click('[data-testid=backend-run]'); pg.wait_for_selector('[data-testid=backend-result]', timeout=20000); time.sleep(0.8)
    pg.screenshot(path=OUT + f'{prefix}-onglet-backend-mcp.png')
    # Onglet Agent : instructions, mémoire, journal + graphique
    pg.click('[data-testid=tab-app-agent]'); pg.wait_for_selector('[data-testid=app-agent-panel]', timeout=30000)
    pg.fill('[data-testid=agent-test-input]', 'Retiens que je préfère traiter les priorités hautes le matin')
    pg.click('[data-testid=agent-test-send]'); time.sleep(8)
    pg.screenshot(path=OUT + f'{prefix}-onglet-agent.png')
    # Code : backend MCP généré
    pg.click('[data-testid=tab-code]'); time.sleep(0.8)
    try:
        pg.click('[data-testid=code-file]'); pg.get_by_role('option', name='server/tools.ts').click(); time.sleep(0.8)
        pg.screenshot(path=OUT + f'{prefix}-code-backend.png')
    except Exception as e:
        print('code backend :', e)
    b.close()
