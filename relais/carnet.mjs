// Carnet de route.
//
// Le téléphone signale chaque trajet : départ, arrivée, distance relevée par le GPS,
// véhicule. Il rattache à son trajet la réponse dictée à la question du motif. Le relais
// tient le registre, nomme les lieux par géocodage inverse et fait interpréter la réponse
// par un appel Claude séparé, sans session, à sortie structurée.
//
// L'enregistrement ne dépend pas du modèle : si l'interprétation échoue, la dictée est
// gardée telle quelle et l'interprétation reprise plus tard.
//
//   POST /v1/trajets  {"type": "depart"|"arrivee"|"reponse", "id": "...", "heure": ISO, ...}
//   GET  /v1/carnet?mois=AAAA-MM   export CSV (séparateur « ; », UTF-8 avec BOM)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const SCHEMA = {
  type: 'object',
  properties: {
    destination: { type: ['string', 'null'] },
    motif: { type: ['string', 'null'] },
    nature: { enum: ['pro', 'perso', null] },
    client: {
      type: ['object', 'null'],
      properties: { id: { type: ['integer', 'string'] }, nom: { type: 'string' } },
      required: ['nom'],
    },
    reprise: { type: ['boolean', 'null'] },
    suite: { type: ['string', 'null'] },
    confirmation: { type: 'string' },
  },
  required: ['destination', 'motif', 'nature', 'client', 'reprise', 'suite', 'confirmation'],
  additionalProperties: false,
};

const ID = /^[0-9A-Za-z-]{8,64}$/;
const TENTATIVES_MAX = 3;

