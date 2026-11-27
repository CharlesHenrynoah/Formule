# FORMULE — interface universelle de pilotage

Tu décris l'interface que tu veux voir. Formule découvre les capacités MCP **réellement autorisées**, lit des données vérifiables, te montre ce qu'il a lu, attend ton **Valider**, puis construit, certifie et publie une application. Elle évolue par versions, sans jamais perdre la dernière version certifiée.

Monorepo TypeScript, Node ≥ 22.13, mono-utilisateur, local.

```bash
npm install
cp .env.example .env && chmod 600 .env   # facultatif : clé LLM
npm run dev                              # Studio : http://127.0.0.1:5173
npm run health                           # health agrégé (gateway :4000/health)
npm test                                 # 55 tests : invariants + cas P0
```

Sans clé, tout fonctionne en **mode démo** (badge « Démo » dans la barre du champ) : la compréhension est déterministe et ne prétend jamais avoir lu une source.

---

## Parcours

1. **Demande** : « Crée une interface du revenu du mois… » (bouton **Générer**, Entrée pour envoyer, Maj+Entrée pour aller à la ligne). Une question simple (« Quel est le revenu du mois ? ») reçoit une réponse factuelle et **ne crée pas d'écran**.
2. **Sourcing avant construction** : Formule Agent répond par ce qu'il a réellement lu (sources, lignes, heure, couverture, exigences couvertes ou manquantes). **Valider** n'est actif que si au moins une mesure demandée est portée par une lecture réelle. **Rejeter** arrête tout : rien n'est construit sans ce oui.
3. **Construction observable** (flux SSE ordonné par `seq`, repris par `Last-Event-ID` : une reconnexion ne relance jamais un second job) : Analyse des données → Conception → Construction → Vérification. **Arrêter** coupe le travail ; la version enregistrée ne bouge pas.
4. **Certification par portes** G0–G7. Une porte obligatoire ratée bloque (pas de score moyen). Réponses types :
   - `Application créée et certifiée : 4/4 exigences. Dernière lecture : 23:41.`
   - `4/5 exigences ; coût d'acquisition client (CAC) manque. Non certifiée complète.`
5. **Vivre avec l'interface** : **Ask** (lecture : « Quel est le taux de conversion ? » → `15,32 %, observé à 23:28, source …`) ou **Agent** (« Ajoute un classement par client », « Retire la colonne statut », « Simule +5 % », « Renomme en … », « Mets en pause la campagne la moins rentable »). Une demande d'écriture en Ask est refusée, avec l'invitation à passer en Agent.
6. **Actions** : carte dans le fil (action, arguments, **Oui, exécuter** / **Non**). Le jeton de confirmation est lié aux arguments exacts : toute modification l'invalide (HTTP 428/409). Après un délai d'écriture dépassé, l'état devient « incertain » et **rien n'est renvoyé**.
7. **Versions** : sélecteur v1, v2… dans l'en-tête du panneau, restauration d'une version publiée, historique à gauche (renommer, dupliquer, exporter, archiver, supprimer avec confirmation). La réouverture ne rejoue aucune action.
8. **Journal** (colonne de gauche) : déroulé réel de chaque génération, portes de certification, sans chaîne de pensée simulée.

## Ports

| Service | Port | Rôle |
|---|---|---|
| frontend (Vite, React 19, Tailwind 4, composants façon shadcn) | 5173 | Studio |
| api-gateway (Fastify) | 4000 | REST + SSE, pont des apps, actions, Basic Auth en mode public. **Seul service joint par le navigateur** |
| ai-engine | 4001 | Orchestration, découverte, contrats, génération, évaluation |
| validator | 4002 | Contrôles statiques de la spec et du HTML généré |
| storage (`node:sqlite`) | 4003 | Projets, versions, jobs, événements, snapshots, conversation |
| mcp-hub | 4004 | **Seule autorité d'appel MCP** (liste blanche, confirmations, snapshots) |
| app-agents | 4005 | Backend MCP de chaque app (`/apps/:id/mcp`) + agent local |
| voice-gateway | 4006 | Arbitrage des confirmations vocales, STT/TTS serveur si clé OpenAI |

