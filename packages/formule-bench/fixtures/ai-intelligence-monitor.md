Crée un dashboard interactif nommé **AI Intelligence Monitor**, connecté au serveur MCP Hugging Face.

L'interface doit servir de centre de surveillance de l'écosystème mondial de l'intelligence artificielle.

**1. Indicateurs principaux**
- Nombre de modèles récupérés.
- Téléchargements cumulés des modèles sélectionnés.
- Nombre de datasets récupérés.
- Nombre de publications scientifiques récentes récupérées.
- Modèle le plus populaire de la sélection.

**2. AI Model Radar**
- Top 20 des modèles tendance.
- Classement par téléchargements et likes.
- Architecture, organisation, licence et date de publication.
- Filtres par catégorie : LLM, audio, vision, multimodal.

**3. Research Intelligence**
- Dernières publications scientifiques.
- Résumé des découvertes.
- Auteurs et organisations.
- Liens vers les articles originaux.

**4. Dataset Explorer**
- Classement des datasets populaires.
- Exploration des colonnes, configurations et volumes.
- Aperçu interactif des données.

**5. AI App Discovery**
- Spaces Hugging Face tendance.
- Découverte des applications IA et serveurs MCP publics.
- Statut et infrastructure disponibles.

**6. Acquisition des données**
- Utilise `hub_repo_search` pour les classements et recherches.
- Utilise `hub_repo_details` pour les métadonnées détaillées.
- Utilise `hf_fs` pour les tendances, publications et fichiers.
- N'utilise pas `f_whoami`, car aucune authentification n'est nécessaire pour ce dashboard public.

**7. Design**
Interface sombre, fond noir graphite, accents orange, typographie monospace, graphiques interactifs, tableaux filtrables et navigation latérale.

Ajoute un bouton d'actualisation et affiche la date de dernière acquisition.

Interdiction de générer des données fictives. Chaque indicateur doit provenir d'un appel MCP réel. Si une donnée est inaccessible, affiche « Donnée indisponible ».
