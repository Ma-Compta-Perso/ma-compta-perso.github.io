// calcul.js — v1.00 — création : le CALCUL PUR de l'appli.
// Montants, dates, soldes, mois de budget, statistiques simples, recherche, CSV,
// sauvegardes (vérification, migration, anonymisation, fusion) et données d'exemple.
//
// RÈGLE D'OR : aucun accès à la page (document, window) ni au stockage (IndexedDB) ici.
// Pourquoi : ce fichier se teste tout seul avec Node (tests/test_calcul.mjs),
// donc chaque chiffre affiché par l'appli est vérifiable sans navigateur.

/* =====================================================================
   CONSTANTES
   ===================================================================== */

// N° du FORMAT des données (≠ version de l'appli). +1 à chaque changement de format, avec une migration testée.
export const SCHEMA = 1;
// Signature d'un fichier de sauvegarde de cette appli (vérifiée à la restauration).
export const FORMAT_SAUVEGARDE = "ma-compta";
// Catégorie « système » des virements entre mes comptes (jamais proposée dans la grille).
export const ID_CAT_VIREMENT = "def-virement";
// Les tables de données (une par type d'objet).
export const TABLES = ["comptes", "categories", "operations", "recurrences", "budgets", "regles"];

export const TYPES_COMPTE = [
  { id: "courant", nom: "Compte courant", icone: "🏦" },
  { id: "livret", nom: "Livret, épargne", icone: "🐷" },
  { id: "especes", nom: "Espèces", icone: "👛" },
  { id: "carte_differe", nom: "Carte à débit différé", icone: "💳" },
  { id: "autre", nom: "Autre", icone: "📁" },
];

export const MOYENS = [
  { id: "cb", nom: "CB" },
  { id: "virement", nom: "Virement" },
  { id: "prelevement", nom: "Prélèvement" },
  { id: "cheque", nom: "Chèque" },
  { id: "especes", nom: "Espèces" },
  { id: "autre", nom: "Autre" },
];

export const REGLAGES_DEFAUT = Object.freeze({
  jour_debut_mois: 1, // 1 = mois calendaire ; sinon le jour de paie (borné au dernier jour du mois)
  theme: "auto", // "auto" | "clair" | "sombre"
  taille_texte: 100, // en %, de 80 à 150
  mode_saisie: "rapide", // "rapide" = mode B (toucher la catégorie enregistre) | "bouton" = mode A
  appareil_principal: true, // c'est sur cet appareil que je note mes opérations
  rappel_sauvegarde_jours: 7, // 0 = jamais
  dernier_compte: null, // le compte proposé par défaut à la saisie
});

/** Des réglages toujours VALIDES, quoi qu'il y ait dans la base ou dans un fichier de sauvegarde.
 *  Pourquoi : un seul réglage faux (ex. jour_debut_mois vide) suffirait à empêcher l'appli de s'afficher.
 *  Chaque valeur hors des clous est remplacée par la valeur par défaut. */
export function normaliserReglages(r) {
  const x = r && typeof r === "object" && !Array.isArray(r) ? r : {};
  const d = REGLAGES_DEFAUT;
  const entier = (v, min, max, defaut) => (Number.isInteger(v) && v >= min && v <= max ? v : defaut);
  return {
    ...x, // un réglage inconnu (venu d'une version plus récente) est gardé tel quel, sans être utilisé
    jour_debut_mois: entier(x.jour_debut_mois, 1, 31, d.jour_debut_mois),
    theme: ["auto", "clair", "sombre"].includes(x.theme) ? x.theme : d.theme,
    taille_texte: entier(x.taille_texte, 80, 150, d.taille_texte),
    mode_saisie: ["rapide", "bouton"].includes(x.mode_saisie) ? x.mode_saisie : d.mode_saisie,
    appareil_principal: typeof x.appareil_principal === "boolean" ? x.appareil_principal : d.appareil_principal,
    rappel_sauvegarde_jours: entier(x.rappel_sauvegarde_jours, 0, 365, d.rappel_sauvegarde_jours),
    dernier_compte: typeof x.dernier_compte === "string" ? x.dernier_compte : null,
  };
}

