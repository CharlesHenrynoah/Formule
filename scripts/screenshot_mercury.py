"""Captures avec le vrai Mercury 3 (nécessite INCEPTION_API_KEY et LLM_PROVIDER=inception)."""
import sys, time, os, shutil
from playwright.sync_api import sync_playwright
URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"
OUT = os.path.join(os.path.dirname(__file__), "..", "screenshots")
chrome = shutil.which("google-chrome")
def shot(page, name):
    page.screenshot(path=os.path.join(OUT, name)); print("capture :", os.path.abspath(os.path.join(OUT, name)))
with sync_playwright() as p:
    b = p.chromium.launch(headless=True, executable_path=chrome)
    page = b.new_page(viewport={"width": 1600, "height": 1000})
    page.goto(URL); page.wait_for_selector('[data-testid="prompt"]'); time.sleep(1)
    page.check('[data-testid="diffusing"]')
    page.fill('[data-testid="prompt"]', "Un suivi d'habitudes quotidien avec séries et statistiques")
    page.click('[data-testid="generate"]')
    page.wait_for_function("() => document.body.innerText.includes('étape de diffusion') || document.body.innerText.includes('reprise en streaming')", timeout=120000)
    time.sleep(1.5)
    shot(page, "12-mercury3-diffusion-reelle.png")
    page.wait_for_selector('[data-testid="validation"]', timeout=180000)
    page.wait_for_function("() => !document.body.innerText.includes('Génération en direct') && !document.body.innerText.includes('Diffusion ·')", timeout=180000)
    time.sleep(2)
    shot(page, "13-mercury3-app-generee.png")
    b.close()
