# Tests de Ma Compta Perso

*(v1.00 — création. Ces tests servent à Claude avant chaque livraison ; ils ne contiennent aucune donnée réelle.)*

## 1. Le calcul (`calcul.js`), avec Node

```
node tests/test_calcul.mjs
```

Le fichier se relance tout seul dans 3 fuseaux horaires (Guadeloupe, Paris, UTC) : le calcul doit donner
exactement les mêmes résultats partout. Il vérifie : montants en centimes, pavé numérique, dates locales,
mois de budget (y compris paie le 31 → 30 / 28 / 29), soldes, virements, tri, recherche, catégories par
défaut, CSV pour Excel, sauvegarde, migration, anonymisation, fusion, données d'exemple.

## 2. L'appli entière, dans Chromium (Playwright)

```
python3 tests/test_appli.py [--captures DOSSIER] [--zip ma-compta_vX_YY.zip] [--seulement MOT]
```

Un petit serveur local sert l'appli, puis un vrai navigateur fait le parcours (et Chrome confirme lui-même
que l'appli est installable) : guide, saisie rapide,
annulation, modification, suppression, double toucher, virement, mode « bouton », date du jour à 21 h et
0 h 30 (Guadeloupe et Paris), hors ligne, mise à jour N → N+1 sans perte de données, sauvegarde →
restauration identique, refus des sauvegardes invalides, CSV, sauvegarde anonymisée, bouton « retour »,
raccourcis de l'icône, et chaque écran à 5 tailles (téléphones, PC à 125 %), en clair et en sombre,
à 100 % et 150 % de texte : aucun débordement, aucune erreur dans la console, aucun appel réseau extérieur.

S'y ajoutent les tests issus de la relecture indépendante du code (chacun a été vérifié : il ÉCHOUE si on
remet le bug) : « ↶ Annuler » jamais sous le doigt par erreur, double toucher (jamais 2 comptes, jamais 2
retours arrière), sauvegarde d'exemple restaurée par erreur puis effacée (la copie de sécurité survit),
réglages abîmés dans une sauvegarde, copie de sécurité écrite en même temps que la restauration (tout ou
rien), appli ouverte dans 2 fenêtres à la fois, virement incomplet.

Ce que ces tests ne remplacent pas : l'essai sur le vrai téléphone (installation, clavier, partage de
fichiers), le vrai Chrome à 125 % et la vraie publication sur GitHub.
