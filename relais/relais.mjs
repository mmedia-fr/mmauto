#!/usr/bin/env node
// Relais « Claude en voiture ».
//
// Le téléphone envoie la dictée du conducteur ; le relais lance Claude Code en mode non
// interactif dans le répertoire de travail du profil (mêmes instructions, même mémoire,
// outils MCP qu'une session ordinaire), avec un profil en lecture seule, puis met la
// réponse à disposition du téléphone.
//
// Seule écriture : la note pour le bureau (note.mjs, section « note » du profil), que le relais
// dépose lui-même dans une boîte IMAP, sur dictée directe ou après confirmation à voix haute.
//
// Aucune dépendance : Node 20.
//
//   GET  /v1/sante                     sans jeton — vérifie que le relais répond
//   GET  /v1/messages?apres=N&attente=S messages de numéro > N ; attend jusqu'à S s (≤ 50)
//   POST /v1/messages {"texte": "..."}  dépose une dictée ; « nouvelle conversation » ouvre un fil
//   POST /v1/fil                        ouvre un nouveau fil (nouvelle session Claude)
//   GET  /v1/etat                       état du relais (calcul en cours, fil courant)
//   POST /v1/trajets {"type": ...}       carnet de route : départ, arrivée, réponse (carnet.mjs)
//   GET  /v1/carnet?mois=AAAA-MM         carnet de route du mois, en CSV
//   POST /v1/diag {"lignes": [...]}      relevé de diagnostic du téléphone, écrit au journal
//
// Le préfixe /voiture est accepté devant chaque chemin (relais derrière nginx).
// Jeton : en-tête « X-Voiture-Jeton ». Le relais n'en garde que l'empreinte SHA-256.

import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { creerCarnet } from './carnet.mjs';
import { creerNotes } from './note.mjs';

const ICI = path.dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || os.homedir();
const PROFIL = JSON.parse(fs.readFileSync(process.env.VOITURE_PROFIL || path.join(ICI, 'profil.json'), 'utf8'));
const PORT = Number(process.env.VOITURE_PORT || 7120);
const HOTE = process.env.VOITURE_HOTE || '0.0.0.0';
const DOSSIER_ETAT = process.env.VOITURE_ETAT || path.join(HOME, '.local/state/claude-voiture');
const FICHIER_EMPREINTE = process.env.VOITURE_EMPREINTE || path.join(HOME, '.config/claude-voiture/jeton.sha256');
const CLAUDE = process.env.VOITURE_CLAUDE || path.join(HOME, '.local/bin/claude');
const DOSSIER_CARNET = process.env.VOITURE_CARNET || path.join(DOSSIER_ETAT, 'carnet');
const FICHIER_SECRET_NOTE = process.env.VOITURE_NOTE_SECRET || path.join(HOME, '.config/claude-voiture/note-imap.secret');
const MESSAGES_GARDES = 200;
const ATTENTE_MAX = 50;

function journal(...x) {
  console.log(new Date().toISOString(), ...x);
}

// --- Jeton -----------------------------------------------------------------

function empreinteAttendue() {
  try {
    const h = fs.readFileSync(FICHIER_EMPREINTE, 'utf8').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(h) ? Buffer.from(h, 'hex') : null;
  } catch {
    return null;
  }
}

function jetonValide(req) {
  const attendu = empreinteAttendue();
  const fourni = req.headers['x-voiture-jeton'];
  if (!attendu || typeof fourni !== 'string' || fourni.length < 20) return false;
  const h = createHash('sha256').update(fourni.trim()).digest();
  return timingSafeEqual(h, attendu);
}

// --- État persistant -------------------------------------------------------

fs.mkdirSync(DOSSIER_ETAT, { recursive: true, mode: 0o700 });
const FICHIER_ETAT = path.join(DOSSIER_ETAT, 'etat.json');

let etat = { seq: 0, fil: null, messages: [] };
try {
  etat = JSON.parse(fs.readFileSync(FICHIER_ETAT, 'utf8'));
} catch {
  /* premier démarrage */
}

function sauver() {
  etat.messages = etat.messages.slice(-MESSAGES_GARDES);
  const tmp = FICHIER_ETAT + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(etat), { mode: 0o600 });
  fs.renameSync(tmp, FICHIER_ETAT);
}

