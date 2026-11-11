// app.js — v1.00 — création : l'INTERFACE de l'appli (écrans, navigation, saisie, affichage).
// Aucun calcul d'argent ici : tout passe par calcul.js (testé avec Node).
// Aucun accès direct à la base : tout passe par stockage.js.

import * as C from "./calcul.js";
import * as S from "./stockage.js";

const VERSION = "1.00"; // ⚠️ le même n° est dans sw.js (CACHE) et dans le nom du zip : un test le vérifie.
const COULEUR_BARRE = { clair: "#f2f4f3", sombre: "#121619" }; // couleur de la barre du téléphone (comme le fond)
const ICONES_COMPTE = ["🏦", "💳", "🐷", "👛", "💶", "🏠", "💼", "⭐"];
const ICONES_CATEGORIE = ["🛒", "🍽️", "☕", "🚗", "⛽", "🚌", "🏠", "⚡", "📶", "🩺", "💊", "👕", "🎬", "🏇", "🏆", "🎮", "📺", "✈️", "📚", "👶", "🐾", "🎁", "🧾", "🔧", "💇", "🍷", "🚬", "💼", "💰", "❓"];
const DUREE_ANNULER = 6000; // ms pendant lesquelles « ↶ Annuler » reste proposé
const JOURS_RAPPEL = [
  [3, "tous les 3 jours"],
  [7, "toutes les semaines"],
  [14, "toutes les 2 semaines"],
  [30, "tous les mois"],
  [0, "jamais"],
];

/* =====================================================================
   ÉTAT DE L'APPLI (en mémoire ; la vérité est dans la base, écrite AVANT d'afficher)
   ===================================================================== */

const etat = {
  meta: null,
  reglages: { ...C.REGLAGES_DEFAUT },
  comptes: [],
  categories: [],
  operations: [],
  recurrences: [],
  budgets: [],
  regles: [],
  aujourdhui: C.dateDuJour(),
  vue: "accueil",
  periodeOps: null, // mois affiché dans Opérations (null = le mois en cours)
  periodeStats: null,
  filtres: { texte: "", compte: "", categorie: "" },
  ordreCats: { depense: [], revenu: [] }, // ordre de la grille, calculé au lancement (stable pendant la session)
  pile: [], // sous-écrans ouverts par-dessus (saisie, compte, catégories…)
  saisie: null, // l'opération en cours de saisie
  guide: null, // le guide du 1er lancement, quand il est affiché
  installation: null, // l'invitation à installer, gardée pour le bouton « Installer »
  majEnAttente: null, // une nouvelle version prête à s'activer
  majDemandee: false,
  copieRestauration: false, // une copie de sécurité d'avant restauration existe
  persistant: null,
  erreurs: [],
  ignorerClicsJusqua: 0, // juste après un enregistrement, un 2e toucher trop rapide est ignoré
  occupeJusqua: 0, // une action est en cours (écriture, dialogue) : un 2e toucher ne la relance pas
};

let catParId = new Map();
let cptParId = new Map();

/* =====================================================================
   OUTILS
   ===================================================================== */

const $ = (sel, racine = document) => racine.querySelector(sel);

