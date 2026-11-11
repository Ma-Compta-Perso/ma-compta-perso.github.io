# tests/test_appli.py — v1.00 — création : tests de l'appli VRAIE dans Chromium, avec Playwright.
#
# Lancement :  python3 tests/test_appli.py [--captures DOSSIER] [--zip ma-compta_vX_YY.zip]
#
# Ce qui est vérifié (protocole du projet) : parcours complet (guide, saisie rapide, annulation,
# modification, suppression), virements, mode « bouton », date du jour dans 2 fuseaux à 21 h et 0 h 30,
# hors ligne, mise à jour N → N+1 sans perte, sauvegarde → restauration identique, refus des sauvegardes
# invalides, CSV pour Excel, sauvegarde anonymisée, bouton « retour », raccourcis de l'icône,
# tailles d'écran (téléphone 412 et 360, PC demi-écran 728 à 125 %, plein écran 1536), texte 150 %,
# mode sombre, aucun défilement horizontal, aucune erreur de console, aucun appel réseau extérieur,
# et le même n° de version partout.
# Toutes les données sont FABRIQUÉES ici : jamais de vraies données.

import argparse
import datetime as dt
import functools
import http.server
import json
import mimetypes
import re
import shutil
import socketserver
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

RACINE = Path(__file__).resolve().parent.parent
mimetypes.add_type("application/manifest+json", ".webmanifest")
mimetypes.add_type("text/javascript", ".js")

TAILLES = {
    "telephone": dict(viewport={"width": 412, "height": 915}, device_scale_factor=2.625, is_mobile=True, has_touch=True),
    "petit-telephone": dict(viewport={"width": 360, "height": 740}, device_scale_factor=3, is_mobile=True, has_touch=True),
    # Le même, ouvert dans Chrome (barre d'adresse visible) : moins de hauteur. Le pavé doit rester entier.
    "petit-telephone-chrome": dict(viewport={"width": 360, "height": 620}, device_scale_factor=3, is_mobile=True, has_touch=True),
    "pc-demi-ecran": dict(viewport={"width": 728, "height": 720}, device_scale_factor=1.25),
    "pc-plein-ecran": dict(viewport={"width": 1536, "height": 740}, device_scale_factor=1.25),
}

LIRE_BASE = """async () => {
  const db = await new Promise((ok, ko) => { const r = indexedDB.open("ma-compta"); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
  const res = {};
  for (const t of ["comptes", "categories", "operations"]) {
    res[t] = await new Promise((ok) => { const r = db.transaction(t).objectStore(t).getAll(); r.onsuccess = () => ok(r.result); });
  }
  await new Promise((ok) => {
    const tx = db.transaction("parametres");
    const m = tx.objectStore("parametres").get("meta");
    const g = tx.objectStore("parametres").get("reglages");
    tx.oncomplete = () => { res.meta = m.result; res.reglages = g.result; ok(); };
  });
  db.close();
  return res;
}"""


class Silencieux(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")  # comme un vrai serveur qui sert la dernière version
        super().end_headers()


class Serveur:
    """Petit serveur local (python -m http.server) qui sert un dossier."""

    def __init__(self, dossier):
        socketserver.ThreadingTCPServer.allow_reuse_address = True
        self.srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), functools.partial(Silencieux, directory=str(dossier)))
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}/"

    def arreter(self):
        self.srv.shutdown()
        self.srv.server_close()