const signal = new EventEmitter();
signal.setMaxListeners(50);

// [extra] : champs propres au carnet de route (trajet et nature de la question posée).
function ajouter(role, texte, extra = {}) {
  const m = { seq: ++etat.seq, role, texte, fil: etat.fil?.id ?? null, heure: new Date().toISOString(), ...extra };
  etat.messages.push(m);
  sauver();
  signal.emit('nouveau');
  return m;
}

function nouveauFil(motif) {
  etat.fil = { id: randomUUID(), session: null, debut: new Date().toISOString() };
  sauver();
  journal('fil', etat.fil.id, motif);
}

if (!etat.fil) nouveauFil('premier démarrage');

// --- Appel de Claude Code ----------------------------------------------------

const enAttente = [];
let enCours = null; // { debut, enfant }

// Claude Code n'applique aucune règle d'autorisation à un serveur MCP dont le nom
// commence comme un connecteur claude.ai (« claude_ai_… ») : relevé le 2026-11-20 dans
// le journal de débogage. Le relais déclare donc le même serveur sous un autre nom,
// dans un fichier propre au mode voiture (mode 600 : il porte le jeton du serveur).
// Sans « serveurMcp » dans le profil, la conversation n'a aucun serveur MCP.
function configMcp() {
  let serveurs = {};
  if (PROFIL.serveurMcp) {
    const conf = JSON.parse(fs.readFileSync(path.join(HOME, '.claude.json'), 'utf8'));
    const serveur = conf.mcpServers?.[PROFIL.serveurMcp.source];
    if (!serveur) throw new Error(`serveur MCP « ${PROFIL.serveurMcp.source} » absent de ~/.claude.json`);
    serveurs = { [PROFIL.serveurMcp.nom]: serveur };
  }
  const fichier = path.join(DOSSIER_ETAT, 'mcp.json');
  fs.writeFileSync(fichier, JSON.stringify({ mcpServers: serveurs }), { mode: 0o600 });
  return fichier;
}

// Le dossier des conversations de Claude Code pour un répertoire de travail : chaque
// caractère hors [A-Za-z0-9] devient un tiret (« /home/moi/projet » → « -home-moi-projet »).
const DOSSIER_SESSIONS = path.join(HOME, '.claude/projects', PROFIL.repertoire.replace(/[^A-Za-z0-9]/g, '-'));
const DOSSIER_ARCHIVE = path.join(HOME, '.claude/transcripts-archive');

// Un archivage nocturne peut déplacer hors de ~/.claude/projects, vers
// ~/.claude/transcripts-archive, les conversations qui n'ont pas servi depuis la veille ;
// `--resume` ne les trouve plus (« No conversation found »). On remet la conversation en
// place avant de la reprendre.
function remettreEnPlace(session) {
  const ici = path.join(DOSSIER_SESSIONS, `${session}.jsonl`);
  if (fs.existsSync(ici)) return;
  const archive = path.join(DOSSIER_ARCHIVE, path.basename(DOSSIER_SESSIONS), `${session}.jsonl`);
  if (!fs.existsSync(archive)) return;
  try {
    fs.mkdirSync(DOSSIER_SESSIONS, { recursive: true });
    fs.renameSync(archive, ici);
    journal('conversation remise en place depuis l\'archive', session);
  } catch (e) {
    journal('remise en place impossible', session, e.message);
  }
}

function argumentsClaude() {
  const prefixe = `mcp__${PROFIL.serveurMcp?.nom}__`;
  const outils = [...PROFIL.outilsIntegres, ...(PROFIL.serveurMcp ? PROFIL.outilsMcp ?? [] : []).map((o) => prefixe + o)];
  // La dictée passe par l'entrée standard : ni visible dans la liste des processus,
  // ni prise pour une option si elle commence par un tiret.
  const a = [
    '-p',
    '--output-format', 'json',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    // Réglages utilisateur seulement : ceux du projet (.claude/settings.local.json) peuvent
    // autoriser des outils d'écriture (exécution de commandes, envoi de courriels…).
    '--setting-sources', 'user',
    '--strict-mcp-config',
    '--mcp-config', configMcp(),
    '--tools', PROFIL.outilsIntegres.join(','),
    '--allowedTools', outils.join(','),
    // Le carnet de route se lit, il ne s'écrit pas depuis la conversation.
    ...(carnet ? ['--add-dir', carnet.dossier] : []),
    '--append-system-prompt', PROFIL.consigne + (carnet ? consigneCarnet() : '') + (notes ? notes.consigne() : ''),
    '--model', PROFIL.modele,
    '--effort', PROFIL.effort,
  ];
  if (etat.fil.session) {
    remettreEnPlace(etat.fil.session);
    a.push('--resume', etat.fil.session);
  } else {
    etat.fil.session = randomUUID();
    sauver();
    a.push('--session-id', etat.fil.session, '--name', `voiture ${etat.fil.debut.slice(0, 16).replace('T', ' ')}`);
  }
  return a;
}

