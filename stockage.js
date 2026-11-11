// stockage.js — v1.00 — création : tout ce qui touche à la base du navigateur (IndexedDB).
// Ouverture, lecture, écriture, restauration, copies de sécurité, migrations du format, stockage « persistant ».
// Pourquoi à part : l'interface (app.js) ne parle jamais directement à IndexedDB, et le calcul (calcul.js) non plus.
// Les données ne quittent JAMAIS l'appareil : aucun envoi sur Internet ici (ni ailleurs).

import { SCHEMA, TABLES, migrer } from "./calcul.js";

const NOM_BASE = "ma-compta";
// Version de la STRUCTURE IndexedDB (les tables). Rien à voir avec le n° de format des données (SCHEMA).
// Toutes les tables, même celles des étapes suivantes (budgets, récurrences, règles), sont créées dès la v1.00.
const VERSION_BASE = 1;
const PARAMETRES = "parametres"; // clés « meta » et « reglages »
const SECURITE = "securite"; // copies de sécurité automatiques (avant une restauration, avant une migration, et — v1.02 — avant une mise à jour)

let base = null;

function ouvrir() {
  if (base) return Promise.resolve(base);
  return new Promise((ok, ko) => {
    if (!globalThis.indexedDB) {
      ko(new Error("Ce navigateur ne permet pas d'enregistrer des données (IndexedDB absent)."));
      return;
    }
    const req = indexedDB.open(NOM_BASE, VERSION_BASE);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const t of TABLES) {
        if (!db.objectStoreNames.contains(t)) {
          const table = db.createObjectStore(t, { keyPath: "id" });
          if (t === "operations") table.createIndex("date", "date");
        }
      }
      if (!db.objectStoreNames.contains(PARAMETRES)) db.createObjectStore(PARAMETRES);
      if (!db.objectStoreNames.contains(SECURITE)) db.createObjectStore(SECURITE);
    };
    req.onsuccess = () => {
      base = req.result;
      // Une version plus récente de l'appli (autre onglet) veut changer la structure : on libère la base.
      base.onversionchange = () => {
        base.close();
        base = null;
      };
      // Le navigateur a fermé la base de lui-même (ex. données du site effacées) : on la rouvrira à la prochaine écriture.
      base.onclose = () => {
        base = null;
      };
      ok(base);
    };
    req.onerror = () => ko(req.error || new Error("Ouverture de la base impossible."));
  });
}

/** Une transaction qui ne « répond » qu'une fois TERMINÉE.
 *  PIÈGE 9 : une saisie ne doit jamais se perdre → on affiche « Enregistré » seulement après la fin de l'écriture.
 *  durability « strict » : le navigateur écrit vraiment sur le disque avant de dire « terminé »
 *  (Chrome 83+, Safari iPhone 15+ ; ignoré sans risque ailleurs). */
function transaction(tables, mode, travail) {
  return ouvrir().then(
    (db) =>
      new Promise((ok, ko) => {
        let tx;
        try {
          tx = mode === "readwrite" ? db.transaction(tables, mode, { durability: "strict" }) : db.transaction(tables, mode);
        } catch (e) {
          ko(e);
          return;
        }
        let resultat;
        tx.oncomplete = () => ok(resultat);
        tx.onerror = () => ko(tx.error || new Error("Écriture impossible."));
        tx.onabort = () => ko(tx.error || new Error("Écriture annulée."));
        try {
          resultat = travail(tx);
        } catch (e) {
          try {
            tx.abort();
          } catch {
            /* déjà terminée */
          }
          ko(e);
        }
      })
  );
}

/** Lit toutes les données de l'appareil. */
export async function chargerTout() {
  const res = { meta: null, reglages: null };
  await transaction([...TABLES, PARAMETRES], "readonly", (tx) => {
    for (const t of TABLES) {
      const r = tx.objectStore(t).getAll();
      r.onsuccess = () => {
        res[t] = r.result;
      };
    }
    for (const cle of ["meta", "reglages"]) {
      const r = tx.objectStore(PARAMETRES).get(cle);
      r.onsuccess = () => {
        res[cle] = r.result ?? null;
      };
    }
  });
  return res;
}

/** Écrit des objets (ajout ou remplacement) en UNE transaction : tout est écrit, ou rien.
 *  changements = { operations: [...], comptes: [...], parametres: { meta: {...}, reglages: {...} } } */
export function ecrire(changements) {
  const noms = Object.keys(changements);
  for (const n of noms) if (n !== "parametres" && !TABLES.includes(n)) throw new Error(`Table inconnue : ${n}`);
  const tables = noms.map((n) => (n === "parametres" ? PARAMETRES : n));
  return transaction(tables, "readwrite", (tx) => {
    for (const [n, contenu] of Object.entries(changements)) {
      if (n === "parametres") {
        for (const [cle, valeur] of Object.entries(contenu)) tx.objectStore(PARAMETRES).put(valeur, cle);
      } else {
        const table = tx.objectStore(n);
        for (const o of contenu) table.put(o);
      }
    }
  });
}