// Catégories par défaut : [id, icône, nom, sens, hors budget, précision].
// Les id sont FIXES (pas tirés au hasard) : le jour où on fusionnera téléphone et PC,
// « Courses » aura le même id des deux côtés → pas de catégorie en double.
const CATEGORIES_DEFAUT = [
  ["def-salaire", "💼", "Salaire", "revenu"],
  ["def-independant", "🧑‍💻", "Activité indépendante", "revenu"],
  ["def-primes", "🎉", "Primes, cadeaux reçus", "revenu"], // 🎉 et pas 🎁 : 🎁 sert déjà à « Cadeaux, dons »
  ["def-remboursements", "🏥", "Remboursements", "revenu", false, "santé…"],
  ["def-allocations", "👨‍👩‍👧", "Allocations, aides", "revenu"],
  ["def-interets", "💰", "Intérêts", "revenu"],
  ["def-autres-revenus", "➕", "Autres revenus", "revenu"],
  ["def-logement", "🏠", "Logement", "depense", false, "loyer ou crédit, charges, assurance"],
  ["def-energie", "⚡", "Énergie, eau", "depense"],
  ["def-telephone", "📶", "Téléphone, internet", "depense"],
  ["def-courses", "🛒", "Courses", "depense"],
  ["def-restaurants", "🍽️", "Restaurants, cafés", "depense"],
  ["def-transport", "🚗", "Transport", "depense", false, "carburant, entretien, assurance, péage, transports en commun"],
  ["def-sante", "🩺", "Santé", "depense", false, "mutuelle, médecin, pharmacie"],
  ["def-habillement", "👕", "Habillement", "depense"],
  ["def-loisirs", "🎬", "Loisirs, sorties", "depense", false, "dont jeux et paris"],
  ["def-abonnements", "📺", "Abonnements", "depense"],
  ["def-vacances", "✈️", "Vacances", "depense"],
  ["def-formation", "🎓", "Formation", "depense"],
  ["def-enfants", "👶", "Enfants", "depense"],
  ["def-animaux", "🐾", "Animaux", "depense"],
  ["def-cadeaux", "🎁", "Cadeaux, dons", "depense"],
  ["def-impots", "🏛️", "Impôts, taxes", "depense"],
  ["def-cotisations", "🧾", "Cotisations", "depense"],
  ["def-frais-bancaires", "🏦", "Frais bancaires", "depense"],
  ["def-maison", "🔧", "Maison, bricolage", "depense"],
  ["def-soins", "💇", "Soins, beauté", "depense"],
  ["def-divers", "❓", "Divers", "depense"],
  ["def-epargne", "🐷", "Épargne", "depense", true, "argent mis de côté sur un compte que l'appli ne suit pas"],
  [ID_CAT_VIREMENT, "🔁", "Virement entre mes comptes", "virement", true, "utilisée automatiquement par les virements"],
];

export function categoriesParDefaut(maintenant) {
  return CATEGORIES_DEFAUT.map(([id, icone, nom, sens, hors_budget = false, description = ""], i) => ({
    id,
    nom,
    icone,
    sens, // "depense" | "revenu" | "virement" (réservé à la catégorie système)
    parent: null, // sous-catégories : prévues dans le format, pas encore dans l'interface
    ordre: i,
    archive: false,
    hors_budget,
    description,
    systeme: id === ID_CAT_VIREMENT,
    cree_le: maintenant,
    modifie_le: maintenant,
    supprime: false,
  }));
}

/* =====================================================================
   MONTANTS — toujours en CENTIMES entiers (12,50 € → 1250).
   Jamais de calcul à virgule : en JavaScript, 0,1 + 0,2 ne fait pas exactement 0,3.
   ===================================================================== */

const MAX_CENTIMES = 99_999_999_999; // 999 999 999,99 € : garde-fou, très loin de la limite des entiers exacts de JS

export function estCentimes(x) {
  return Number.isSafeInteger(x) && Math.abs(x) <= MAX_CENTIMES;
}

/** "12,5" · "12.50" · "1 234,56" · "-3" → centimes (entier). null si illisible. */
export function texteVersCentimes(texte) {
  if (typeof texte !== "string") return null;
  let t = texte.replace(/[\s  ]/g, "").replace(/−/g, "-"); // espaces (même insécables) ; « − » typographique
  let signe = 1;
  if (t.startsWith("-")) {
    signe = -1;
    t = t.slice(1);
  } else if (t.startsWith("+")) {
    t = t.slice(1);
  }
  t = t.replace(",", "."); // la virgule française devient le séparateur décimal (une seule autorisée)
  const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(t);
  if (!m) return null;
  const entier = m[1];
  const decimales = m[2] ?? "";
  if (entier === "" && decimales === "") return null;
  if (entier.length > 9) return null;
  const c = Number(entier || "0") * 100 + Number((decimales + "00").slice(0, 2));
  return c === 0 ? 0 : signe * c; // évite le « -0 »
}

/** centimes → "1234,56" (sans séparateur de milliers). Pour le CSV et les champs de saisie. */
export function centimesVersTexte(c) {
  const a = Math.abs(c);
  return (c < 0 ? "-" : "") + Math.trunc(a / 100) + "," + String(a % 100).padStart(2, "0");
}

const FORMAT_EUROS = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });

/** centimes → "1 234,56 €" pour l'affichage. signe:true → "+12,50 €" pour les entrées.
 *  ⚠️ Intl met des espaces insécables (fines) : jamais dans le CSV (voir centimesVersTexte). */
export function formaterEuros(c, { signe = false } = {}) {
  const txt = FORMAT_EUROS.format(Math.abs(c) / 100);
  if (c < 0) return "−" + txt; // vrai signe moins, plus lisible que le tiret
  if (signe && c > 0) return "+" + txt;
  return txt;
}

/** Somme d'entiers, avec un garde-fou si on sortait des entiers exacts. */
export function somme(valeurs) {
  let s = 0;
  for (const v of valeurs) s += v;
  if (!Number.isSafeInteger(s)) throw new RangeError("Somme hors limites");
  return s;
}

/** Le pavé numérique : applique une touche au texte déjà tapé (« , » et « . » acceptés).
 *  Au plus 2 décimales et 7 chiffres avant la virgule (9 999 999 €). */