export function creerCarnet({ dossier, profil, claude, poser, transmettre, journal }) {
  const P = profil.carnet;
  fs.mkdirSync(dossier, { recursive: true, mode: 0o700 });
  const FICHIER = path.join(dossier, 'carnet.json');

  let carnet = { trajets: [] };
  try {
    carnet = JSON.parse(fs.readFileSync(FICHIER, 'utf8'));
  } catch {
    /* premier usage */
  }

  function sauver() {
    const tmp = FICHIER + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(carnet, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, FICHIER);
  }

  const trouver = (id) => carnet.trajets.find((t) => t.id === id);

  // --- Dates, nombres, lieux ------------------------------------------------

  // « 2026-11-22 09:40 » à l'heure locale du conducteur.
  const local = (iso) =>
    iso ? new Date(iso).toLocaleString('sv-SE', { timeZone: P.fuseau }).slice(0, 16) : '';

  const kmDit = (km) => (km >= 10 ? String(Math.round(km)) : String(Math.round(km * 10) / 10).replace('.', ','));

  function position(p) {
    if (!p || typeof p.lat !== 'number' || typeof p.lon !== 'number') return null;
    return { lat: p.lat, lon: p.lon, precision: typeof p.precision === 'number' ? Math.round(p.precision) : null };
  }

  async function nommer(p) {
    if (!p || p.adresse !== undefined) return;
    const url = P.geocodage.replace('{lat}', p.lat).replace('{lon}', p.lon);
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      const f = (await r.json()).features?.[0]?.properties;
      p.adresse = f?.label ?? null;
      p.commune = f?.city ?? null;
      if (typeof f?.distance === 'number') p.ecart = Math.round(f.distance);
    } catch (e) {
      journal('géocodage impossible', e.message);
    }
  }

  // --- Questions -------------------------------------------------------------

  function demander(t, nature, texte) {
    t.question = nature;
    t.questionTexte = texte;
    sauver();
    poser(texte, { trajet: t.id, question: nature });
  }

  // Trajet terminé peu avant, avec le même véhicule : on propose de le continuer.
  function precedent(t) {
    const debut = Date.parse(t.debut);
    return carnet.trajets
      .filter((p) => p.id !== t.id && p.fin && (p.destination || p.motif))
      .filter((p) => !t.vehicule || !p.vehicule || p.vehicule === t.vehicule)
      .filter((p) => debut - Date.parse(p.fin) >= 0 && debut - Date.parse(p.fin) <= P.repriseMinutes * 60_000)
      .sort((a, b) => Date.parse(b.fin) - Date.parse(a.fin))[0];
  }

  // --- Interprétation de la réponse --------------------------------------------

  const file = [];
  let interpretationEnCours = null; // identifiant du trajet en cours d'interprétation

  function planifier(t) {
    if (!file.includes(t.id)) file.push(t.id);
    pomper();
  }

  function pomper() {
    if (interpretationEnCours || file.length === 0) return;
    const t = trouver(file.shift());
    if (!t) return pomper();
    interpretationEnCours = t.id;
    interpreter(t).finally(() => {
      interpretationEnCours = null;
      pomper();
    });
  }

  function lieu(p) {
    if (!p) return 'position inconnue';
    return p.adresse ? `${p.adresse}${p.ecart > 300 ? ` (à ${p.ecart} m près)` : ''}` : `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}`;
  }

  function enonce(t) {
    const l = [];
    l.push(
      `Trajet : départ le ${local(t.debut)} de ${lieu(t.depart)}` +
        (t.fin ? `, arrivée le ${local(t.fin)} à ${lieu(t.arrivee)}` : ', en cours') +
        (t.km != null ? `, ${kmDit(t.km)} km` : '') +
        `. Véhicule : ${t.vehicule || 'inconnu'}.`
    );
    const p = t.precedent && trouver(t.precedent);
    if (p) {
      l.push(
        `Trajet précédent, terminé le ${local(p.fin)} : destination ${p.destination ?? 'inconnue'}, ` +
          `motif ${p.motif ?? 'inconnu'}, nature ${p.nature ?? 'inconnue'}` +
          (p.client ? `, client ${p.client.nom}` : '') + '.'
      );
    }
    for (const r of t.reponses) {
      l.push(`Question posée : « ${r.questionTexte || 'aucune'} »`);
      l.push(`Réponse dictée à ${local(r.heure).slice(11)} : « ${r.texte} »`);
    }
    if (t.destination || t.motif) {
      l.push(`Déjà noté : destination ${t.destination ?? 'inconnue'}, motif ${t.motif ?? 'inconnu'}. Complétez ou corrigez.`);
    }
    return l.join('\n');
  }

  function interpreter(t) {
    return new Promise((fini) => {
      const prefixe = `mcp__${claude.serveurMcp}__`;
      let args;
      try {
        args = [
          '-p',
          '--output-format', 'json',
          '--json-schema', JSON.stringify(SCHEMA),
          '--no-session-persistence',
          '--permission-mode', 'dontAsk',
          '--permission-prompts', 'none',
          '--setting-sources', 'user',
          '--strict-mcp-config',
          '--mcp-config', claude.configMcp(),
          '--tools', 'ToolSearch',
          '--allowedTools', ['ToolSearch', ...(claude.serveurMcp ? P.outilsMcp ?? [] : []).map((o) => prefixe + o)].join(','),
          '--append-system-prompt', P.consigne,
          '--model', P.modele,
          '--effort', P.effort,
        ];
      } catch (e) {
        journal('carnet : préparation impossible', e.message);
        return echec(t, fini);
      }
      const debut = Date.now();
      // Répertoire du carnet : ni CLAUDE.md de dépôt, ni réglages de projet.
      let sortie = '';
      let erreurs = '';
      const enfant = spawn(claude.binaire, args, { cwd: dossier, env: { ...process.env, HOME: claude.home }, stdio: ['pipe', 'pipe', 'pipe'] });
      enfant.on('error', (e) => (erreurs += `lancement impossible : ${e.message} `));
      enfant.stdin.on('error', () => {});
      enfant.stdin.end(enonce(t));
      enfant.stdout.on('data', (d) => (sortie += d));
      enfant.stderr.on('data', (d) => (erreurs += d));
      const coupe = setTimeout(() => enfant.kill('SIGTERM'), P.delaiSecondes * 1000);
      enfant.on('close', (code) => {
        clearTimeout(coupe);
        const duree = Math.round((Date.now() - debut) / 1000);
        let r = null;
        let brut = {};
        try {
          brut = JSON.parse(sortie);
          r = brut.structured_output ?? (brut.is_error ? null : JSON.parse(brut.result));
        } catch {
          /* sortie illisible */
        }
        if (!r || typeof r.confirmation !== 'string') {
          journal('carnet : interprétation en échec', `trajet=${t.id}`, `durée=${duree}s`, `code=${code}`,
            (erreurs || sortie).replace(/\s+/g, ' ').slice(0, 300));
          return echec(t, fini);
        }
        appliquer(t, r);
        journal('carnet : interprété', `trajet=${t.id}`, `durée=${duree}s`, `tours=${brut.num_turns ?? '?'}`,
          `refus=${brut.permission_denials?.length ?? 0}`, `client=${r.client ? 'oui' : 'non'}`);
        fini();
      });
    });
  }

  function echec(t, fini) {
    t.tentatives = (t.tentatives ?? 0) + 1;
    t.interpretation = 'echec';
    sauver();
    if (t.tentatives === 1) poser(P.messages.echec);
    fini();
  }

  function appliquer(t, r) {
    const p = t.precedent && trouver(t.precedent);
    const derniere = t.reponses.at(-1)?.question;
    if (derniere === 'reprise' && r.reprise === true && p) {
      t.reprise = p.id;
      for (const k of ['destination', 'motif', 'nature', 'client']) t[k] = p[k] ?? null;
    }
    for (const k of ['destination', 'motif', 'nature', 'client']) {
      if (r[k] !== null && r[k] !== undefined && r[k] !== '') t[k] = r[k];
    }
    t.interpretation = 'faite';
    t.tentatives = (t.tentatives ?? 0) + 1;
    const manque = !t.destination && !t.motif;
    if (manque) {
      demander(t, 'complement', r.confirmation);
    } else {
      sauver();
      poser(r.confirmation);
    }
    if (r.suite && r.suite.trim()) transmettre(r.suite.trim());
  }

  // Reprise des interprétations en échec : au démarrage, puis toutes les trente minutes.
  // Un trajet en cours d'interprétation n'est pas replanifié : il serait interprété deux
  // fois, et sa confirmation lue deux fois (essai du 22/11).
  function reprendre() {
    for (const t of carnet.trajets) {
      if (t.id === interpretationEnCours) continue;
      if (t.reponses?.length && t.interpretation !== 'faite' && (t.tentatives ?? 0) < TENTATIVES_MAX) planifier(t);
    }
  }
  setTimeout(reprendre, 10_000).unref();
  setInterval(reprendre, 30 * 60_000).unref();

  // --- Événements du téléphone ---------------------------------------------------

  function nouveau(id, corps) {
    const t = {
      id,
      vehicule: typeof corps.vehicule === 'string' && corps.vehicule.trim() ? corps.vehicule.trim().slice(0, 80) : null,
      debut: corps.debut || corps.heure,
      fin: null,
      depart: null,
      arrivee: null,
      km: null,
      points: 0,
      reponses: [],
      destination: null,
      motif: null,
      nature: null,
      client: null,
      reprise: null,
      precedent: null,
      question: null,
      interpretation: null,
    };
    carnet.trajets.push(t);
    return t;
  }

  async function depart(id, corps) {
    let t = trouver(id);
    if (t) return; // déjà reçu (renvoi de la file du téléphone)
    t = nouveau(id, corps);
    t.depart = position(corps.position);
    sauver();
    journal('carnet : départ', id, t.vehicule ?? 'véhicule inconnu');
    if (corps.questionPosee) {
      // Question déjà posée par le téléphone, faute de relais, ou trajet trop court.
      t.question = 'depart';
      t.questionTexte = P.questions.depart;
      sauver();
    } else {
      const p = precedent(t);
      if (p) {
        t.precedent = p.id;
        demander(t, 'reprise', P.questions.reprise.replace('{destination}', p.destination ?? p.motif));
      } else {
        demander(t, 'depart', P.questions.depart);
      }
    }
    await nommer(t.depart);
    sauver();
  }

  async function arrivee(id, corps) {
    const t = trouver(id) ?? nouveau(id, corps);
    if (t.fin) return;
    // Le nom du véhicule peut arriver après le départ (Bluetooth lent à répondre).
    if (!t.vehicule && typeof corps.vehicule === 'string' && corps.vehicule.trim()) t.vehicule = corps.vehicule.trim().slice(0, 80);
    t.fin = corps.heure;
    t.arrivee = position(corps.position);
    t.km = typeof corps.km === 'number' ? Math.round(corps.km * 10) / 10 : null;
    t.points = Number(corps.points) || 0;
    sauver();
    journal('carnet : arrivée', id, `${t.km ?? '?'} km`);
    await nommer(t.arrivee);
    await nommer(t.depart);
    sauver();
    if (t.reponses.length === 0) {
      if (t.km !== null && t.km < P.kmMinimum) {
        t.sansDeplacement = true;
        sauver();
        return;
      }
      const ou = t.arrivee?.commune ? ` à ${t.arrivee.commune}` : '';
      const trajet = t.km === null ? 'Trajet terminé' : `Trajet de ${kmDit(t.km)} ${t.km < 2 ? 'kilomètre' : 'kilomètres'} terminé`;
      demander(t, 'arrivee', `${trajet}${ou}. ${P.questions.arrivee}`);
    } else if (t.interpretation !== 'faite') {
      planifier(t);
    }
  }

  function reponse(id, corps) {
    const texte = typeof corps.texte === 'string' ? corps.texte.trim().slice(0, 2000) : '';
    if (!texte) return;
    const t = trouver(id) ?? nouveau(id, corps);
    if (t.reponses.some((r) => r.heure === corps.heure && r.texte === texte)) return;
    t.reponses.push({ heure: corps.heure, texte, question: t.question, questionTexte: t.questionTexte });
    t.interpretation = 'a_faire';
    t.tentatives = 0;
    t.sansDeplacement = false;
    sauver();
    journal('carnet : réponse', id);
    planifier(t);
  }

  // Rend le code HTTP. Le traitement lent (géocodage, question) suit la réponse.
  function evenement(corps) {
    const id = corps?.id;
    if (typeof id !== 'string' || !ID.test(id)) return 400;
    if (typeof corps.heure !== 'string' || Number.isNaN(Date.parse(corps.heure))) return 400;
    const action = { depart, arrivee, reponse }[corps.type];
    if (!action) return 400;
    Promise.resolve(action(id, corps)).catch((e) => journal('carnet : erreur', corps.type, e.message));
    return 200;
  }

  // --- Export ------------------------------------------------------------------

  function champ(v) {
    const s = v === null || v === undefined ? '' : String(v);
    return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exporter(mois) {
    const km = (x) => (x === null || x === undefined ? '' : String(x).replace('.', ','));
    const lignes = [
      ['Date', 'Départ', 'Arrivée', 'Véhicule', 'Lieu de départ', "Lieu d'arrivée", 'Km', 'Destination',
        'Motif', 'Nature', 'Client', 'Réponse dictée', 'Suite du trajet du'],
    ];
    const totaux = { pro: 0, perso: 0, aucune: 0 };
    const liste = carnet.trajets
      .filter((t) => local(t.debut).startsWith(mois) && !t.sansDeplacement)
      .sort((a, b) => Date.parse(a.debut) - Date.parse(b.debut));
    for (const t of liste) {
      totaux[t.nature ?? 'aucune'] += t.km ?? 0;
      const p = t.reprise && trouver(t.reprise);
      lignes.push([
        local(t.debut).slice(0, 10), local(t.debut).slice(11), local(t.fin).slice(11), t.vehicule ?? '',
        t.depart?.adresse ?? '', t.arrivee?.adresse ?? '', km(t.km), t.destination ?? '', t.motif ?? '',
        t.nature ?? 'à préciser', t.client?.nom ?? '', t.reponses.map((r) => r.texte).join(' / '),
        p ? local(p.debut) : '',
      ]);
    }
    lignes.push([]);
    const arrondi = (x) => km(Math.round(x * 10) / 10);
    lignes.push(['Total professionnel', '', '', '', '', '', arrondi(totaux.pro)]);
    lignes.push(['Total personnel', '', '', '', '', '', arrondi(totaux.perso)]);
    lignes.push(['Nature à préciser', '', '', '', '', '', arrondi(totaux.aucune)]);
    return '﻿' + lignes.map((l) => l.map(champ).join(';')).join('\r\n') + '\r\n';
  }

  return { evenement, exporter, fichier: FICHIER, dossier };
}