Chaque service expose `GET /health` ; `GET :4000/health` agrège.

## LLM

Ordre de résolution (lu dans `.env`, jamais journalisé ni envoyé au navigateur ou aux apps) :

1. `INCEPTION_API_KEY` → **Inception Mercury** (`https://api.inceptionlabs.ai/v1`, modèle `mercury-3`, `reasoning_effort: medium`). Variables facultatives : `FORMULE_MODEL`, `INCEPTION_REASONING_EFFORT`, `INCEPTION_BASE_URL`.
2. `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`) → tout fournisseur OpenAI-compatible.
3. Aucune clé → mock déterministe (mode démo).

Le LLM **propose** des exigences (mots-clés d'outils et de champs) ; le code vérifie tout : outil présent dans le catalogue réel, permission, champs présents dans le brut, liaison vérifiée dans le DOM. Si le LLM est injoignable ou répond hors JSON, Formule le dit (`GET :4001/llm`) et revient à la compréhension déterministe. Le Studio n'affiche jamais le nom du modèle.

## MCP

- **Panneau MCP** (bouton en bas du champ, avec le nombre d'outils autorisés) : activer/désactiver un serveur, classer chaque outil en *Refusé / Lecture / Écriture*, ajouter un serveur **HTTP streamable** ou **SSE** avec jeton Bearer. Le jeton n'est plus jamais affiché qu'en `••••` + 4 derniers caractères.
- **Refus par défaut** : un outil non classé est refusé. Les annotations du fournisseur (`readOnlyHint`…) sont affichées comme indices, jamais comme autorisations.
- **stdio** : désactivé depuis l'UI (`FORMULE_ALLOW_STDIO_UI=1` pour l'autoriser). Ajout par la ligne de commande :

```bash
# serveurs officiels, données publiques réelles (vega-datasets)
npm i --prefix ~/mcp @modelcontextprotocol/server-filesystem @modelcontextprotocol/server-everything @modelcontextprotocol/server-memory vega-datasets
npm run mcp:add -- --id fs --name "Fichiers" --read read_text_file,list_allowed_directories \
  -- node ~/mcp/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js ~/mcp/node_modules/vega-datasets/data
npm run mcp:add -- --id everything --name "MCP Everything" --read get-structured-content \
  -- node ~/mcp/node_modules/@modelcontextprotocol/server-everything/dist/index.js
npm run mcp:add -- --id memory --name "Mémoire" --read read_graph,search_nodes \
  -- node ~/mcp/node_modules/@modelcontextprotocol/server-memory/dist/index.js
npm run e2e:real   # parcours contre ces serveurs réels
```

- **Serveurs « code mode »** (un seul outil `execute`, ex. CoinGecko v9) : Formule n'envoie **jamais** de code écrit par le modèle. Il n'envoie que des **gabarits relus** (`services/ai-engine/src/discovery/code-adapters.ts`) dont les paramètres sont validés (identifiants `[a-z0-9-]`, devise sur liste, bornes). Tout autre outil exigeant du code est refusé avec la raison.
- **CoinGecko** (testé sur le serveur MCP officiel `@coingecko/coingecko-mcp`, SDK réel, bac à sable Deno réel) :

```bash
npm i --prefix ~/mcp @coingecko/coingecko-mcp deno@2.8.3        # Deno ≤ 2.8 : la 2.9 refuse le socket du bac à sable
export COINGECKO_DEMO_API_KEY=CG-…                              # clé démo gratuite (coingecko.com/api)
npm run mcp:add -- --id coingecko --name "CoinGecko" --read execute,search_docs \
  --secret-env COINGECKO_DEMO_API_KEY --env "COINGECKO_ENVIRONMENT=demo,PATH=$HOME/mcp/node_modules/.bin:/usr/local/bin:/usr/bin:/bin" \
  -- node ~/mcp/node_modules/@coingecko/coingecko-mcp/index.js
```

  Demandes reconnues : « top 10 des cryptos en euros », « historique du bitcoin sur 90 jours avec une simulation », « quel est le prix de l'ethereum en dollars ? ». La clé est stockée dans `data/secrets/secrets.json` (chmod 600), jamais dans `servers.json`, et n'apparaît qu'en `NOM=••••`. Variables : `--env` (non secrètes), `--secret-env` (lues dans ton environnement au moment de l'enregistrement), `--demo true` pour marquer un serveur de données synthétiques.
