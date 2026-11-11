// tests/test_calcul.mjs — v1.00 — création : tests de calcul.js avec Node, sans aucune bibliothèque.
// Lancement : node tests/test_calcul.mjs
// Le fichier se relance tout seul dans 3 fuseaux horaires (Guadeloupe, Paris, UTC) :
// le calcul doit donner EXACTEMENT les mêmes résultats partout.
// Données de test FABRIQUÉES ici, jamais de vraies données.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FUSEAUX = ["America/Guadeloupe", "Europe/Paris", "UTC"];

if (!process.env.TEST_FUSEAU) {
  let echecs = 0;
  for (const tz of FUSEAUX) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, TZ: tz, TEST_FUSEAU: tz },
      encoding: "utf8",
    });
    process.stdout.write(r.stdout);
    process.stderr.write(r.stderr);
    if (r.status !== 0) echecs += 1;
  }
  if (echecs) {
    console.error(`\n❌ Échec dans ${echecs} fuseau(x) sur ${FUSEAUX.length}`);
    process.exit(1);
  }
  console.log(`\n✅ Tous les tests de calcul.js passent dans les ${FUSEAUX.length} fuseaux.`);
  process.exit(0);
}

const C = await import("../calcul.js");

let nb = 0;
const ratés = [];
function test(nom, f) {
  try {
    f();
    nb += 1;
  } catch (e) {
    ratés.push(`  ✗ ${nom}\n      ${String(e.message).split("\n").join("\n      ")}`);
  }
}
const espaces = (s) => s.replace(/[  ]/g, " "); // pour comparer l'affichage sans se soucier du type d'espace

const MAINTENANT = "2026-10-29T14:00:00.000Z";
let compteur = 0;
const nouvelId = () => `id-${++compteur}`;

/* ------------------------- Montants ------------------------- */

test("texteVersCentimes : formats acceptés", () => {
  const cas = {
    "12": 1200,
    "12,5": 1250,
    "12.50": 1250,
    "0,05": 5,
    "1 234,56": 123456,
    "1 234,56": 123456,
    "1 234,56": 123456,
    ",5": 50,
    "12,": 1200,
    "-3,10": -310,
    "−3,10": -310,
    "+7": 700,
    "0": 0,
    "-0": 0,
    "999999999,99": 99999999999,
  };
  for (const [t, attendu] of Object.entries(cas)) assert.equal(C.texteVersCentimes(t), attendu, `« ${t} »`);
});

test("texteVersCentimes : refus", () => {
  for (const t of ["", "abc", "12,345", "1.234,56", "1,2,3", "12a", "--3", "1234567890", " ", null, undefined, 12]) {
    assert.equal(C.texteVersCentimes(t), null, `« ${t} » doit être refusé`);
  }
});

test("centimesVersTexte (CSV, sans séparateur de milliers)", () => {
  assert.equal(C.centimesVersTexte(123456), "1234,56");
  assert.equal(C.centimesVersTexte(-5), "-0,05");
  assert.equal(C.centimesVersTexte(0), "0,00");
  assert.equal(C.centimesVersTexte(100), "1,00");
  assert.equal(C.centimesVersTexte(-123456789), "-1234567,89");
});

test("formaterEuros (affichage)", () => {
  assert.equal(espaces(C.formaterEuros(123456)), "1 234,56 €");
  assert.equal(espaces(C.formaterEuros(-1250)), "−12,50 €");
  assert.equal(espaces(C.formaterEuros(1250, { signe: true })), "+12,50 €");
  assert.equal(espaces(C.formaterEuros(0, { signe: true })), "0,00 €");
  assert.equal(espaces(C.formaterEuros(29)), "0,29 €"); // 29/100 n'est pas exact en binaire : l'affichage doit l'être
  assert.equal(espaces(C.formaterEuros(99999999999)), "999 999 999,99 €");
});

test("somme : entiers exacts, là où 0,1 + 0,2 ≠ 0,3", () => {
  assert.notEqual(0.1 + 0.2, 0.3); // le piège des nombres à virgule…
  assert.equal(C.somme([10, 20]), 30); // … qui n'existe pas en centimes
  assert.equal(C.somme([]), 0);
  assert.throws(() => C.somme([Number.MAX_SAFE_INTEGER, 10]));
});

test("appliquerTouche : le pavé numérique", () => {
  const taper = (touches) => touches.reduce((t, k) => C.appliquerTouche(t, k), "");
  assert.equal(taper(["1", "2", ",", "5", "0"]), "12,50");
  assert.equal(taper(["1", "2", ",", "5", "0", "9"]), "12,50"); // 2 décimales maximum
  assert.equal(taper([","]), "0,");
  assert.equal(taper(["."]), "0,"); // le point devient une virgule
  assert.equal(taper(["0", "5"]), "5"); // pas de « 05 »
  assert.equal(taper(["1", ",", ","]), "1,"); // une seule virgule
  assert.equal(taper(["1", "2", "⌫"]), "1");
  assert.equal(taper(["⌫"]), "");
  assert.equal(taper(["1", "2", "3", "4", "5", "6", "7", "8"]), "1234567"); // 7 chiffres maximum avant la virgule
  assert.equal(taper(["x"]), "");
  assert.equal(C.texteVersCentimes(taper(["4", "2", ",", "9"])), 4290);
});

/* ------------------------- Dates ------------------------- */

