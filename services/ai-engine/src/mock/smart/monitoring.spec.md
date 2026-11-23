# Console ventes
> Mini-SaaS personnel, mindset DJ, layout salle de contrôle : à gauche le dashboard live (tout en données visuelles), à droite le chat du contremaître qui reçoit mes ordres (analyses, simulations, actions confirmées, évolutions de l'app). Zéro saisie, zéro bouton d'action.

## User stories
- **Surveiller** — Je veux un dashboard « salle de contrôle » de mes ventes rafraîchi en live (tuiles KPI, jauges vs seuils, combo commandes + CA, tendance à onglets, heatmap), afin de sentir le rythme sans rien saisir.
- **Surveiller** — Je veux que le contremaître me signale de lui-même dans le chat tout seuil franchi ou anomalie, et m'explique « pourquoi ça baisse » en allant chercher l'info dans mes MCP (métriques, ventes par produit, stock) avec ses sources.
- **Simuler** — Je veux dire « simule +10 % de prix » et voir le scénario se superposer au réel projeté (ou tourner les sliders moi-même), recalculé instantanément.
- **Agir** — Je veux ordonner « envoie une alerte » ou « applique +5 % » dans le chat, valider par une carte oui/non, et retrouver l'action dans le journal.
- **Évoluer** — Je veux demander « ajoute un panneau de marge par produit » dans le même chat : le contremaître délègue à l'équipe, une nouvelle version s'affiche à chaud.
- **Mémoire** — Je veux que le contremaître retienne mes objectifs et en tienne compte dans ses contrôles.

## Critères d'acceptation
- CA1 : layout AppShell : dashboard (≈ 72 %) + chat contremaître (≈ 28 %), thème salle de contrôle, aucun formulaire de saisie ni bouton d'action.
- CA2 : source MCP `demo__get_metrics` rafraîchie automatiquement (useLive), historisée via `ingest_metrics`.
- CA3 : panneaux shadcn Charts : jauges radiales, tuiles KPI, barres horizontales, combo barres + courbe, tendance à onglets, heatmap, tableau compact, journal.
- CA4 : simulation `simulate_scenario` recalculée à chaque changement (sliders ou patch du contremaître).
- CA5 : le chat pilote le dashboard (`set_dashboard` : scénario, onglet, focus, panneau temporaire), affiche plan de chantier et étapes repliables, et des cartes de confirmation pour les actions.
- CA6 : alertes de surveillance proactives dans le chat.

## Écrans
- **Dashboard** : ligne 1 tuiles + jauges ; ligne 2 combo + barres horizontales ; ligne 3 tendance à onglets + heatmap ; ligne 4 simulation (sliders + mix) + 7 derniers jours + journal.
- **Chat** : contremaître (plan, étapes 🔎/🖥️, confirmations, alertes, progression de l'équipe), suggestions d'ordres.

## Composants shadcn
chart, slider, tabs, button, sonner, tooltip

## Contrat
```json
{
  "entities": [
    { "name": "metrics", "fields": { "date": "string", "commandes": "number", "prix_moyen": "number", "ca_eur": "number", "visiteurs": "number", "conversion_pct": "number" } },
    { "name": "presets", "fields": { "name": "string", "params": "object", "ecart_ca_pct": "number" } },
    { "name": "actions", "fields": { "action": "string", "details": "string", "statut": "string", "origine": "string" } }
  ],
  "tools": [
    { "name": "ingest_metrics", "kind": "store", "description": "Historise les points lus sur les decks MCP", "input": { "points": { "type": "array" } }, "write": true, "safe": true },
    { "name": "get_kpis", "kind": "read", "description": "VU-mètres : KPIs du jour vs moyenne et seuils", "input": { "window": { "type": "integer", "optional": true } } },
    { "name": "get_series", "kind": "read", "description": "Historique pour la waveform", "input": { "days": { "type": "integer", "optional": true } } },
    { "name": "detect_anomalies", "kind": "read", "description": "Anomalies + cause probable", "input": { "z": { "type": "number", "optional": true } } },
    { "name": "forecast", "kind": "simulate", "description": "Prévision commandes / CA", "input": { "days": { "type": "integer", "optional": true } } },
    { "name": "simulate_scenario", "kind": "simulate", "description": "What-if instantané prix / trafic / élasticité", "input": { "price_change_pct": { "type": "number" }, "traffic_change_pct": { "type": "number", "optional": true }, "elasticity": { "type": "number", "optional": true }, "days": { "type": "integer", "optional": true }, "name": { "type": "string", "optional": true } } },
    { "name": "save_preset", "kind": "store", "description": "Sauve une scène (knobs + crossfader)", "input": { "name": { "type": "string" }, "params": { "type": "object" } }, "write": true, "safe": true },
    { "name": "list_presets", "kind": "read", "description": "Scènes sauvegardées", "input": {} },
    { "name": "suggest_next_move", "kind": "read", "description": "Co-DJ : prochain mouvement", "input": { "price_change_pct": { "type": "number", "optional": true } } },
    { "name": "set_thresholds", "kind": "store", "description": "Réglage des seuils des VU-mètres", "input": { "commandes_min": { "type": "number", "optional": true }, "conversion_min": { "type": "number", "optional": true } }, "write": true, "safe": true },
    { "name": "log_action", "kind": "store", "description": "Journal des actions", "input": { "action": { "type": "string" }, "details": { "type": "string", "optional": true }, "statut": { "type": "string", "optional": true }, "origine": { "type": "string", "optional": true } }, "write": true, "safe": true },
    { "name": "get_action_log", "kind": "read", "description": "Lecture du journal", "input": {} }
  ],
  "agent": {
    "name": "Contremaître ventes",
    "persona": "Contremaître du pipeline de tes ventes : il décompose tes ordres, fait travailler les outils MCP, contrôle les résultats, te rend compte avec ses sources et te souffle le prochain mouvement, mindset DJ.",
    "capabilities": ["expliquer une variation de KPI (pourquoi ça baisse)", "lancer des simulations prix/trafic et les comparer au réel", "proposer le prochain mouvement", "déclencher les pads d'action après confirmation", "retenir mes objectifs et préférences"],
    "guardrails": ["jamais d'action externe sans confirmation explicite", "toujours chiffrer : valeurs, variations, écart scénario vs réel"],
    "tools": ["get_kpis", "get_series", "detect_anomalies", "forecast", "simulate_scenario", "list_presets", "save_preset", "suggest_next_move", "set_thresholds", "log_action", "get_action_log"]
  },
  "charts": ["area : waveform commandes réel + prévision (get_series, forecast)", "line : CA scénario vs prévu (simulate_scenario.serie)", "radial/progress : VU-mètres KPIs vs seuils (get_kpis)"],
  "dashboard": {
    "panels": [
      { "id": "kpis", "type": "kpi", "title": "Tuiles KPI + jauges", "tools": ["get_kpis"] },
      { "id": "combo", "type": "combo", "title": "Commandes & CA 30 j", "tools": ["get_series", "detect_anomalies"] },
      { "id": "dow", "type": "hbar", "title": "Moyenne par jour de semaine", "tools": ["get_series"] },
      { "id": "trend", "type": "multiline", "title": "Tendance à onglets", "tools": ["get_series", "forecast"] },
      { "id": "heatmap", "type": "heatmap", "title": "Heatmap 4 semaines", "tools": ["get_series"] },
      { "id": "simulation", "type": "simulation", "title": "What-if prix/trafic", "tools": ["simulate_scenario"] },
      { "id": "table", "type": "table", "title": "7 derniers jours", "tools": ["get_series"] },
      { "id": "journal", "type": "log", "title": "Journal des actions", "tools": ["get_action_log"] }
    ],
    "state": { "scenario": "{ price_change_pct, traffic_change_pct, elasticity }", "crossfader": "0-100 réel ↔ scénario", "metric": "commandes | ca_eur | conversion_pct | visiteurs", "focus": "id de panneau à mettre en avant", "panel": "panneau temporaire { type, title, data[{label,value}] }" }
  },
  "chat": {
    "commands": [
      { "example": "Pourquoi les ventes ont baissé ? Quel produit, et est-il en stock ?", "does": "retrieval multi-MCP (métriques, ventes par produit, ressource catalogue) + panneau temporaire" },
      { "example": "Simule +10 % de prix", "does": "simulate_scenario + set_dashboard scenario/focus" },
      { "example": "Alerte si commandes < 100", "does": "set_thresholds + surveillance continue" },
      { "example": "Envoie une alerte", "does": "demo__send_alert (carte de confirmation) + log_action" },
      { "example": "Compare cette semaine et la semaine dernière", "does": "get_series + panneau temporaire" },
      { "example": "Ajoute un panneau de marge par produit", "does": "evolve_app → équipe DE/PO/Dev, nouvelle version" }
    ]
  },
  "console": {
    "decks": [{ "label": "Ventes", "tool": "demo__get_metrics", "args": { "source": "ventes", "days": 30 } }],
    "knobs": [
      { "param": "price_change_pct", "label": "Prix", "min": -20, "max": 20, "step": 1, "default": 0 },
      { "param": "traffic_change_pct", "label": "Trafic", "min": -30, "max": 30, "step": 1, "default": 0 },
      { "param": "elasticity", "label": "Élasticité", "min": -3, "max": 0, "step": 0.1, "default": -1.6 }
    ],
    "crossfader": "réel projeté ↔ scénario",
    "refreshSec": 15
  },
  "externalTools": ["demo__get_metrics", "demo__get_funnel", "demo__send_alert", "demo__set_price"]
}
```