export function appliquerTouche(texte, touche) {
  const t = texte || "";
  if (touche === "⌫" || touche === "Backspace") return t.slice(0, -1);
  if (touche === "," || touche === ".") {
    if (t.includes(",")) return t;
    return (t === "" ? "0" : t) + ",";
  }
  if (!/^\d$/.test(touche)) return t;
  const [entier, decimales] = t.split(",");
  if (decimales !== undefined) return decimales.length >= 2 ? t : t + touche;
  if (entier === "0") return touche; // pas de « 05 »
  if (entier.length >= 7) return t;
  return t + touche;
}

/* =====================================================================
   DATES — texte « AAAA-MM-JJ », date LOCALE de l'appareil.
   PIÈGE 1 : new Date().toISOString() donne la date UTC (en Guadeloupe après 20 h, c'est déjà demain).
   PIÈGE 2 : new Date("2026-10-29") est lu à minuit UTC (en Guadeloupe, ça affiche le 28).
   → On découpe le texte nous-mêmes, et les calculs de jours se font en UTC « neutre » (pas d'heure d'été).
   ===================================================================== */

const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function joursDansMois(a, m) {
  return new Date(Date.UTC(a, m, 0)).getUTCDate(); // le « jour 0 » du mois suivant = dernier jour du mois m
}

export function lireDate(texte) {
  const r = RE_DATE.exec(typeof texte === "string" ? texte : "");
  if (!r) return null;
  const a = Number(r[1]);
  const m = Number(r[2]);
  const j = Number(r[3]);
  if (a < 1900 || a > 2999 || m < 1 || m > 12 || j < 1 || j > joursDansMois(a, m)) return null;
  return { a, m, j };
}

export function dateValide(texte) {
  return lireDate(texte) !== null;
}

export function ecrireDate(a, m, j) {
  return `${String(a).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(j).padStart(2, "0")}`;
}

/** La date du jour de l'APPAREIL (heure locale), quel que soit son fuseau. */
export function dateDuJour(maintenant = new Date()) {
  return ecrireDate(maintenant.getFullYear(), maintenant.getMonth() + 1, maintenant.getDate());
}

function versUTC(texte) {
  const d = lireDate(texte);
  return Date.UTC(d.a, d.m - 1, d.j);
}

export function ajouterJours(texte, n) {
  const d = lireDate(texte);
  const x = new Date(Date.UTC(d.a, d.m - 1, d.j + n));
  return ecrireDate(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
}

/** Nombre de jours pour aller de `de` à `a` (positif si `a` est après `de`). */
export function ecartJours(de, a) {
  return Math.round((versUTC(a) - versUTC(de)) / 86_400_000);
}

/** Le jour voulu, ramené au dernier jour du mois si besoin : le 31 → 30, 28 ou 29. */
export function jourBorne(a, m, jour) {
  return Math.min(jour, joursDansMois(a, m));
}

export function decalerMois(a, m, n) {
  const t = a * 12 + (m - 1) + n;
  const an = Math.floor(t / 12);
  return { a: an, m: t - an * 12 + 1 };
}

/** La période du mois de budget qui COMMENCE dans le mois civil (a, m).
 *  jourDebut = 1 → mois calendaire. Sinon du jour de paie au veille du jour de paie suivant.
 *  Le nom affiché est celui du mois qui contient le plus de jours de la période. */
export function periodeDuMois(a, m, jourDebut = 1) {
  const debut = ecrireDate(a, m, jourBorne(a, m, jourDebut));
  const s = decalerMois(a, m, 1);
  const fin = ajouterJours(ecrireDate(s.a, s.m, jourBorne(s.a, s.m, jourDebut)), -1);
  const nom = jourDebut <= 15 ? { a, m } : s;
  return { a, m, debut, fin, nom_a: nom.a, nom_m: nom.m };
}

/** Le mois de budget qui contient `date`. */
export function moisDeBudget(date, jourDebut = 1) {
  const d = lireDate(date);
  if (d.j >= jourBorne(d.a, d.m, jourDebut)) return periodeDuMois(d.a, d.m, jourDebut);
  const p = decalerMois(d.a, d.m, -1);
  return periodeDuMois(p.a, p.m, jourDebut);
}

/** Le mois de budget voisin (n = -1 : précédent, +1 : suivant). */
export function moisVoisin(periode, n, jourDebut = 1) {
  const x = decalerMois(periode.a, periode.m, n);
  return periodeDuMois(x.a, x.m, jourDebut);
}

// Formats d'affichage : on formate une date « midi UTC » en fuseau UTC → jamais de décalage d'un jour.
const FMT_JOUR = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
const FMT_JOUR_ANNEE = new Intl.DateTimeFormat("fr-FR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const FMT_COURT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const FMT_COURT_ANNEE = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const FMT_MOIS = new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" });

function dateMidiUTC(texte) {
  const d = lireDate(texte);
  return new Date(Date.UTC(d.a, d.m - 1, d.j, 12));
}

