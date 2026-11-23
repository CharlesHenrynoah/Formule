"""Captures d'écran de l'UI (Playwright headless). Prérequis : npm run dev, `pip install playwright`.
Usage : python3 scripts/screenshots.py [http://localhost:5173]"""
import sys, time, os, shutil
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"
OUT = os.path.join(os.path.dirname(__file__), "..", "screenshots")
os.makedirs(OUT, exist_ok=True)
chrome = shutil.which("google-chrome") or shutil.which("chromium")

def shot(page, name):
    path = os.path.join(OUT, name)
    page.screenshot(path=path)
    print("capture :", os.path.abspath(path))

def wait_done(page, timeout=60000):
    page.wait_for_selector('[data-testid="validation"]', timeout=timeout)
    page.wait_for_function("() => !document.querySelector('[data-testid=\"code-stream\"]') && !document.body.innerText.includes('Génération en direct')", timeout=timeout)
    time.sleep(0.8)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path=chrome) if chrome else p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1600, "height": 1000}, device_scale_factor=1)
    page.goto(URL)
    page.wait_for_selector('[data-testid="prompt"]')
    time.sleep(1)
    shot(page, "01-accueil.png")

    # 1) Génération streamée
    page.fill('[data-testid="prompt"]', "Une calculatrice")
    page.click('[data-testid="generate"]')
    page.wait_for_function("() => document.querySelector('[data-testid=\"plan\"]').innerText.length > 120", timeout=20000)
    time.sleep(0.4)
    shot(page, "02-streaming-plan.png")
    page.click('[data-testid="tab-code"]')
    time.sleep(1.2)
    shot(page, "03-streaming-code.png")
    wait_done(page)
    page.click('[data-testid="tab-preview"]')
    frame = page.frame_locator('[data-testid="preview"]')
    for k in ["7", "*", "8", "="]:
        frame.locator(f'button[data-k="{k}"]').click()
    time.sleep(0.5)
    shot(page, "04-apercu-interactif.png")

    # 2) Itération
    page.fill('[data-testid="iterate-input"]', "passe en thème clair, couleur verte")
    page.click('[data-testid="iterate"]')
    wait_done(page)
    frame = page.frame_locator('[data-testid="preview"]')
    for k in ["1", "2", "+", "3", "0", "="]:
        frame.locator(f'button[data-k="{k}"]').click()
    time.sleep(0.4)
    shot(page, "05-iteration.png")

    # 3) Mode diffusion (Mercury) sur une nouvelle app
    page.click("text=+ Nouvelle app")
    page.check('[data-testid="diffusing"]')
    page.fill('[data-testid="prompt"]', "Un minuteur pomodoro")
    page.click('[data-testid="generate"]')
    page.wait_for_function("() => document.body.innerText.includes('étape de diffusion')", timeout=20000)
    time.sleep(0.5)
    shot(page, "06-diffusion.png")
    wait_done(page)
    page.uncheck('[data-testid="diffusing"]')

    # 4) MCP : outil utilisé à la génération puis à l'exécution
    page.click("text=+ Nouvelle app")
    page.fill('[data-testid="prompt"]', "Une app météo pour Lyon")
    page.click('[data-testid="generate"]')
    wait_done(page)
    frame = page.frame_locator('[data-testid="preview"]')
    frame.locator("text=Lyon").first.wait_for(timeout=10000)
    time.sleep(0.8)
    shot(page, "07-mcp-meteo.png")
    frame.locator("#save").click()
    page.wait_for_selector('[data-testid="confirm-dialog"]', timeout=10000)
    time.sleep(0.3)
    shot(page, "08-mcp-confirmation.png")
    page.click("text=Autoriser")
    frame.locator("text=enregistrée").wait_for(timeout=10000)
    time.sleep(0.4)
    shot(page, "09-mcp-ecriture-executee.png")

    # 5) Panneau MCP
    page.click('[data-testid="mcp-button"]')
    page.wait_for_selector('[data-testid="mcp-panel"]')
    time.sleep(0.6)
    shot(page, "10-panneau-mcp.png")
    page.keyboard.press("Escape")
    page.mouse.click(5, 5)

    # 6) Éditeur de code + historique
    page.click('[data-testid="tab-code"]')
    time.sleep(0.4)
    shot(page, "11-editeur-code.png")
    browser.close()
