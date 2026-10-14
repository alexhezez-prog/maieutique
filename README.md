# Maïeutique

*La maïeutique, chez Socrate : faire « accoucher » l'esprit de ce qu'il sait, par des questions.*

Vérification de leçon pour un parent ou un élève autonome. Pas de photo : on décrit la leçon, on la colle ou on la dicte, et l'application prépare un QCM corrigé et expliqué, noté sur 20, avec en option une fiche résumé et une carte mentale.

## Parcours

1. **Demande** : sujet, niveau (CP à Terminale, Supérieur), matière, texte de la leçon (collé ou dicté au micro), consignes libres (« insister sur les dates », « surtout du vocabulaire »…), nombre de questions (10, 15, 20), difficulté (facile, standard, exigeant), qui répond, et options fiche / carte mentale.
2. **Préparation** : la leçon est restituée et découpée en notions clés. Sans texte, le contenu suit le programme officiel du niveau, et l'appli le signale.
3. **Fiche résumé et carte mentale** (si demandées), pendant que le quiz se prépare.
4. **Quiz**, deux modes :
   - *L'élève, sur l'écran* : il touche sa réponse, correction et explication immédiates ;
   - *Le parent, à l'oral* : le parent lit la question et les 4 choix et touche la réponse donnée, ou fait répondre librement, affiche la réponse attendue et note Juste / Faux. Le choix « libre » est conservé pour les questions suivantes.
5. **Note sur 20**, maîtrise par notion, erreurs expliquées, « Refaire les erreurs », nouvelle série, impression (bilan, erreurs, carte, fiche).

## Architecture

- `index.html` : application (page unique, GitHub Pages), état gardé dans le navigateur pour reprendre une leçon.
- `worker.js` : relais Cloudflare, seul à détenir la clé API. Étapes `preparer`, `fiche`, `qcm`. Modèle par défaut : `claude-sonnet-5-5`.
- `wrangler.toml` : configuration du Worker (facultatif si déploiement par l'interface web).

## Mise en ligne

1. **GitHub** : créer le dépôt `maieutique`, y déposer `index.html`, `icon-180.png`, `maieutique-icone.svg`, `README.md` (et `worker.js` pour archive). Settings → Pages → branche `main`, dossier `/ (root)`.
2. **Cloudflare** : Workers & Pages → Create → Create Worker, nom exact `maieutique`, Deploy, Edit code, coller `worker.js`, Deploy. Puis Settings → Variables and Secrets :
   - `ANTHROPIC_API_KEY` (Secret) ;
   - `ACCESS_CODE` (Secret) ;
   - `ALLOWED_ORIGIN` (Text) : `https://alexhezez-prog.github.io`
3. **Appareil** : ouvrir `https://alexhezez-prog.github.io/maieutique/#cle=CODE` dans Safari, puis Partager → Sur l'écran d'accueil.

Démonstration sans IA : `…/maieutique/#demo`.