export function majuscule(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** "Aujourd'hui", "Hier", "Avant-hier", "Demain" ou "Jeudi 29 octobre" (+ l'année si ce n'est pas celle d'aujourd'hui). */
export function nomDuJour(date, aujourdhui) {
  const e = ecartJours(date, aujourdhui);
  if (e === 0) return "Aujourd'hui";
  if (e === 1) return "Hier";
  if (e === 2) return "Avant-hier";
  if (e === -1) return "Demain";
  const f = lireDate(date).a === lireDate(aujourdhui).a ? FMT_JOUR : FMT_JOUR_ANNEE;
  return majuscule(f.format(dateMidiUTC(date)));
}

/** "29 oct." (ou "29 oct. 2025" si l'année diffère de `aujourdhui`). */
export function dateCourte(date, aujourdhui) {
  const f = aujourdhui && lireDate(date).a !== lireDate(aujourdhui).a ? FMT_COURT_ANNEE : FMT_COURT;
  return f.format(dateMidiUTC(date));
}

/** "Novembre 2026". */
export function nomDuMois(a, m) {
  return majuscule(FMT_MOIS.format(new Date(Date.UTC(a, m - 1, 15, 12))));
}

/** Le titre d'un mois de budget : "Novembre 2026" (calendaire) ou "Novembre 2026 · 28 oct. → 27 nov.". */
export function titrePeriode(p, jourDebut = 1) {
  const nom = nomDuMois(p.nom_a, p.nom_m);
  return jourDebut === 1 ? nom : `${nom} · ${dateCourte(p.debut)} → ${dateCourte(p.fin)}`;
}

/** "29/10/2026" pour le CSV (format que l'Excel français reconnaît). */
export function dateCSV(texte) {
  const d = lireDate(texte);
  return `${String(d.j).padStart(2, "0")}/${String(d.m).padStart(2, "0")}/${d.a}`;
}

/* =====================================================================
   SOLDES ET MOIS
   ===================================================================== */

/** Solde d'un compte à la fin de la journée `jusquau`.
 *  Règle : le solde de départ = l'argent sur le compte AU DÉBUT de sa date de départ.
 *  On y ajoute les opérations datées de la date de départ (incluse) à `jusquau` (inclus).
 *  Une opération datée AVANT la date de départ est déjà comprise dans le solde de départ :
 *  elle ne compte pas (sinon on la compterait deux fois). Les opérations supprimées non plus. */
export function soldeCompte(compte, operations, jusquau) {
  let s = compte.solde_depart;
  for (const o of operations) {
    if (!o.supprime && o.compte === compte.id && o.date >= compte.date_depart && o.date <= jusquau) s += o.montant;
  }
  return s;
}

/** Total des opérations « à venir » d'un compte (datées après aujourd'hui). */
export function aVenirCompte(compte, operations, aujourdhui) {
  let s = 0;
  for (const o of operations) {
    if (!o.supprime && o.compte === compte.id && o.date > aujourdhui && o.date >= compte.date_depart) s += o.montant;
  }
  return s;
}

/** Les comptes visibles (ni supprimés ni archivés), triés. */
export function comptesActifs(comptes) {
  return comptes.filter((c) => !c.supprime && !c.archive).sort((x, y) => x.ordre - y.ordre || x.nom.localeCompare(y.nom, "fr"));
}

/** Soldes de chaque compte actif + total, à aujourd'hui. */
export function resumeComptes(comptes, operations, aujourdhui) {
  const lignes = comptesActifs(comptes).map((c) => ({
    compte: c,
    solde: soldeCompte(c, operations, aujourdhui),
    aVenir: aVenirCompte(c, operations, aujourdhui),
  }));
  return {
    lignes,
    total: somme(lignes.map((l) => l.solde)),
    totalAVenir: somme(lignes.map((l) => l.aVenir)),
  };
}

/** Entrées / sorties d'une période (mêmes définitions partout : écrans, bilan, export).
 *  - Les virements entre MES comptes sont exclus (ils ne font que déplacer l'argent).
 *  - Seules les opérations jusqu'à aujourd'hui inclus sont « réalisées » ;
 *    celles datées après sont « à venir » et comptées à part. */
export function resumePeriode(operations, periode, aujourdhui) {
  let entrees = 0;
  let sorties = 0;
  let aVenirEntrees = 0;
  let aVenirSorties = 0;
  let nb = 0;
  for (const o of operations) {
    if (o.supprime || o.lien_virement || o.date < periode.debut || o.date > periode.fin) continue;
    const futur = o.date > aujourdhui;
    if (o.montant >= 0) {
      if (futur) aVenirEntrees += o.montant;
      else entrees += o.montant;
    } else if (futur) aVenirSorties -= o.montant;
    else sorties -= o.montant;
    if (!futur) nb += 1;
  }
  return { entrees, sorties, solde: entrees - sorties, aVenirEntrees, aVenirSorties, nb };
}

/** Tri d'affichage : la plus récente en premier (à date égale, la dernière saisie en premier). */
export function trierOperations(ops) {
  return [...ops].sort(
    (x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0) || (x.cree_le < y.cree_le ? 1 : x.cree_le > y.cree_le ? -1 : 0) || (x.id < y.id ? 1 : -1)
  );
}

/** Les opérations (non supprimées) d'une période, triées. */
export function operationsDeLaPeriode(operations, periode) {
  return trierOperations(operations.filter((o) => !o.supprime && o.date >= periode.debut && o.date <= periode.fin));
}

/** Regroupe par jour (déjà triées) : [{ date, operations, total }]. Le total du jour exclut les virements. */
export function grouperParJour(ops) {
  const groupes = [];
  for (const o of ops) {
    let g = groupes[groupes.length - 1];
    if (!g || g.date !== o.date) {
      g = { date: o.date, operations: [], total: 0 };
      groupes.push(g);
    }
    g.operations.push(o);
    if (!o.lien_virement) g.total += o.montant;
  }
  return groupes;
}

/** Ordre de la grille de catégories : les plus utilisées (90 derniers jours) d'abord, puis l'ordre de la liste.
 *  Calculé au lancement de l'appli, pas après chaque saisie : la grille ne bouge pas sous ton doigt. */
export function ordreCategories(categories, operations, sens, aujourdhui, jours = 90) {
  const depuis = ajouterJours(aujourdhui, -jours);
  const usage = new Map();
  for (const o of operations) {
    if (!o.supprime && !o.lien_virement && o.date >= depuis && o.date <= aujourdhui) usage.set(o.categorie, (usage.get(o.categorie) || 0) + 1);
  }
  return categories
    .filter((c) => !c.supprime && !c.archive && !c.systeme && c.sens === sens)
    .sort((x, y) => (usage.get(y.id) || 0) - (usage.get(x.id) || 0) || x.ordre - y.ordre)
    .map((c) => c.id);
}

/** Totaux d'une période par catégorie (réalisées seulement, virements exclus).
 *  Sorties (montants négatifs) d'un côté, entrées de l'autre, du plus gros au plus petit. */
export function totauxParCategorie(operations, periode, aujourdhui) {
  const sorties = new Map();
  const entrees = new Map();
  for (const o of operations) {
    if (o.supprime || o.lien_virement || o.date < periode.debut || o.date > periode.fin || o.date > aujourdhui) continue;
    const m = o.montant < 0 ? sorties : entrees;
    const t = m.get(o.categorie) || { categorie: o.categorie, total: 0, nb: 0 };
    t.total += Math.abs(o.montant);
    t.nb += 1;
    m.set(o.categorie, t);
  }
  const trier = (m) => [...m.values()].sort((x, y) => y.total - x.total);
  const s = trier(sorties);
  const e = trier(entrees);
  return { sorties: s, entrees: e, totalSorties: somme(s.map((x) => x.total)), totalEntrees: somme(e.map((x) => x.total)) };
}

/** Pourcentage arrondi à l'unité, en entiers (pas de virgule flottante dans le résultat). */
export function pourcentage(part, total) {
  return total > 0 ? Math.round((part * 100) / total) : 0;
}

/* =====================================================================
   RECHERCHE (dans le mois affiché)
   ===================================================================== */

export function normaliser(texte) {
  return String(texte || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // enlève les accents : « electricite » trouve « Électricité »
    .toLowerCase()
    .replace(/[\s  ]+/g, " ")
    .trim();
}

/** Filtre les opérations : texte (libellé, tiers, note, catégorie, compte, montant), compte, catégorie. */
export function filtrerOperations(ops, { texte = "", compte = "", categorie = "" } = {}, categoriesParId = new Map(), comptesParId = new Map()) {
  const q = normaliser(texte);
  return ops.filter((o) => {
    if (compte && o.compte !== compte) return false;
    if (categorie && o.categorie !== categorie) return false;
    if (!q) return true;
    const cat = categoriesParId.get(o.categorie);
    const cpt = comptesParId.get(o.compte);
    const montant = centimesVersTexte(Math.abs(o.montant));
    const meule = normaliser([o.libelle, o.tiers, o.note, cat && cat.nom, cpt && cpt.nom, montant, montant.replace(",", ".")].join(" | "));
    return meule.includes(q);
  });
}

/* =====================================================================
   VIREMENTS ENTRE MES COMPTES — 2 opérations liées par le même `lien_virement`
   ===================================================================== */

export function construireVirement({ ids, lien, de, vers, montant, date, libelle = "", note = "", maintenant }) {
  if (!estCentimes(montant) || montant <= 0) throw new RangeError("Montant de virement invalide");
  if (de === vers) throw new Error("Un virement doit aller d'un compte vers un AUTRE compte");
  const base = {
    date,
    categorie: ID_CAT_VIREMENT,
    libelle,
    tiers: "",
    moyen: "virement",
    note,
    pointe: false,
    recurrence_id: null,
    lien_virement: lien,
    cree_le: maintenant,
    modifie_le: maintenant,
    supprime: false,
  };
  return [
    { ...base, id: ids[0], compte: de, montant: -montant },
    { ...base, id: ids[1], compte: vers, montant },
  ];
}

/* =====================================================================
   CSV POUR EXCEL (France)
   PIÈGE 5 : séparateur « ; », virgule décimale, BOM UTF-8 en tête (sinon accents cassés),
   dates JJ/MM/AAAA, fins de ligne CRLF, guillemets autour des champs qui contiennent ; " ou un retour à la ligne,
   et une apostrophe devant un TEXTE qui commence par = + - @ (sinon Excel peut l'exécuter comme une formule).
   ===================================================================== */

export function champCSV(valeur, { texte = true } = {}) {
  let s = valeur == null ? "" : String(valeur);
  if (texte && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[;"\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export const COLONNES_CSV = ["Date", "Compte", "Type", "Catégorie", "Libellé", "Tiers", "Moyen", "Montant", "Note", "Pointée"];

export function genererCSV({ comptes, categories, operations }) {
  const cpt = new Map(comptes.map((c) => [c.id, c]));
  const cat = new Map(categories.map((c) => [c.id, c]));
  const moyens = new Map(MOYENS.map((m) => [m.id, m.nom]));
  const ops = trierOperations(operations.filter((o) => !o.supprime)).reverse(); // du plus ancien au plus récent
  const lignes = [COLONNES_CSV.map((c) => champCSV(c)).join(";")];
  for (const o of ops) {
    const type = o.lien_virement ? "Virement" : o.montant < 0 ? "Dépense" : "Entrée";
    lignes.push(
      [
        champCSV(dateCSV(o.date), { texte: false }),
        champCSV(cpt.get(o.compte)?.nom ?? "?"),
        champCSV(type),
        champCSV(cat.get(o.categorie)?.nom ?? "?"),
        champCSV(o.libelle),
        champCSV(o.tiers),
        champCSV(moyens.get(o.moyen) ?? ""),
        champCSV(centimesVersTexte(o.montant), { texte: false }), // un nombre : son « - » ne doit PAS recevoir d'apostrophe
        champCSV(o.note),
        champCSV(o.pointe ? "oui" : ""),
      ].join(";")
    );
  }
  return "﻿" + lignes.join("\r\n") + "\r\n";
}

/* =====================================================================
   SAUVEGARDES : construction, vérification, migration, anonymisation, fusion
   ===================================================================== */

function cloner(x) {
  return JSON.parse(JSON.stringify(x));
}

/** Le contenu complet d'un fichier de sauvegarde (y compris les éléments « supprimés », utiles pour une future fusion). */
export function construireSauvegarde(donnees, { versionAppli, appareil = "", maintenant, exemple = false }) {
  const s = {
    format: FORMAT_SAUVEGARDE,
    schema: SCHEMA,
    version_appli: versionAppli,
    cree_le: maintenant,
    appareil,
    anonyme: false,
    exemple: Boolean(exemple),
    reglages: normaliserReglages(donnees.reglages),
  };
  for (const t of TABLES) s[t] = cloner(donnees[t] || []);
  return s;
}

/** Nom de fichier daté : ma-compta_sauvegarde_2026-10-29.json */
export function nomFichier(genre, aujourdhui, extension) {
  return `ma-compta_${genre}_${aujourdhui}.${extension}`;
}

// Migrations du FORMAT : MIGRATIONS[n] transforme une sauvegarde du format n en format n+1.
// Format 1 = le premier : aucune migration pour l'instant.
export const MIGRATIONS = Object.freeze({});

/** Amène une sauvegarde au format `cible`, étape par étape. Ne modifie jamais l'objet reçu. */
export function migrer(sauvegarde, migrations = MIGRATIONS, cible = SCHEMA) {
  let s = cloner(sauvegarde);
  while (s.schema < cible) {
    const etape = migrations[s.schema];
    if (typeof etape !== "function") throw new Error(`Migration manquante : format ${s.schema} → ${s.schema + 1}`);
    const avant = s.schema;
    s = etape(s);
    if (s.schema !== avant + 1) throw new Error(`La migration du format ${avant} n'a pas avancé le n° de format`);
  }
  return s;
}

const estTexte = (x) => typeof x === "string";
const estHorodatage = (x) => estTexte(x) && !Number.isNaN(Date.parse(x));

function erreurObjet(table, i, champ) {
  return `${table} n°${i + 1} : champ « ${champ} » invalide`;
}

/** Vérifie (et migre si besoin) une sauvegarde lue dans un fichier.
 *  → { ok: true, sauvegarde, avertissements } ou { ok: false, erreur } (message clair, en français). */
export function verifierSauvegarde(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { ok: false, erreur: "Ce fichier ne contient pas une sauvegarde lisible." };
  if (obj.format !== FORMAT_SAUVEGARDE) return { ok: false, erreur: "Ce fichier n'est pas une sauvegarde de Ma Compta Perso." };
  if (!Number.isInteger(obj.schema) || obj.schema < 1) return { ok: false, erreur: "Sauvegarde abîmée : n° de format absent." };
  if (obj.schema > SCHEMA) {
    return {
      ok: false,
      erreur: `Cette sauvegarde vient d'une version plus récente de l'appli (format n°${obj.schema}). Mets d'abord l'appli à jour, puis recommence.`,
    };
  }
  let s;
  try {
    s = migrer(obj);
  } catch (e) {
    return { ok: false, erreur: "Impossible de convertir cette ancienne sauvegarde : " + e.message };
  }
  for (const t of TABLES) {
    if (s[t] === undefined) s[t] = [];
    if (!Array.isArray(s[t])) return { ok: false, erreur: `Sauvegarde abîmée : « ${t} » n'est pas une liste.` };
  }
  const ids = new Set();
  for (const t of TABLES) {
    for (let i = 0; i < s[t].length; i++) {
      const x = s[t][i];
      if (!x || typeof x !== "object" || !estTexte(x.id) || !x.id) return { ok: false, erreur: erreurObjet(t, i, "id") };
      if (ids.has(x.id)) return { ok: false, erreur: `Sauvegarde abîmée : l'identifiant ${x.id} apparaît deux fois.` };
      ids.add(x.id);
      if (!estHorodatage(x.modifie_le)) return { ok: false, erreur: erreurObjet(t, i, "modifie_le") };
    }
  }
  for (let i = 0; i < s.comptes.length; i++) {
    const c = s.comptes[i];
    if (!estTexte(c.nom)) return { ok: false, erreur: erreurObjet("Compte", i, "nom") };
    if (!estCentimes(c.solde_depart)) return { ok: false, erreur: erreurObjet("Compte", i, "solde de départ") };
    if (!dateValide(c.date_depart)) return { ok: false, erreur: erreurObjet("Compte", i, "date de départ") };
  }
  for (let i = 0; i < s.categories.length; i++) {
    const c = s.categories[i];
    if (!estTexte(c.nom)) return { ok: false, erreur: erreurObjet("Catégorie", i, "nom") };
    if (!["depense", "revenu", "virement"].includes(c.sens)) return { ok: false, erreur: erreurObjet("Catégorie", i, "sens") };
  }
  const comptesConnus = new Set(s.comptes.map((c) => c.id));
  const categoriesConnues = new Set(s.categories.map((c) => c.id));
  const avertissements = [];
  let orphelines = 0;
  for (let i = 0; i < s.operations.length; i++) {
    const o = s.operations[i];
    if (!dateValide(o.date)) return { ok: false, erreur: erreurObjet("Opération", i, "date") };
    if (!estCentimes(o.montant)) return { ok: false, erreur: erreurObjet("Opération", i, "montant") };
    if (!estTexte(o.compte) || !estTexte(o.categorie)) return { ok: false, erreur: erreurObjet("Opération", i, "compte / catégorie") };
    if (o.lien_virement != null && !estTexte(o.lien_virement)) return { ok: false, erreur: erreurObjet("Opération", i, "lien de virement") };
    if (!comptesConnus.has(o.compte) || !categoriesConnues.has(o.categorie)) orphelines += 1;
  }
  if (orphelines) avertissements.push(`${orphelines} opération(s) pointent vers un compte ou une catégorie inconnus.`);
  const incomplets = virementsIncomplets(s.operations).length;
  if (incomplets) avertissements.push(`${incomplets} virement(s) incomplet(s) : une seule des deux opérations existe. Touchez-les dans la liste pour les supprimer.`);
  s.reglages = normaliserReglages(s.reglages);
  return { ok: true, sauvegarde: s, avertissements };
}

/** Les virements entre mes comptes qui ne sont PAS faits de 2 opérations actives de montants opposés.
 *  Ça ne peut venir que d'un fichier abîmé ou d'une future fusion ; l'appli propose alors de les supprimer. */
export function virementsIncomplets(operations) {
  const parLien = new Map();
  for (const o of operations) {
    if (o.supprime || !o.lien_virement) continue;
    const g = parLien.get(o.lien_virement) || [];
    g.push(o);
    parLien.set(o.lien_virement, g);
  }
  return [...parLien.entries()].filter(([, g]) => g.length !== 2 || g[0].montant + g[1].montant !== 0).map(([lien]) => lien);
}

/** Version anonymisée pour l'envoyer à Claude : libellés, tiers, notes et noms de comptes remplacés.
 *  Montants, dates et catégories gardés. Deux libellés identiques restent identiques (utile pour repérer un doublon). */
export function anonymiser(sauvegarde) {
  const s = cloner(sauvegarde);
  s.anonyme = true;
  s.appareil = "anonyme";
  const remplacer = (prefixe) => {
    const vus = new Map();
    return (v) => {
      if (!v) return "";
      if (!vus.has(v)) vus.set(v, `${prefixe} ${vus.size + 1}`);
      return vus.get(v);
    };
  };
  const libelle = remplacer("Libellé");
  const tiers = remplacer("Tiers");
  s.operations = s.operations.map((o) => ({ ...o, libelle: libelle(o.libelle), tiers: tiers(o.tiers), note: o.note ? "(note)" : "" }));
  s.comptes = s.comptes.map((c, i) => ({ ...c, nom: `Compte ${i + 1}` }));
  for (const t of ["recurrences", "regles"]) {
    s[t] = s[t].map((x) => {
      const y = { ...x };
      for (const k of ["libelle", "tiers", "note", "motif"]) if (estTexte(y[k]) && y[k]) y[k] = "(masqué)";
      return y;
    });
  }
  return s;
}

/** Fusion de deux sauvegardes (prête pour la future synchro téléphone ↔ PC, pas encore branchée dans l'interface).
 *  Pour chaque objet (même id) : on garde la version modifiée le plus récemment (égalité → celle de `a`).
 *  Une suppression est une modification comme une autre : elle suit dans la fusion. Les réglages de `a` sont gardés. */
export function fusionner(a, b) {
  const r = cloner(a);
  for (const t of TABLES) {
    const parId = new Map((a[t] || []).map((x) => [x.id, x]));
    for (const x of b[t] || []) {
      const y = parId.get(x.id);
      if (!y || x.modifie_le > y.modifie_le) parId.set(x.id, x);
    }
    r[t] = cloner([...parId.values()]);
  }
  return r;
}

/* =====================================================================
   v1.01 — PARTAGER L'APPLI : le message que chacun envoie à un proche.
   Le texte est fixé par l'éditeur (Rocco) ; seul le prénom change d'un appareil à l'autre,
   pour que personne ne partage « au nom de Rocco » sans être Rocco.
   ===================================================================== */

export const MAX_PRENOM = 30; // v1.01 — un prénom, pas un roman : le message reste lisible

/** v1.01 — Le prénom tel qu'il signera le message : sans espaces en trop, 30 caractères au plus. */
export function normaliserPrenom(texte) {
  return String(texte ?? "")
    .replace(/[\s  ]+/g, " ")
    .trim()
    .slice(0, MAX_PRENOM)
    .trim();
}

/** v1.01 — Le message de partage. Avec un prénom : « Salut, c'est Rocco ! » ; sans : « Salut ! ». */
export function messagePartage(prenom, adresse) {
  const p = normaliserPrenom(prenom);
  return [
    `Salut${p ? `, c'est ${p}` : ""} ! Je te partage une petite appli pour suivre tes comptes : gratuite, sans pub, sans inscription.`,
    `👉 ${adresse}`,
    "",
    "Pour l'installer :",
    "• Android : ouvre le lien dans Chrome, menu ⋮ → « Installer l'application ».",
    "• iPhone : ouvre le lien dans Safari, bouton Partager → « Sur l'écran d'accueil ».",
    "",
    "Ensuite, ouvre-la depuis son icône et laisse-toi guider. Tu peux d'abord l'essayer avec des exemples.",
    "",
    "Important : tes chiffres restent uniquement sur ton téléphone, personne d'autre ne les voit, même pas moi. Du coup, fais une sauvegarde de temps en temps (Réglages → Partager la sauvegarde, vers ton Drive ou ton mail) : si tu perds ton téléphone, c'est elle qui garde tes comptes.",
  ].join("\n");
}

/* =====================================================================
   DONNÉES D'EXEMPLE (« ▶ Essayer avec des exemples ») — le même générateur sert aux tests.
   Tirage pseudo-aléatoire « à graine » : mêmes paramètres → mêmes données, toujours.
   ===================================================================== */

function aleatoire(graine) {
  let x = graine >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Comptes + opérations inventés, des 3 derniers mois jusqu'à aujourd'hui (+ une opération à venir). */
export function genererExemples({ aujourdhui, maintenant, nouvelId, graine = 2026 }) {
  const alea = aleatoire(graine);
  const entre = (min, max) => min + Math.floor(alea() * (max - min + 1)); // centimes entiers
  const t = lireDate(aujourdhui);
  const d = decalerMois(t.a, t.m, -2);
  const depart = ecrireDate(d.a, d.m, 1);
  const base = { couleur: null, archive: false, cree_le: maintenant, modifie_le: maintenant, supprime: false };
  const courant = { ...base, id: nouvelId(), nom: "Compte courant", type: "courant", solde_depart: 185000, date_depart: depart, icone: "🏦", ordre: 0 };
  const livret = { ...base, id: nouvelId(), nom: "Livret A", type: "livret", solde_depart: 320000, date_depart: depart, icone: "🐷", ordre: 1 };
  const ops = [];
  const op = (date, montant, categorie, libelle, moyen) =>
    ops.push({
      id: nouvelId(),
      date,
      montant,
      compte: courant.id,
      categorie,
      libelle,
      tiers: "",
      moyen,
      note: "",
      pointe: false,
      recurrence_id: null,
      lien_virement: null,
      cree_le: maintenant,
      modifie_le: maintenant,
      supprime: false,
    });
  for (let jour = depart; jour <= aujourdhui; jour = ajouterJours(jour, 1)) {
    const j = lireDate(jour).j;
    if (j === 1) op(jour, 215000, "def-salaire", "Salaire", "virement");
    if (j === 5) op(jour, -65000, "def-logement", "Loyer", "prelevement");
    if (j === 8) op(jour, -entre(6500, 9800), "def-energie", "Électricité", "prelevement");
    if (j === 10) op(jour, -2999, "def-telephone", "Box internet", "prelevement");
    if (j === 12) op(jour, -1349, "def-abonnements", "Abonnement vidéo", "cb");
    if (j === 15) ops.push(...construireVirement({ ids: [nouvelId(), nouvelId()], lien: nouvelId(), de: courant.id, vers: livret.id, montant: 10000, date: jour, libelle: "Épargne du mois", maintenant }));
    if (j === 20) op(jour, -4200, "def-sante", "Mutuelle", "prelevement");
    if (alea() < 0.3) op(jour, -entre(1800, 9500), "def-courses", alea() < 0.7 ? "Supermarché" : "Marché", "cb");
    if (alea() < 0.15) op(jour, -entre(250, 900), "def-courses", "Boulangerie", "especes");
    if (alea() < 0.1) op(jour, -entre(4500, 7000), "def-transport", "Carburant", "cb");
    if (alea() < 0.12) op(jour, -entre(1200, 3800), "def-restaurants", "Restaurant", "cb");
    if (alea() < 0.04) op(jour, -entre(800, 3500), "def-sante", "Pharmacie", "cb");
    if (alea() < 0.05) op(jour, -entre(950, 2500), "def-loisirs", "Cinéma, sortie", "cb");
    if (alea() < 0.03) op(jour, -entre(1500, 6000), "def-habillement", "Vêtements", "cb");
  }
  op(ajouterJours(aujourdhui, 4), -5620, "def-transport", "Assurance auto", "prelevement"); // une opération « à venir »
  return { comptes: [courant, livret], operations: ops };
}