test("lireDate / dateValide", () => {
  assert.deepEqual(C.lireDate("2026-10-29"), { a: 2026, m: 10, j: 29 });
  assert.equal(C.dateValide("2026-02-29"), false); // 2026 n'est pas bissextile
  assert.equal(C.dateValide("2028-02-29"), true);
  for (const t of ["2026-13-01", "2026-00-10", "2026-04-31", "29/10/2026", "2026-1-5", "", null]) assert.equal(C.dateValide(t), false, String(t));
});

test("dateDuJour = date LOCALE (piège 1)", () => {
  // 21 h le 29 octobre, heure de l'appareil : c'est toujours le 29, quel que soit le fuseau.
  assert.equal(C.dateDuJour(new Date(2026, 9, 29, 21, 0)), "2026-10-29");
  assert.equal(C.dateDuJour(new Date(2026, 9, 30, 0, 30)), "2026-10-30");
  assert.equal(C.dateDuJour(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
  if (process.env.TEST_FUSEAU === "America/Guadeloupe") {
    // La preuve du piège : toISOString() donnerait le 30 à 21 h en Guadeloupe.
    assert.equal(new Date(2026, 9, 29, 21, 0).toISOString().slice(0, 10), "2026-10-30");
  }
});

test("ajouterJours / ecartJours (y compris changements d'heure)", () => {
  assert.equal(C.ajouterJours("2026-10-29", 1), "2026-10-30");
  assert.equal(C.ajouterJours("2026-10-31", 1), "2026-11-01");
  assert.equal(C.ajouterJours("2026-12-31", 1), "2027-01-01");
  assert.equal(C.ajouterJours("2026-03-01", -1), "2026-02-28");
  assert.equal(C.ajouterJours("2028-03-01", -1), "2028-02-29");
  assert.equal(C.ajouterJours("2026-03-28", 2), "2026-03-30"); // passage à l'heure d'été à Paris le 29/03
  assert.equal(C.ajouterJours("2026-10-24", 2), "2026-10-26"); // passage à l'heure d'hiver le 25/10
  assert.equal(C.ecartJours("2026-10-27", "2026-10-29"), 2);
  assert.equal(C.ecartJours("2026-10-29", "2026-10-27"), -2);
  assert.equal(C.ecartJours("2026-03-28", "2026-03-30"), 2);
});

test("mois de budget calendaire", () => {
  const p = C.moisDeBudget("2026-10-29", 1);
  assert.equal(p.debut, "2026-10-01");
  assert.equal(p.fin, "2026-10-31");
  assert.equal(C.titrePeriode(p, 1), "Octobre 2026");
  const f = C.moisDeBudget("2028-02-10", 1);
  assert.equal(f.fin, "2028-02-29");
  const s = C.moisVoisin(p, 1, 1);
  assert.equal(s.debut, "2026-11-01");
  assert.equal(s.fin, "2026-11-30");
  const avant = C.moisVoisin(C.moisDeBudget("2026-01-15", 1), -1, 1);
  assert.equal(avant.debut, "2025-12-01");
});

test("mois de budget d'une paie à l'autre (le 31 → 30 / 28 / 29)", () => {
  const p = C.moisDeBudget("2026-10-29", 28);
  assert.equal(p.debut, "2026-10-28");
  assert.equal(p.fin, "2026-11-27");
  assert.equal(C.nomDuMois(p.nom_a, p.nom_m), "Novembre 2026"); // la paie du 28/10 « finance » novembre
  assert.equal(C.moisDeBudget("2026-10-27", 28).debut, "2026-09-28");
  // Paie le 31 : février non bissextile, bissextile, mois de 30 jours.
  assert.equal(C.moisDeBudget("2027-02-28", 31).debut, "2027-02-28");
  assert.equal(C.moisDeBudget("2027-02-28", 31).fin, "2027-03-30");
  assert.equal(C.moisDeBudget("2027-02-27", 31).debut, "2027-01-31");
  assert.equal(C.moisDeBudget("2027-02-27", 31).fin, "2027-02-27");
  assert.equal(C.moisDeBudget("2028-02-29", 31).debut, "2028-02-29");
  assert.equal(C.moisDeBudget("2026-04-30", 31).debut, "2026-04-30");
  assert.equal(C.moisDeBudget("2026-04-29", 31).fin, "2026-04-29");
  // Les périodes s'enchaînent sans trou ni chevauchement sur 3 ans.
  let q = C.moisDeBudget("2026-01-15", 31);
  for (let i = 0; i < 36; i++) {
    const n = C.moisVoisin(q, 1, 31);
    assert.equal(C.ajouterJours(q.fin, 1), n.debut, `trou après ${q.fin}`);
    q = n;
  }
  // Paie le 5 : le mois porte le nom du mois où il commence.
  const c = C.moisDeBudget("2026-11-10", 5);
  assert.equal(c.debut, "2026-11-05");
  assert.equal(C.nomDuMois(c.nom_a, c.nom_m), "Novembre 2026");
});

test("noms de jours et dates (fr)", () => {
  assert.equal(C.nomDuJour("2026-10-29", "2026-10-29"), "Aujourd'hui");
  assert.equal(C.nomDuJour("2026-10-28", "2026-10-29"), "Hier");
  assert.equal(C.nomDuJour("2026-10-27", "2026-10-29"), "Avant-hier");
  assert.equal(C.nomDuJour("2026-10-30", "2026-10-29"), "Demain");
  assert.equal(C.nomDuJour("2026-10-20", "2026-10-29"), "Mardi 20 octobre");
  assert.equal(C.nomDuJour("2025-12-31", "2026-01-05"), "Mercredi 31 décembre 2025");
  assert.equal(C.dateCSV("2026-01-05"), "05/01/2026");
  assert.equal(C.dateCourte("2026-10-29"), "29 oct.");
  assert.equal(C.nomDuMois(2026, 11), "Novembre 2026");
});

/* ------------------------- Soldes et mois ------------------------- */

const compteA = { id: "A", nom: "Courant", solde_depart: 100000, date_depart: "2026-10-01", ordre: 0, archive: false, supprime: false };
const compteB = { id: "B", nom: "Livret", solde_depart: 50000, date_depart: "2026-10-01", ordre: 1, archive: false, supprime: false };
const op = (id, date, montant, compte = "A", extra = {}) => ({
  id,
  date,
  montant,
  compte,
  categorie: "def-courses",
  libelle: "",
  tiers: "",
  note: "",
  lien_virement: null,
  supprime: false,
  cree_le: MAINTENANT,
  modifie_le: MAINTENANT,
  ...extra,
});

test("solde d'un compte : départ + opérations jusqu'à aujourd'hui inclus", () => {
  const ops = [
    op("1", "2026-10-02", -1250),
    op("2", "2026-10-29", -500), // aujourd'hui : compte
    op("3", "2026-10-30", -9999), // demain : « à venir », ne compte pas
    op("4", "2026-09-30", -7777), // AVANT la date de départ : déjà dans le solde de départ
    op("5", "2026-10-10", -3333, "A", { supprime: true }), // supprimée
    op("6", "2026-10-10", 20000, "B"), // autre compte
  ];
  assert.equal(C.soldeCompte(compteA, ops, "2026-10-29"), 100000 - 1250 - 500);
  assert.equal(C.aVenirCompte(compteA, ops, "2026-10-29"), -9999);
  const r = C.resumeComptes([compteA, compteB, { ...compteB, id: "Z", archive: true }], ops, "2026-10-29");
  assert.equal(r.lignes.length, 2); // le compte archivé n'apparaît pas
  assert.equal(r.total, 100000 - 1750 + 70000);
  assert.equal(r.totalAVenir, -9999);
});

test("virements : 2 opérations liées, exclues des entrées / sorties du mois", () => {
  const v = C.construireVirement({ ids: ["v1", "v2"], lien: "L", de: "A", vers: "B", montant: 10000, date: "2026-10-15", maintenant: MAINTENANT });
  assert.equal(v[0].montant, -10000);
  assert.equal(v[1].montant, 10000);
  assert.equal(v[0].lien_virement, "L");
  assert.equal(v[0].categorie, C.ID_CAT_VIREMENT);
  assert.throws(() => C.construireVirement({ ids: ["a", "b"], lien: "L", de: "A", vers: "A", montant: 1, date: "2026-10-15", maintenant: MAINTENANT }));
  assert.throws(() => C.construireVirement({ ids: ["a", "b"], lien: "L", de: "A", vers: "B", montant: 0, date: "2026-10-15", maintenant: MAINTENANT }));
  const ops = [...v, op("s", "2026-10-02", 200000, "A"), op("d", "2026-10-03", -4590, "A"), op("f", "2026-10-31", -65000, "A")];
  const p = C.moisDeBudget("2026-10-29", 1);
  const r = C.resumePeriode(ops, p, "2026-10-29");
  assert.deepEqual(r, { entrees: 200000, sorties: 4590, solde: 195410, aVenirEntrees: 0, aVenirSorties: 65000, nb: 2 });
  // Les soldes, eux, bougent : l'argent a changé de compte.
  assert.equal(C.soldeCompte(compteA, ops, "2026-10-29"), 100000 - 10000 + 200000 - 4590);
  assert.equal(C.soldeCompte(compteB, ops, "2026-10-29"), 50000 + 10000);
  // Le total du jour exclut le virement.
  const g = C.grouperParJour(C.trierOperations(ops.filter((o) => o.date === "2026-10-15")));
  assert.equal(g[0].total, 0);
});

test("tri et regroupement par jour", () => {
  const ops = [
    op("a", "2026-10-02", -100, "A", { cree_le: "2026-10-02T10:00:00.000Z" }),
    op("b", "2026-10-03", -200),
    op("c", "2026-10-02", -300, "A", { cree_le: "2026-10-02T11:00:00.000Z" }),
  ];
  const t = C.trierOperations(ops).map((o) => o.id);
  assert.deepEqual(t, ["b", "c", "a"]);
  const g = C.grouperParJour(C.trierOperations(ops));
  assert.deepEqual(
    g.map((x) => [x.date, x.total, x.operations.length]),
    [
      ["2026-10-03", -200, 1],
      ["2026-10-02", -400, 2],
    ]
  );
});

test("ordre de la grille : les plus utilisées d'abord, stable sinon", () => {
  const cats = C.categoriesParDefaut(MAINTENANT);
  const sans = C.ordreCategories(cats, [], "depense", "2026-10-29");
  assert.equal(sans[0], "def-logement"); // aucune utilisation : l'ordre de la liste
  assert.ok(!sans.includes(C.ID_CAT_VIREMENT), "la catégorie système n'est jamais dans la grille");
  const ops = [op("1", "2026-10-20", -1, "A", { categorie: "def-courses" }), op("2", "2026-10-21", -1, "A", { categorie: "def-courses" }), op("3", "2026-10-21", -1, "A", { categorie: "def-sante" })];
  const avec = C.ordreCategories(cats, ops, "depense", "2026-10-29");
  assert.deepEqual(avec.slice(0, 2), ["def-courses", "def-sante"]);
  const vieux = C.ordreCategories(cats, [op("4", "2026-01-01", -1, "A", { categorie: "def-sante" })], "depense", "2026-10-29");
  assert.equal(vieux[0], "def-logement"); // plus de 90 jours : ne compte plus
  assert.equal(C.ordreCategories(cats, [], "revenu", "2026-10-29")[0], "def-salaire");
});

test("totaux par catégorie et pourcentages", () => {
  const p = C.moisDeBudget("2026-10-29", 1);
  const ops = [
    op("1", "2026-10-05", -3000, "A", { categorie: "def-courses" }),
    op("2", "2026-10-06", -1000, "A", { categorie: "def-courses" }),
    op("3", "2026-10-07", -6000, "A", { categorie: "def-logement" }),
    op("4", "2026-10-08", 150000, "A", { categorie: "def-salaire" }),
    op("5", "2026-10-30", -9999, "A", { categorie: "def-courses" }), // à venir : exclue
  ];
  const t = C.totauxParCategorie(ops, p, "2026-10-29");
  assert.deepEqual(
    t.sorties.map((x) => [x.categorie, x.total, x.nb]),
    [
      ["def-logement", 6000, 1],
      ["def-courses", 4000, 2],
    ]
  );
  assert.equal(t.totalSorties, 10000);
  assert.equal(t.totalEntrees, 150000);
  assert.equal(C.pourcentage(4000, 10000), 40);
  assert.equal(C.pourcentage(1, 3), 33);
  assert.equal(C.pourcentage(5, 0), 0);
});

test("recherche : sans accents, dans le libellé, la catégorie, le montant", () => {
  const cats = new Map(C.categoriesParDefaut(MAINTENANT).map((c) => [c.id, c]));
  const cpts = new Map([["A", compteA]]);
  const ops = [
    op("1", "2026-10-05", -4590, "A", { libelle: "Électricité EDF", categorie: "def-energie" }),
    op("2", "2026-10-06", -1250, "A", { libelle: "Pain", categorie: "def-courses" }),
  ];
  const f = (q, extra = {}) => C.filtrerOperations(ops, { texte: q, ...extra }, cats, cpts).map((o) => o.id);
  assert.deepEqual(f("electricite"), ["1"]);
  assert.deepEqual(f("COURSES"), ["2"]);
  assert.deepEqual(f("12,50"), ["2"]);
  assert.deepEqual(f("45.90"), ["1"]);
  assert.deepEqual(f(""), ["1", "2"]);
  assert.deepEqual(f("", { categorie: "def-energie" }), ["1"]);
  assert.deepEqual(f("zzz"), []);
});

/* ------------------------- Catégories par défaut ------------------------- */

test("catégories par défaut : id uniques et fixes, pas d'icône en double dans un même sens", () => {
  const cats = C.categoriesParDefaut(MAINTENANT);
  assert.equal(new Set(cats.map((c) => c.id)).size, cats.length);
  for (const sens of ["depense", "revenu"]) {
    const icones = cats.filter((c) => c.sens === sens).map((c) => c.icone);
    assert.equal(new Set(icones).size, icones.length, `icône en double côté ${sens}`);
  }
  const toutes = cats.map((c) => c.icone);
  assert.equal(new Set(toutes).size, toutes.length, "icône en double (🎁 ?)");
  assert.equal(cats.find((c) => c.id === "def-primes").icone, "🎉");
  assert.equal(cats.filter((c) => c.systeme).length, 1);
  assert.deepEqual(C.categoriesParDefaut(MAINTENANT).map((c) => c.id), cats.map((c) => c.id)); // mêmes id à chaque fois
});

/* ------------------------- CSV ------------------------- */

test("CSV pour Excel : BOM, « ; », CRLF, virgule décimale, JJ/MM/AAAA, guillemets, formules neutralisées", () => {
  const cats = C.categoriesParDefaut(MAINTENANT);
  const ops = [
    op("1", "2026-10-05", -123456, "A", { libelle: 'Pain "frais"; et lait', moyen: "cb" }),
    op("2", "2026-10-06", 2500, "A", { libelle: "=SOMME(A1:A9)", categorie: "def-salaire", note: "ligne 1\nligne 2" }),
    op("3", "2026-10-07", -5, "A", { libelle: "-pas une formule", tiers: "@moi", supprime: true }),
  ];
  const csv = C.genererCSV({ comptes: [compteA], categories: cats, operations: ops });
  assert.ok(csv.startsWith("﻿"), "BOM absent");
  const horsGuillemets = csv.replace(/"(?:[^"]|"")*"/g, "«champ»"); // un retour à la ligne DANS une note (entre guillemets) est permis
  assert.ok(!/[^\r]\n/.test(horsGuillemets), "une fin de ligne n'est pas en CRLF");
  const lignes = csv.slice(1).split("\r\n");
  assert.equal(lignes[0], "Date;Compte;Type;Catégorie;Libellé;Tiers;Moyen;Montant;Note;Pointée");
  assert.equal(lignes[1], '05/10/2026;Courant;Dépense;Courses;"Pain ""frais""; et lait";;CB;-1234,56;;');
  assert.ok(lignes[2].startsWith("06/10/2026;Courant;Entrée;Salaire;'=SOMME(A1:A9);;;25,00;"), lignes[2]);
  assert.ok(csv.includes('"ligne 1\nligne 2"'));
  assert.ok(!csv.includes("pas une formule"), "une opération supprimée est exportée");
  assert.ok(!/[  ]/.test(csv), "espace insécable dans le CSV");
  assert.equal(C.champCSV("-12,50", { texte: false }), "-12,50");
  assert.equal(C.champCSV("-12,50"), "'-12,50");
  assert.equal(C.champCSV("+33 6"), "'+33 6");
});

/* ------------------------- Sauvegardes ------------------------- */

function donneesTest() {
  const cats = C.categoriesParDefaut(MAINTENANT);
  return {
    reglages: { ...C.REGLAGES_DEFAUT, theme: "sombre" },
    comptes: [compteA, compteB].map((c) => ({ ...c, cree_le: MAINTENANT, modifie_le: MAINTENANT })),
    categories: cats,
    operations: [op("o1", "2026-10-05", -4590, "A", { libelle: "Boulangerie", tiers: "Chez Paul", note: "pain" }), op("o2", "2026-10-06", -4590, "A", { libelle: "Boulangerie" })],
    recurrences: [],
    budgets: [],
    regles: [],
  };
}

test("sauvegarde → vérification : identique", () => {
  const d = donneesTest();
  const s = C.construireSauvegarde(d, { versionAppli: "1.00", appareil: "Téléphone", maintenant: MAINTENANT });
  const relue = JSON.parse(JSON.stringify(s));
  const v = C.verifierSauvegarde(relue);
  assert.equal(v.ok, true, v.erreur);
  for (const t of C.TABLES) assert.deepEqual(v.sauvegarde[t], d[t], t);
  assert.equal(v.sauvegarde.reglages.theme, "sombre");
  assert.deepEqual(v.avertissements, []);
  assert.equal(C.nomFichier("sauvegarde", "2026-10-29", "json"), "ma-compta_sauvegarde_2026-10-29.json");
});

test("sauvegarde : refus clairs", () => {
  const s = C.construireSauvegarde(donneesTest(), { versionAppli: "1.00", maintenant: MAINTENANT });
  assert.equal(C.verifierSauvegarde(null).ok, false);
  assert.match(C.verifierSauvegarde({ format: "autre" }).erreur, /n'est pas une sauvegarde/);
  assert.match(C.verifierSauvegarde({ ...s, schema: C.SCHEMA + 1 }).erreur, /plus récente/);
  const montantFaux = JSON.parse(JSON.stringify(s));
  montantFaux.operations[0].montant = 45.9;
  assert.match(C.verifierSauvegarde(montantFaux).erreur, /montant/);
  const dateFausse = JSON.parse(JSON.stringify(s));
  dateFausse.operations[0].date = "05/10/2026";
  assert.match(C.verifierSauvegarde(dateFausse).erreur, /date/);
  const doublon = JSON.parse(JSON.stringify(s));
  doublon.operations[1].id = doublon.operations[0].id;
  assert.match(C.verifierSauvegarde(doublon).erreur, /deux fois/);
  const orpheline = JSON.parse(JSON.stringify(s));
  orpheline.operations[0].categorie = "inconnue";
  const v = C.verifierSauvegarde(orpheline);
  assert.equal(v.ok, true);
  assert.equal(v.avertissements.length, 1);
});

test("migration : ancien format → nouveau, sans perte (mécanisme testé avec une migration fictive)", () => {
  const ancien = { ...C.construireSauvegarde(donneesTest(), { versionAppli: "1.00", maintenant: MAINTENANT }) };
  const fictives = {
    1: (s) => ({ ...s, schema: 2, operations: s.operations.map((o) => ({ ...o, nouveau_champ: true })) }),
  };
  const m = C.migrer(ancien, fictives, 2);
  assert.equal(m.schema, 2);
  assert.equal(m.operations.length, ancien.operations.length);
  assert.ok(m.operations.every((o) => o.nouveau_champ === true));
  assert.equal(m.operations[0].montant, ancien.operations[0].montant);
  assert.equal(ancien.schema, 1, "l'original ne doit pas être modifié");
  assert.throws(() => C.migrer(ancien, {}, 2), /Migration manquante/);
  assert.throws(() => C.migrer(ancien, { 1: (s) => s }, 2), /pas avancé/);
  assert.equal(C.migrer(ancien).schema, C.SCHEMA); // déjà au bon format : rien à faire
});

test("anonymisation : libellés, tiers, notes, noms de comptes remplacés ; montants, dates, catégories gardés", () => {
  const s = C.construireSauvegarde(donneesTest(), { versionAppli: "1.00", appareil: "Téléphone de Rocco", maintenant: MAINTENANT });
  const a = C.anonymiser(s);
  assert.equal(a.anonyme, true);
  assert.equal(a.appareil, "anonyme");
  assert.deepEqual(
    a.operations.map((o) => [o.libelle, o.tiers, o.note, o.montant, o.date, o.categorie]),
    [
      ["Libellé 1", "Tiers 1", "(note)", -4590, "2026-10-05", "def-courses"],
      ["Libellé 1", "", "", -4590, "2026-10-06", "def-courses"], // même libellé → même remplaçant
    ]
  );
  assert.deepEqual(a.comptes.map((c) => c.nom), ["Compte 1", "Compte 2"]);
  const texte = JSON.stringify(a);
  for (const secret of ["Boulangerie", "Chez Paul", "pain", "Courant", "Livret", "Rocco"]) assert.ok(!texte.includes(secret), `« ${secret} » visible`);
  assert.equal(s.operations[0].libelle, "Boulangerie", "l'original ne doit pas être modifié");
  assert.equal(C.verifierSauvegarde(a).ok, true);
});

test("fusion : la version la plus récente gagne, les suppressions suivent", () => {
  const a = { comptes: [], categories: [], recurrences: [], budgets: [], regles: [], operations: [op("1", "2026-10-01", -100, "A", { modifie_le: "2026-10-01T10:00:00.000Z" }), op("2", "2026-10-02", -200, "A", { modifie_le: "2026-10-02T10:00:00.000Z" })] };
  const b = { operations: [op("1", "2026-10-01", -150, "A", { modifie_le: "2026-10-03T10:00:00.000Z" }), op("2", "2026-10-02", -200, "A", { modifie_le: "2026-10-04T10:00:00.000Z", supprime: true }), op("3", "2026-10-05", -300, "A")] };
  const f = C.fusionner(a, b);
  const parId = new Map(f.operations.map((o) => [o.id, o]));
  assert.equal(parId.size, 3);
  assert.equal(parId.get("1").montant, -150);
  assert.equal(parId.get("2").supprime, true);
  assert.equal(parId.get("3").montant, -300);
  const g = C.fusionner(b.operations ? { ...a, operations: b.operations } : b, a);
  assert.equal(new Map(g.operations.map((o) => [o.id, o])).get("1").montant, -150); // dans l'autre sens aussi
});

test("réglages : toujours valides, même venant d'un fichier abîmé", () => {
  assert.deepEqual(C.normaliserReglages(undefined), { ...C.REGLAGES_DEFAUT });
  assert.deepEqual(C.normaliserReglages([1, 2]), { ...C.REGLAGES_DEFAUT });
  const faux = { jour_debut_mois: null, theme: "violet", taille_texte: 999, mode_saisie: 3, appareil_principal: "oui", rappel_sauvegarde_jours: -1, dernier_compte: 12 };
  assert.deepEqual(C.normaliserReglages(faux), { ...C.REGLAGES_DEFAUT });
  const bons = { jour_debut_mois: 28, theme: "sombre", taille_texte: 130, mode_saisie: "bouton", appareil_principal: false, rappel_sauvegarde_jours: 0, dernier_compte: "abc" };
  assert.deepEqual(C.normaliserReglages(bons), bons);
  assert.equal(C.normaliserReglages({ jour_debut_mois: 0 }).jour_debut_mois, 1);
  assert.equal(C.normaliserReglages({ jour_debut_mois: 32 }).jour_debut_mois, 1);
  assert.equal(C.normaliserReglages({ jour_debut_mois: 2.5 }).jour_debut_mois, 1);
  assert.equal(C.normaliserReglages({ futur: "x" }).futur, "x"); // un réglage inconnu est gardé
  // Une sauvegarde aux réglages abîmés est acceptée, réglages remis d'aplomb (sinon l'appli ne s'afficherait plus).
  const s = C.construireSauvegarde(donneesTest(), { versionAppli: "1.00", maintenant: MAINTENANT });
  const v = C.verifierSauvegarde({ ...JSON.parse(JSON.stringify(s)), reglages: faux });
  assert.equal(v.ok, true, v.erreur);
  assert.equal(v.sauvegarde.reglages.jour_debut_mois, 1);
  assert.doesNotThrow(() => C.moisDeBudget("2026-10-29", v.sauvegarde.reglages.jour_debut_mois));
});

test("virements incomplets : repérés, et signalés à la restauration", () => {
  const v = C.construireVirement({ ids: ["v1", "v2"], lien: "L", de: "A", vers: "B", montant: 5000, date: "2026-10-15", maintenant: MAINTENANT });
  assert.deepEqual(C.virementsIncomplets(v), []);
  assert.deepEqual(C.virementsIncomplets([v[0]]), ["L"]); // une seule jambe
  assert.deepEqual(C.virementsIncomplets([v[0], { ...v[1], supprime: true }]), ["L"]);
  assert.deepEqual(C.virementsIncomplets([{ ...v[0], supprime: true }, { ...v[1], supprime: true }]), []); // supprimé en entier : rien à signaler
  assert.deepEqual(C.virementsIncomplets([v[0], { ...v[1], montant: 4000 }]), ["L"]); // montants qui ne s'équilibrent pas
  const d = donneesTest();
  const s = C.construireSauvegarde({ ...d, operations: [...d.operations, v[0]] }, { versionAppli: "1.00", maintenant: MAINTENANT });
  const r = C.verifierSauvegarde(JSON.parse(JSON.stringify(s)));
  assert.equal(r.ok, true, r.erreur);
  assert.ok(r.avertissements.some((a) => a.includes("incomplet")), r.avertissements.join(" / "));
  const fausse = JSON.parse(JSON.stringify(s));
  fausse.operations[0].lien_virement = 42;
  assert.match(C.verifierSauvegarde(fausse).erreur, /lien de virement/);
});

/* ------------------------- v1.01 — Partager l'appli ------------------------- */

test("v1.01 — prénom : espaces nettoyés, 30 caractères au plus", () => {
  assert.equal(C.normaliserPrenom("  Rocco  "), "Rocco");
  assert.equal(C.normaliserPrenom("Jean   Marc"), "Jean Marc");
  assert.equal(C.normaliserPrenom(""), "");
  assert.equal(C.normaliserPrenom(null), "");
  assert.equal(C.normaliserPrenom(undefined), "");
  assert.equal(C.normaliserPrenom("x".repeat(50)).length, C.MAX_PRENOM);
});

test("v1.01 — message de partage : signé du prénom, sinon « Salut ! »", () => {
  const adresse = "https://ma-compta-perso.github.io/";
  const m = C.messagePartage("Rocco", adresse);
  assert.ok(m.startsWith("Salut, c'est Rocco ! Je te partage une petite appli"), m.slice(0, 60));
  assert.ok(m.includes(`👉 ${adresse}\n`), "l'adresse doit être sur sa propre ligne");
  assert.ok(m.includes("• Android : ouvre le lien dans Chrome"));
  assert.ok(m.includes("• iPhone : ouvre le lien dans Safari"));
  assert.ok(m.endsWith("c'est elle qui garde tes comptes."));
  assert.ok(C.messagePartage("", adresse).startsWith("Salut ! Je te partage"));
  assert.ok(C.messagePartage("   ", adresse).startsWith("Salut ! Je te partage"));
  assert.ok(C.messagePartage(" Marie ", adresse).startsWith("Salut, c'est Marie ! "));
  assert.equal(C.messagePartage("Rocco", adresse).split(adresse).length, 2, "l'adresse une seule fois");
});

/* ------------------------- v1.02 — copie avant mise à jour ------------------------- */

test("v1.02 — n° de version lu en nombres (1.10 vient après 1.09, pas avant 1.2)", () => {
  assert.deepEqual(C.lireVersion("1.02"), [1, 2]);
  assert.deepEqual(C.lireVersion("1.10"), [1, 10]);
  assert.deepEqual(C.lireVersion("2.00"), [2, 0]);
  assert.deepEqual(C.lireVersion("1.02-test"), [1, 2]);
  assert.equal(C.lireVersion(""), null);
  assert.equal(C.lireVersion(undefined), null);
  assert.equal(C.lireVersion("abc"), null);
});

test("v1.02 — copie avant mise à jour : seulement pour de vraies données laissées par une version plus ancienne", () => {
  const vraie = (v) => ({ schema: 1, version_appli: v, exemple: false });
  assert.equal(C.copieAvantMiseAJourNecessaire(vraie("1.01"), "1.02"), true, "1.01 → 1.02");
  assert.equal(C.copieAvantMiseAJourNecessaire(vraie("1.00"), "1.02"), true, "une version sautée");
  assert.equal(C.copieAvantMiseAJourNecessaire(vraie("1.09"), "1.10"), true, "1.09 → 1.10 (et pas 1.1 < 1.09)");
  assert.equal(C.copieAvantMiseAJourNecessaire(vraie("1.99"), "2.00"), true, "1.99 → 2.00");
  assert.equal(C.copieAvantMiseAJourNecessaire(vraie(undefined), "1.02"), true, "version inconnue : prudence");
  assert.equal(C.copieAvantMiseAJourNecessaire({ schema: 1 }, "1.02"), true, "pas de n° du tout : prudence");
  assert.equal(C.copieAvantMiseAJourNecessaire(vraie("1.02"), "1.02-test"), true, "version de test (même n°, autre nom)");
  assert.equal(C.copieAvantMiseAJourNecessaire(vraie("1.02"), "1.02"), false, "même version : rien à faire");
  assert.equal(C.copieAvantMiseAJourNecessaire(vraie("1.03"), "1.02"), false, "un vieil onglet ne doit pas écraser la copie");
  assert.equal(C.copieAvantMiseAJourNecessaire(vraie("2.00"), "1.99"), false);
  assert.equal(C.copieAvantMiseAJourNecessaire({ ...vraie("1.01"), exemple: true }, "1.02"), false, "données d'exemple : jamais");
  assert.equal(C.copieAvantMiseAJourNecessaire(null, "1.02"), false, "aucune donnée : rien à copier");
  assert.equal(C.copieAvantMiseAJourNecessaire(undefined, "1.02"), false);
});

/* ------------------------- v1.02 — donner son avis ------------------------- */

const UA = {
  chromeAndroid: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  samsung: "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  edgeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  chromeWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  safariIPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
  chromeIPhone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  firefoxWindows: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  safariMac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15",
};

test("v1.02 — appareil et navigateur lus dans l'user agent (Edge et Samsung ne sont pas pris pour Chrome)", () => {
  assert.equal(C.decrireAppareil(UA.chromeAndroid), "Android · Chrome 131");
  assert.equal(C.decrireAppareil(UA.samsung), "Android · Samsung Internet 26");
  assert.equal(C.decrireAppareil(UA.edgeWindows), "Windows · Edge 131");
  assert.equal(C.decrireAppareil(UA.chromeWindows), "Windows · Chrome 131");
  assert.equal(C.decrireAppareil(UA.safariIPhone), "iPhone · Safari 18");
  assert.equal(C.decrireAppareil(UA.chromeIPhone), "iPhone · Chrome 131");
  assert.equal(C.decrireAppareil(UA.firefoxWindows), "Windows · Firefox 133");
  assert.equal(C.decrireAppareil(UA.safariMac), "Mac · Safari 18");
  assert.equal(C.decrireAppareil(""), "système inconnu · navigateur inconnu");
  assert.equal(C.decrireAppareil(undefined), "système inconnu · navigateur inconnu");
});

test("v1.02 — infos techniques : appareil, installée ou non, écran, texte, thème ; rien d'autre", () => {
  const i = C.infosAppareil({ ua: UA.chromeAndroid, largeur: 412.4, hauteur: 915, installee: true, taille: 150, theme: "sombre" });
  assert.equal(i, "Android · Chrome 131 · appli installée · écran 412 × 915 · texte 150 % · thème sombre");
  const j = C.infosAppareil({ ua: UA.chromeWindows, largeur: 728, hauteur: 720, installee: false, taille: 100, theme: "n'importe quoi" });
  assert.equal(j, "Windows · Chrome 131 · dans le navigateur · écran 728 × 720 · texte 100 % · thème auto");
});

test("v1.02 — note en étoiles : 1 à 5, sinon rien", () => {
  assert.equal(C.etoilesNote(4), "★★★★☆");
  assert.equal(C.etoilesNote(1), "★☆☆☆☆");
  assert.equal(C.etoilesNote(5), "★★★★★");
  for (const n of [0, 6, -1, 2.5, "4", null, undefined, NaN]) assert.equal(C.etoilesNote(n), "", `note ${n}`);
});

test("v1.02 — message d'avis : texte nettoyé, note pour « avis », infos techniques pour « problème » seulement", () => {
  const idee = C.messageAvis({ type: "idee", note: 4, texte: "  Pouvoir trier par montant\r\nmerci  ", version: "1.02", infos: "Android · Chrome 131" });
  assert.equal(idee.sujet, "Ma Compta Perso – idée (v1.02)");
  assert.equal(idee.corps, "💡 Une idée pour Ma Compta Perso\n\nPouvoir trier par montant\nmerci\n\n—\nVersion 1.02");
  assert.ok(!idee.corps.includes("★"), "la note ne compte que pour « Un avis »");
  assert.ok(!idee.corps.includes("Android"), "les infos techniques ne partent que pour un problème");
  const pb = C.messageAvis({ type: "probleme", texte: "Le bouton ne répond pas", version: "1.02", infos: "Android · Chrome 131" });
  assert.equal(pb.sujet, "Ma Compta Perso – problème (v1.02)");
  assert.ok(pb.corps.startsWith("🐞 Un problème dans Ma Compta Perso\n\nLe bouton ne répond pas\n"));
  assert.ok(pb.corps.endsWith("—\nVersion 1.02 · Android · Chrome 131"));
  const avis = C.messageAvis({ type: "avis", note: 4, texte: "Très pratique", version: "1.02" });
  assert.equal(avis.sujet, "Ma Compta Perso – avis ★★★★☆ (v1.02)");
  assert.equal(avis.corps, "👍 Mon avis sur Ma Compta Perso\n\nMa note : ★★★★☆ (4/5)\n\nTrès pratique\n\n—\nVersion 1.02");
  const vide = C.messageAvis({ type: "inconnu", texte: "", version: "1.02" });
  assert.equal(vide.corps, "💡 Une idée pour Ma Compta Perso\n\n—\nVersion 1.02", "type inconnu → idée ; sans texte : pas de ligne vide en trop");
  assert.equal(C.messageAvis({ type: "idee", texte: "x".repeat(5000), version: "1.02" }).corps.split("\n")[2].length, C.MAX_AVIS);
  assert.deepEqual(C.TYPES_AVIS.map((t) => t.id), ["idee", "probleme", "avis"]);
});

test("v1.02 — lien mailto : sujet et corps encodés, retours à la ligne en %0D%0A, rien de perdu", () => {
  const m = C.messageAvis({ type: "avis", note: 5, texte: "Génial & simple ; 100 % ?\nOui", version: "1.02" });
  const lien = C.lienMail("contact@exemple.fr", m.sujet, m.corps);
  assert.ok(lien.startsWith("mailto:contact@exemple.fr?subject="), lien.slice(0, 50));
  assert.ok(lien.includes("%0D%0A"), "retours à la ligne CRLF");
  assert.ok(!/[\s&]/.test(lien.split("&body=")[1]), "aucun espace ni « & » brut dans le corps");
  const params = new URLSearchParams(lien.split("?")[1]);
  assert.equal(params.get("subject"), m.sujet);
  assert.equal(params.get("body"), m.corps.replace(/\n/g, "\r\n"));
});

/* ------------------------- Exemples ------------------------- */

test("données d'exemple : déterministes, montants entiers, dates valides, virements équilibrés", () => {
  let n1 = 0;
  let n2 = 0;
  const e1 = C.genererExemples({ aujourdhui: "2026-10-29", maintenant: MAINTENANT, nouvelId: () => `x${++n1}` });
  const e2 = C.genererExemples({ aujourdhui: "2026-10-29", maintenant: MAINTENANT, nouvelId: () => `x${++n2}` });
  assert.deepEqual(e1, e2);
  assert.equal(e1.comptes.length, 2);
  assert.ok(e1.operations.length > 40, `${e1.operations.length} opérations seulement`);
  for (const o of e1.operations) {
    assert.ok(C.estCentimes(o.montant) && o.montant !== 0, `montant ${o.montant}`);
    assert.ok(C.dateValide(o.date), o.date);
  }
  const virements = e1.operations.filter((o) => o.lien_virement);
  assert.ok(virements.length >= 2);
  assert.equal(C.somme(virements.map((o) => o.montant)), 0);
  assert.equal(e1.operations.filter((o) => o.date > "2026-10-29").length, 1); // une opération « à venir »
  assert.equal(e1.comptes[0].date_depart, "2026-08-01");
  const s = C.construireSauvegarde({ ...e1, categories: C.categoriesParDefaut(MAINTENANT) }, { versionAppli: "1.00", maintenant: MAINTENANT });
  const v = C.verifierSauvegarde(JSON.parse(JSON.stringify(s)));
  assert.equal(v.ok, true, v.erreur);
  assert.deepEqual(v.avertissements, []);
});

/* ------------------------- Bilan ------------------------- */

const fuseau = process.env.TEST_FUSEAU;
if (ratés.length) {
  console.log(`❌ [${fuseau}] ${ratés.length} test(s) raté(s), ${nb} réussi(s) :\n${ratés.join("\n")}`);
  process.exit(1);
}
console.log(`✓ [${fuseau}] ${nb} tests réussis`);