class Session:
    """Un navigateur « propre » (stockage vide) + la surveillance des erreurs et du réseau."""

    def __init__(self, navigateur, serveur, taille="telephone", fuseau="America/Guadeloupe", sombre=False, heure=None):
        self.serveur = serveur
        self.ctx = navigateur.new_context(
            locale="fr-FR", timezone_id=fuseau, color_scheme="dark" if sombre else "light", accept_downloads=True, **TAILLES[taille]
        )
        self.problemes = []
        self.ctx.on("request", self._requete)
        self.page = self._surveiller(self.ctx.new_page())
        if heure is not None:
            self.page.clock.set_fixed_time(heure)

    def _surveiller(self, page):
        page.on("console", lambda m: self.problemes.append(f"console {m.type} : {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: self.problemes.append(f"erreur JavaScript : {e}"))
        return page

    def nouvelle_page(self, chemin=""):
        """Une 2e fenêtre de l'appli, dans le MÊME navigateur (même base) : comme l'appli installée + un onglet Chrome."""
        p = self._surveiller(self.ctx.new_page())
        p.goto(self.serveur.url + chemin)
        return p

    def _requete(self, req):
        if not (req.url.startswith(self.serveur.url) or req.url.startswith("blob:") or req.url.startswith("data:")):
            self.problemes.append(f"appel réseau EXTÉRIEUR : {req.url}")

    def ouvrir(self, chemin=""):
        self.page.goto(self.serveur.url + chemin)
        return self.page

    def fermer(self):
        self.ctx.close()
        if self.problemes:
            raise AssertionError("Problèmes relevés :\n  " + "\n  ".join(self.problemes))

    def base(self):
        return self.page.evaluate(LIRE_BASE)


# ----------------------------------------------------------------- gestes

def guide(page, solde="1234,56", nom="Compte perso"):
    page.wait_for_selector(".guide-titre")
    page.click("text=Commencer")
    page.fill("#guide-nom", nom)
    page.fill("#guide-solde", solde)
    page.click("text=Suivant")
    page.click("text=Suivant")
    page.click("text=Terminer")
    page.wait_for_selector(".solde-chiffre")


def exemples(page):
    page.wait_for_selector(".guide-titre")
    page.click("text=Essayer avec des exemples")
    page.wait_for_selector(".solde-chiffre")


def taper(page, montant):
    for t in montant:
        page.click(f'.touche[data-touche="{t}"]')


def saisir(page, montant, categorie, sens="depense", date=None):
    page.click(".onglet-plus")
    page.wait_for_selector(".pave")
    if sens != "depense":
        page.click(f'.segments [data-sens="{sens}"]')
    if date:
        page.click(f'[data-action="date"][data-date="{date}"]')
    taper(page, montant)
    page.click(f'.tuile[data-id="{categorie}"]')
    page.wait_for_selector(".saisie", state="detached")


def onglet(page, vue):
    page.click(f'.onglet[data-vue="{vue}"]')
    expect(page.locator(f'.onglet[data-vue="{vue}"]')).to_have_attribute("aria-current", "page")


def attendre(page, js, delai=15):
    """Attend qu'une condition (fonction JS) soit vraie, en l'interrogeant depuis Python.
    Pourquoi pas wait_for_function : la page interdit eval (règle de sécurité CSP), ce qui le fait échouer s'il doit patienter."""
    fin = time.time() + delai
    while time.time() < fin:
        if page.evaluate(js):
            return
        page.wait_for_timeout(100)
    raise AssertionError(f"condition jamais remplie en {delai} s : {js}")


def texte(page, selecteur):
    return page.inner_text(selecteur).replace(" ", " ").replace(" ", " ")


def sans_debordement(page, ou):
    largeur = page.evaluate("[document.documentElement.scrollWidth, window.innerWidth]")
    assert largeur[0] <= largeur[1], f"défilement horizontal ({ou}) : {largeur[0]} px pour {largeur[1]} px"
    # Un élément qui dépasse mais qui est coupé proprement par son parent (texte « … ») n'est pas un débordement.
    trop_larges = page.evaluate(
        """() => [...document.querySelectorAll('body *')].filter(e => {
            const r = e.getBoundingClientRect();
            if (!(r.width > 0 && (r.right > innerWidth + 1 || r.left < -1))) return false;
            if (getComputedStyle(e).position === 'fixed' || e.closest('.invisible')) return false;
            for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
              const ox = getComputedStyle(p).overflowX;
              if (ox !== 'visible') { const q = p.getBoundingClientRect(); if (q.right <= innerWidth + 1 && q.left >= -1) return false; }
            }
            return true;
          }).slice(0, 5).map(e => (e.className || e.tagName) + ' « ' + (e.textContent || '').trim().slice(0, 30) + ' »')"""
    )
    assert not trop_larges, f"élément qui sort de l'écran ({ou}) : {trop_larges}"


def date_locale(page):
    return page.evaluate("(() => { const d = new Date(); return [d.getFullYear(), d.getMonth() + 1, d.getDate()].map((x, i) => String(x).padStart(i ? 2 : 4, '0')).join('-'); })()")


def decaler(date, jours):
    return (dt.date.fromisoformat(date) + dt.timedelta(days=jours)).isoformat()


# ----------------------------------------------------------------- tests

def test_parcours_complet(nav, srv):
    s = Session(nav, srv)
    page = s.ouvrir()
    guide(page)
    assert texte(page, ".solde-chiffre") == "1 234,56 €"
    aujourdhui = date_locale(page)

    # Saisie rapide (mode B) : montant puis catégorie = enregistré.
    saisir(page, "12,50", "def-courses")
    expect(page.locator(".solde-chiffre")).to_have_text(re.compile("1.222,06.€"))
    ops = [o for o in s.base()["operations"] if not o["supprime"]]
    assert len(ops) == 1 and ops[0]["montant"] == -1250 and ops[0]["date"] == aujourdhui, ops
    assert isinstance(ops[0]["montant"], int)

    # ↶ Annuler juste après.
    page.click("#toast button")
    expect(page.locator(".solde-chiffre")).to_have_text(re.compile("1.234,56.€"))
    assert all(o["supprime"] for o in s.base()["operations"])

    # Dépense, entrée, dépense d'hier.
    saisir(page, "12,50", "def-courses")
    saisir(page, "1500", "def-salaire", sens="revenu")
    saisir(page, "3,2", "def-courses", date=decaler(aujourdhui, -1))
    addition = texte(page, ".addition")
    assert "+1 500,00 €" in addition and "−15,70 €" in addition and "+1 484,30 €" in addition, addition
    hier = [o for o in s.base()["operations"] if not o["supprime"] and o["montant"] == -320]
    assert hier and hier[0]["date"] == decaler(aujourdhui, -1), hier

    # Modifier une opération (12,50 → 15) depuis la liste.
    onglet(page, "operations")
    page.click('.ligne-op:has-text("12,50")')
    page.wait_for_selector(".pave")
    for _ in range(5):
        page.click('.touche[data-touche="⌫"]')
    taper(page, "15")
    page.click('[data-action="enregistrer"]')
    page.wait_for_selector(".saisie", state="detached")
    montants = sorted(o["montant"] for o in s.base()["operations"] if not o["supprime"])
    assert montants == [-1500, -320, 150000], montants

    # Supprimer, puis ↶ Annuler.
    page.click('.ligne-op:has-text("15,00")')
    page.click('[data-action="supprimer-op"]')
    page.wait_for_selector(".saisie", state="detached")
    assert sorted(o["montant"] for o in s.base()["operations"] if not o["supprime"]) == [-320, 150000]
    page.click("#toast button")
    page.wait_for_timeout(300)
    assert sorted(o["montant"] for o in s.base()["operations"] if not o["supprime"]) == [-1500, -320, 150000]

    # Double toucher sur une catégorie : UNE seule opération, et rien ne s'ouvre dessous.
    page.click(".onglet-plus")
    taper(page, "9")
    page.dblclick('.tuile[data-id="def-courses"]')
    page.wait_for_selector(".saisie", state="detached")
    page.mouse.click(200, 300)  # un 2e toucher un peu plus lent, là où était la grille
    assert page.locator(".saisie").count() == 0
    neuf = [o for o in s.base()["operations"] if o["montant"] == -900 and not o["supprime"]]
    assert len(neuf) == 1, f"double toucher : {len(neuf)} opérations enregistrées"
    page.click("#toast button")  # on annule ce test
    page.wait_for_timeout(300)

    # Un gros montant tient dans l'écran (il rétrécit au lieu d'être coupé).
    page.click(".onglet-plus")
    taper(page, "1234567,89")
    largeur = page.evaluate("(() => { const z = document.querySelector('#saisie-montant'); return [z.scrollWidth, z.clientWidth]; })()")
    assert largeur[0] <= largeur[1], f"gros montant coupé : {largeur}"
    page.keyboard.press("Escape")
    page.wait_for_selector(".saisie", state="detached")

    # Recherche dans le mois.
    page.fill('[data-champ="filtre-texte"]', "salaire")
    assert page.locator(".ligne-op").count() == 1
    page.fill('[data-champ="filtre-texte"]', "")

    # Les données restent après rechargement.
    # Solde = 1234,56 − 15 + 1500 : la dépense d'HIER est d'avant la date de départ du compte (aujourd'hui),
    # elle est donc déjà comprise dans le solde de départ (règle de calcul) — et l'écran le signale.
    page.reload()
    page.wait_for_selector(".solde-chiffre")
    assert texte(page, ".solde-chiffre") == "2 719,56 €", texte(page, ".solde-chiffre")
    onglet(page, "operations")
    assert "avant le départ" in texte(page, ".ligne-op:has-text('3,20')")
    s.fermer()


def test_virement(nav, srv):
    s = Session(nav, srv)
    page = s.ouvrir()
    guide(page, solde="1000")
    onglet(page, "reglages")
    page.click('[data-action="ajouter-compte"]')
    page.fill("#compte-nom", "Livret A")
    page.select_option("#compte-type", "livret")
    page.fill("#compte-solde", "500")
    page.click('[data-action="enregistrer-compte"]')
    page.wait_for_selector(".ecran", state="detached")
    page.click(".onglet-plus")
    page.click('.segments [data-sens="virement"]')
    taper(page, "100")
    page.click('[data-action="enregistrer"]')
    page.wait_for_selector(".saisie", state="detached")
    base = s.base()
    virements = [o for o in base["operations"] if o["lien_virement"]]
    assert len(virements) == 2 and sum(o["montant"] for o in virements) == 0, virements
    onglet(page, "accueil")
    accueil = texte(page, "#vue")
    assert "1 500,00 €" in accueil, "le total doit rester 1 500 €"
    assert "900,00 €" in accueil and "600,00 €" in accueil, accueil
    assert "Sorties\n0,00 €" in texte(page, ".addition"), "un virement n'est pas une sortie"
    onglet(page, "operations")
    assert page.locator(".ligne-op").count() == 1, "un virement = une seule ligne"
    assert "Compte perso → Livret A" in texte(page, ".ligne-op")
    s.fermer()


def test_mode_bouton(nav, srv):
    s = Session(nav, srv)
    page = s.ouvrir()
    guide(page)
    onglet(page, "reglages")
    page.check('input[value="bouton"]')
    page.wait_for_timeout(200)
    page.click(".onglet-plus")
    taper(page, "8")
    page.click('.tuile[data-id="def-restaurants"]')
    assert page.locator(".saisie").count() == 1, "en mode bouton, toucher la catégorie n'enregistre pas"
    assert not [o for o in s.base()["operations"]]
    page.click('[data-action="enregistrer-nouvelle"]')
    page.wait_for_timeout(300)
    assert page.locator(".saisie").count() == 1, "« Enregistrer + nouvelle » garde l'écran ouvert"
    assert texte(page, "#saisie-montant").startswith("0,00")
    taper(page, "2")
    page.click('.tuile[data-id="def-courses"]')
    page.click('[data-action="enregistrer"]')
    page.wait_for_selector(".saisie", state="detached")
    assert sorted(o["montant"] for o in s.base()["operations"]) == [-800, -200]
    s.fermer()


def test_fuseaux_et_minuit(nav, srv):
    # 29/10/2026 à 21 h et 30/10/2026 à 0 h 30, en heure de l'appareil : la date du jour ne doit pas sauter.
    cas = [
        ("America/Guadeloupe", dt.datetime(2026, 10, 30, 1, 0, tzinfo=dt.timezone.utc), "2026-10-29"),
        ("America/Guadeloupe", dt.datetime(2026, 10, 30, 4, 30, tzinfo=dt.timezone.utc), "2026-10-30"),
        ("Europe/Paris", dt.datetime(2026, 10, 29, 20, 0, tzinfo=dt.timezone.utc), "2026-10-29"),
        ("Europe/Paris", dt.datetime(2026, 10, 29, 23, 30, tzinfo=dt.timezone.utc), "2026-10-30"),
    ]
    for fuseau, instant, attendu in cas:
        s = Session(nav, srv, fuseau=fuseau, heure=instant)
        page = s.ouvrir()
        guide(page)
        saisir(page, "5", "def-courses")
        base = s.base()
        assert base["comptes"][0]["date_depart"] == attendu, (fuseau, instant, base["comptes"][0]["date_depart"])
        assert base["operations"][0]["date"] == attendu, (fuseau, instant, base["operations"][0]["date"])
        onglet(page, "operations")
        assert texte(page, ".jour-entete h2") == "Aujourd'hui", (fuseau, instant)
        s.fermer()


def test_hors_ligne(nav, srv):
    s = Session(nav, srv)
    page = s.ouvrir()
    guide(page)
    attendre(page, "() => navigator.serviceWorker.controller !== null")
    s.ctx.set_offline(True)
    page.reload()
    page.wait_for_selector(".solde-chiffre")
    saisir(page, "4,5", "def-courses")
    assert [o["montant"] for o in s.base()["operations"]] == [-450]
    s.ctx.set_offline(False)
    s.fermer()


def test_mise_a_jour(nav, _srv):
    dossier = Path(tempfile.mkdtemp(prefix="maj-"))
    copie = dossier / "appli"
    shutil.copytree(RACINE, copie, ignore=shutil.ignore_patterns("tests", "__pycache__"))
    srv = Serveur(copie)
    try:
        s = Session(nav, srv)
        page = s.ouvrir()
        guide(page)
        saisir(page, "7", "def-courses")
        attendre(page, "() => navigator.serviceWorker.controller !== null")
        version = re.search(r'const VERSION = "([\d.]+)"', (copie / "app.js").read_text()).group(1)
        suivante = f"{version}-test"
        for nom, motif, remplace in [("app.js", f'const VERSION = "{version}"', f'const VERSION = "{suivante}"'), ("sw.js", f'"ma-compta-v{version}"', f'"ma-compta-v{suivante}"')]:
            f = copie / nom
            contenu = f.read_text()
            assert motif in contenu, f"{motif} introuvable dans {nom}"
            f.write_text(contenu.replace(motif, remplace))
        page.evaluate("navigator.serviceWorker.getRegistration().then(r => r.update())")
        page.wait_for_selector('[data-action="mettre-a-jour"]', timeout=15000)
        assert page.locator(".saisie").count() == 0
        with page.expect_event("load", timeout=15000):
            page.click('[data-action="mettre-a-jour"]')
        page.wait_for_selector(".solde-chiffre")
        onglet(page, "reglages")
        assert f"version {suivante}" in texte(page, ".a-propos"), texte(page, ".a-propos")
        assert [o["montant"] for o in s.base()["operations"]] == [-700], "données perdues à la mise à jour"
        s.fermer()
    finally:
        srv.arreter()
        shutil.rmtree(dossier, ignore_errors=True)


def test_sauvegarde_restauration(nav, srv, travail):
    s = Session(nav, srv, taille="pc-demi-ecran")
    page = s.ouvrir()
    exemples(page)
    avant = s.base()
    solde = texte(page, ".solde-chiffre")
    onglet(page, "reglages")
    with page.expect_download() as d:
        page.click('[data-action="sauvegarder-fichier"]')
    fichier = travail / d.value.suggested_filename
    d.value.save_as(fichier)
    assert re.fullmatch(r"ma-compta_sauvegarde_\d{4}-\d{2}-\d{2}\.json", fichier.name), fichier.name
    sauvegarde = json.loads(fichier.read_text(encoding="utf-8"))
    assert sauvegarde["format"] == "ma-compta" and sauvegarde["schema"] == 1
    assert len(sauvegarde["operations"]) == len(avant["operations"])
    assert s.base()["meta"]["derniere_sauvegarde"], "la date de dernière sauvegarde doit être notée"

    # Anonymisée : plus aucun libellé d'origine.
    with page.expect_download() as d:
        page.click('[data-action="exporter-anonyme"]')
    anonyme = travail / d.value.suggested_filename
    d.value.save_as(anonyme)
    contenu = anonyme.read_text(encoding="utf-8")
    for secret in ["Supermarché", "Loyer", "Compte courant", "Livret A"]:
        assert secret not in contenu, f"« {secret} » visible dans la sauvegarde anonymisée"
    s.fermer()

    # Restauration sur un appareil « neuf » : identique.
    s2 = Session(nav, srv, taille="pc-demi-ecran")
    page = s2.ouvrir()
    page.wait_for_selector(".guide-titre")
    with page.expect_file_chooser() as fc:
        page.click("text=J'ai une sauvegarde")
    fc.value.set_files(str(fichier))
    page.click('#dialogue [data-reponse="oui"]')
    page.wait_for_selector(".solde-chiffre")
    assert texte(page, ".solde-chiffre") == solde
    apres = s2.base()
    for t in ["comptes", "categories", "operations"]:
        cle = lambda x: x["id"]
        assert sorted(apres[t], key=cle) == sorted(avant[t], key=cle), f"table {t} différente après restauration"

    # Refus clairs : format plus récent, fichier étranger.
    onglet(page, "reglages")
    futur = travail / "futur.json"
    futur.write_text(json.dumps({**sauvegarde, "schema": 99}), encoding="utf-8")
    with page.expect_file_chooser() as fc:
        page.click('[data-action="restaurer"]')
    fc.value.set_files(str(futur))
    expect(page.locator("#dialogue")).to_contain_text("version plus récente")
    page.click('#dialogue [data-reponse="ok"]')
    etranger = travail / "etranger.json"
    etranger.write_text('{"bonjour": 1}', encoding="utf-8")
    with page.expect_file_chooser() as fc:
        page.click('[data-action="restaurer"]')
    fc.value.set_files(str(etranger))
    expect(page.locator("#dialogue")).to_contain_text("n'est pas une sauvegarde")
    page.click('#dialogue [data-reponse="ok"]')

    # Restaurer l'anonymisée : avertissement, puis « revenir à l'état d'avant » remet tout.
    with page.expect_file_chooser() as fc:
        page.click('[data-action="restaurer"]')
    fc.value.set_files(str(anonyme))
    expect(page.locator("#dialogue")).to_contain_text("ANONYMISÉE")
    page.click('#dialogue [data-reponse="oui"]')
    page.wait_for_selector(".solde-chiffre")
    assert all(c["nom"].startswith("Compte ") for c in s2.base()["comptes"])
    onglet(page, "reglages")
    page.click('[data-action="annuler-restauration"]')
    page.click('#dialogue [data-reponse="oui"]')
    page.wait_for_selector(".solde-chiffre")
    assert sorted(c["nom"] for c in s2.base()["comptes"]) == ["Compte courant", "Livret A"]
    s2.fermer()


def test_csv(nav, srv, travail):
    s = Session(nav, srv, taille="pc-demi-ecran")
    page = s.ouvrir()
    guide(page)
    page.click(".onglet-plus")
    page.keyboard.type("1234,56")  # au clavier du PC
    page.click('[data-action="details"]')
    page.fill('[data-champ="saisie-libelle"]', '=1+1 "test"; ok')
    page.click('.tuile[data-id="def-logement"]')
    page.wait_for_selector(".saisie", state="detached")
    onglet(page, "reglages")
    with page.expect_download() as d:
        page.click('[data-action="exporter-csv"]')
    brut = d.value.path().read_bytes()
    assert brut.startswith(b"\xef\xbb\xbf"), "BOM UTF-8 absent"
    lignes = brut[3:].decode("utf-8").split("\r\n")
    assert lignes[0] == "Date;Compte;Type;Catégorie;Libellé;Tiers;Moyen;Montant;Note;Pointée", lignes[0]
    champs = lignes[1].split(";")
    assert re.fullmatch(r"\d{2}/\d{2}/\d{4}", champs[0]), champs[0]
    assert lignes[1].endswith(";-1234,56;;"), lignes[1]
    assert "\"'=1+1 \"\"test\"\"; ok\"" in lignes[1], lignes[1]
    assert lignes[-1] == "", "le fichier doit finir par un retour à la ligne CRLF"
    s.fermer()


def test_retour_et_raccourcis(nav, srv):
    s = Session(nav, srv)
    page = s.ouvrir()
    guide(page)
    page.click(".onglet-plus")
    page.wait_for_selector(".pave")
    page.go_back()  # le bouton « retour » d'Android
    page.wait_for_selector(".saisie", state="detached")
    assert page.locator(".solde-chiffre").count() == 1, "le retour doit fermer la saisie, pas quitter l'appli"
    onglet(page, "operations")
    page.go_back()
    expect(page.locator('.onglet[data-vue="accueil"]')).to_have_attribute("aria-current", "page")
    s.ouvrir("?saisie=entree")  # raccourci « ➕ Entrée » de l'icône
    page.wait_for_selector(".pave")
    assert page.get_attribute('.segments [data-sens="revenu"]', "aria-pressed") == "true"
    assert "saisie" not in page.url, "l'adresse doit être nettoyée"
    s.fermer()


def telecharger_sauvegarde(page):
    """Touche « Sauvegarder dans un fichier » (Réglages) et renvoie le contenu de la sauvegarde."""
    onglet(page, "reglages")
    with page.expect_download() as d:
        page.click('[data-action="sauvegarder-fichier"]')
    return json.loads(d.value.path().read_text(encoding="utf-8"))


def restaurer_au_guide(page, fichier, attendu=None):
    """Depuis le guide d'un appareil neuf : « J'ai une sauvegarde » → fichier → (texte attendu dans la confirmation) → Restaurer."""
    page.wait_for_selector(".guide-titre")
    with page.expect_file_chooser() as fc:
        page.click("text=J'ai une sauvegarde")
    fc.value.set_files(str(fichier))
    if attendu:
        expect(page.locator("#dialogue")).to_contain_text(attendu)
    page.click('#dialogue [data-reponse="oui"]')
    page.wait_for_selector(".solde-chiffre")


def test_annuler_sans_piege(nav, srv):
    """Relecture n°1 : le « ↶ Annuler » ne se retrouve jamais sous le doigt par erreur."""
    s = Session(nav, srv)
    page = s.ouvrir()
    guide(page)
    saisir(page, "12,50", "def-courses")
    expect(page.locator("#toast")).to_be_visible()
    page.click(".onglet-plus")  # on enchaîne aussitôt une autre saisie…
    page.wait_for_selector(".pave")
    assert page.locator("#toast").is_hidden(), "le « ↶ Annuler » doit disparaître quand un nouvel écran s'ouvre"
    page.click('.segments [data-sens="revenu"]')  # … et on touche « Entrée », là où le message aurait pu être
    assert page.get_attribute('.segments [data-sens="revenu"]', "aria-pressed") == "true"
    assert len([o for o in s.base()["operations"] if not o["supprime"]]) == 1, "la dépense a été annulée par erreur"
    page.keyboard.press("Escape")
    page.wait_for_selector(".saisie", state="detached")

    # Mode « bouton » : après « Enregistrer + nouvelle », le message se pose SUR le montant, jamais sur un bouton.
    onglet(page, "reglages")
    page.check('input[value="bouton"]')
    page.wait_for_timeout(200)
    page.click(".onglet-plus")
    taper(page, "8")
    page.click('.tuile[data-id="def-restaurants"]')
    page.click('[data-action="enregistrer-nouvelle"]')
    statut = page.locator("#saisie-statut")
    expect(statut).to_be_visible()
    expect(statut).to_contain_text("Annuler")
    boite = statut.bounding_box()
    zone = page.locator(".saisie-montant-zone").bounding_box()
    assert boite["y"] >= zone["y"] - 1 and boite["y"] + boite["height"] <= zone["y"] + zone["height"] + 1, "le message déborde de la zone du montant"
    for b in page.locator(".saisie button").all():
        r = b.bounding_box()
        if not r or b.evaluate("e => e.closest('#saisie-statut') !== null"):
            continue
        dessus = not (r["y"] >= boite["y"] + boite["height"] or r["y"] + r["height"] <= boite["y"] or r["x"] >= boite["x"] + boite["width"] or r["x"] + r["width"] <= boite["x"])
        assert not dessus, f"le message recouvre le bouton « {b.inner_text()} »"
    statut.locator("button").click()  # ↶ Annuler
    expect(statut).to_contain_text("annulée")
    assert [o["montant"] for o in s.base()["operations"] if not o["supprime"]] == [-1250]
    taper(page, "3")  # on tape : le message s'efface, le montant se voit
    expect(statut).to_be_hidden()
    s.fermer()


def test_double_toucher(nav, srv):
    """Relecture n°3 : un double toucher n'enregistre jamais deux fois, et ne fait pas sortir de l'appli."""
    s = Session(nav, srv)
    page = s.ouvrir()
    page.wait_for_selector(".guide-titre")
    page.click("text=Commencer")
    page.fill("#guide-solde", "100")
    page.click("text=Suivant")
    page.click("text=Suivant")
    page.dblclick("text=Terminer")
    page.wait_for_selector(".solde-chiffre")
    page.wait_for_timeout(300)
    assert len(s.base()["comptes"]) == 1, "double toucher sur « Terminer » : 2 comptes créés"
    onglet(page, "reglages")
    page.click('[data-action="ajouter-compte"]')
    page.fill("#compte-nom", "Livret A")
    page.dblclick('[data-action="enregistrer-compte"]')
    page.wait_for_timeout(500)
    assert sorted(c["nom"] for c in s.base()["comptes"]) == ["Compte courant", "Livret A"], "double toucher sur « Enregistrer » : compte en double"
    assert page.url.startswith(srv.url), "le double toucher a fait sortir de l'appli"
    expect(page.locator('.onglet[data-vue="reglages"]')).to_have_attribute("aria-current", "page")
    s.fermer()


def test_exemple_restaure_par_erreur(nav, srv, travail):
    """Relecture n°2 : vraies données remplacées par une sauvegarde d'EXEMPLE, puis « Effacer et commencer » :
    la copie de sécurité survit, et le guide propose d'y revenir."""
    ex = Session(nav, srv, taille="pc-demi-ecran")
    page = ex.ouvrir()
    exemples(page)
    fichier = travail / "exemple.json"
    fichier.write_text(json.dumps(telecharger_sauvegarde(page)), encoding="utf-8")
    ex.fermer()

    s = Session(nav, srv, taille="pc-demi-ecran")
    page = s.ouvrir()
    guide(page, solde="1000", nom="Mon vrai compte")
    saisir(page, "5", "def-courses")
    onglet(page, "reglages")
    with page.expect_file_chooser() as fc:
        page.click('[data-action="restaurer"]')
    fc.value.set_files(str(fichier))
    expect(page.locator("#dialogue")).to_contain_text("EXEMPLE")  # l'avertissement
    page.click('#dialogue [data-reponse="oui"]')
    page.click('[data-action="effacer-exemples"]')
    page.click('#dialogue [data-reponse="oui"]')
    page.wait_for_selector(".guide-titre")
    page.click('[data-action="annuler-restauration"]')  # 🛟 proposé dès le guide
    page.click('#dialogue [data-reponse="oui"]')
    page.wait_for_selector(".solde-chiffre")
    base = s.base()
    assert [c["nom"] for c in base["comptes"]] == ["Mon vrai compte"], base["comptes"]
    assert [o["montant"] for o in base["operations"] if not o["supprime"]] == [-500]
    assert texte(page, ".solde-chiffre") == "995,00 €", texte(page, ".solde-chiffre")
    s.fermer()


def test_effacer_previent(nav, srv):
    """« Effacer et commencer » prévient si des opérations ont été notées pour de vrai par-dessus les exemples."""
    s = Session(nav, srv)
    page = s.ouvrir()
    exemples(page)
    saisir(page, "7", "def-courses")
    page.click('[data-action="effacer-exemples"]')
    expect(page.locator("#dialogue")).to_contain_text("1 opération que vous avez notée vous-même sera effacée")
    page.click('#dialogue [data-reponse="non"]')
    assert any(o["montant"] == -700 and not o["supprime"] for o in s.base()["operations"])
    s.fermer()


def test_reglages_abimes(nav, srv, travail):
    """Relecture n°4 : une sauvegarde aux réglages abîmés ne bloque jamais l'appli."""
    s = Session(nav, srv, taille="pc-demi-ecran")
    page = s.ouvrir()
    exemples(page)
    sauvegarde = telecharger_sauvegarde(page)
    s.fermer()
    sauvegarde["reglages"] = {"jour_debut_mois": None, "theme": "violet", "taille_texte": 999, "mode_saisie": 3}
    abimee = travail / "reglages_abimes.json"
    abimee.write_text(json.dumps(sauvegarde), encoding="utf-8")
    s2 = Session(nav, srv, taille="pc-demi-ecran")
    page = s2.ouvrir()
    restaurer_au_guide(page, abimee)
    page.reload()
    page.wait_for_selector(".solde-chiffre")  # pas bloquée sur « Chargement… »
    r = s2.base()["reglages"]
    assert (r["jour_debut_mois"], r["mode_saisie"], r["theme"], r["taille_texte"]) == (1, "rapide", "auto", 100), r
    s2.fermer()


def test_copie_securite_atomique(nav, srv):
    """Relecture n°5 : si le remplacement échoue, l'ancienne copie de sécurité n'est pas écrasée, les données non plus."""
    s = Session(nav, srv)
    page = s.ouvrir()
    guide(page)
    saisir(page, "5", "def-courses")
    r = page.evaluate(
        """async () => {
      const S = await import("./stockage.js");
      await S.ecrireCopieSecurite("avant-restauration", { marque: "ancienne" });
      let echec = false;
      try {
        // une opération SANS identifiant : la base la refuse, toute l'opération doit être annulée
        await S.remplacerTout({ comptes: [], categories: [], operations: [{ sans_id: true }], recurrences: [], budgets: [], regles: [], reglages: {} }, {}, { cle: "avant-restauration", contenu: { marque: "nouvelle" } });
      } catch { echec = true; }
      const copie = await S.lireCopieSecurite("avant-restauration");
      return { echec, marque: copie && copie.contenu.marque };
    }"""
    )
    assert r == {"echec": True, "marque": "ancienne"}, r
    assert [o["montant"] for o in s.base()["operations"]] == [-500], "les données ont changé malgré l'échec"
    s.fermer()


def test_deux_fenetres(nav, srv):
    """Relecture n°6 : l'appli ouverte deux fois (appli installée + onglet) : chaque fenêtre voit ce que l'autre écrit."""
    s = Session(nav, srv)
    a = s.ouvrir()
    b = s.nouvelle_page()
    b.wait_for_selector(".guide-titre")
    guide(a, solde="100")
    b.wait_for_selector(".solde-chiffre")  # B quitte son guide toute seule
    saisir(a, "5", "def-courses")
    expect(b.locator(".solde-chiffre")).to_have_text(re.compile("95,00"))  # B voit la dépense sans recharger
    assert [o["montant"] for o in telecharger_sauvegarde(b)["operations"]] == [-500], "la sauvegarde faite depuis B a oublié la dépense"
    # Modifier dans B une opération supprimée entre-temps dans A : refus clair, rien n'est ressuscité.
    onglet(b, "operations")
    b.click(".ligne-op")
    b.wait_for_selector(".pave")
    onglet(a, "operations")
    a.click(".ligne-op")
    a.click('[data-action="supprimer-op"]')
    a.wait_for_selector(".saisie", state="detached")
    b.wait_for_timeout(400)
    b.click('[data-action="enregistrer"]')
    expect(b.locator("#toast")).to_contain_text("supprimée entre-temps")
    assert all(o["supprime"] for o in s.base()["operations"]), "l'opération supprimée a été ressuscitée"
    s.fermer()


def test_virement_incomplet(nav, srv, travail):
    """Relecture n°7 : un virement à moitié (sauvegarde abîmée) est signalé, puis supprimable."""
    s = Session(nav, srv, taille="pc-demi-ecran")
    page = s.ouvrir()
    exemples(page)
    sauvegarde = telecharger_sauvegarde(page)
    s.fermer()
    jambe = [o for o in sauvegarde["operations"] if o["lien_virement"] and o["montant"] > 0][-1]
    sauvegarde["operations"].remove(jambe)  # il ne reste que le départ du virement
    abimee = travail / "virement_abime.json"
    abimee.write_text(json.dumps(sauvegarde), encoding="utf-8")
    s2 = Session(nav, srv, taille="pc-demi-ecran")
    page = s2.ouvrir()
    restaurer_au_guide(page, abimee, attendu="incomplet")
    onglet(page, "operations")
    auj = date_locale(page)
    ecart = (int(auj[:4]) - int(jambe["date"][:4])) * 12 + int(auj[5:7]) - int(jambe["date"][5:7])
    for _ in range(ecart):
        page.click('[data-action="mois-prec"][data-cible="ops"]')
    page.click('.ligne-op:has-text("→")')
    expect(page.locator("#dialogue")).to_contain_text("Virement incomplet")
    page.click('#dialogue [data-reponse="oui"]')
    expect(page.locator("#toast")).to_contain_text("supprimé")
    restes = [o for o in s2.base()["operations"] if o["lien_virement"] == jambe["lien_virement"]]
    assert len(restes) == 1 and restes[0]["supprime"], restes
    s2.fermer()


def test_installable(nav, srv):
    """On demande à Chrome lui-même (son protocole de débogage) si l'appli est installable."""
    s = Session(nav, srv)
    page = s.ouvrir()
    guide(page)
    attendre(page, "() => navigator.serviceWorker.controller !== null")
    cdp = s.ctx.new_cdp_session(page)
    erreurs = cdp.send("Page.getInstallabilityErrors")["installabilityErrors"]
    assert not erreurs, f"Chrome refuse l'installation : {erreurs}"
    manifeste = cdp.send("Page.getAppManifest")
    assert not manifeste.get("errors"), f"erreurs dans le manifeste : {manifeste.get('errors')}"
    s.fermer()


def test_version(zip_nom):
    app = (RACINE / "app.js").read_text(encoding="utf-8")
    sw = (RACINE / "sw.js").read_text(encoding="utf-8")
    v_app = re.search(r'const VERSION = "(\d+\.\d{2})";', app).group(1)
    v_sw = re.search(r'const CACHE = "ma-compta-v(\d+\.\d{2})";', sw).group(1)
    assert v_app == v_sw, f"app.js dit {v_app}, sw.js dit {v_sw}"
    if zip_nom:
        attendu = "ma-compta_v" + v_app.replace(".", "_") + ".zip"
        assert Path(zip_nom).name == attendu, f"le zip devrait s'appeler {attendu}"
    fichiers_sw = re.findall(r'"([^"]+)",?\n', sw.split("const FICHIERS = [")[1].split("];")[0])
    for f in fichiers_sw:
        if f != "./":
            assert (RACINE / f).exists(), f"sw.js garde en cache un fichier absent : {f}"
    for f in RACINE.glob("*.js"):
        contenu = f.read_text(encoding="utf-8")
        assert "console.log" not in contenu and "debugger" not in contenu, f"reste de débogage dans {f.name}"


def test_affichage(nav, srv, captures):
    """Chaque écran, à chaque taille, en clair et en sombre, à 100 % et 150 % : rien ne déborde."""
    for taille in TAILLES:
        for sombre in (False, True):
            for echelle in (100, 150):
                s = Session(nav, srv, taille=taille, sombre=sombre)
                page = s.ouvrir()
                exemples(page)
                if echelle != 100:
                    onglet(page, "reglages")
                    for _ in range((echelle - 100) // 10):
                        page.click('[data-action="taille"][data-pas="10"]')
                    onglet(page, "accueil")
                nom = f"{taille}_{'sombre' if sombre else 'clair'}_{echelle}"
                for vue in ["accueil", "operations", "stats", "reglages"]:
                    onglet(page, vue)
                    page.evaluate("window.scrollTo(0, 0)")
                    if captures:
                        page.screenshot(path=str(captures / f"{nom}_{vue}.png"))
                    sans_debordement(page, f"{nom} {vue}")
                page.click(".onglet-plus")
                page.wait_for_selector(".pave")
                taper(page, "42,9")
                if captures:
                    page.screenshot(path=str(captures / f"{nom}_saisie.png"))
                sans_debordement(page, f"{nom} saisie")
                derniere_touche = page.locator('.touche[data-touche="⌫"]').bounding_box()
                hauteur = page.viewport_size["height"]
                assert derniere_touche["y"] + derniere_touche["height"] <= hauteur + 1, f"pavé coupé en bas ({nom})"
                assert page.locator(".tuile").first.bounding_box()["height"] > 30, f"grille écrasée ({nom})"
                page.keyboard.press("Escape")
                s.fermer()


# ----------------------------------------------------------------- lancement

def main():
    a = argparse.ArgumentParser()
    a.add_argument("--captures", help="dossier où enregistrer les captures d'écran")
    a.add_argument("--zip", help="nom du zip livré (vérifie qu'il porte le bon n° de version)")
    a.add_argument("--seulement", help="ne lancer que les tests dont le nom contient ce texte")
    args = a.parse_args()
    captures = Path(args.captures) if args.captures else None
    if captures:
        captures.mkdir(parents=True, exist_ok=True)
    travail = Path(tempfile.mkdtemp(prefix="tests-"))
    srv = Serveur(RACINE)
    resultats = []
    with sync_playwright() as p:
        nav = p.chromium.launch(args=["--lang=fr-FR"])
        tests = [
            ("version", lambda: test_version(args.zip)),
            ("installable", lambda: test_installable(nav, srv)),
            ("parcours complet", lambda: test_parcours_complet(nav, srv)),
            ("virement", lambda: test_virement(nav, srv)),
            ("mode bouton", lambda: test_mode_bouton(nav, srv)),
            ("fuseaux et minuit", lambda: test_fuseaux_et_minuit(nav, srv)),
            ("hors ligne", lambda: test_hors_ligne(nav, srv)),
            ("mise à jour", lambda: test_mise_a_jour(nav, srv)),
            ("sauvegarde et restauration", lambda: test_sauvegarde_restauration(nav, srv, travail)),
            ("csv", lambda: test_csv(nav, srv, travail)),
            ("retour et raccourcis", lambda: test_retour_et_raccourcis(nav, srv)),
            ("annuler sans piège", lambda: test_annuler_sans_piege(nav, srv)),
            ("double toucher", lambda: test_double_toucher(nav, srv)),
            ("exemple restauré par erreur", lambda: test_exemple_restaure_par_erreur(nav, srv, travail)),
            ("effacer prévient", lambda: test_effacer_previent(nav, srv)),
            ("réglages abîmés", lambda: test_reglages_abimes(nav, srv, travail)),
            ("copie de sécurité atomique", lambda: test_copie_securite_atomique(nav, srv)),
            ("deux fenêtres", lambda: test_deux_fenetres(nav, srv)),
            ("virement incomplet", lambda: test_virement_incomplet(nav, srv, travail)),
            ("affichage", lambda: test_affichage(nav, srv, captures)),
        ]
        for nom, f in tests:
            if args.seulement and args.seulement not in nom:
                continue
            try:
                f()
                resultats.append((nom, None))
                print(f"✓ {nom}")
            except Exception as e:  # noqa: BLE001 — on veut le détail de chaque échec
                resultats.append((nom, e))
                print(f"✗ {nom}\n{traceback.format_exc()}")
        nav.close()
    srv.arreter()
    shutil.rmtree(travail, ignore_errors=True)
    rates = [n for n, e in resultats if e]
    print(f"\n{'✅' if not rates else '❌'} {len(resultats) - len(rates)}/{len(resultats)} tests de l'appli réussis" + (f" — ratés : {', '.join(rates)}" if rates else ""))
    sys.exit(1 if rates else 0)


if __name__ == "__main__":
    main()