/** Remplace TOUTES les données par celles d'une sauvegarde, en une seule transaction (jamais à moitié).
 *  copie = { cle, contenu } : la copie de sécurité de l'état actuel est écrite DANS LA MÊME transaction.
 *  Pourquoi : si le remplacement échoue (ex. téléphone plein), l'ancienne copie n'a pas été écrasée pour rien. */
export function remplacerTout(sauvegarde, meta, copie = null) {
  const tables = copie ? [...TABLES, PARAMETRES, SECURITE] : [...TABLES, PARAMETRES];
  return transaction(tables, "readwrite", (tx) => {
    if (copie) tx.objectStore(SECURITE).put({ cle: copie.cle, cree_le: new Date().toISOString(), contenu: copie.contenu }, copie.cle);
    for (const t of TABLES) {
      const table = tx.objectStore(t);
      table.clear();
      for (const o of sauvegarde[t] || []) table.put(o);
    }
    tx.objectStore(PARAMETRES).put(sauvegarde.reglages, "reglages");
    tx.objectStore(PARAMETRES).put(meta, "meta");
  });
}

/** Efface les données (utilisé pour « Effacer les exemples et commencer pour de vrai »).
 *  Les copies de sécurité ne sont JAMAIS effacées : si de vraies données avaient été remplacées par erreur
 *  par une sauvegarde d'exemple, « Revenir à l'état d'avant la restauration » reste possible. */
export function toutEffacer() {
  return transaction([...TABLES, PARAMETRES], "readwrite", (tx) => {
    for (const t of [...TABLES, PARAMETRES]) tx.objectStore(t).clear();
  });
}

/* ------------------------- Copies de sécurité ------------------------- */

export function ecrireCopieSecurite(cle, contenu) {
  return transaction([SECURITE], "readwrite", (tx) => {
    tx.objectStore(SECURITE).put({ cle, cree_le: new Date().toISOString(), contenu }, cle);
  });
}

export async function lireCopieSecurite(cle) {
  let copie = null;
  await transaction([SECURITE], "readonly", (tx) => {
    const r = tx.objectStore(SECURITE).get(cle);
    r.onsuccess = () => {
      copie = r.result ?? null;
    };
  });
  return copie;
}

export function effacerCopieSecurite(cle) {
  return transaction([SECURITE], "readwrite", (tx) => {
    tx.objectStore(SECURITE).delete(cle);
  });
}

/** v1.02 — Au 1er lancement d'une nouvelle version : la copie de l'état actuel ET la « meta » qui note la nouvelle
 *  version, dans UNE transaction. Pourquoi ensemble : si la copie échoue (téléphone plein…), la version n'est pas
 *  notée non plus, et la copie sera retentée au prochain lancement. */
export function ecrireCopieEtMeta(copie, meta) {
  return transaction([PARAMETRES, SECURITE], "readwrite", (tx) => {
    tx.objectStore(SECURITE).put({ cle: copie.cle, cree_le: new Date().toISOString(), contenu: copie.contenu }, copie.cle);
    tx.objectStore(PARAMETRES).put(meta, "meta");
  });
}

/* ------------------------- Migrations ------------------------- */

/** Au lancement : si les données de l'appareil sont dans un ANCIEN format,
 *  copie de sécurité automatique D'ABORD, puis migration, puis réécriture en une transaction. */
export async function migrerSiBesoin(donnees, versionAppli) {
  const schema = donnees.meta?.schema ?? SCHEMA;
  if (schema === SCHEMA) return donnees;
  if (schema > SCHEMA) {
    throw new Error("Les données de cet appareil viennent d'une version plus récente de l'appli. Recharge la page pour obtenir la dernière version.");
  }
  await ecrireCopieSecurite("avant-migration", donnees);
  const ancien = { schema, reglages: donnees.reglages };
  for (const t of TABLES) ancien[t] = donnees[t] || [];
  const nouveau = migrer(ancien);
  const meta = { ...donnees.meta, schema: SCHEMA, version_appli: versionAppli };
  await remplacerTout(nouveau, meta);
  return { ...nouveau, meta };
}

/* ------------------------- Stockage « persistant » ------------------------- */

/** Demande au navigateur de ne pas effacer nos données quand il manque de place.
 *  Chrome l'accorde tout seul (surtout une fois l'appli installée), sans rien demander. */
export async function demanderPersistance() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export async function estPersistant() {
  try {
    return navigator.storage?.persisted ? await navigator.storage.persisted() : false;
  } catch {
    return false;
  }
}