function pomper() {
  if (enCours || enAttente.length === 0) return;
  // Les avis du relais sur les notes (déposée, abandonnée…) précèdent la dictée.
  const dicte = enAttente.splice(0).join('\n');
  const texte = notes ? notes.prefixer(dicte) : dicte;
  const debut = Date.now();
  const filAuDepart = etat.fil.id;
  const reprise = !!etat.fil.session;
  let args;
  try {
    args = argumentsClaude();
  } catch (e) {
    journal('préparation impossible', e.message);
    ajouter('erreur', "Je n'ai pas pu répondre : la configuration du relais est incomplète.");
    return;
  }
  let sortie = '';
  let erreurs = '';
  const enfant = spawn(CLAUDE, args, {
    cwd: PROFIL.repertoire,
    env: { ...process.env, HOME },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Binaire ou répertoire de travail introuvable : un échec de cette dictée, pas l'arrêt du
  // relais (« close » suit, avec un code d'erreur).
  enfant.on('error', (e) => (erreurs += `lancement impossible : ${e.message} `));
  enfant.stdin.on('error', () => {});
  enfant.stdin.end(texte);
  enCours = { debut, enfant };
  journal('appel', `fil=${filAuDepart}`, `session=${etat.fil.session}`, `longueur=${texte.length}`);

  enfant.stdout.on('data', (d) => (sortie += d));
  enfant.stderr.on('data', (d) => (erreurs += d));

  const avis = setTimeout(() => {
    if (enCours?.enfant === enfant) ajouter('etat', 'Je regarde, la réponse arrive.');
  }, PROFIL.premierAvisSecondes * 1000);
  let depasse = false;
  const coupe = setTimeout(() => {
    depasse = true;
    journal('délai dépassé, arrêt du calcul');
    enfant.kill('SIGTERM');
  }, PROFIL.delaiMaxSecondes * 1000);

  enfant.on('close', (code) => {
    clearTimeout(avis);
    clearTimeout(coupe);
    enCours = null;
    const duree = Math.round((Date.now() - debut) / 1000);
    let r = null;
    try {
      r = JSON.parse(sortie);
    } catch {
      /* sortie illisible */
    }
    if (r && !r.is_error && typeof r.result === 'string' && r.result.trim()) {
      if (r.session_id && etat.fil.id === filAuDepart) {
        etat.fil.session = r.session_id;
      }
      // Une note proposée par la conversation est retirée de ce qui est lu, et attend la confirmation.
      const lu = notes ? notes.extraire(r.result.trim(), filAuDepart) : { texte: r.result.trim() };
      ajouter('claude', lu.texte, lu.extra);
      journal('réponse', `durée=${duree}s`, `tours=${r.num_turns ?? '?'}`, `coût=${r.total_cost_usd ?? '?'}`);
    } else {
      const motif = (r?.result || erreurs || `code ${code}`).toString().replace(/\s+/g, ' ').slice(0, 300);
      journal('échec', `durée=${duree}s`, `code=${code}`, motif);
      if (reprise && etat.fil.id === filAuDepart && /No conversation found/i.test(motif)) {
        // Conversation introuvable malgré la remise en place : une nouvelle conversation
        // reprend la dictée, plutôt qu'un échec à chaque message jusqu'au retour au bureau.
        nouveauFil('conversation précédente introuvable');
        // Rôle « avis » : lu comme un message ordinaire (un « etat » s'efface devant la
        // réponse qui suit, le conducteur ne l'entendrait pas), sans clore l'attente de la réponse.
        ajouter('avis', "Je ne retrouve plus notre conversation précédente : j'en ouvre une nouvelle.");
        enAttente.unshift(texte);
      } else {
        ajouter('erreur', "Je n'ai pas pu répondre : " + (depasse
          ? 'le calcul a dépassé le temps permis et a été interrompu.'
          : code === null
          ? 'le calcul a été interrompu.'
          : "Claude Code s'est arrêté sur une erreur, dont le détail est dans le journal du relais."));
      }
    }
    pomper();
  });
}

const NOUVEAU_FIL = /^\s*(nouvelle conversation|nouveau fil|on recommence)\b/i;

// Un « ok », « oui » ou « merci » dit seul, après une réponse qui ne posait pas de
// question, n'appelle pas Claude. En voiture, la dictée en envoie pour clore une
// lecture, et chacun relançait une réponse inutile (21/11 : cinq en dix minutes).
const ACQUIESCEMENT =
  /^\s*(ok(ay)?|oui|ouais|d['’]accord|merci( beaucoup)?|entendu|parfait|tr[eè]s bien|[cç]a marche|super)\s*[.!]*\s*$/i;

function derniereReponse() {
  for (let i = etat.messages.length - 1; i >= 0; i--) {
    const m = etat.messages[i];
    if (m.fil !== etat.fil.id) return null;
    if (m.role === 'claude' || m.role === 'note') return m;
  }
  return null;
}

function recevoir(texte) {
  const m = ajouter('moi', texte);
  if (!NOUVEAU_FIL.test(texte) && notes?.intercepter(texte, m)) return m;
  if (NOUVEAU_FIL.test(texte)) {
    notes?.oublier();
    nouveauFil('demandé par la dictée');
    const reste = texte.replace(NOUVEAU_FIL, '').replace(/^[\s,.:;!?-]+/, '');
    if (!reste) {
      ajouter('etat', 'Nouvelle conversation. Je vous écoute.');
      return m;
    }
    if (notes?.intercepter(reste, m)) return m;
    enAttente.push(reste);
  } else if (ACQUIESCEMENT.test(texte) && !/\?\s*$/.test(derniereReponse()?.texte ?? '')) {
    journal('acquiescement seul, sans appel');
    return m;
  } else {
    enAttente.push(texte);
  }
  pomper();
  return m;
}

// --- Note pour le bureau --------------------------------------------------------

const notes = PROFIL.note
  ? creerNotes({
      profil: PROFIL,
      fichierSecret: FICHIER_SECRET_NOTE,
      lireEtat: () => etat,
      sauver,
      ajouter,
      journal,
    })
  : null;

// --- Carnet de route ----------------------------------------------------------

const carnet = PROFIL.carnet
  ? creerCarnet({
      dossier: DOSSIER_CARNET,
      profil: PROFIL,
      claude: { binaire: CLAUDE, home: HOME, serveurMcp: PROFIL.serveurMcp?.nom, configMcp },
      poser: (texte, extra) => ajouter('carnet', texte, extra),
      transmettre: (texte) => recevoir(texte),
      journal,
    })
  : null;

function consigneCarnet() {
  return `\n\nCarnet de route : le registre des trajets est le fichier ${carnet.fichier} (JSON, un objet par ` +
    'trajet, heures en UTC, distances en kilomètres). Lisez-le pour toute question sur les trajets, les ' +
    'kilomètres ou les motifs. Vous ne pouvez pas le modifier.';
}

// --- HTTP ------------------------------------------------------------------

function repondre(res, code, corps) {
  const s = JSON.stringify(corps);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(s);
}

function lireCorps(req) {
  return new Promise((ok, ko) => {
    let n = 0;
    const morceaux = [];
    req.on('data', (d) => {
      n += d.length;
      if (n > 16384) {
        ko(new Error('trop long'));
        req.destroy();
      } else morceaux.push(d);
    });
    req.on('end', () => ok(Buffer.concat(morceaux).toString('utf8')));
    req.on('error', ko);
  });
}

function messagesApres(n) {
  return etat.messages.filter((m) => m.seq > n);
}

const serveur = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relais');
  const chemin = url.pathname.replace(/^\/voiture(?=\/)/, '');

  if (req.method === 'GET' && chemin === '/v1/sante') return repondre(res, 200, { ok: true });
  if (!jetonValide(req)) {
    journal('refus', req.method, chemin);
    return repondre(res, 401, { erreur: 'jeton' });
  }

  try {
    if (req.method === 'GET' && chemin === '/v1/messages') {
      const apres = Number(url.searchParams.get('apres') || 0);
      const attente = Math.min(Number(url.searchParams.get('attente') || 0), ATTENTE_MAX);
      let liste = messagesApres(apres);
      if (liste.length === 0 && attente > 0) {
        await new Promise((ok) => {
          const fin = setTimeout(ok, attente * 1000);
          const vu = () => {
            clearTimeout(fin);
            ok();
          };
          signal.once('nouveau', vu);
          req.on('close', () => {
            clearTimeout(fin);
            signal.off('nouveau', vu);
            ok();
          });
        });
        liste = messagesApres(apres);
      }
      return repondre(res, 200, { messages: liste, dernier: etat.seq, enCours: !!enCours });
    }

    if (req.method === 'POST' && chemin === '/v1/messages') {
      const corps = JSON.parse((await lireCorps(req)) || '{}');
      const texte = typeof corps.texte === 'string' ? corps.texte.trim() : '';
      if (!texte) return repondre(res, 400, { erreur: 'texte vide' });
      const m = recevoir(texte.slice(0, 4000));
      return repondre(res, 202, { seq: m.seq });
    }

    if (req.method === 'POST' && chemin === '/v1/fil') {
      notes?.oublier();
      nouveauFil('demandé par le téléphone');
      const m = ajouter('etat', 'Nouvelle conversation. Je vous écoute.');
      return repondre(res, 200, { fil: etat.fil.id, seq: m.seq });
    }

    if (req.method === 'POST' && chemin === '/v1/trajets') {
      if (!carnet) return repondre(res, 404, { erreur: 'carnet de route désactivé' });
      const code = carnet.evenement(JSON.parse((await lireCorps(req)) || '{}'));
      return repondre(res, code, code === 200 ? { ok: true } : { erreur: 'événement illisible' });
    }

    // Relevé de diagnostic de l'application (0.2.1) : états de la veille, de la connexion à
    // la voiture et du carnet, sans contenu ni position. Écrit tel quel au journal du relais.
    if (req.method === 'POST' && chemin === '/v1/diag') {
      const corps = JSON.parse((await lireCorps(req)) || '{}');
      if (!Array.isArray(corps.lignes)) return repondre(res, 400, { erreur: 'lignes attendues' });
      for (const l of corps.lignes.slice(0, 50)) {
        const heure = typeof l?.heure === 'string' ? l.heure.slice(0, 30) : '?';
        const texte = typeof l?.texte === 'string' ? l.texte.replace(/[\u0000-\u001f\u007f]+/g, ' ').slice(0, 300) : '';
        if (texte) journal('téléphone', heure, texte);
      }
      return repondre(res, 200, { ok: true });
    }

    if (req.method === 'GET' && chemin === '/v1/carnet') {
      if (!carnet) return repondre(res, 404, { erreur: 'carnet de route désactivé' });
      const mois = url.searchParams.get('mois') || '';
      if (!/^\d{4}-\d{2}$/.test(mois)) return repondre(res, 400, { erreur: 'mois attendu : AAAA-MM' });
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="carnet-de-route-${mois}.csv"`,
        'cache-control': 'no-store',
      });
      return res.end(carnet.exporter(mois));
    }

    if (req.method === 'GET' && chemin === '/v1/etat') {
      return repondre(res, 200, {
        enCours: enCours ? Math.round((Date.now() - enCours.debut) / 1000) : null,
        enAttente: enAttente.length,
        fil: etat.fil.id,
        dernier: etat.seq,
      });
    }

    return repondre(res, 404, { erreur: 'chemin inconnu' });
  } catch (e) {
    journal('erreur', chemin, e.message);
    return repondre(res, 400, { erreur: 'requête illisible' });
  }
});

serveur.listen(PORT, HOTE, () => journal(`relais à l'écoute sur ${HOTE}:${PORT}`));

for (const s of ['SIGTERM', 'SIGINT']) {
  process.on(s, () => {
    enCours?.enfant.kill('SIGTERM');
    serveur.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