- **Arguments obligatoires** : pris dans la demande (nom de fichier `seattle-weather.csv`, valeur d'énumération citée, texte entre « guillemets », nombres) ou découverts par un outil de lecture du même serveur (`list_allowed_directories`). Jamais inventés : sinon Formule nomme l'argument manquant.
- **Résultats** : `structuredContent` en priorité, sinon JSON du texte, sinon CSV (conversion **déclarée** dans la couverture), sinon texte = documentation, **jamais une mesure**.
- **Pagination** suivie dans un budget (10 pages) ; au-delà, couverture partielle affichée.
- **Fichiers joints** (CSV/JSON, 3 max) : restent sur la machine, exposés comme source en lecture seule « Fichiers joints ».
- Serveur **démo** intégré (`servers/demo-mcp`, stdio) : revenus, pipeline, publicités, inscriptions. Données synthétiques **marquées démo** partout (badge DÉMO, provenance « (démo) »).

## Demandes complexes : ne pas échouer

Une demande en sections (« 1. Indicateurs », « 2. Radar »…, comme *AI Intelligence Monitor* dans `packages/formule-bench/fixtures/`) n'est jamais bloquée par un argument manquant :

- **Arguments synthétisés depuis le schéma** (`services/ai-engine/src/discovery/args-synth.ts`) : énumérations rapprochées du français (*tendance* → `trendingScore`, *modèles* → `model`), « top 20 » → `limit`, défauts du schéma, **exemples publiés par le serveur dans la description de l'outil** (validés contre le schéma, choisis selon l'intention, jamais s'ils citent un identifiant précis absent de la demande), puis proposition du LLM validée contre le schéma.
- **Une source par section**, choisie en lisant les candidats et en gardant celle dont les champs réels couvrent le plus de puces ; périmètre limité aux serveurs désignés (« Utilise `outil` pour … ») ou nommés ; outils exclus (« N'utilise pas `x` ») jamais appelés, même avec une faute de frappe.
- **Réponses Markdown** converties (enregistrements « ### » + « **Clé :** valeur », tableaux, nombres abrégés signalés « ≈ approx. », tags `clé:valeur`).
- **Livraison de ce qui existe** : chaque puce devient une exigence ; sans champ réel, elle est affichée « Donnée indisponible » avec la raison, et l'app est livrée « partielle » plutôt que bloquée.
- **Style demandé** appliqué à l'app : accent (orange…), police monospace, fond graphite, navigation latérale par section, filtres de catégories, liens vers les sources (HTTPS, ouverts par le Studio).

`npm run e2e:sections` rejoue ce scénario. Serveur de test de contrat : `servers/hf-contract-mcp` (noms, schémas, descriptions et formats du serveur Hugging Face, valeurs synthétiques) :

```bash
npm run mcp:add -- --id huggingface --name "Hugging Face (test de contrat)" --demo true \
  --read hub_repo_search,hub_repo_details,hf_fs,hf_whoami -- node --import tsx "$PWD/servers/hf-contract-mcp/src/index.ts"
```

Avec le vrai serveur : ajoute `https://huggingface.co/mcp` en HTTP depuis le panneau MCP (jeton facultatif), puis coche les outils en lecture.

## Cœur agnostique et packs

Le moteur ne connaît aucun fournisseur MCP. Il lit le catalogue (`tools/list`), le schéma JSON des arguments, les exemples publiés par le serveur et la forme réelle des réponses. Tout savoir propre à un service vit dans un **pack** JSON optionnel, dans `packs/` (ou `data/packs/`, ou `FORMULE_PACKS_DIR`) :

- `recipes` / `knownMissing` : indicateurs métier prêts à l’emploi ;
- `taxonomies` : regroupements de catégories pour les filtres ;
- `codeTemplates` : gabarits de code **relus** pour les outils qui exigent du code (aucun code écrit par le modèle n’est envoyé) ;
- `synonyms` : vocabulaire de la demande vers les valeurs d’énumération.

Un pack ne s’active que si ses outils sont présents au catalogue. Sans pack, tout fonctionne quand même : arguments synthétisés depuis le schéma, filtres dérivés des valeurs réelles, source choisie par preuve discriminante. Un outil qui exige du code sans pack est refusé avec une raison lisible. `FORMULE_PACKS_DISABLED=1` désactive tous les packs.

## Moteur de graphiques

`services/ai-engine/src/semantic/charts.ts` choisit les graphiques en trois temps :

1. **Profil** des données lues : mesures, catégories (2–24 valeurs), temps, noms, signe, additivité, asymétrie, champs cités dans la demande (vocabulaire FR↔EN).
2. **Intentions** de la demande : tendance, part, classement, distribution, corrélation, comparaison, calendrier.
3. **Recommandation notée** : adéquation données × intention × champs cités ; une vue par famille d’abord, pas de doublon sur les mêmes champs, budget par source (5, ou 4 par section).

Règles de lisibilité : camembert seulement sur une mesure additive et ≤ 8 parts ; barres divergentes pour une mesure signée ; histogramme seulement avec ≥ 10 points ; calendrier seulement avec ≥ 20 jours ; jamais de courbe sur un instantané.

## Où vont les secrets

| Secret | Emplacement |
|---|---|
| Clé LLM | `.env` à la racine (ignoré par git, `chmod 600`) ou variables d'environnement |
| Jetons MCP | `data/secrets/secrets.json` (`chmod 600`) ou `FORMULE_SECRET_<ID>` |
| Clé de signature des confirmations, clé « humain » de la gateway | même fichier, générées au premier démarrage |

Jamais dans les logs (expurgation pino + `redact()`), les événements, les prompts, les bundles d'app (contrôle du validateur) ni le navigateur. Le processus stdio d'un serveur MCP reçoit un environnement nettoyé.

## Design

- **Noir et blanc**, façon OpenAI / Apple : polices système (SF Pro sur Mac, repli Geist/Inter), chiffres tabulaires, boutons pilules, cartes très arrondies, verre dépoli pour les panneaux, libellés en casse normale. Aucun accent décoratif : l'état actif est blanc.
- **La couleur est réservée aux graphiques**, et elle est **dynamique** : palette OKLCH aux teintes vives (bleu, vert, orange, rose, violet, cyan, jaune, rouge façon couleurs système), dont le point de départ dépend de l'interface (titre + accent) et qui reste distincte quel que soit le nombre de séries (angle d'or au-delà de 8). Les barres de comptage et le calendrier utilisent une rampe d'intensité selon la valeur.
- **Plusieurs graphiques par page, de toutes formes**, choisis d'après le contrat réel des données : KPI avec mini-courbe (et jauge pour les %), courbes, anneau de répartition, barres, classement, histogramme, nuage de points (avec coefficient r), calendrier quotidien, simulation en éventail, tableau.
- Graphiques **shadcn/ui `chart`** (Recharts). Le composant est préinstallé dans le gabarit (`packages/app-runtime/src/components/ui/chart.tsx`, `components.json`) pour fonctionner hors ligne ; `npm run shadcn:chart -w @formule/app-runtime` lance `npx shadcn@latest add chart --yes`. Dans le workspace de génération, l'agent exécute `shadcn add` via `execFile` sur **liste blanche** (`FORMULE_SHADCN_ALLOW`, défaut `chart`, ex. `chart,@shadcn-dashboard/sales-trend-chart`) seulement si `FORMULE_SHADCN_ONLINE=1` et si le composant manque.

## Applications générées

- **Contrat avant le code** : le moteur écrit une spec typée (`packages/contracts/src/spec.ts`) ; elle est compilée par un gabarit Vite + React + Tailwind 4 (`packages/app-runtime`) en **un seul `index.html`** (vite-plugin-singlefile), dans un workspace isolé par génération (écriture limitée à `src/**` et `index.html`, `execFile` sans shell, env sans clé, délai borné).
- **Instruments selon le besoin** : KPI (valeur, unité, fraîcheur), courbe (trous conservés, horodatage natif, infobulle), tableau (tri, filtre, pagination), classement (métrique + population), simulation, actions typées.
- **Simulations** : éventail pessimiste / central / optimiste autour de la dernière observation, repère « Aujourd'hui », projection par période, animation à chaque changement d'hypothèse, préréglages, fenêtre 60/180/tout. Hypothèses listées, aucun effet externe, calcul reproductible, toujours étiqueté SCÉNARIO.
- **États** : initial, chargement, prêt, vide, partiel, obsolète, erreur, indisponible ; toute erreur propose une action. Une panne d'actualisation garde la dernière donnée **marquée obsolète**.
- **Sécurité** : iframe `sandbox="allow-scripts allow-forms"` **sans** `allow-same-origin`, CSP `connect-src 'none'`, pont `postMessage` filtré par `event.source`, liste blanche = requêtes de la version certifiée + outils `app__*`, 60 appels/min, arguments ≤ 20 Ko et identiques à ceux déclarés. Un aperçu non certifié ne peut déclencher aucune action.

## Certification

| Porte | Contrôle |
|---|---|
| G0 | Outils du catalogue réel, lectures classées « read », actions classées « write » |
| G1 | Lecture réelle réussie, empreinte du brut, pas de documentation seule, couverture déclarée |
| G2 | Spec valide ; chaque chemin lié existe dans le contrat, est numérique, sans unités mélangées |
| G3 | Build vite OK + validateur HTML (scripts externes, cookies, `window.top`, URL inconnues, secrets) |
| G4 | Calcul de l'app = **oracle indépendant** (implémentation séparée) |
| G5 | jsdom dans un processus fils non privilégié : chaque vue présente, valeur du DOM = valeur attendue, tri testé, pas d'écran blanc |
| G6 | Exigences obligatoires couvertes (vue vérifiée dans le DOM) et données de moins de 24 h |
| G7 | Vues non demandées strictement inchangées, publication possible, version précédente restaurable |

Réparation bornée (1 tentative) : les vues mal liées sont retirées et leurs exigences nommées comme manquantes.

## Tests

- `npm test` — 55 tests : machine à états, enveloppes, confirmations, certification, stockage (promotion atomique, restauration, isolation), validateur, pont, voix, LLM, et `packages/formule-bench` (cas P0).
- `npm run e2e` — parcours complet contre une instance lancée (démo) : question simple, refus en Ask, création, certification, évolution sans recollecte, non-régression, livraison partielle, action confirmée, arguments modifiés refusés, pas de double exécution.
- `npm run e2e:real` — contre les serveurs MCP officiels : CSV réels (1 461 jours de météo de Seattle, CO₂ de Mauna Loa), objet structuré, argument manquant non inventé, graphe vide.
- CoinGecko : chaîne réelle (serveur MCP officiel → SDK → Deno → gabarit) validée jusqu'à la requête HTTP ; sans clé → « autorisation manquante », sans réseau → « panne du fournisseur ». La transformation des réponses a été vérifiée avec `COINGECKO_BASE_URL` pointé sur un serveur reproduisant le **format** de l'API v3 avec des valeurs **synthétiques** (marquées DÉMO) : 2 apps certifiées 5/5.

| Cas P0 | Où |
|---|---|
| MCP inédit imbriqué, documentation seule, binding absent du DOM, série irrégulière, exigence manquante, deux unités, rupture de schéma, simulation, incrément, panne runtime | `packages/formule-bench/test/p0.test.ts` |
| Vide / zéro / null / date invalide, injection détectée, pas de transition invalide, événements dédupliqués | `packages/contracts/test` |
| Suppression, restauration, versions, nonce à usage unique | `services/storage/test` |
| Pagination, timeout d'écriture sans second envoi, coupure SSE | vérifiés en e2e (voir limites) |

## Docker

```bash
docker compose up --build    # http://localhost:4000 (Studio compilé servi par la gateway)
```

Données persistées dans le volume `formule-data`. `FORMULE_PUBLIC=1` + `FORMULE_BASIC_PASS` activent la Basic Auth.

## Limites connues

- **Le modèle n'écrit pas de code TSX** : il propose des exigences ; la spec déclarative est compilée par un runtime fixe. C'est volontaire (aucun code arbitraire du modèle dans le DOM), mais les vues possibles sont limitées au catalogue d'instruments (KPI, courbe, tableau, classement, simulation, note). Pas encore de scènes 2D/3D (PixiJS/three.js non intégrés).
- **Sans LLM**, la compréhension repose sur un lexique (revenu, pipeline, publicités, inscriptions, mesures manquantes connues) et sur un mode générique (outil nommé, fichier cité). Avec Mercury, la compréhension est plus large mais reste vérifiée par le code. L'appel à Mercury n'a **pas pu être testé ici** (réseau sortant bloqué dans l'environnement de construction) : `GET :4001/llm` indique s'il répond chez toi.
- **Redémarrage du moteur** : les jobs en cours sont marqués FAILED (« interrompu, relance la demande »), pas repris.
- **Voix** : reconnaissance et synthèse du navigateur (Chrome/Edge) ; STT/TTS serveur seulement avec `OPENAI_API_KEY` (Mercury ne fait pas d'audio).
- **Évaluateur** : jsdom (pas de vrai moteur de rendu) ; le canvas n'est pas vérifié pixel par pixel, seulement le nombre de points liés.
- **Builds** : délai et taille bornés, mais pas de quotas CPU/RAM au niveau OS (à confier à Docker/cgroups).
- Les tests de timeout d'écriture et de pagination passent par le hub réel (e2e), pas par la suite unitaire.
- Docker Compose est fourni mais n'a pas été exécuté dans l'environnement de construction.
- Le serveur MCP Hugging Face réel (`huggingface.co`) n'était pas joignable ici : le scénario a été validé sur `servers/hf-contract-mcp`, qui suit le code source public du serveur (formats de sortie compris). Les sections « Auteurs des publications », « colonnes/configurations/volumes » et « aperçu des données » restent « Donnée indisponible » tant qu'aucun outil lu ne fournit ces champs.
- Le registre shadcn (`ui.shadcn.com`) et les blocs `@shadcn-dashboard` n'étaient pas joignables ici : le composant `chart` est une réécriture fidèle de l'API shadcn ; lance `npm run shadcn:chart -w @formule/app-runtime` sur une machine connectée pour reprendre la version officielle. Avec `FORMULE_SHADCN_ONLINE=1`, `shadcn add` peut installer des dépendances dans le `node_modules` partagé : à réserver à un environnement de confiance.
- Fichiers d'app plus lourds avec Recharts (~0,8 Mo par version, un seul fichier).
- CoinGecko n'a pas pu être interrogé avec de vrais cours (`api.coingecko.com` inaccessible depuis l'environnement de construction, pas de clé fournie). Le serveur MCP distant sans clé (`https://mcp.api.coingecko.com/mcp`) peut aussi être ajouté en HTTP depuis le panneau MCP ; ses outils (non « code mode ») passent par le mode générique.

## Arborescence

```
packages/contracts      schémas versionnés, machine à états, enveloppes, agrégats, certification, simulation
packages/service-kit    Fastify, health, appels internes, .env, secrets
packages/app-runtime    gabarit des apps générées (React + Tailwind 4 → index.html unique)
packages/formule-bench  fixtures et scénarios P0
services/*              gateway, ai-engine, validator, storage, mcp-hub, app-agents, voice-gateway
servers/demo-mcp        serveur MCP de démonstration (stdio)
frontend                Studio + Journal
scripts                 health, e2e, e2e-real, mcp-add
```