function esc(texte) {
  return String(texte ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const maintenant = () => new Date().toISOString();
const nouvelId = () => crypto.randomUUID();
const pointeurTactile = () => matchMedia("(pointer: coarse)").matches;
const estInstallee = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const estIPhone = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;

function indexer() {
  catParId = new Map(etat.categories.map((c) => [c.id, c]));
  cptParId = new Map(etat.comptes.map((c) => [c.id, c]));
}

function nomCompte(id) {
  return cptParId.get(id)?.nom ?? "Compte inconnu";
}

function periodeCourante() {
  return C.moisDeBudget(etat.aujourdhui, etat.reglages.jour_debut_mois);
}

function calculerOrdreCategories() {
  for (const sens of ["depense", "revenu"]) etat.ordreCats[sens] = C.ordreCategories(etat.categories, etat.operations, sens, etat.aujourdhui);
}

/** Montant coloré : rouge pour une sortie, vert pour une entrée. */
function montantHTML(c, { signe = true, classe = "" } = {}) {
  const couleur = c < 0 ? "m-sortie" : c > 0 && signe ? "m-entree" : "";
  return `<span class="montant ${couleur} ${classe}">${esc(C.formaterEuros(c, { signe }))}</span>`;
}

/** Un virement = 2 opérations liées. Renvoie [départ, arrivée]. */
function jambesVirement(lien) {
  return etat.operations.filter((o) => o.lien_virement === lien && !o.supprime).sort((a, b) => a.montant - b.montant);
}

/** Dans une liste, un virement n'apparaît qu'une fois (« Compte A → Compte B »), sauf si on regarde un seul compte. */
function pourAffichage(ops, { compte = "" } = {}) {
  if (compte) return ops;
  const vus = new Set();
  return ops.filter((o) => {
    if (!o.lien_virement) return true;
    if (vus.has(o.lien_virement)) return false;
    vus.add(o.lien_virement);
    return true;
  });
}

function nomAppareilParDefaut() {
  return pointeurTactile() ? "Téléphone" : "Ordinateur";
}

function nouvelleMeta(exemple = false) {
  return { schema: C.SCHEMA, version_appli: VERSION, derniere_sauvegarde: null, appareil: nomAppareilParDefaut(), exemple, cree_le: maintenant() };
}

function dateHeure(iso) {
  try {
    return new Date(iso).toLocaleString("fr-FR", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

/* =====================================================================
   DONNÉES : lecture et écriture
   ===================================================================== */

async function chargerDonnees() {
  let d = await S.chargerTout();
  if (d.meta) d = await S.migrerSiBesoin(d, VERSION);
  etat.meta = d.meta;
  etat.reglages = C.normaliserReglages(d.reglages); // un réglage abîmé ne peut pas empêcher l'appli de s'afficher
  for (const t of C.TABLES) etat[t] = d[t] || [];
  indexer();
  if (!etat.saisie) calculerOrdreCategories(); // pendant une saisie, la grille ne bouge pas sous le doigt
  etat.copieRestauration = Boolean(await S.lireCopieSecurite("avant-restauration"));
}

/* Les écritures passent l'une après l'autre (file d'attente). Pourquoi : deux écritures rapprochées
   (ex. quitter le champ « nom de l'appareil » puis toucher « Sauvegarder ») ne peuvent plus s'écraser. */
let fileEcritures = Promise.resolve();

function enFile(travail) {
  const suite = fileEcritures.then(travail);
  fileEcritures = suite.catch(() => {}); // une écriture ratée ne bloque pas les suivantes
  return suite;
}

/* Plusieurs fenêtres ouvertes en même temps (l'appli installée + un onglet Chrome, 2 onglets sur le PC)
   partagent la même base. Après chaque écriture, on prévient les autres pour qu'elles relisent la base :
   sinon une sauvegarde faite depuis une fenêtre « en retard » oublierait les dernières opérations.
   BroadcastChannel : Chrome Android 54+, Chrome / Edge 79+, Safari iPhone 15.4+. Sans lui, la relecture se fait au retour sur l'appli. */
const canal = "BroadcastChannel" in globalThis ? new BroadcastChannel("ma-compta") : null;

function prevenirAutresFenetres() {
  try {
    canal?.postMessage({ type: "donnees-changees" });
  } catch {
    /* fenêtre en train de se fermer */
  }
}

async function rechargerDepuisBase() {
  if (etat.guide) lireGuide(); // ce qui était tapé dans le guide n'est pas perdu
  await enFile(() => chargerDonnees()); // après les écritures en attente
  if (!etat.meta) {
    // tout a été effacé depuis une autre fenêtre : retour au guide
    etat.pile = [];
    etat.saisie = null;
    if (!etat.guide) etat.guide = nouveauGuide();
  } else if (etat.guide) {
    etat.guide = null; // le guide a été terminé dans une autre fenêtre
  }
  rendreTout();
}

/** Écrit dans la base, PUIS met à jour la mémoire : rien n'est affiché comme « enregistré » avant (piège 9).
 *  changements peut être une fonction : il est alors calculé au moment d'écrire, à partir de l'état le plus récent. */
function enregistrer(changements) {
  return enFile(() => ecrireMaintenant(typeof changements === "function" ? changements() : changements));
}

async function ecrireMaintenant(changements) {
  await S.ecrire(changements);
  for (const [t, objets] of Object.entries(changements)) {
    if (t === "parametres") {
      if (objets.meta) etat.meta = objets.meta;
      if (objets.reglages) etat.reglages = objets.reglages;
      continue;
    }
    const liste = etat[t];
    for (const o of objets) {
      const i = liste.findIndex((x) => x.id === o.id);
      if (i >= 0) liste[i] = o;
      else liste.push(o);
    }
  }
  indexer();
  prevenirAutresFenetres();
}

async function changerReglage(changement) {
  await enregistrer(() => ({ parametres: { reglages: C.normaliserReglages({ ...etat.reglages, ...changement }) } }));
  if ("jour_debut_mois" in changement) {
    etat.periodeOps = null;
    etat.periodeStats = null;
  }
  appliquerAffichage();
  rendre();
}

async function changerMeta(changement) {
  await enregistrer(() => ({ parametres: { meta: { ...etat.meta, ...changement } } }));
}

function sauvegardeActuelle() {
  return C.construireSauvegarde(etat, {
    versionAppli: VERSION,
    appareil: etat.meta?.appareil || "",
    maintenant: maintenant(),
    exemple: Boolean(etat.meta?.exemple),
  });
}

/* =====================================================================
   AFFICHAGE : thème, taille du texte
   ===================================================================== */

function appliquerAffichage() {
  const r = document.documentElement;
  const theme = etat.reglages.theme;
  if (theme === "auto") delete r.dataset.theme;
  else r.dataset.theme = theme;
  r.style.setProperty("--echelle", String(etat.reglages.taille_texte / 100)); // CSSOM : autorisé par la règle de sécurité
  const sombre = theme === "sombre" || (theme === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.content = sombre ? COULEUR_BARRE.sombre : COULEUR_BARRE.clair;
}

/* =====================================================================
   NAVIGATION — le bouton « retour » d'Android ferme le sous-écran au lieu de quitter l'appli
   ===================================================================== */

function allerA(vue) {
  if (etat.pile.length || etat.guide) return;
  if (vue === etat.vue) {
    window.scrollTo(0, 0);
    return;
  }
  if (vue === "accueil" && history.state?.onglet && history.state.onglet !== "accueil") {
    history.back(); // revient à l'entrée « accueil » de l'historique (popstate fait le reste)
    return;
  }
  if (etat.vue === "accueil") history.pushState({ onglet: vue, profondeur: 0 }, "");
  else history.replaceState({ onglet: vue, profondeur: 0 }, "");
  etat.vue = vue;
  window.scrollTo(0, 0);
  rendre();
}

function ouvrir(calque) {
  cacherToast(); // un « ↶ Annuler » ne doit jamais rester par-dessus un nouvel écran : on est passé à autre chose
  etat.pile.push(calque);
  history.pushState({ onglet: etat.vue, profondeur: etat.pile.length }, "");
  rendreCalque();
}

function fermer() {
  if (!etat.pile.length || $("#calque").inert) return; // déjà en train de se fermer : un 2e appel ne doit pas reculer 2 fois
  $("#calque").inert = true; // plus aucun toucher n'est pris en compte : un double toucher ne peut pas enregistrer deux fois
  history.back();
}

window.addEventListener("popstate", (e) => {
  const s = e.state || { onglet: "accueil", profondeur: 0 };
  let changement = false;
  while (etat.pile.length > (s.profondeur || 0)) {
    const parti = etat.pile.pop();
    if (parti.type === "saisie") etat.saisie = null;
    changement = true;
  }
  const vue = s.onglet || "accueil";
  if (vue !== etat.vue || changement) {
    etat.vue = vue;
    rendre(); // l'écran du dessous montre tout de suite ce qui vient d'être enregistré
  }
  if (changement) rendreCalque();
});

/* =====================================================================
   RENDU DES VUES
   ===================================================================== */

function rendreTout() {
  appliquerAffichage();
  rendre();
  rendreCalque();
}

function rendre() {
  for (const b of document.querySelectorAll(".onglet[data-vue]")) {
    if (b.dataset.vue === etat.vue) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  }
  rendreBandeaux();
  const vues = { accueil: vueAccueil, operations: vueOperations, stats: vueStats, reglages: vueReglages };
  $("#vue").innerHTML = etat.meta ? vues[etat.vue]() : "";
}

function rafraichirVue() {
  if (!etat.pile.length && !etat.guide) rendre();
}

/* ---------- Bandeaux (mise à jour, exemples, rappel de sauvegarde) ---------- */

function joursDepuisSauvegarde() {
  const d = etat.meta?.derniere_sauvegarde;
  if (!d) return null;
  return C.ecartJours(C.dateDuJour(new Date(d)), etat.aujourdhui);
}

function rappelSauvegarde() {
  const n = etat.reglages.rappel_sauvegarde_jours;
  if (!n || etat.meta?.exemple || !etat.reglages.appareil_principal) return null;
  if (!etat.operations.some((o) => !o.supprime)) return null;
  const j = joursDepuisSauvegarde();
  if (j === null) {
    // Jamais sauvegardé : on le rappelle une fois l'appli utilisée depuis N jours (pas dès la 1re opération).
    const depuis = etat.meta?.cree_le ? C.ecartJours(C.dateDuJour(new Date(etat.meta.cree_le)), etat.aujourdhui) : n;
    return depuis >= n ? "Vos données ne sont pas encore sauvegardées." : null;
  }
  if (j >= n) return `Dernière sauvegarde il y a ${pluriel(j, "jour", "jours")}.`;
  return null;
}

function rendreBandeaux() {
  const b = [];
  if (etat.majEnAttente) {
    b.push(`<div class="bandeau"><p>Une nouvelle version de l'appli est prête.</p><button type="button" class="btn btn-principal" data-action="mettre-a-jour">Mettre à jour</button></div>`);
  }
  if (etat.meta && etat.vue === "accueil") {
    if (etat.meta.exemple) {
      b.push(`<div class="bandeau bandeau-attention"><p>Ce sont des données d'exemple, inventées.</p><button type="button" class="btn" data-action="effacer-exemples">Effacer et commencer</button></div>`);
    }
    if (!etat.reglages.appareil_principal) {
      b.push(`<div class="bandeau"><p>Copie de consultation : notez vos opérations sur votre appareil principal, puis restaurez sa dernière sauvegarde ici.</p></div>`);
    }
    const rappel = rappelSauvegarde();
    if (rappel) b.push(`<div class="bandeau bandeau-attention"><p>💾 ${esc(rappel)}</p><button type="button" class="btn" data-action="sauvegarde-rapide">Sauvegarder</button></div>`);
  }
  $("#bandeaux").innerHTML = b.join("");
}

/* ---------- Une ligne d'opération ---------- */

function ligneOperationHTML(o, { plusieursComptes = C.comptesActifs(etat.comptes).length > 1 } = {}) {
  const avenir = o.date > etat.aujourdhui ? `<span class="etiquette etiquette-avenir">à venir</span>` : "";
  if (o.lien_virement) {
    const [de, vers] = jambesVirement(o.lien_virement);
    const titre = `${nomCompte(de?.compte)} → ${nomCompte(vers?.compte)}`;
    return `<button type="button" class="ligne-op" data-action="modifier-op" data-id="${esc(o.id)}">
      <span class="op-icone" aria-hidden="true">🔁</span>
      <span class="op-texte"><span class="op-titre">${esc(titre)}</span><span class="op-sous-titre">${esc(o.libelle || "Virement entre mes comptes")}${avenir}</span></span>
      <span class="montant op-montant m-virement">${esc(C.formaterEuros(Math.abs(o.montant)))}</span></button>`;
  }
  const cat = catParId.get(o.categorie);
  const nomCat = cat ? cat.nom : "Catégorie inconnue";
  const titre = o.libelle || o.tiers || nomCat;
  const compte = plusieursComptes ? `<span class="etiquette">${esc(nomCompte(o.compte))}</span>` : "";
  const cpt = cptParId.get(o.compte);
  const avantDepart = cpt && o.date < cpt.date_depart ? `<span class="etiquette" title="Déjà comprise dans le solde de départ du compte">avant le départ</span>` : "";
  const sous = o.libelle || o.tiers ? esc(nomCat) : "";
  const ligne2 = sous || compte || avenir || avantDepart ? `<span class="op-sous-titre">${sous}${compte}${avenir}${avantDepart}</span>` : "";
  return `<button type="button" class="ligne-op" data-action="modifier-op" data-id="${esc(o.id)}">
    <span class="op-icone" aria-hidden="true">${esc(cat?.icone ?? "❓")}</span>
    <span class="op-texte"><span class="op-titre">${esc(titre)}</span>${ligne2}</span>
    ${montantHTML(o.montant, { classe: "op-montant" })}</button>`;
}

/* ---------- 🏠 Accueil ---------- */

function vueAccueil() {
  const r = C.resumeComptes(etat.comptes, etat.operations, etat.aujourdhui);
  const p = periodeCourante();
  const m = C.resumePeriode(etat.operations, p, etat.aujourdhui);
  const plusieurs = r.lignes.length > 1;
  const titreSolde = plusieurs ? "Solde total" : r.lignes[0]?.compte.nom ?? "Solde";
  const avenir = r.totalAVenir ? `<p class="solde-avenir">À venir : ${esc(C.formaterEuros(r.totalAVenir, { signe: true }))}</p>` : "";
  const comptes = plusieurs
    ? `<div class="bloc liste-comptes">${r.lignes
        .map(
          (l) => `<button type="button" class="ligne-compte" data-action="filtrer-compte" data-id="${esc(l.compte.id)}">
        <span class="op-icone" aria-hidden="true">${esc(l.compte.icone || "🏦")}</span><span class="op-titre">${esc(l.compte.nom)}</span>${montantHTML(l.solde, { signe: false })}</button>`
        )
        .join("")}</div>`
    : "";
  const avenirMois = [];
  if (m.aVenirEntrees) avenirMois.push(C.formaterEuros(m.aVenirEntrees, { signe: true }));
  if (m.aVenirSorties) avenirMois.push(C.formaterEuros(-m.aVenirSorties));
  const noteMois = avenirMois.length ? `<p class="addition-note">Encore à venir ce mois-ci : ${esc(avenirMois.join(" et "))}</p>` : "";
  const dernieres = pourAffichage(C.trierOperations(etat.operations.filter((o) => !o.supprime && o.date <= etat.aujourdhui))).slice(0, 5);
  const listeDernieres = dernieres.length
    ? `<div class="bloc liste-ops">${dernieres.map((o) => ligneOperationHTML(o, { plusieursComptes: plusieurs })).join("")}</div>`
    : `<div class="bloc vide"><strong>Rien de noté pour l'instant.</strong>Touchez + pour noter votre première dépense.</div>`;
  return `<h1 class="invisible">Accueil</h1>
  <div class="colonnes">
    <div>
      <section class="solde-principal" aria-label="Solde">
        <p class="solde-nom">${esc(titreSolde)}</p>
        <p class="solde-chiffre${r.total < 0 ? " negatif" : ""}">${esc(C.formaterEuros(r.total))}</p>
        ${avenir}
        ${comptes}
      </section>
      <section class="section">
        <div class="titre-ligne"><h2>${esc(C.titrePeriode(p, etat.reglages.jour_debut_mois))}</h2><button type="button" class="btn btn-discret" data-action="voir-mois">Voir le détail</button></div>
        <div class="bloc addition">
          <div class="addition-ligne"><span>Entrées</span>${montantHTML(m.entrees)}</div>
          <div class="addition-ligne"><span>Sorties</span>${montantHTML(-m.sorties)}</div>
          <div class="addition-ligne addition-total"><span>Solde du mois</span>${montantHTML(m.solde)}</div>
          ${noteMois}
        </div>
      </section>
    </div>
    <section class="section">
      <div class="titre-ligne"><h2>Dernières opérations</h2>${dernieres.length ? `<button type="button" class="btn btn-discret" data-action="voir-mois">Tout voir</button>` : ""}</div>
      ${listeDernieres}
    </section>
  </div>`;
}

/* ---------- 📋 Opérations ---------- */

function navMoisHTML(p, cible) {
  return `<div class="nav-mois">
    <button type="button" class="btn-icone" data-action="mois-prec" data-cible="${cible}" aria-label="Mois précédent">◀</button>
    <h1><button type="button" class="btn btn-discret" data-action="mois-actuel" data-cible="${cible}" title="Revenir au mois en cours">${esc(C.titrePeriode(p, etat.reglages.jour_debut_mois))}</button></h1>
    <button type="button" class="btn-icone" data-action="mois-suiv" data-cible="${cible}" aria-label="Mois suivant">▶</button>
  </div>`;
}

function vueOperations() {
  const p = etat.periodeOps ?? periodeCourante();
  const m = C.resumePeriode(etat.operations, p, etat.aujourdhui);
  const comptes = C.comptesActifs(etat.comptes);
  const f = etat.filtres;
  const choixCompte =
    comptes.length > 1
      ? `<select data-champ="filtre-compte" aria-label="Filtrer par compte"><option value="">Tous comptes</option>${comptes
          .map((c) => `<option value="${esc(c.id)}"${f.compte === c.id ? " selected" : ""}>${esc(c.nom)}</option>`)
          .join("")}</select>`
      : "";
  const cats = etat.categories
    .filter((c) => !c.supprime)
    .sort((a, b) => a.nom.localeCompare(b.nom, "fr"))
    .map((c) => `<option value="${esc(c.id)}"${f.categorie === c.id ? " selected" : ""}>${esc(c.icone)} ${esc(c.nom)}</option>`)
    .join("");
  const avenir = m.aVenirEntrees || m.aVenirSorties ? `<p class="addition-note">À venir : ${esc([m.aVenirEntrees ? C.formaterEuros(m.aVenirEntrees, { signe: true }) : "", m.aVenirSorties ? C.formaterEuros(-m.aVenirSorties) : ""].filter(Boolean).join(" et "))}</p>` : "";
  return `${navMoisHTML(p, "ops")}
  <div class="bloc resume-mois">
    <div><span class="petit doux">Entrées</span>${montantHTML(m.entrees)}</div>
    <div><span class="petit doux">Sorties</span>${montantHTML(-m.sorties)}</div>
    <div><span class="petit doux">Solde</span>${montantHTML(m.solde)}</div>
  </div>
  ${avenir}
  <div class="filtres">
    <input type="search" data-champ="filtre-texte" value="${esc(f.texte)}" placeholder="Rechercher (libellé, montant…)" aria-label="Rechercher par libellé, montant, catégorie, note" enterkeyhint="search" />
    <div class="filtres-selects">${choixCompte}<select data-champ="filtre-categorie" aria-label="Filtrer par catégorie"><option value="">Toutes catégories</option>${cats}</select></div>
  </div>
  <div id="liste-ops">${listeOperationsHTML(p)}</div>`;
}

function listeOperationsHTML(p) {
  let ops = C.operationsDeLaPeriode(etat.operations, p);
  ops = C.filtrerOperations(ops, etat.filtres, catParId, cptParId);
  ops = pourAffichage(ops, { compte: etat.filtres.compte });
  const filtre = etat.filtres.texte || etat.filtres.compte || etat.filtres.categorie;
  if (!ops.length) {
    return filtre
      ? `<div class="bloc vide"><strong>Aucune opération ne correspond.</strong><button type="button" class="btn btn-discret" data-action="effacer-filtres">Effacer la recherche</button></div>`
      : `<div class="bloc vide"><strong>Aucune opération ce mois-ci.</strong>Touchez + pour en noter une.</div>`;
  }
  const plusieurs = C.comptesActifs(etat.comptes).length > 1;
  return C.grouperParJour(ops)
    .map(
      (g) => `<section class="jour">
      <div class="jour-entete"><h2 class="petit">${esc(C.nomDuJour(g.date, etat.aujourdhui))}</h2>${g.total ? montantHTML(g.total) : ""}</div>
      <div class="bloc liste-ops">${g.operations.map((o) => ligneOperationHTML(o, { plusieursComptes: plusieurs })).join("")}</div>
    </section>`
    )
    .join("");
}

function rendreListeOps() {
  const zone = $("#liste-ops");
  if (zone) zone.innerHTML = listeOperationsHTML(etat.periodeOps ?? periodeCourante());
}

/* ---------- 📊 Stats (simples ; les graphiques complets viendront ensuite) ---------- */

function statLigneHTML(x, total, genre) {
  const cat = catParId.get(x.categorie);
  const pct = C.pourcentage(x.total, total);
  const largeur = Math.max(pct, 1);
  return `<div class="stat-ligne">
    <span class="op-icone" aria-hidden="true">${esc(cat?.icone ?? "❓")}</span>
    <span class="op-texte"><span class="op-titre">${esc(cat?.nom ?? "Catégorie inconnue")}</span><span class="op-sous-titre">${pct} %, ${pluriel(x.nb, "opération", "opérations")}</span></span>
    <span class="montant op-montant">${esc(C.formaterEuros(x.total))}</span>
    <svg class="stat-barre" viewBox="0 0 100 4" preserveAspectRatio="none" aria-hidden="true"><rect class="fond-barre" width="100" height="4"/><rect class="barre-${genre}" width="${largeur}" height="4"/></svg>
  </div>`;
}

function vueStats() {
  const p = etat.periodeStats ?? periodeCourante();
  const t = C.totauxParCategorie(etat.operations, p, etat.aujourdhui);
  if (!t.sorties.length && !t.entrees.length) {
    return `${navMoisHTML(p, "stats")}<div class="bloc vide"><strong>Rien à montrer pour ce mois.</strong>Les totaux par catégorie apparaissent dès la première opération.</div>`;
  }
  const bloc = (titre, liste, total, genre) =>
    liste.length
      ? `<section class="section"><div class="titre-ligne"><h2>${titre}</h2><span class="montant">${esc(C.formaterEuros(total))}</span></div>
      <div class="bloc">${liste.map((x) => statLigneHTML(x, total, genre)).join("")}</div></section>`
      : "";
  return `${navMoisHTML(p, "stats")}
  <div class="colonnes">${bloc("Sorties par catégorie", t.sorties, t.totalSorties, "sortie") || "<div></div>"}${bloc("Entrées par catégorie", t.entrees, t.totalEntrees, "entree")}</div>
  <p class="addition-note">Sans les virements entre vos comptes ni les opérations à venir.</p>`;
}

/* ---------- ⚙️ Réglages ---------- */

function boutonReglage(action, icone, titre, sousTitre = "", attributs = "") {
  return `<button type="button" class="reglage-bouton" data-action="${action}" ${attributs}>
    <span class="op-icone" aria-hidden="true">${esc(icone)}</span>
    <span class="op-texte"><span class="op-titre">${esc(titre)}</span>${sousTitre ? `<span class="op-sous-titre">${esc(sousTitre)}</span>` : ""}</span>
    <span class="doux" aria-hidden="true">›</span></button>`;
}

function vueReglages() {
  const r = etat.reglages;
  const tous = etat.comptes.filter((c) => !c.supprime).sort((a, b) => Number(a.archive) - Number(b.archive) || a.ordre - b.ordre);
  const comptes = tous
    .map((c) => {
      const solde = C.soldeCompte(c, etat.operations, etat.aujourdhui);
      return boutonReglage("modifier-compte", c.icone || "🏦", c.nom + (c.archive ? " (archivé)" : ""), C.formaterEuros(solde), `data-id="${esc(c.id)}"`);
    })
    .join("");
  const j = joursDepuisSauvegarde();
  const derniere = etat.meta?.derniere_sauvegarde
    ? `Dernière sauvegarde : ${j === 0 ? "aujourd'hui" : j === 1 ? "hier" : `il y a ${j} jours`} (${dateHeure(etat.meta.derniere_sauvegarde)}).`
    : "Aucune sauvegarde pour l'instant.";
  const jd = r.jour_debut_mois;
  const joursPaie = Array.from({ length: 30 }, (_, i) => i + 2)
    .map((n) => `<option value="${n}"${n === (jd > 1 ? jd : 28) ? " selected" : ""}>${n}</option>`)
    .join("");
  const installer = estInstallee()
    ? ""
    : `<section class="section"><h2>Installer l'appli</h2><div class="bloc reglage"><p>${
        etat.installation
          ? "Elle aura son icône sur l'écran d'accueil et marchera sans réseau."
          : estIPhone()
            ? "Dans Safari : touchez Partager, puis « Sur l'écran d'accueil »."
            : "Dans le menu du navigateur (⋮), choisissez « Installer l'application » ou « Ajouter à l'écran d'accueil »."
      }</p>${etat.installation ? `<div class="actions"><button type="button" class="btn btn-principal" data-action="installer">📲 Installer l'appli</button></div>` : ""}</div></section>`;
  const erreurs = etat.erreurs.length
    ? `<p class="champ-erreur">Erreurs récentes :</p>${etat.erreurs.map((e) => `<p class="petit">${esc(e.quand)} : ${esc(e.message)}</p>`).join("")}`
    : "";
  const nbOps = etat.operations.filter((o) => !o.supprime).length;
  return `<h1>Réglages</h1>
  <div class="colonnes">
  <div>
  <section class="section"><h2>Comptes</h2><div class="bloc">${comptes}${boutonReglage("ajouter-compte", "➕", "Ajouter un compte", "livret, espèces, autre banque…")}</div></section>
  <section class="section"><h2>Catégories</h2><div class="bloc">${boutonReglage("gerer-categories", "🏷️", "Gérer les catégories", "renommer, ajouter, archiver")}</div></section>
  <section class="section"><h2>Sauvegarde</h2>
    <div class="bloc">
      <div class="reglage"><p>${esc(derniere)}</p><p class="petit doux">Si l'appareil est perdu ou cassé, seules vos sauvegardes gardent vos chiffres. Rangez-les en lieu sûr (Drive, mail…), jamais en lien public.</p></div>
      ${boutonReglage("sauvegarder-fichier", "💾", "Sauvegarder dans un fichier", "un fichier daté, dans vos téléchargements")}
      ${boutonReglage("partager-sauvegarde", "📤", "Partager la sauvegarde", "vers Drive, un mail…")}
      ${boutonReglage("restaurer", "📂", "Restaurer une sauvegarde", "remplace les données de cet appareil")}
      ${etat.copieRestauration ? boutonReglage("annuler-restauration", "🛟", "Revenir à l'état d'avant la dernière restauration", "si vous vous êtes trompé de fichier") : ""}
      ${boutonReglage("exporter-anonyme", "🕶️", "Sauvegarde anonymisée", "pour demander de l'aide (à Claude par exemple) sans montrer vos libellés")}
      ${boutonReglage("exporter-csv", "📊", "Exporter pour Excel (CSV)", "toutes les opérations")}
      <label class="champ reglage"><span>Me rappeler de sauvegarder</span><select data-champ="reglage-rappel">${JOURS_RAPPEL.map(([n, t]) => `<option value="${n}"${n === r.rappel_sauvegarde_jours ? " selected" : ""}>${t}</option>`).join("")}</select></label>
    </div>
  </section>
  </div>
  <div>
  <section class="section"><h2>Saisie</h2>
    <div class="bloc reglage"><div class="options">
      <label class="option"><input type="radio" name="mode-saisie" value="rapide" data-champ="reglage-mode-saisie"${r.mode_saisie === "rapide" ? " checked" : ""} /><span><strong>Rapide</strong><br /><span class="petit doux">Toucher la catégorie enregistre aussitôt, avec « ↶ Annuler » pendant quelques secondes.</span></span></label>
      <label class="option"><input type="radio" name="mode-saisie" value="bouton" data-champ="reglage-mode-saisie"${r.mode_saisie === "bouton" ? " checked" : ""} /><span><strong>Avec le bouton Enregistrer</strong><br /><span class="petit doux">On choisit la catégorie, puis on touche « Enregistrer ».</span></span></label>
    </div></div>
  </section>
  <section class="section"><h2>Mois de budget</h2>
    <div class="bloc reglage"><div class="options">
      <label class="option"><input type="radio" name="jour-debut" value="1" data-champ="reglage-jour"${jd === 1 ? " checked" : ""} /><span>Du 1er au dernier jour du mois<br /><span class="petit doux">Conseillé si vos revenus arrivent à des dates variables.</span></span></label>
      <label class="option"><input type="radio" name="jour-debut" value="paie" data-champ="reglage-jour"${jd > 1 ? " checked" : ""} /><span>D'une paie à l'autre, à partir du jour <select data-champ="reglage-jour-paie" aria-label="Jour de paie">${joursPaie}</select></span></label>
    </div></div>
  </section>
  <section class="section"><h2>Affichage</h2>
    <div class="bloc">
      <div class="reglage"><p>Thème</p><div class="segments" role="group" aria-label="Thème">
        ${[
          ["auto", "Auto"],
          ["clair", "Clair"],
          ["sombre", "Sombre"],
        ]
          .map(([v, t]) => `<button type="button" data-action="theme" data-valeur="${v}" aria-pressed="${r.theme === v}">${t}</button>`)
          .join("")}
      </div></div>
      <div class="reglage"><p>Taille du texte</p><div class="taille-texte">
        <button type="button" class="btn" data-action="taille" data-pas="-10" aria-label="Texte plus petit"${r.taille_texte <= 80 ? " disabled" : ""}>A−</button>
        <output aria-live="polite">${r.taille_texte} %</output>
        <button type="button" class="btn" data-action="taille" data-pas="10" aria-label="Texte plus grand"${r.taille_texte >= 150 ? " disabled" : ""}>A+</button>
      </div></div>
    </div>
  </section>
  <section class="section"><h2>Cet appareil</h2>
    <div class="bloc reglage">
      <label class="champ"><span>Nom de l'appareil</span><input type="text" data-champ="reglage-appareil" value="${esc(etat.meta?.appareil ?? "")}" maxlength="40" placeholder="ex. Téléphone" /><span class="champ-aide">Il est noté dans les sauvegardes, pour s'y retrouver.</span></label>
      <label class="option"><input type="checkbox" data-champ="reglage-principal"${r.appareil_principal ? " checked" : ""} /><span>C'est mon appareil principal : j'y note mes opérations.</span></label>
    </div>
  </section>
  ${installer}
  <section class="section a-propos"><h2>À propos</h2>
    <div class="bloc reglage">
      <p><strong>Ma Compta Perso</strong>, version ${VERSION}</p>
      <p>Vos données restent sur cet appareil : rien n'est envoyé sur Internet.</p>
      <p>Logiciel gratuit, fourni tel quel. Faites des sauvegardes.</p>
      <p class="petit doux">${pluriel(nbOps, "opération enregistrée", "opérations enregistrées")}. Protection contre l'effacement automatique par le navigateur : ${etat.persistant ? "oui" : "non accordée (les sauvegardes n'en sont que plus importantes)"}.</p>
      ${erreurs}
    </div>
  </section>
  </div>
  </div>`;
}

/* =====================================================================
   SOUS-ÉCRANS (calque) : saisie, compte, catégories, guide
   ===================================================================== */

function rendreCalque() {
  const calque = $("#calque");
  const haut = etat.guide ? { type: "guide" } : etat.pile[etat.pile.length - 1];
  document.body.classList.toggle("calque-ouvert", Boolean(haut));
  $("#appli").inert = Boolean(haut); // ce qui est dessous ne réagit plus (lecteurs d'écran, clavier)
  if (!haut) {
    calque.hidden = true;
    calque.innerHTML = "";
    rendreBandeaux();
    return;
  }
  calque.hidden = false;
  calque.inert = false;
  const ecrans = { saisie: ecranSaisieHTML, compte: ecranCompteHTML, categories: ecranCategoriesHTML, categorie: ecranCategorieHTML, guide: ecranGuideHTML };
  calque.innerHTML = ecrans[haut.type](haut);
  calque.scrollTop = 0;
}

/* ---------- ➕ Saisie rapide ---------- */

function ouvrirSaisie({ sens = "depense", edition = null } = {}) {
  const comptes = C.comptesActifs(etat.comptes);
  if (!comptes.length) {
    toast("Créez d'abord un compte dans ⚙️ Réglages.");
    return;
  }
  const parDefaut = comptes.find((c) => c.id === etat.reglages.dernier_compte)?.id ?? comptes[0].id;
  let s;
  if (edition?.lien_virement) {
    const jambes = jambesVirement(edition.lien_virement);
    if (C.virementsIncomplets(jambes).length) return supprimerVirementIncomplet(edition.lien_virement);
    const [de, vers] = jambes;
    s = { edition: edition.lien_virement, sens: "virement", texte: C.centimesVersTexte(Math.abs(de.montant)), categorie: null, compte: de.compte, vers: vers.compte, date: de.date, libelle: de.libelle || "", tiers: "", moyen: "", note: de.note || "" };
  } else if (edition) {
    s = {
      edition: edition.id,
      sens: edition.montant < 0 ? "depense" : "revenu",
      texte: C.centimesVersTexte(Math.abs(edition.montant)),
      categorie: edition.categorie,
      compte: edition.compte,
      vers: null,
      date: edition.date,
      libelle: edition.libelle || "",
      tiers: edition.tiers || "",
      moyen: edition.moyen || "",
      note: edition.note || "",
    };
  } else {
    s = { edition: null, sens, texte: "", categorie: null, compte: parDefaut, vers: comptes.find((c) => c.id !== parDefaut)?.id ?? null, date: etat.aujourdhui, libelle: "", tiers: "", moyen: "", note: "" };
  }
  s.details = Boolean(s.libelle || s.tiers || s.moyen || s.note);
  s.enCours = false;
  etat.saisie = s;
  ouvrir({ type: "saisie" });
}

function modeRapide() {
  return etat.reglages.mode_saisie === "rapide" && !etat.saisie.edition && etat.saisie.sens !== "virement";
}

function grouperMilliers(texte) {
  const [entier, dec] = texte.split(",");
  const groupe = entier.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return dec === undefined ? groupe : `${groupe},${dec}`;
}

function montantSaisiHTML() {
  const s = etat.saisie;
  if (!s.texte) return "0,00 €";
  const signe = s.sens === "depense" ? "− " : s.sens === "revenu" ? "+ " : "";
  return `${signe}${esc(grouperMilliers(s.texte))} €`;
}

function classeMontantSaisi() {
  const s = etat.saisie;
  const couleur = { depense: "m-sortie", revenu: "m-entree", virement: "m-virement" }[s.sens];
  const long = s.texte.length >= 8 ? " long" : ""; // un gros montant rétrécit au lieu d'être coupé
  return `saisie-montant${long} ${s.texte ? couleur : "vide-montant"}`;
}

function pucesDatesHTML() {
  const s = etat.saisie;
  const a = etat.aujourdhui;
  const jours = [
    [a, "Aujourd'hui"],
    [C.ajouterJours(a, -1), "Hier"],
    [C.ajouterJours(a, -2), "Avant-hier"],
  ];
  const autre = !jours.some(([d]) => d === s.date);
  const libelle = s.libelle.trim();
  return (
    jours.map(([d, nom]) => `<button type="button" class="puce" data-action="date" data-date="${d}" aria-pressed="${s.date === d}">${nom}</button>`).join("") +
    `<span class="puce puce-date" aria-pressed="${autre}" title="Autre date">📅${autre ? ` ${esc(C.dateCourte(s.date, a))}` : ""}<input type="date" data-champ="saisie-date" value="${esc(s.date)}" aria-label="Choisir une autre date" /></span>` +
    `<button type="button" class="puce puce-details" data-action="details" aria-pressed="${s.details}" aria-expanded="${s.details}" aria-label="Libellé, note, moyen de paiement" title="Libellé, note…">✎${libelle ? ` <span class="puce-texte">${esc(libelle)}</span>` : ""}</button>`
  );
}

function optionsComptes(selection, { exclure = null } = {}) {
  const liste = C.comptesActifs(etat.comptes);
  const courant = cptParId.get(selection);
  if (courant && !liste.includes(courant)) liste.push(courant); // un compte archivé reste choisi s'il l'était
  return liste
    .filter((c) => c.id !== exclure)
    .map((c) => `<option value="${esc(c.id)}"${c.id === selection ? " selected" : ""}>${esc(c.icone || "🏦")} ${esc(c.nom)}</option>`)
    .join("");
}

/** Une opération datée AVANT la date de départ d'un compte est déjà comprise dans son solde de départ :
 *  elle ne le change pas. On le dit clairement, pour qu'un solde « qui ne bouge pas » ne surprenne personne. */
function avertissementDepartHTML() {
  const s = etat.saisie;
  const comptes = s.sens === "virement" ? [s.compte, s.vers] : [s.compte];
  const touche = comptes.map((id) => cptParId.get(id)).find((c) => c && s.date < c.date_depart);
  if (!touche) return "";
  return `<p class="petit avertissement">Date d'avant le départ de « ${esc(touche.nom)} » (${esc(C.dateCourte(touche.date_depart, etat.aujourdhui))}) : déjà comprise dans le solde de départ, elle ne le changera pas.</p>`;
}

function majAvertissementDepart() {
  const zone = $("#saisie-avertissement");
  if (zone) zone.innerHTML = avertissementDepartHTML();
}

/** Le choix du compte n'apparaît que s'il y a un choix à faire (au moins 2 comptes) : une ligne de gagnée sinon. */
function ligneCompteSaisieHTML() {
  const s = etat.saisie;
  if (s.sens === "virement") return "";
  const comptes = C.comptesActifs(etat.comptes);
  if (comptes.length <= 1 && cptParId.get(s.compte)?.archive !== true) return "";
  return `<select data-champ="saisie-compte" aria-label="Compte">${optionsComptes(s.compte)}</select>`;
}

function detailsSaisieHTML() {
  const s = etat.saisie;
  const moyens = C.MOYENS.map((m) => `<option value="${m.id}"${s.moyen === m.id ? " selected" : ""}>${m.nom}</option>`).join("");
  const virement = s.sens === "virement";
  return `<input type="text" class="large" data-champ="saisie-libelle" value="${esc(s.libelle)}" maxlength="80" placeholder="Libellé (ex. Boulangerie)" aria-label="Libellé" enterkeyhint="done" />
    ${virement ? "" : `<input type="text" data-champ="saisie-tiers" value="${esc(s.tiers)}" maxlength="60" placeholder="Chez qui ?" aria-label="Chez qui (ex. Carrefour)" enterkeyhint="done" />
    <select data-champ="saisie-moyen" aria-label="Moyen de paiement"><option value="">Paiement</option>${moyens}</select>`}
    <input type="text" class="large" data-champ="saisie-note" value="${esc(s.note)}" maxlength="200" placeholder="Note" aria-label="Note" enterkeyhint="done" />`;
}

function grilleSaisieHTML() {
  const s = etat.saisie;
  if (s.sens === "virement") {
    return `<label class="champ"><span>De</span><select data-champ="saisie-compte">${optionsComptes(s.compte)}</select></label>
      <label class="champ"><span>Vers</span><select data-champ="saisie-vers">${optionsComptes(s.vers)}</select></label>
      <p class="champ-aide">Un virement entre vos comptes ne compte ni en entrée ni en sortie : l'argent change juste de compte.</p>`;
  }
  const ids = [...etat.ordreCats[s.sens]];
  for (const c of etat.categories) {
    // une catégorie créée pendant la session va à la fin ; celle de l'opération modifiée reste visible même archivée
    if (!c.supprime && !c.systeme && c.sens === s.sens && !ids.includes(c.id) && (!c.archive || c.id === s.categorie)) ids.push(c.id);
  }
  return ids
    .map((id) => {
      const c = catParId.get(id);
      return `<button type="button" class="tuile" data-action="categorie" data-id="${esc(id)}" aria-pressed="${s.categorie === id}"><span class="tuile-icone" aria-hidden="true">${esc(c.icone)}</span><span class="tuile-nom">${esc(c.nom)}</span></button>`;
    })
    .join("");
}

function actionsSaisieHTML() {
  const s = etat.saisie;
  const pret = Boolean(C.texteVersCentimes(s.texte || "")) && (s.sens === "virement" || s.categorie);
  if (s.edition) {
    return `<button type="button" class="btn btn-danger" data-action="supprimer-op">Supprimer</button><button type="button" class="btn btn-principal" data-action="enregistrer"${pret ? "" : " disabled"}>Enregistrer</button>`;
  }
  if (s.sens === "virement") return `<button type="button" class="btn btn-principal" data-action="enregistrer"${pret ? "" : " disabled"}>Enregistrer le virement</button>`;
  if (modeRapide()) return `<p class="petit doux astuce">Montant, puis catégorie : c'est enregistré.</p>`;
  return `<button type="button" class="btn" data-action="enregistrer-nouvelle"${pret ? "" : " disabled"}>Enregistrer + nouvelle</button><button type="button" class="btn btn-principal" data-action="enregistrer"${pret ? "" : " disabled"}>Enregistrer</button>`;
}

function ecranSaisieHTML() {
  const s = etat.saisie;
  const plusieurs = C.comptesActifs(etat.comptes).length > 1;
  const sens = s.edition ? (s.sens === "virement" ? ["virement"] : ["depense", "revenu"]) : plusieurs ? ["depense", "revenu", "virement"] : ["depense", "revenu"];
  const noms = { depense: "Dépense", revenu: "Entrée", virement: "Virement" };
  const titre = s.edition ? "Modifier l'opération" : "Nouvelle opération";
  return `<div class="saisie" role="dialog" aria-modal="true" aria-label="${titre}">
    <div class="saisie-haut">
      <button type="button" class="btn-icone" data-action="fermer" aria-label="Fermer sans enregistrer">✕</button>
      <div class="segments" role="group" aria-label="Type d'opération">${sens.map((x) => `<button type="button" data-action="sens" data-sens="${x}" aria-pressed="${s.sens === x}">${noms[x]}</button>`).join("")}</div>
    </div>
    <div class="saisie-montant-zone">
      <div class="${classeMontantSaisi()}" id="saisie-montant" aria-live="polite">${montantSaisiHTML()}</div>
      <div class="saisie-statut" id="saisie-statut" role="status" aria-live="polite" hidden></div>
    </div>
    <div class="saisie-ligne saisie-puces" id="saisie-dates">${pucesDatesHTML()}</div>
    <div id="saisie-avertissement">${avertissementDepartHTML()}</div>
    <div class="saisie-ligne" id="saisie-compte"${ligneCompteSaisieHTML() ? "" : " hidden"}>${ligneCompteSaisieHTML()}</div>
    <div class="saisie-details" id="saisie-details"${s.details ? "" : " hidden"}>${detailsSaisieHTML()}</div>
    <div class="${s.sens === "virement" ? "virement-comptes" : "grille"}" id="saisie-grille">${grilleSaisieHTML()}</div>
    <div class="saisie-actions" id="saisie-actions">${actionsSaisieHTML()}</div>
    <div class="pave" role="group" aria-label="Pavé numérique">${["1", "2", "3", "4", "5", "6", "7", "8", "9", ",", "0", "⌫"]
      .map((t) => `<button type="button" class="touche" data-action="touche" data-touche="${t}"${t === "⌫" ? ' aria-label="Effacer le dernier chiffre (appui long : tout effacer)"' : ""}>${t}</button>`)
      .join("")}</div>
  </div>`;
}

function majMontantSaisi() {
  const zone = $("#saisie-montant");
  if (!zone) return;
  zone.className = classeMontantSaisi();
  zone.innerHTML = montantSaisiHTML();
  const actions = $("#saisie-actions");
  if (actions) actions.innerHTML = actionsSaisieHTML();
}

function toucher(touche) {
  const s = etat.saisie;
  if (!s) return;
  cacherStatut(); // on tape un montant : le message posé dessus s'efface
  s.texte = touche === "C" ? "" : C.appliquerTouche(s.texte, touche);
  majMontantSaisi();
}

function secouerMontant() {
  const zone = $("#saisie-montant");
  if (!zone) return;
  zone.classList.remove("secoue");
  void zone.offsetWidth; // relance l'animation
  zone.classList.add("secoue");
}

function changerSens(sens) {
  const s = etat.saisie;
  if (!s || s.sens === sens) return;
  s.sens = sens;
  const cat = catParId.get(s.categorie);
  if (!cat || cat.sens !== sens) s.categorie = null;
  if (sens === "virement" && (!s.vers || s.vers === s.compte)) s.vers = C.comptesActifs(etat.comptes).find((c) => c.id !== s.compte)?.id ?? null;
  rendreCalque();
}

function choisirDate(date) {
  if (!etat.saisie || !C.dateValide(date)) return;
  etat.saisie.date = date;
  const zone = $("#saisie-dates");
  if (zone) zone.innerHTML = pucesDatesHTML();
  majAvertissementDepart();
}

function basculerDetails() {
  const s = etat.saisie;
  s.details = !s.details;
  const zone = $("#saisie-details");
  zone.hidden = !s.details;
  const bouton = document.querySelector('[data-action="details"]');
  bouton.setAttribute("aria-pressed", String(s.details));
  bouton.setAttribute("aria-expanded", String(s.details));
  if (s.details) zone.querySelector("input")?.focus();
}

function toucherCategorie(id) {
  const s = etat.saisie;
  if (!s) return;
  if (modeRapide()) {
    if (!C.texteVersCentimes(s.texte || "")) {
      secouerMontant();
      toast("Tapez d'abord le montant.");
      return;
    }
    return enregistrerSaisie({ categorie: id, parTuile: true });
  }
  s.categorie = id;
  for (const t of document.querySelectorAll(".tuile")) t.setAttribute("aria-pressed", String(t.dataset.id === id));
  $("#saisie-actions").innerHTML = actionsSaisieHTML();
}

async function enregistrerSaisie({ categorie = null, nouvelle = false, parTuile = false } = {}) {
  const s = etat.saisie;
  if (!s || s.enCours) return; // anti double toucher
  const centimes = C.texteVersCentimes(s.texte || "");
  if (!centimes || centimes < 0) {
    secouerMontant();
    toast("Tapez d'abord le montant.");
    return;
  }
  if (!C.dateValide(s.date)) {
    toast("La date n'est pas valide.");
    return;
  }
  const m = maintenant();
  s.enCours = true;
  try {
    if (s.sens === "virement") {
      if (!s.compte || !s.vers || s.compte === s.vers) {
        toast("Choisissez deux comptes différents.");
        return;
      }
      let ops;
      if (s.edition) {
        const [de, vers] = jambesVirement(s.edition);
        if (!de || !vers) return operationDisparue();
        const commun = { date: s.date, libelle: s.libelle.trim(), note: s.note.trim(), modifie_le: m };
        ops = [
          { ...de, ...commun, compte: s.compte, montant: -centimes },
          { ...vers, ...commun, compte: s.vers, montant: centimes },
        ];
      } else {
        ops = C.construireVirement({ ids: [nouvelId(), nouvelId()], lien: nouvelId(), de: s.compte, vers: s.vers, montant: centimes, date: s.date, libelle: s.libelle.trim(), note: s.note.trim(), maintenant: m });
      }
      await enregistrer({ operations: ops });
      apresEnregistrement(ops, { message: s.edition ? "Virement modifié ✓" : `Virement de ${C.formaterEuros(centimes)} enregistré ✓`, nouvelle: false, creation: !s.edition });
      return;
    }
    const cat = categorie ?? s.categorie;
    if (!cat) {
      toast("Touchez une catégorie.");
      return;
    }
    const montant = s.sens === "depense" ? -centimes : centimes;
    const champs = { date: s.date, montant, compte: s.compte, categorie: cat, libelle: s.libelle.trim(), tiers: s.tiers.trim(), moyen: s.moyen || null, note: s.note.trim(), modifie_le: m };
    let o;
    if (s.edition) {
      const actuelle = etat.operations.find((x) => x.id === s.edition);
      if (!actuelle || actuelle.supprime) return operationDisparue();
      o = { ...actuelle, ...champs };
    } else {
      o = { id: nouvelId(), pointe: false, recurrence_id: null, lien_virement: null, cree_le: m, supprime: false, ...champs };
    }
    await enregistrer(() => {
      const changements = { operations: [o] };
      if (etat.reglages.dernier_compte !== s.compte) changements.parametres = { reglages: { ...etat.reglages, dernier_compte: s.compte } };
      return changements;
    });
    const c = catParId.get(cat);
    apresEnregistrement([o], {
      message: s.edition ? "Opération modifiée ✓" : `Enregistré : ${C.formaterEuros(montant, { signe: true })} en ${c?.icone ?? ""} ${c?.nom ?? ""}`,
      nouvelle,
      creation: !s.edition,
      parTuile,
    });
  } catch (e) {
    toast(`L'opération n'a PAS été enregistrée : ${e.message}`, { erreur: true, duree: 8000 });
  } finally {
    s.enCours = false;
  }
}

function operationDisparue() {
  fermer();
  toast("Cette opération a été supprimée entre-temps (autre fenêtre ou « Annuler ») : rien n'a été enregistré.", { erreur: true, duree: 6000 });
}

function apresEnregistrement(ops, { message, nouvelle, creation, parTuile = false }) {
  if (nouvelle) {
    const s = etat.saisie;
    Object.assign(s, { texte: "", categorie: null, libelle: "", tiers: "", note: "", moyen: "" });
    rendreCalque();
  } else {
    if (parTuile) etat.ignorerClicsJusqua = performance.now() + 450; // le 2e toucher d'un double toucher sur une tuile ne doit rien ouvrir dessous
    fermer();
  }
  rafraichirVue();
  const annuler = creation ? { action: "↶ Annuler", onAction: () => annulerCreation(ops), duree: DUREE_ANNULER } : {};
  toast(message, annuler);
}

async function annulerCreation(ops) {
  try {
    const m = maintenant();
    await enregistrer({ operations: ops.map((o) => ({ ...o, supprime: true, modifie_le: m })) });
    rafraichirVue();
    toast("Saisie annulée.");
  } catch (e) {
    toast(`Annulation impossible : ${e.message}`, { erreur: true });
  }
}

async function supprimerSaisie() {
  const s = etat.saisie;
  if (!s?.edition) return;
  const ops = s.sens === "virement" ? jambesVirement(s.edition) : [etat.operations.find((o) => o.id === s.edition)].filter(Boolean);
  try {
    const m = maintenant();
    await enregistrer({ operations: ops.map((o) => ({ ...o, supprime: true, modifie_le: m })) });
  } catch (e) {
    toast(`Suppression impossible : ${e.message}`, { erreur: true });
    return;
  }
  fermer();
  rafraichirVue();
  toast("Opération supprimée.", {
    action: "↶ Annuler",
    duree: DUREE_ANNULER,
    onAction: async () => {
      const m2 = maintenant();
      await enregistrer({ operations: ops.map((o) => ({ ...o, supprime: false, modifie_le: m2 })) });
      rafraichirVue();
      toast("Opération remise ✓");
    },
  });
}

/** Un virement dont une des deux opérations manque (fichier abîmé) : il fausse un solde et ne peut pas être modifié. */
async function supprimerVirementIncomplet(lien) {
  const jambes = jambesVirement(lien);
  const ok = await confirmer({
    titre: "Virement incomplet",
    textes: [
      "Il manque une des deux opérations de ce virement (sauvegarde abîmée ?) : il fausse le solde et ne peut pas être modifié.",
      "Le supprimer ? Vous pourrez ensuite le noter à nouveau.",
    ],
    ok: "Supprimer",
    danger: true,
  });
  if (!ok) return;
  const m = maintenant();
  await enregistrer({ operations: jambes.map((o) => ({ ...o, supprime: true, modifie_le: m })) });
  rafraichirVue();
  toast("Virement incomplet supprimé.");
}

/* ---------- 🏦 Compte (ajout / modification) ---------- */

function ecranCompteHTML(haut) {
  const c = haut.id ? cptParId.get(haut.id) : null;
  if (haut.icone === undefined) haut.icone = c?.icone ?? "🏦";
  const nbOps = c ? etat.operations.filter((o) => o.compte === c.id && !o.supprime).length : 0;
  const seulActif = Boolean(c) && !c.archive && C.comptesActifs(etat.comptes).length <= 1; // le dernier compte actif ne s'archive ni ne se supprime
  const types = C.TYPES_COMPTE.map((t) => `<option value="${t.id}"${(c?.type ?? "courant") === t.id ? " selected" : ""}>${t.nom}</option>`).join("");
  return `<div class="ecran" role="dialog" aria-modal="true" aria-labelledby="titre-compte">
    <div class="ecran-entete"><button type="button" class="btn-icone" data-action="fermer" aria-label="Fermer">✕</button><h1 id="titre-compte">${c ? "Modifier le compte" : "Nouveau compte"}</h1><span></span></div>
    <div class="ecran-corps">
      <label class="champ"><span>Nom</span><input type="text" id="compte-nom" value="${esc(c?.nom ?? "")}" maxlength="40" placeholder="ex. Livret A" /></label>
      <label class="champ"><span>Type</span><select id="compte-type">${types}</select></label>
      <div class="champ"><span>Solde de départ</span>
        <div class="champ-montant"><input type="text" inputmode="decimal" id="compte-solde" value="${c ? C.centimesVersTexte(c.solde_depart) : ""}" placeholder="0,00" aria-label="Solde de départ en euros" autocomplete="off" /><button type="button" class="btn" data-action="signe" data-cible="compte-solde" aria-label="Mettre en négatif ou en positif">±</button></div>
        <span class="champ-aide">L'argent sur le compte au début de la date de départ. À découvert ? Touchez ± pour le mettre en négatif.</span>
      </div>
      <label class="champ"><span>Date de départ</span><input type="date" id="compte-date" value="${esc(c?.date_depart ?? etat.aujourdhui)}" /><span class="champ-aide">Les opérations datées d'avant ne changent pas le solde : elles sont déjà comprises dedans.</span></label>
      <div class="champ"><span>Icône</span><div class="choix-icones">${ICONES_COMPTE.map((i) => `<button type="button" class="puce" data-action="icone-compte" data-icone="${i}" aria-pressed="${haut.icone === i}">${i}</button>`).join("")}</div></div>
      ${seulActif ? `<p class="champ champ-aide">C'est votre seul compte actif : il reste là, pour pouvoir noter vos opérations.</p>` : ""}
      ${c && !seulActif ? `<label class="option"><input type="checkbox" id="compte-archive"${c.archive ? " checked" : ""} /><span>Archiver ce compte (il disparaît des listes ; ses opérations restent)</span></label>` : ""}
      <p class="champ-erreur" id="compte-erreur" hidden></p>
      ${c && nbOps === 0 && !seulActif ? `<div class="champ"><button type="button" class="btn btn-danger" data-action="supprimer-compte">Supprimer ce compte</button></div>` : ""}
      ${c && nbOps > 0 && !seulActif ? `<p class="champ champ-aide">${pluriel(nbOps, "opération est notée", "opérations sont notées")} sur ce compte : il ne peut pas être supprimé, mais vous pouvez l'archiver.</p>` : ""}
    </div>
    <div class="ecran-pied"><button type="button" class="btn" data-action="fermer">Annuler</button><button type="button" class="btn btn-principal" data-action="enregistrer-compte">Enregistrer</button></div>
  </div>`;
}

function erreurChamp(id, message) {
  const zone = $(`#${id}`);
  zone.textContent = message;
  zone.hidden = false;
}

async function enregistrerCompte() {
  const haut = etat.pile[etat.pile.length - 1];
  const c = haut.id ? cptParId.get(haut.id) : null;
  const nom = $("#compte-nom").value.trim();
  const solde = C.texteVersCentimes($("#compte-solde").value.trim() || "0");
  const date = $("#compte-date").value;
  const archive = $("#compte-archive")?.checked ?? false;
  if (!nom) return erreurChamp("compte-erreur", "Donnez un nom au compte.");
  if (solde === null) return erreurChamp("compte-erreur", "Le solde de départ n'est pas un montant lisible (ex. 1234,56).");
  if (!C.dateValide(date)) return erreurChamp("compte-erreur", "La date de départ n'est pas valide.");
  if (archive && !c?.archive && C.comptesActifs(etat.comptes).length <= 1) return erreurChamp("compte-erreur", "Gardez au moins un compte actif pour pouvoir noter vos opérations.");
  const m = maintenant();
  const type = $("#compte-type").value;
  const compte = c
    ? { ...c, nom, type, solde_depart: solde, date_depart: date, icone: haut.icone, archive, modifie_le: m }
    : { id: nouvelId(), nom, type, solde_depart: solde, date_depart: date, icone: haut.icone, couleur: null, ordre: etat.comptes.length, archive: false, cree_le: m, modifie_le: m, supprime: false };
  try {
    await enregistrer({ comptes: [compte] });
  } catch (e) {
    return erreurChamp("compte-erreur", `Le compte n'a PAS été enregistré : ${e.message}`);
  }
  fermer();
  rafraichirVue();
  toast(c ? "Compte modifié ✓" : "Compte ajouté ✓");
}

async function supprimerCompte() {
  const haut = etat.pile[etat.pile.length - 1];
  const c = cptParId.get(haut.id);
  if (!c) return;
  if (etat.operations.some((o) => o.compte === c.id && !o.supprime)) return;
  if (!c.archive && C.comptesActifs(etat.comptes).length <= 1) return erreurChamp("compte-erreur", "C'est votre seul compte actif : il faut en garder un.");
  if (!(await confirmer({ titre: "Supprimer ce compte ?", textes: [`« ${c.nom} » n'a aucune opération. Il sera retiré de l'appli.`], ok: "Supprimer", danger: true }))) return;
  await enregistrer({ comptes: [{ ...c, supprime: true, modifie_le: maintenant() }] });
  fermer();
  rafraichirVue();
  toast("Compte supprimé.");
}

/* ---------- 🏷️ Catégories ---------- */

function ecranCategoriesHTML() {
  const actives = etat.categories.filter((c) => !c.supprime);
  const groupe = (titre, liste, sens) => {
    const tri = liste.sort((a, b) => Number(a.archive) - Number(b.archive) || a.ordre - b.ordre);
    const lignes = tri
      .map((c) =>
        c.systeme
          ? `<div class="reglage-bouton"><span class="op-icone" aria-hidden="true">${esc(c.icone)}</span><span class="op-texte"><span class="op-titre">${esc(c.nom)}</span><span class="op-sous-titre">utilisée automatiquement par les virements</span></span><span></span></div>`
          : boutonReglage("modifier-categorie", c.icone, c.nom + (c.archive ? " (archivée)" : ""), c.description || "", `data-id="${esc(c.id)}"`)
      )
      .join("");
    const ajout = sens ? boutonReglage("ajouter-categorie", "➕", sens === "depense" ? "Nouvelle catégorie de dépense" : "Nouvelle catégorie de revenu", "", `data-sens="${sens}"`) : "";
    return `<section class="section"><h2>${titre}</h2><div class="bloc">${lignes}${ajout}</div></section>`;
  };
  return `<div class="ecran" role="dialog" aria-modal="true" aria-labelledby="titre-categories">
    <div class="ecran-entete"><button type="button" class="btn-icone" data-action="fermer" aria-label="Fermer">✕</button><h1 id="titre-categories">Catégories</h1><span></span></div>
    <div class="ecran-corps">
      ${groupe("Dépenses", actives.filter((c) => c.sens === "depense" && !c.hors_budget), "depense")}
      ${groupe("Revenus", actives.filter((c) => c.sens === "revenu" && !c.hors_budget), "revenu")}
      ${groupe("Hors budget", actives.filter((c) => c.hors_budget), null)}
    </div>
  </div>`;
}

function ecranCategorieHTML(haut) {
  const c = haut.id ? catParId.get(haut.id) : null;
  if (haut.sens === undefined) haut.sens = c?.sens ?? "depense";
  const utilisee = c ? etat.operations.filter((o) => o.categorie === c.id && !o.supprime).length : 0;
  const sensModifiable = !c || utilisee === 0;
  return `<div class="ecran" role="dialog" aria-modal="true" aria-labelledby="titre-categorie">
    <div class="ecran-entete"><button type="button" class="btn-icone" data-action="fermer" aria-label="Fermer">✕</button><h1 id="titre-categorie">${c ? "Modifier la catégorie" : "Nouvelle catégorie"}</h1><span></span></div>
    <div class="ecran-corps">
      <label class="champ"><span>Nom</span><input type="text" id="categorie-nom" value="${esc(c?.nom ?? "")}" maxlength="40" placeholder="ex. Paris hippiques" /></label>
      <div class="champ"><span>Icône</span>
        <input type="text" id="categorie-icone" value="${esc(c?.icone ?? "")}" maxlength="12" placeholder="un émoji" aria-label="Icône (un émoji)" />
        <div class="choix-icones">${ICONES_CATEGORIE.map((i) => `<button type="button" class="puce" data-action="icone-categorie" data-icone="${i}">${i}</button>`).join("")}</div>
      </div>
      ${
        sensModifiable
          ? `<div class="champ"><span>Type</span><div class="segments" role="group" aria-label="Type de catégorie">
        <button type="button" data-action="sens-categorie" data-sens="depense" aria-pressed="${haut.sens === "depense"}">Dépense</button>
        <button type="button" data-action="sens-categorie" data-sens="revenu" aria-pressed="${haut.sens === "revenu"}">Revenu</button></div></div>`
          : `<p class="champ champ-aide">Type : ${c.sens === "depense" ? "dépense" : "revenu"} (non modifiable : ${pluriel(utilisee, "opération l'utilise", "opérations l'utilisent")}).</p>`
      }
      <label class="option"><input type="checkbox" id="categorie-hors-budget"${c?.hors_budget ? " checked" : ""} /><span>Hors budget (comme l'épargne : n'entrera pas dans les budgets)</span></label>
      ${c ? `<label class="option"><input type="checkbox" id="categorie-archive"${c.archive ? " checked" : ""} /><span>Archiver (elle disparaît de la grille de saisie ; ses opérations restent)</span></label>` : ""}
      <p class="champ-erreur" id="categorie-erreur" hidden></p>
      ${c && utilisee === 0 ? `<div class="champ"><button type="button" class="btn btn-danger" data-action="supprimer-categorie">Supprimer cette catégorie</button></div>` : ""}
    </div>
    <div class="ecran-pied"><button type="button" class="btn" data-action="fermer">Annuler</button><button type="button" class="btn btn-principal" data-action="enregistrer-categorie">Enregistrer</button></div>
  </div>`;
}

async function enregistrerCategorie() {
  const haut = etat.pile[etat.pile.length - 1];
  const c = haut.id ? catParId.get(haut.id) : null;
  const nom = $("#categorie-nom").value.trim();
  const icone = $("#categorie-icone").value.trim() || "❓";
  if (!nom) return erreurChamp("categorie-erreur", "Donnez un nom à la catégorie.");
  const m = maintenant();
  const hors_budget = $("#categorie-hors-budget").checked;
  const archive = $("#categorie-archive")?.checked ?? false;
  const categorie = c
    ? { ...c, nom, icone, sens: haut.sens, hors_budget, archive, modifie_le: m }
    : { id: nouvelId(), nom, icone, sens: haut.sens, parent: null, ordre: etat.categories.length, archive: false, hors_budget, description: "", systeme: false, cree_le: m, modifie_le: m, supprime: false };
  try {
    await enregistrer({ categories: [categorie] });
  } catch (e) {
    return erreurChamp("categorie-erreur", `La catégorie n'a PAS été enregistrée : ${e.message}`);
  }
  calculerOrdreCategories();
  fermer();
  toast(c ? "Catégorie modifiée ✓" : "Catégorie ajoutée ✓");
}

async function supprimerCategorie() {
  const haut = etat.pile[etat.pile.length - 1];
  const c = catParId.get(haut.id);
  if (!c || c.systeme || etat.operations.some((o) => o.categorie === c.id && !o.supprime)) return;
  if (!(await confirmer({ titre: "Supprimer cette catégorie ?", textes: [`« ${c.nom} » n'est utilisée par aucune opération.`], ok: "Supprimer", danger: true }))) return;
  await enregistrer({ categories: [{ ...c, supprime: true, modifie_le: maintenant() }] });
  calculerOrdreCategories();
  fermer();
  toast("Catégorie supprimée.");
}

/* ---------- 👋 Guide du 1er lancement ---------- */

function nouveauGuide() {
  return { etape: 0, nom: "Compte courant", type: "courant", solde: "", date: etat.aujourdhui, jour: 1, erreur: "" };
}

function lireGuide() {
  const g = etat.guide;
  if (!g) return;
  if ($("#guide-nom")) g.nom = $("#guide-nom").value;
  if ($("#guide-type")) g.type = $("#guide-type").value;
  if ($("#guide-solde")) g.solde = $("#guide-solde").value;
  if ($("#guide-date")) g.date = $("#guide-date").value;
  const choix = document.querySelector('input[name="guide-jour"]:checked');
  if (choix) g.jour = choix.value === "1" ? 1 : Number($("#guide-jour-paie").value);
}

function ecranGuideHTML() {
  const g = etat.guide;
  const etapes = `<p class="guide-etapes">Étape ${g.etape} sur 3</p>`;
  const pied = (suivant = "Suivant", action = "guide-suivant") =>
    `<div class="guide-pied guide-pied-2"><button type="button" class="btn" data-action="guide-precedent">Précédent</button><button type="button" class="btn btn-principal" data-action="${action}">${suivant}</button></div>`;
  if (g.etape === 0) {
    return `<div class="ecran" role="dialog" aria-modal="true" aria-label="Bienvenue">
      <div class="guide-corps">
        <img src="icones/icone-192.png" alt="" class="logo-guide" width="72" height="72" />
        <h1 class="guide-titre">Ma Compta Perso</h1>
        <p class="guide-texte">Notez vos dépenses en quelques secondes et voyez où en est votre mois.</p>
        <ul class="promesses">
          <li><span aria-hidden="true">🔒</span><span>Vos données restent sur cet appareil : pas de compte en ligne, pas de pub, rien n'est envoyé sur Internet.</span></li>
          <li><span aria-hidden="true">📴</span><span>Une fois installée, l'appli marche même sans réseau.</span></li>
          <li><span aria-hidden="true">💾</span><span>Pensez aux sauvegardes : si l'appareil est perdu, ce sont elles qui gardent vos chiffres.</span></li>
        </ul>
      </div>
      <div class="guide-pied">
        <button type="button" class="btn btn-principal btn-large" data-action="guide-suivant">Commencer</button>
        <button type="button" class="btn btn-large" data-action="guide-exemples">▶ Essayer avec des exemples</button>
        <button type="button" class="btn btn-discret btn-large" data-action="restaurer">J'ai une sauvegarde : la restaurer</button>
        ${etat.copieRestauration ? `<button type="button" class="btn btn-discret btn-large" data-action="annuler-restauration">🛟 Revenir à l'état d'avant la dernière restauration</button>` : ""}
      </div>
    </div>`;
  }
  if (g.etape === 1) {
    const types = C.TYPES_COMPTE.map((t) => `<option value="${t.id}"${g.type === t.id ? " selected" : ""}>${t.nom}</option>`).join("");
    const premier = C.ecrireDate(C.lireDate(etat.aujourdhui).a, C.lireDate(etat.aujourdhui).m, 1);
    return `<div class="ecran" role="dialog" aria-modal="true" aria-labelledby="titre-guide">
      <div class="guide-corps">
        ${etapes}
        <h1 class="guide-titre" id="titre-guide">Votre compte</h1>
        <p class="guide-texte">Celui où passent vos dépenses. Vous pourrez en ajouter d'autres ensuite (livret, espèces…) dans ⚙️ Réglages.</p>
        <label class="champ"><span>Nom</span><input type="text" id="guide-nom" value="${esc(g.nom)}" maxlength="40" /></label>
        <label class="champ"><span>Type</span><select id="guide-type">${types}</select></label>
        <div class="champ"><span>Solde de départ</span>
          <div class="champ-montant"><input type="text" inputmode="decimal" id="guide-solde" value="${esc(g.solde)}" placeholder="0,00" aria-label="Solde de départ en euros" autocomplete="off" /><button type="button" class="btn" data-action="signe" data-cible="guide-solde" aria-label="Mettre en négatif ou en positif">±</button></div>
          <span class="champ-aide">L'argent sur le compte au début de la date de départ : regardez votre appli bancaire ou votre relevé. À découvert ? Touchez ±.</span>
        </div>
        <div class="champ"><span>Date de départ</span>
          <div class="puces">
            <button type="button" class="puce" data-action="guide-date" data-date="${etat.aujourdhui}" aria-pressed="${g.date === etat.aujourdhui}">Aujourd'hui</button>
            ${premier !== etat.aujourdhui ? `<button type="button" class="puce" data-action="guide-date" data-date="${premier}" aria-pressed="${g.date === premier}">Le 1er du mois</button>` : ""}
          </div>
          <input type="date" id="guide-date" value="${esc(g.date)}" aria-label="Date de départ" />
          <span class="champ-aide">Partir du 1er du mois donne un premier mois complet, mais il faudra noter les opérations passées depuis.</span>
        </div>
        ${g.erreur ? `<p class="champ-erreur">${esc(g.erreur)}</p>` : ""}
      </div>
      ${pied()}
    </div>`;
  }
  if (g.etape === 2) {
    const joursPaie = Array.from({ length: 30 }, (_, i) => i + 2)
      .map((n) => `<option value="${n}"${n === (g.jour > 1 ? g.jour : 28) ? " selected" : ""}>${n}</option>`)
      .join("");
    return `<div class="ecran" role="dialog" aria-modal="true" aria-labelledby="titre-guide">
      <div class="guide-corps">
        ${etapes}
        <h1 class="guide-titre" id="titre-guide">Votre mois</h1>
        <p class="guide-texte">C'est la période que l'accueil appelle « le mois en cours ».</p>
        <div class="options champ">
          <label class="option"><input type="radio" name="guide-jour" value="1"${g.jour === 1 ? " checked" : ""} /><span><strong>Du 1er au dernier jour du mois</strong><br /><span class="petit doux">Conseillé si vos revenus arrivent à des dates variables.</span></span></label>
          <label class="option"><input type="radio" name="guide-jour" value="paie"${g.jour > 1 ? " checked" : ""} /><span><strong>D'une paie à l'autre</strong><br /><span class="petit doux">Pour un salaire à date fixe : le mois commence le jour <select id="guide-jour-paie" aria-label="Jour de paie">${joursPaie}</select></span></span></label>
        </div>
      </div>
      ${pied()}
    </div>`;
  }
  let install;
  if (estInstallee()) install = `<p class="guide-texte">✓ C'est déjà fait : l'appli est installée.</p>`;
  else if (etat.installation) install = `<p class="guide-texte">Elle aura son icône sur l'écran d'accueil et marchera sans réseau.</p><div class="champ"><button type="button" class="btn btn-principal" data-action="installer">📲 Installer l'appli</button></div>`;
  else if (estIPhone()) install = `<p class="guide-texte">Dans Safari : touchez Partager, puis « Sur l'écran d'accueil ». Sur iPhone, c'est important : une page non installée peut voir ses données effacées après 7 jours sans visite.</p>`;
  else install = `<p class="guide-texte">Dans le menu du navigateur (⋮), choisissez « Installer l'application » ou « Ajouter à l'écran d'accueil ». Elle aura son icône et marchera sans réseau.</p>`;
  return `<div class="ecran" role="dialog" aria-modal="true" aria-labelledby="titre-guide">
    <div class="guide-corps">
      ${etapes}
      <h1 class="guide-titre" id="titre-guide">Installez l'appli</h1>
      ${install}
      <p class="guide-texte doux">Vous pourrez aussi le faire plus tard, depuis ⚙️ Réglages.</p>
    </div>
    ${pied("Terminer", "guide-terminer")}
  </div>`;
}

function guideAller(etape) {
  lireGuide();
  etat.guide.erreur = "";
  if (etat.guide.etape === 1 && etape === 2) {
    const g = etat.guide;
    if (!g.nom.trim()) etat.guide.erreur = "Donnez un nom au compte.";
    else if (C.texteVersCentimes(g.solde.trim() || "0") === null) etat.guide.erreur = "Le solde de départ n'est pas un montant lisible (ex. 1234,56).";
    else if (!C.dateValide(g.date)) etat.guide.erreur = "La date de départ n'est pas valide.";
    if (etat.guide.erreur) {
      rendreCalque();
      return;
    }
  }
  etat.guide.etape = Math.max(0, Math.min(3, etape));
  rendreCalque();
}

async function terminerGuide() {
  lireGuide();
  const g = etat.guide;
  const m = maintenant();
  const type = C.TYPES_COMPTE.find((t) => t.id === g.type) ?? C.TYPES_COMPTE[0];
  const compte = { id: nouvelId(), nom: g.nom.trim(), type: type.id, solde_depart: C.texteVersCentimes(g.solde.trim() || "0"), date_depart: g.date, icone: type.icone, couleur: null, ordre: 0, archive: false, cree_le: m, modifie_le: m, supprime: false };
  const reglages = { ...etat.reglages, jour_debut_mois: g.jour, dernier_compte: compte.id };
  try {
    await enFile(async () => {
      await S.ecrire({ comptes: [compte], categories: C.categoriesParDefaut(m), parametres: { meta: nouvelleMeta(false), reglages } });
      await chargerDonnees();
    });
    prevenirAutresFenetres();
  } catch (e) {
    g.erreur = `Rien n'a été enregistré : ${e.message}`;
    rendreCalque();
    return;
  }
  etat.guide = null;
  etat.vue = "accueil";
  rendreTout();
  demanderPersistance();
  toast("C'est prêt ! Touchez + pour noter votre première dépense.", { duree: 6000 });
}

async function essayerExemples() {
  const m = maintenant();
  const ex = C.genererExemples({ aujourdhui: etat.aujourdhui, maintenant: m, nouvelId });
  try {
    await enFile(async () => {
      await S.ecrire({
        comptes: ex.comptes,
        categories: C.categoriesParDefaut(m),
        operations: ex.operations,
        parametres: { meta: nouvelleMeta(true), reglages: { ...etat.reglages, dernier_compte: ex.comptes[0].id } },
      });
      await chargerDonnees();
    });
    prevenirAutresFenetres();
  } catch (e) {
    toast(`Impossible de créer les exemples : ${e.message}`, { erreur: true });
    return;
  }
  etat.guide = null;
  etat.vue = "accueil";
  rendreTout();
}

async function effacerExemples() {
  // Les opérations d'exemple sont toutes créées au même instant : celles créées APRÈS ont été notées par vous.
  const actives = etat.operations.filter((o) => !o.supprime);
  const debut = actives.reduce((min, o) => (o.cree_le < min ? o.cree_le : min), actives[0]?.cree_le ?? "");
  const ajoutees = actives.filter((o) => o.cree_le > debut).length;
  const textes = ["Toutes les données d'exemple seront effacées, puis le guide vous aidera à créer votre compte."];
  if (ajoutees) textes.push(`⚠️ ${pluriel(ajoutees, "opération que vous avez notée vous-même sera effacée", "opérations que vous avez notées vous-même seront effacées")} aussi.`);
  if (!(await confirmer({ titre: "Effacer les exemples ?", textes, ok: "Effacer et commencer", danger: ajoutees > 0 }))) return;
  await enFile(async () => {
    await S.toutEffacer(); // les copies de sécurité, elles, restent
    await chargerDonnees();
  });
  prevenirAutresFenetres();
  Object.assign(etat, { periodeOps: null, periodeStats: null, filtres: { texte: "", compte: "", categorie: "" }, vue: "accueil" });
  etat.guide = nouveauGuide();
  rendreTout();
}

/* =====================================================================
   SAUVEGARDES, RESTAURATION, EXPORTS
   ===================================================================== */

function telecharger(contenu, nom, type) {
  const url = URL.createObjectURL(new Blob([contenu], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = nom;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Partage (Drive, mail…) si le navigateur le permet, sinon téléchargement.
 *  PIÈGE 8 : Chrome refuse de partager un fichier .json → on retente avec le même contenu en .txt. */
async function partagerOuTelecharger(contenu, nom, type) {
  if (navigator.canShare && navigator.share) {
    const essais = [new File([contenu], nom, { type })];
    if (nom.endsWith(".json")) essais.push(new File([contenu], nom.replace(/\.json$/, ".txt"), { type: "text/plain" }));
    for (const f of essais) {
      if (navigator.canShare({ files: [f] })) {
        await navigator.share({ files: [f], title: nom }); // erreur « AbortError » si on annule : gérée par l'appelant
        return "partage";
      }
    }
  }
  telecharger(contenu, nom, type);
  return "telechargement";
}

async function noterSauvegarde(quand) {
  await changerMeta({ derniere_sauvegarde: quand });
  rafraichirVue();
}

async function sauvegarderFichier() {
  const s = sauvegardeActuelle();
  telecharger(JSON.stringify(s, null, 1), C.nomFichier("sauvegarde", etat.aujourdhui, "json"), "application/json");
  await noterSauvegarde(s.cree_le);
  toast("Sauvegarde téléchargée : rangez-la en lieu sûr (Drive, mail…).", { duree: 6000 });
}

async function partagerSauvegarde() {
  const s = sauvegardeActuelle();
  try {
    const r = await partagerOuTelecharger(JSON.stringify(s, null, 1), C.nomFichier("sauvegarde", etat.aujourdhui, "json"), "application/json");
    await noterSauvegarde(s.cree_le);
    toast(r === "partage" ? "Sauvegarde partagée ✓" : "Le partage n'est pas possible ici : la sauvegarde a été téléchargée.", { duree: 6000 });
  } catch (e) {
    if (e.name === "AbortError") toast("Partage annulé : rien n'a été envoyé.");
    else toast(`Partage impossible : ${e.message}`, { erreur: true });
  }
}

function sauvegardeRapide() {
  return pointeurTactile() ? partagerSauvegarde() : sauvegarderFichier();
}

async function livrer(contenu, nom, type) {
  if (!pointeurTactile()) {
    telecharger(contenu, nom, type);
    toast(`Fichier téléchargé : ${nom}`, { duree: 5000 });
    return;
  }
  try {
    const r = await partagerOuTelecharger(contenu, nom, type);
    if (r === "telechargement") toast(`Fichier téléchargé : ${nom}`, { duree: 5000 });
  } catch (e) {
    if (e.name !== "AbortError") toast(`Envoi impossible : ${e.message}`, { erreur: true });
  }
}

function exporterAnonyme() {
  const a = C.anonymiser(sauvegardeActuelle());
  return livrer(JSON.stringify(a, null, 1), C.nomFichier("anonyme", etat.aujourdhui, "json"), "application/json");
}

function exporterCSV() {
  return livrer(C.genererCSV(etat), C.nomFichier("operations", etat.aujourdhui, "csv"), "text/csv");
}

function choisirFichierRestauration() {
  const champ = $("#fichier-restaurer");
  champ.value = "";
  champ.click();
}

async function restaurerDepuisFichier(fichier) {
  let obj;
  try {
    obj = JSON.parse(await fichier.text());
  } catch {
    await alerte("Fichier illisible", "Ce fichier n'est pas une sauvegarde de Ma Compta Perso (ou il est abîmé).");
    return;
  }
  const v = C.verifierSauvegarde(obj);
  if (!v.ok) {
    await alerte("Restauration impossible", v.erreur);
    return;
  }
  const s = v.sauvegarde;
  const nbOps = s.operations.filter((o) => !o.supprime).length;
  const nbComptes = s.comptes.filter((c) => !c.supprime).length;
  const textes = [`Sauvegarde du ${dateHeure(s.cree_le)}${s.appareil ? ` (${s.appareil})` : ""} : ${pluriel(nbComptes, "compte", "comptes")}, ${pluriel(nbOps, "opération", "opérations")}.`];
  if (etat.meta) textes.push("Elle va REMPLACER toutes les données de cet appareil. Une copie de sécurité de l'état actuel est gardée : vous pourrez revenir en arrière.");
  if (s.anonyme) textes.push("⚠️ Cette sauvegarde est ANONYMISÉE : libellés, notes et noms de comptes ont été remplacés. Ce n'est sans doute pas celle que vous voulez.");
  if (s.exemple) textes.push("⚠️ Cette sauvegarde contient les données d'EXEMPLE (inventées), pas de vrais chiffres. Ce n'est sans doute pas celle que vous voulez.");
  textes.push(...v.avertissements);
  if (!(await confirmer({ titre: "Restaurer cette sauvegarde ?", textes, ok: "Restaurer", danger: Boolean(etat.meta) }))) return;
  const copie = etat.meta ? { cle: "avant-restauration", contenu: { sauvegarde: sauvegardeActuelle(), meta: etat.meta } } : null;
  try {
    await appliquerSauvegarde(s, { derniere_sauvegarde: s.cree_le, exemple: Boolean(s.exemple) }, copie);
  } catch (e) {
    await alerte("Restauration impossible", `Rien n'a été modifié. Détail : ${e.message}`);
    return;
  }
  await apresRestauration("Sauvegarde restaurée ✓");
}

/** Remplace les données de l'appareil par une sauvegarde VÉRIFIÉE, en UNE seule opération,
 *  copie de sécurité de l'état actuel comprise : si ça échoue, RIEN n'a changé (ni les données, ni l'ancienne copie).
 *  Restent propres à l'appareil : son nom, son thème, sa taille de texte, « appareil principal ». */
async function appliquerSauvegarde(s, metaEnPlus, copie = null) {
  const local = etat.reglages;
  const reglages = C.normaliserReglages({ ...s.reglages, theme: local.theme, taille_texte: local.taille_texte, appareil_principal: local.appareil_principal });
  const meta = { ...(etat.meta || nouvelleMeta(false)), schema: C.SCHEMA, version_appli: VERSION, ...metaEnPlus };
  await enFile(() => S.remplacerTout({ ...s, reglages }, meta, copie));
  prevenirAutresFenetres();
}

/** Après un remplacement RÉUSSI : on relit la base et on redessine. Une erreur ici ne veut pas dire « rien n'a changé ». */
async function apresRestauration(message) {
  try {
    await enFile(() => chargerDonnees());
    Object.assign(etat, { guide: null, pile: [], saisie: null, vue: "accueil", periodeOps: null, periodeStats: null, filtres: { texte: "", compte: "", categorie: "" } });
    history.replaceState({ onglet: "accueil", profondeur: 0 }, "");
    rendreTout();
  } catch (e) {
    await alerte("Données remplacées, affichage impossible", `Les données ont bien été remplacées, mais l'écran n'a pas pu s'afficher (${e.message}). Rechargez la page.`);
    return;
  }
  demanderPersistance();
  toast(message, { duree: 5000 });
}

async function annulerRestauration() {
  const copie = await S.lireCopieSecurite("avant-restauration");
  if (!copie) return;
  const v = C.verifierSauvegarde(copie.contenu.sauvegarde);
  if (!v.ok) {
    await alerte("Retour impossible", v.erreur);
    return;
  }
  const textes = [`Les données d'avant la restauration (copie du ${dateHeure(copie.cree_le)}) vont remplacer les données actuelles.`];
  if (etat.meta) textes.push("Les données actuelles sont gardées à leur tour en copie de sécurité.");
  const ok = await confirmer({ titre: "Revenir en arrière ?", textes, ok: "Revenir en arrière", danger: true });
  if (!ok) return;
  const ancienne = copie.contenu.meta || {};
  const copieActuelle = etat.meta ? { cle: "avant-restauration", contenu: { sauvegarde: sauvegardeActuelle(), meta: etat.meta } } : null;
  const metaEnPlus = { ...(etat.meta ? {} : ancienne), derniere_sauvegarde: ancienne.derniere_sauvegarde ?? null, exemple: Boolean(ancienne.exemple) };
  try {
    await appliquerSauvegarde(v.sauvegarde, metaEnPlus, copieActuelle); // copie de l'état actuel ET retour arrière : tout ou rien
  } catch (e) {
    await alerte("Retour impossible", `Rien n'a été modifié. Détail : ${e.message}`);
    return;
  }
  await apresRestauration("Retour à l'état d'avant la restauration ✓");
}

/* =====================================================================
   TOAST (message en bas) ET DIALOGUES
   ===================================================================== */

let minuterieToast = null;
let minuterieStatut = null;

/** Un message court. Pendant une saisie, il se pose SUR LE MONTANT (une zone sans bouton) : jamais par-dessus
 *  « Dépense / Entrée » ou le pavé, donc impossible de toucher « ↶ Annuler » par erreur. Ailleurs, en bas de l'écran. */
function toast(message, { action = null, onAction = null, duree = 3500, erreur = false } = {}) {
  const statut = $("#saisie-statut");
  const enSaisie = Boolean(statut) && !$("#calque").inert;
  const t = enSaisie ? statut : $("#toast");
  const cacher = enSaisie ? cacherStatut : cacherToast;
  if (enSaisie) {
    cacherToast();
    clearTimeout(minuterieStatut);
  } else {
    clearTimeout(minuterieToast);
  }
  t.classList.toggle("erreur", erreur);
  t.classList.toggle("avec-action", Boolean(action));
  t.innerHTML = `<p>${esc(message)}</p>${action ? `<button type="button" class="btn">${esc(action)}</button>` : ""}`;
  t.hidden = false;
  const bouton = t.querySelector("button");
  if (bouton) {
    bouton.addEventListener(
      "click",
      () => {
        cacher();
        etat.ignorerClicsJusqua = performance.now() + 450; // le 2e toucher d'un double toucher n'ouvre rien dessous
        Promise.resolve(onAction?.()).catch((e) => signalerErreur(e));
      },
      { once: true }
    );
  }
  if (enSaisie) minuterieStatut = setTimeout(cacherStatut, duree);
  else minuterieToast = setTimeout(cacherToast, duree);
}

function cacherToast() {
  clearTimeout(minuterieToast);
  $("#toast").hidden = true;
}

function cacherStatut() {
  clearTimeout(minuterieStatut);
  const s = $("#saisie-statut");
  if (s) s.hidden = true;
}

function dialogue({ titre, textes = [], boutons }) {
  const d = $("#dialogue");
  d.innerHTML = `<h2>${esc(titre)}</h2>${textes.map((t) => `<p>${esc(t)}</p>`).join("")}<div class="dialogue-actions">${boutons
    .map((b) => `<button type="button" class="btn ${b.classe || ""}" data-reponse="${esc(b.valeur)}">${esc(b.texte)}</button>`)
    .join("")}</div>`;
  return new Promise((resoudre) => {
    const fin = (valeur) => {
      d.removeEventListener("click", clic);
      d.removeEventListener("cancel", annule);
      if (d.open) d.close();
      resoudre(valeur);
    };
    const clic = (e) => {
      const b = e.target.closest("[data-reponse]");
      if (b) fin(b.dataset.reponse);
    };
    const annule = (e) => {
      e.preventDefault();
      fin(null);
    };
    d.addEventListener("click", clic);
    d.addEventListener("cancel", annule);
    d.showModal();
    d.querySelector("[data-reponse]")?.focus(); // le premier bouton (Annuler) : le choix sans risque
  });
}

async function confirmer({ titre, textes, ok = "Confirmer", danger = false }) {
  const r = await dialogue({
    titre,
    textes,
    boutons: [
      { texte: "Annuler", valeur: "non" },
      { texte: ok, valeur: "oui", classe: danger ? "btn-danger" : "btn-principal" },
    ],
  });
  return r === "oui";
}

function alerte(titre, texte) {
  return dialogue({ titre, textes: [texte], boutons: [{ texte: "OK", valeur: "ok", classe: "btn-principal" }] });
}

function signalerErreur(e) {
  const message = String(e?.message ?? e ?? "erreur inconnue").slice(0, 300);
  etat.erreurs.unshift({ quand: new Date().toLocaleString("fr-FR"), message });
  etat.erreurs.length = Math.min(etat.erreurs.length, 10);
  toast(`⚠️ Un problème est survenu : ${message}`, { erreur: true, duree: 8000 });
}

/* =====================================================================
   ACTIONS (un seul écouteur pour tous les boutons : data-action="…")
   ===================================================================== */

const ACTIONS = {
  onglet: (el) => {
    etat.ignorerClicsJusqua = 0; // un geste voulu : la protection anti double toucher s'arrête
    allerA(el.dataset.vue);
  },
  "nouvelle-saisie": () => {
    etat.ignorerClicsJusqua = 0;
    ouvrirSaisie();
  },
  fermer: () => fermer(),
  touche: (el) => toucher(el.dataset.touche),
  sens: (el) => changerSens(el.dataset.sens),
  date: (el) => choisirDate(el.dataset.date),
  details: () => basculerDetails(),
  categorie: (el) => toucherCategorie(el.dataset.id),
  enregistrer: () => enregistrerSaisie(),
  "enregistrer-nouvelle": () => enregistrerSaisie({ nouvelle: true }),
  "supprimer-op": () => supprimerSaisie(),
  "modifier-op": (el) => {
    const o = etat.operations.find((x) => x.id === el.dataset.id);
    if (o) return ouvrirSaisie({ edition: o });
  },
  "voir-mois": () => {
    etat.periodeOps = null;
    etat.filtres = { texte: "", compte: "", categorie: "" };
    allerA("operations");
  },
  "filtrer-compte": (el) => {
    etat.periodeOps = null;
    etat.filtres = { texte: "", compte: el.dataset.id, categorie: "" };
    allerA("operations");
  },
  "effacer-filtres": () => {
    etat.filtres = { texte: "", compte: "", categorie: "" };
    rendre();
  },
  "mois-prec": (el) => changerMois(el.dataset.cible, -1),
  "mois-suiv": (el) => changerMois(el.dataset.cible, 1),
  "mois-actuel": (el) => {
    etat[el.dataset.cible === "stats" ? "periodeStats" : "periodeOps"] = null;
    rendre();
  },
  "mettre-a-jour": () => mettreAJour(),
  "effacer-exemples": () => effacerExemples(),
  "sauvegarde-rapide": () => sauvegardeRapide(),
  "sauvegarder-fichier": () => sauvegarderFichier(),
  "partager-sauvegarde": () => partagerSauvegarde(),
  restaurer: () => choisirFichierRestauration(),
  "annuler-restauration": () => annulerRestauration(),
  "exporter-anonyme": () => exporterAnonyme(),
  "exporter-csv": () => exporterCSV(),
  theme: (el) => changerReglage({ theme: el.dataset.valeur }),
  taille: (el) => changerReglage({ taille_texte: Math.max(80, Math.min(150, etat.reglages.taille_texte + Number(el.dataset.pas))) }),
  installer: () => installer(),
  "modifier-compte": (el) => ouvrir({ type: "compte", id: el.dataset.id }),
  "ajouter-compte": () => ouvrir({ type: "compte", id: null }),
  "enregistrer-compte": () => enregistrerCompte(),
  "supprimer-compte": () => supprimerCompte(),
  "icone-compte": (el) => {
    etat.pile[etat.pile.length - 1].icone = el.dataset.icone;
    for (const b of document.querySelectorAll('[data-action="icone-compte"]')) b.setAttribute("aria-pressed", String(b === el));
  },
  signe: (el) => {
    const champ = $(`#${el.dataset.cible}`);
    const v = champ.value.trim();
    champ.value = v.startsWith("-") ? v.slice(1) : `-${v}`;
  },
  "gerer-categories": () => ouvrir({ type: "categories" }),
  "modifier-categorie": (el) => ouvrir({ type: "categorie", id: el.dataset.id }),
  "ajouter-categorie": (el) => ouvrir({ type: "categorie", id: null, sens: el.dataset.sens }),
  "enregistrer-categorie": () => enregistrerCategorie(),
  "supprimer-categorie": () => supprimerCategorie(),
  "icone-categorie": (el) => {
    $("#categorie-icone").value = el.dataset.icone;
  },
  "sens-categorie": (el) => {
    etat.pile[etat.pile.length - 1].sens = el.dataset.sens;
    for (const b of document.querySelectorAll('[data-action="sens-categorie"]')) b.setAttribute("aria-pressed", String(b === el));
  },
  "guide-suivant": () => guideAller(etat.guide.etape + 1),
  "guide-precedent": () => guideAller(etat.guide.etape - 1),
  "guide-terminer": () => terminerGuide(),
  "guide-exemples": () => essayerExemples(),
  "guide-date": (el) => {
    $("#guide-date").value = el.dataset.date;
    for (const b of document.querySelectorAll('[data-action="guide-date"]')) b.setAttribute("aria-pressed", String(b === el));
  },
};

function changerMois(cible, n) {
  const cle = cible === "stats" ? "periodeStats" : "periodeOps";
  etat[cle] = C.moisVoisin(etat[cle] ?? periodeCourante(), n, etat.reglages.jour_debut_mois);
  rendre();
}

// Champs de saisie : réagissent pendant la frappe (input) ou une fois le choix fait (change).
const SUR_INPUT = {
  "saisie-libelle": (el) => {
    etat.saisie.libelle = el.value;
    const puce = $(".puce-details");
    if (puce) puce.innerHTML = `✎${el.value.trim() ? ` <span class="puce-texte">${esc(el.value.trim())}</span>` : ""}`; // le libellé reste visible, détails repliés
  },
  "saisie-tiers": (el) => (etat.saisie.tiers = el.value),
  "saisie-note": (el) => (etat.saisie.note = el.value),
  "filtre-texte": (el) => {
    etat.filtres.texte = el.value;
    rendreListeOps();
  },
};

const SUR_CHANGE = {
  "saisie-date": (el) => choisirDate(el.value),
  "saisie-compte": (el) => {
    etat.saisie.compte = el.value;
    majAvertissementDepart();
  },
  "saisie-vers": (el) => {
    etat.saisie.vers = el.value;
    majAvertissementDepart();
  },
  "saisie-moyen": (el) => (etat.saisie.moyen = el.value),
  "filtre-compte": (el) => {
    etat.filtres.compte = el.value;
    rendreListeOps();
  },
  "filtre-categorie": (el) => {
    etat.filtres.categorie = el.value;
    rendreListeOps();
  },
  "reglage-mode-saisie": (el) => changerReglage({ mode_saisie: el.value }),
  "reglage-jour": (el) => changerReglage({ jour_debut_mois: el.value === "1" ? 1 : Number($('[data-champ="reglage-jour-paie"]').value) }),
  "reglage-jour-paie": (el) => changerReglage({ jour_debut_mois: Number(el.value) }),
  "reglage-rappel": (el) => changerReglage({ rappel_sauvegarde_jours: Number(el.value) }),
  "reglage-principal": (el) => changerReglage({ appareil_principal: el.checked }),
  "reglage-appareil": async (el) => {
    await changerMeta({ appareil: el.value.trim() });
    toast("Nom de l'appareil enregistré ✓");
  },
};

function installerEcouteurs() {
  document.addEventListener("click", (e) => {
    const date = e.target.closest?.('input[type="date"]');
    if (date && !pointeurTactile() && date.showPicker) {
      try {
        date.showPicker(); // sur PC, ouvre le calendrier même si on clique à côté de la petite icône
      } catch {
        /* déjà ouvert */
      }
    }
    const el = e.target.closest?.("[data-action]");
    if (!el || el.disabled) return;
    // Juste après un enregistrement, le contenu de l'écran (sous l'ancienne grille) ignore un toucher trop rapide :
    // le 2e toucher d'un double toucher n'ouvre rien par erreur. Les onglets et le bouton + restent actifs.
    if (performance.now() < etat.ignorerClicsJusqua && el.closest("#vue")) return;
    const f = ACTIONS[el.dataset.action];
    if (!f) return;
    // Une action est en cours (écriture, dialogue) : un 2e toucher ne la relance pas (sinon : 2 comptes, 2 retours arrière…).
    if (performance.now() < etat.occupeJusqua) return;
    try {
      const r = f(el, e); // appel direct (pas de « await » avant) : le partage de fichiers exige un geste récent
      if (r && typeof r.then === "function") {
        etat.occupeJusqua = performance.now() + 8000; // garde-fou : jamais bloqué plus de 8 s, même si une promesse ne répond pas
        r.catch(signalerErreur).finally(() => {
          etat.occupeJusqua = 0;
        });
      }
    } catch (err) {
      signalerErreur(err);
    }
  });
  document.addEventListener("input", (e) => {
    const f = SUR_INPUT[e.target.dataset?.champ];
    if (f) f(e.target);
  });
  document.addEventListener("change", (e) => {
    const f = SUR_CHANGE[e.target.dataset?.champ];
    if (f) Promise.resolve(f(e.target)).catch(signalerErreur);
  });
  $("#fichier-restaurer").addEventListener("change", (e) => {
    const f = e.target.files?.[0];
    if (f) restaurerDepuisFichier(f).catch(signalerErreur);
  });

  // Clavier (PC) : chiffres, virgule, effacement, Entrée, Échap.
  document.addEventListener("keydown", (e) => {
    if ($("#dialogue").open) return;
    const haut = etat.pile[etat.pile.length - 1];
    if (e.key === "Escape" && haut) {
      e.preventDefault();
      fermer();
      return;
    }
    if (!haut || haut.type !== "saisie" || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.target.matches?.("input, select, textarea")) return; // on tape un libellé : on laisse faire
    if (/^\d$/.test(e.key) || e.key === "," || e.key === "." || e.key === "Backspace") {
      e.preventDefault();
      toucher(e.key === "Backspace" ? "⌫" : e.key);
    } else if (e.key === "Enter" && !modeRapide()) {
      e.preventDefault();
      enregistrerSaisie();
    }
  });

  // Appui long sur ⌫ : tout effacer.
  let minuterieEffacer = null;
  document.addEventListener("pointerdown", (e) => {
    if (e.target.closest?.('[data-touche="⌫"]')) minuterieEffacer = setTimeout(() => toucher("C"), 550);
  });
  for (const fin of ["pointerup", "pointercancel", "pointerleave"]) document.addEventListener(fin, () => clearTimeout(minuterieEffacer));

  // Installation (Chrome, Edge — pas Safari) : on garde l'invitation pour notre bouton « Installer ».
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    etat.installation = e;
    if (etat.guide?.etape === 3) rendreCalque();
    else if (etat.vue === "reglages") rafraichirVue();
  });
  window.addEventListener("appinstalled", () => {
    etat.installation = null;
    toast("Appli installée ✓");
    if (etat.guide) rendreCalque();
    else rafraichirVue();
  });

  // La date du jour change à minuit, même si l'appli reste ouverte.
  // Au retour sur l'appli, on relit aussi la base : une autre fenêtre a pu y écrire (sauf pendant une saisie ou le guide).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    verifierDate();
    if (etat.meta && !etat.pile.length && !etat.guide) rechargerDepuisBase().catch(signalerErreur);
  });
  canal?.addEventListener("message", (e) => {
    if (e.data?.type === "donnees-changees") rechargerDepuisBase().catch(signalerErreur);
  });
  setInterval(verifierDate, 60_000);
  matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", appliquerAffichage);

  window.addEventListener("error", (e) => signalerErreur(e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => signalerErreur(e.reason));
}

async function installer() {
  const e = etat.installation;
  if (!e) return;
  e.prompt();
  await e.userChoice;
  etat.installation = null;
  if (etat.guide) rendreCalque();
  else rafraichirVue();
}

function verifierDate() {
  const d = C.dateDuJour();
  if (d === etat.aujourdhui) return;
  const avant = etat.aujourdhui;
  etat.aujourdhui = d;
  for (const cle of ["periodeOps", "periodeStats"]) {
    const p = etat[cle];
    if (p && p.debut <= avant && avant <= p.fin) etat[cle] = null; // on suivait le mois en cours : on le suit encore
  }
  rafraichirVue();
}

async function demanderPersistance() {
  etat.persistant = await S.demanderPersistance();
}

/* =====================================================================
   MISES À JOUR (service worker) — la nouvelle version ne s'active qu'à votre clic
   ===================================================================== */

async function enregistrerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  let reg;
  try {
    reg = await navigator.serviceWorker.register("sw.js");
  } catch {
    return; // sans service worker, l'appli marche quand même (mais pas hors ligne)
  }
  const surveiller = (w) => {
    if (!w) return;
    w.addEventListener("statechange", () => {
      if (w.state === "installed" && navigator.serviceWorker.controller) proposerMiseAJour(w);
    });
  };
  if (reg.waiting && navigator.serviceWorker.controller) proposerMiseAJour(reg.waiting);
  surveiller(reg.installing);
  reg.addEventListener("updatefound", () => surveiller(reg.installing));
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (etat.majDemandee) location.reload(); // seulement après votre clic sur « Mettre à jour »
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") reg.update().catch(() => {});
  });
}

function proposerMiseAJour(worker) {
  etat.majEnAttente = worker;
  rendreBandeaux();
}

function mettreAJour() {
  if (!etat.majEnAttente) return;
  etat.majDemandee = true;
  etat.majEnAttente.postMessage({ type: "MISE_A_JOUR" });
}

/* =====================================================================
   DÉMARRAGE
   ===================================================================== */

/** L'écran de secours : les données sont là, mais l'affichage a échoué. On permet au moins de les mettre à l'abri. */
function afficherSecours(e) {
  $("#calque").hidden = true;
  $("#appli").inert = false;
  document.body.classList.remove("calque-ouvert");
  $("#vue").innerHTML = `<div class="bloc vide"><strong>L'écran n'a pas pu s'afficher.</strong>${esc(e?.message ?? e)}<br />Vos données sont toujours sur l'appareil. Mettez-les à l'abri, puis rechargez la page.</div>
    <div class="champ"><button type="button" class="btn btn-principal btn-large" data-action="sauvegarder-fichier">💾 Sauvegarder mes données</button></div>`;
}

async function demarrer() {
  installerEcouteurs();
  try {
    await chargerDonnees();
  } catch (e) {
    $("#vue").innerHTML = `<div class="bloc vide"><strong>Impossible d'ouvrir vos données.</strong>${esc(e.message)}<br />Vérifiez que le navigateur n'est pas en navigation privée, puis rechargez la page.</div>`;
    return;
  }
  appliquerAffichage();
  const raccourci = new URLSearchParams(location.search).get("saisie"); // raccourcis de l'icône : « ➖ Dépense », « ➕ Entrée »
  history.replaceState({ onglet: "accueil", profondeur: 0 }, "", location.pathname);
  if (!etat.meta) etat.guide = nouveauGuide();
  try {
    rendreTout();
  } catch (e) {
    afficherSecours(e);
    enregistrerServiceWorker(); // une nouvelle version pourra quand même arriver et corriger le problème
    return;
  }
  if (etat.meta && (raccourci === "depense" || raccourci === "entree")) ouvrirSaisie({ sens: raccourci === "entree" ? "revenu" : "depense" });
  if (etat.meta) demanderPersistance();
  enregistrerServiceWorker();
}

demarrer();
