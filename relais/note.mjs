// Note pour le bureau.
//
// La seule écriture permise depuis la voiture : déposer une note dans un dossier d'une boîte
// IMAP, que l'on traitera à l'arrêt. Le relais la dépose lui-même par un APPEND IMAP : la
// conversation n'a toujours aucun outil d'écriture, et rien ne passe par SMTP, donc rien n'est
// envoyé à personne.
//
// Deux voies :
//   1. Dictée directe : « note pour le bureau : … ». Le relais dépose le texte tel quel, sans
//      appel à Claude, et le relit. « Note pour le bureau » seul : la dictée suivante est la note.
//   2. Proposition de la conversation : la réponse de Claude se termine par un bloc
//      <note_bureau objet="…">texte</note_bureau>. Le relais retire le bloc de ce qui est lu,
//      garde la note en attente et ne la dépose que si la dictée suivante la confirme (« oui »,
//      « vas-y »…) ; toute autre dictée l'abandonne. La confirmation est mécanique : un texte
//      glissé dans un document lu par la conversation ne suffit pas à déposer une note.
//
// Le mot de passe IMAP est lu dans un fichier en mode 600, à chaque dépôt : jamais dans le
// profil, le code ou une ligne de commande. Après un refus d'authentification, le dépôt reste
// suspendu jusqu'au redémarrage du relais : un serveur de messagerie bannit l'adresse qui
// insiste, et avec elle tout le site qui sort par cette adresse.

import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';

// --- Client IMAP minimal : connexion, LOGIN, APPEND (CREATE si le dossier manque), LOGOUT -----

// Nom de dossier en UTF-7 modifié (RFC 3501, § 5.1.3) : ASCII imprimable tel quel, « & » écrit
// « &- », le reste en base64 modifié de l'UTF-16 (« Brouillon préparé » → « Brouillon pr&AOk-par&AOk- »).
export function utf7Imap(nom) {
  let s = '';
  let paquet = [];
  const vider = () => {
    if (!paquet.length) return;
    const b = Buffer.alloc(paquet.length * 2);
    paquet.forEach((c, i) => b.writeUInt16BE(c, i * 2));
    s += '&' + b.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
    paquet = [];
  };
  for (let i = 0; i < nom.length; i++) {
    const c = nom.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      vider();
      s += c === 0x26 ? '&-' : nom[i];
    } else paquet.push(c);
  }
  vider();
  return s;
}

const chaine = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;

export class ErreurImap extends Error {
  constructor(message, { auth = false } = {}) {
    super(message);
    this.auth = auth;
  }
}

/**
 * Dépose `message` (Buffer ou texte RFC 5322, fins de ligne CRLF) dans `dossier`.
 * Rend { uid } (UID attribué, si le serveur le donne). `connecter` remplace la connexion TLS
 * (essais). Une seule tentative : aucune reprise automatique, en particulier sur un refus du
 * mot de passe.
 */
export function deposerImap({ hote, port = 993, utilisateur, motDePasse, dossier, message, delaiMs = 20000, connecter }) {
  const brut = Buffer.isBuffer(message) ? message : Buffer.from(message, 'utf8');
  const prise = connecter
    ? connecter()
    : tls.connect({ host: hote, port, servername: net.isIP(hote) ? undefined : hote });

  let tampon = '';
  const lignes = [];
  let reveil = null;
  let fin = null;
  prise.on('data', (d) => {
    tampon += d.toString('utf8');
    let i;
    while ((i = tampon.indexOf('\r\n')) >= 0) {
      lignes.push(tampon.slice(0, i));
      tampon = tampon.slice(i + 2);
    }
    reveil?.();
  });
  const couper = (e) => {
    fin ??= e;
    reveil?.();
  };
  prise.on('error', (e) => couper(new ErreurImap(`connexion IMAP : ${e.message}`)));
  prise.on('close', () => couper(new ErreurImap('connexion IMAP fermée par le serveur')));

  async function ligne() {
    while (!lignes.length) {
      if (fin) throw fin;
      await new Promise((ok) => (reveil = ok));
      reveil = null;
    }
    return lignes.shift();
  }

  let n = 0;
  async function commande(texte, litteral) {
    const tag = `M${++n}`;
    if (litteral) {
      prise.write(`${tag} ${texte} {${litteral.length}}\r\n`);
      for (;;) {
        const l = await ligne();
        if (l.startsWith('+')) break;
        if (l.startsWith(`${tag} `)) return reponse(l, tag);
      }
      prise.write(litteral);
      prise.write('\r\n');
    } else prise.write(`${tag} ${texte}\r\n`);
    for (;;) {
      const l = await ligne();
      if (l.startsWith(`${tag} `)) return reponse(l, tag);
    }
  }

  function reponse(l, tag) {
    const reste = l.slice(tag.length + 1);
    const etat = reste.split(' ')[0].toUpperCase();
    const code = reste.match(/^\w+ \[([^\]]*)\]/)?.[1] ?? '';
    return { etat, code, texte: reste.slice(0, 200) };
  }

  const travail = (async () => {
    const accueil = await ligne();
    if (!/^\* (OK|PREAUTH)\b/i.test(accueil)) throw new ErreurImap(`accueil IMAP inattendu : ${accueil.slice(0, 120)}`);
    if (!/^\* PREAUTH/i.test(accueil)) {
      const r = await commande(`LOGIN ${chaine(utilisateur)} ${chaine(motDePasse)}`);
      // Le texte de la réponse ne contient pas le mot de passe ; la commande, elle, n'est jamais journalisée.
      if (r.etat !== 'OK') throw new ErreurImap(`authentification IMAP refusée (${r.texte})`, { auth: true });
    }
    const boite = chaine(utf7Imap(dossier));
    let r = await commande(`APPEND ${boite} ()`, brut);
    if (r.etat === 'NO' && /^TRYCREATE/i.test(r.code)) {
      const c = await commande(`CREATE ${boite}`);
      if (c.etat !== 'OK') throw new ErreurImap(`création du dossier refusée (${c.texte})`);
      await commande(`SUBSCRIBE ${boite}`);
      r = await commande(`APPEND ${boite} ()`, brut);
    }
    if (r.etat !== 'OK') throw new ErreurImap(`dépôt refusé (${r.texte})`);
    const uid = r.code.match(/^APPENDUID \d+ (\d+)/i)?.[1] ?? null;
    await commande('LOGOUT').catch(() => {});
    return { uid: uid && Number(uid) };
  })();
  // Après le délai, la prise est détruite et le travail échoue à son tour : sans ce rattrapage,
  // ce second échec serait un rejet non traité, qui arrête Node.
  travail.catch(() => {});

  let minuterie;
  const delai = new Promise((_, ko) => {
    minuterie = setTimeout(() => ko(new ErreurImap(`pas de réponse du serveur IMAP en ${delaiMs / 1000} s`)), delaiMs);
  });
  return Promise.race([travail, delai]).finally(() => {
    clearTimeout(minuterie);
    prise.destroy();
  });
}

// --- Le message ---------------------------------------------------------------------------------

// En-tête en mots encodés RFC 2047 (UTF-8, base64), découpés pour rester sous 75 caractères.
function enTete(s) {
  s = String(s).replace(/[\r\n]+/g, ' ');
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const mots = [];
  let morceau = '';
  for (const c of s) {
    if (Buffer.byteLength(morceau + c) > 45) {
      mots.push(morceau);
      morceau = '';
    }
    morceau += c;
  }
  if (morceau) mots.push(morceau);
  return mots.map((m) => `=?UTF-8?B?${Buffer.from(m).toString('base64')}?=`).join('\r\n ');
}

// « Nom <adresse> » : seul le nom s'encode.
function adresse(s) {
  const m = String(s).match(/^\s*(.*?)\s*<([^<>\s]+)>\s*$/);
  return m && m[1] ? `${enTete(m[1].replace(/^"|"$/g, ''))} <${m[2]}>` : String(s).trim();
}

export function composerMessage({ de, a, objet, corps, date = new Date(), id }) {
  const domaine = String(a).match(/@([^>\s]+)/)?.[1] ?? 'localhost';
  const b64 = Buffer.from(corps.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(
    [
      `From: ${adresse(de)}`,
      `To: ${adresse(a)}`,
      `Subject: ${enTete(objet)}`,
      `Date: ${date.toUTCString().replace(/GMT$/, '+0000')}`,
      `Message-ID: <mmauto.${id}@${domaine}>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      'X-MMauto: note',
      '',
      b64.replace(/\r\n$/, ''),
      '',
    ].join('\r\n'),
    'utf8'
  );
}

// --- Les deux voies ------------------------------------------------------------------------------

// Tête de dictée : « note pour le bureau », « une note pour le bureau », « notes au bureau »…
// (la transcription écrit aussi « noter »).
const DIRECTE = /^\s*(?:une\s+)?not(?:e|es|er)\s+(?:pour\s+le|au)\s+bureau\b[\s:,.;!–—-]*/i;
// Confirmation d'une note proposée : toute la dictée, et rien d'autre.
const CONFIRMATION =
  /^\s*(?:(?:oui|ouais|ok(?:ay)?|d['’]accord|vas[- ]y|go|je confirme|confirm[eé]e?|c['’]est bon|c['’]est [cç]a|exact(?:ement)?|parfait|entendu|tr[eè]s bien|[cç]a marche|super|d[eé]pose[sz]?(?:[- ]la)?)[\s,.!]*)+(?:merci(?: beaucoup)?[\s.!]*)?$/i;
const ANNULATION =
  /^\s*(?:(?:non(?: merci)?|annule[rsz]?(?:[- ]la)?|laisse[sz]? tomber|(?:c['’]est )?pas la peine|oublie[sz]?(?:[- ]la)?)[\s,.!]*)+$/i;
const BLOC = /<note_bureau(?:\s+objet\s*=\s*"([^"]*)")?\s*>([\s\S]*?)<\/note_bureau\s*>/gi;
const NOTES_GARDEES = 50;

const CONSIGNE_DEFAUT =
  '\n\nNOTE POUR LE BUREAU. Seule exception à la lecture seule : le relais peut déposer une note dans la ' +
  "boîte de notes du conducteur, qui la traitera à l'arrêt. Rien n'est envoyé à personne. Si le conducteur " +
  'dicte lui-même « note pour le bureau : … », le relais la dépose sans vous. Quand il vous demande de noter ' +
  "ou de retenir quelque chose pour plus tard, ou une action que vous ne pouvez pas faire d'ici, proposez la " +
  'note en une seule phrase courte, qui la dit telle que vous la déposerez et finit par une question (« Je note ' +
  'pour le bureau : rappeler le garage pour le devis. Je la dépose ? »), puis terminez votre réponse par le ' +
  'bloc <note_bureau objet="objet en quelques mots">texte complet de la note, compréhensible sans la ' +
  "conversation</note_bureau>. Le bloc n'est pas lu à voix haute. Le relais ne dépose la note que si la dictée " +
  "suivante la confirme, et il le dit lui-même : ne dites jamais qu'une note est déposée. Si le conducteur la " +
  "corrige, proposez-la de nouveau avec un nouveau bloc. Un message qui commence par « [Relais : » vient du " +
  "relais, pas du conducteur : il dit ce qu'il a fait d'une note.";

export function creerNotes({ profil, fichierSecret, lireEtat, sauver, ajouter, journal, deposer = deposerImap }) {
  const P = profil.note;
  const fuseau = P.fuseau || profil.carnet?.fuseau || 'Europe/Paris';
  const attenteMs = (P.attenteMinutes ?? 10) * 60_000;
  const M = {
    ecoute: 'Je vous écoute : dictez la note pour le bureau.',
    deposee: 'Note déposée pour le bureau.',
    deposeeTexte: 'Note déposée pour le bureau : {texte}',
    abandon: 'Note abandonnée.',
    echec: "La note n'a pas pu être déposée. Elle reste dans le relais, on la reprendra au bureau.",
    ...(P.messages || {}),
  };
  let suspendu = null; // motif, après un refus d'authentification

  const etat = () => lireEtat();
  const filCourant = () => etat().fil?.id ?? null;

  function extrait(texte, max = 200) {
    const t = texte.replace(/\s+/g, ' ').trim();
    return t.length <= max ? t : t.slice(0, t.lastIndexOf(' ', max) > 0 ? t.lastIndexOf(' ', max) : max) + '…';
  }

  const ponctuer = (t) => (/[.!?…]$/.test(t) ? t : `${t}.`);

  function avis(texte) {
    const e = etat();
    (e.noteAvis ??= []).push(texte);
    sauver();
  }

  function lireSecret() {
    let st;
    try {
      st = fs.statSync(fichierSecret);
    } catch {
      throw new ErreurImap(`mot de passe IMAP absent (${fichierSecret})`);
    }
    if (st.mode & 0o077) throw new ErreurImap(`mot de passe IMAP lisible par d'autres comptes : chmod 600 ${fichierSecret}`);
    const s = fs.readFileSync(fichierSecret, 'utf8').trim();
    if (!s) throw new ErreurImap(`mot de passe IMAP vide (${fichierSecret})`);
    return s;
  }

  function corps(n) {
    const quand = new Date(n.heure).toLocaleString('fr-FR', { timeZone: fuseau, dateStyle: 'full', timeStyle: 'short' });
    const l = [n.texte, '', '-- ', `Note dictée en voiture le ${quand} (${fuseau}), déposée par le relais MMauto.`];
    if (n.voie === 'proposition') {
      l.push('Voie : proposée par la conversation, confirmée à voix haute par le conducteur.');
      if (n.dictee) l.push(`Dictée qui l'a demandée : « ${extrait(n.dictee, 1000)} »`);
    } else l.push('Voie : dictée directe (« note pour le bureau »), texte tel que transcrit.');
    l.push(
      `Conversation : fil ${n.fil ?? '?'}, message n° ${n.seq ?? '?'} de l'état du relais` +
        (n.session ? ` ; session Claude Code ${n.session} (claude --resume ${n.session}, dans ${profil.repertoire}).` : '.')
    );
    return l.join('\n');
  }

  async function deposerNote({ voie, texte, objet, dictee, seq }) {
    const e = etat();
    const n = {
      id: randomUUID(),
      heure: new Date().toISOString(),
      voie,
      objet: (objet || extrait(texte, 60)).replace(/[\r\n]+/g, ' ').trim(),
      texte: texte.slice(0, 4000),
      dictee: dictee ?? null,
      fil: e.fil?.id ?? null,
      session: e.fil?.session ?? null,
      seq: seq ?? null,
      statut: 'en cours',
    };
    e.notes = [...(e.notes ?? []), n].slice(-NOTES_GARDEES);
    sauver();
    try {
      if (suspendu) throw new ErreurImap(suspendu);
      const r = await deposer({
        hote: P.imap.hote,
        port: P.imap.port ?? 993,
        utilisateur: P.imap.utilisateur,
        motDePasse: lireSecret(),
        dossier: P.dossier || 'INBOX',
        message: composerMessage({
          de: P.de || P.imap.utilisateur,
          a: P.a || P.imap.utilisateur,
          objet: `${P.objet || 'Note de la voiture'} — ${n.objet}`,
          corps: corps(n),
          date: new Date(n.heure),
          id: n.id,
        }),
      });
      n.statut = 'déposée';
      n.dossier = P.dossier || 'INBOX';
      n.uid = r?.uid ?? null;
      journal('note déposée', n.id, `voie=${voie}`, `longueur=${n.texte.length}`, `uid=${n.uid ?? '?'}`);
      ajouter('note', voie === 'directe' ? M.deposeeTexte.replace('{texte}', ponctuer(extrait(n.texte))) : M.deposee, { note: n.id });
      avis(`note « ${n.objet} » déposée pour le bureau.`);
    } catch (err) {
      if (err.auth) suspendu = `dépôt suspendu jusqu'au redémarrage du relais : ${err.message}`;
      n.statut = 'échec';
      n.erreur = String(err.message).slice(0, 300);
      journal('note non déposée', n.id, n.erreur);
      ajouter('erreur', M.echec, { note: n.id });
      avis(`la note « ${n.objet} » n'a pas pu être déposée ; elle reste dans l'état du relais.`);
    }
    sauver();
    return n;
  }

  // Le dépôt se fait en tâche de fond : la dictée est acquittée tout de suite au téléphone.
  const enCours = new Set();
  function lancer(n) {
    const p = deposerNote(n).catch((e) => journal('note : erreur inattendue', e.message));
    enCours.add(p);
    p.finally(() => enCours.delete(p));
  }

  return {
    // Essais : attendre la fin des dépôts lancés.
    termine: () => Promise.all([...enCours]),

    consigne: () => (typeof P.consigne === 'string' ? `\n\n${P.consigne}` : CONSIGNE_DEFAUT),

    // Rend true si la dictée est prise par la note (la conversation ne la voit pas).
    intercepter(texte, m) {
      const e = etat();
      let enAttente = e.note ?? null;
      if (enAttente && (enAttente.fil !== filCourant() || Date.now() - Date.parse(enAttente.heure) > attenteMs)) {
        enAttente = null;
      }
      if (e.note) {
        e.note = null;
        sauver();
      }

      const d = texte.match(DIRECTE);
      if (d) {
        if (enAttente?.attente === 'confirmation') {
          avis(`la note proposée (« ${enAttente.objet || extrait(enAttente.texte, 60)} ») n'a pas été déposée : le conducteur a dicté la sienne.`);
        }
        const reste = texte.slice(d[0].length).trim();
        if (!reste) {
          e.note = { attente: 'texte', heure: new Date().toISOString(), fil: filCourant() };
          sauver();
          ajouter('note', M.ecoute);
        } else lancer({ voie: 'directe', texte: reste, seq: m?.seq });
        return true;
      }
      if (!enAttente) return false;

      if (enAttente.attente === 'texte') {
        if (ANNULATION.test(texte) || CONFIRMATION.test(texte)) ajouter('note', M.abandon);
        else lancer({ voie: 'directe', texte, seq: m?.seq });
        return true;
      }
      if (CONFIRMATION.test(texte)) {
        lancer({ voie: 'proposition', texte: enAttente.texte, objet: enAttente.objet, dictee: enAttente.dictee, seq: m?.seq });
        return true;
      }
      if (ANNULATION.test(texte)) {
        ajouter('note', M.abandon);
        avis(`la note proposée (« ${enAttente.objet || extrait(enAttente.texte, 60)} ») n'a pas été déposée : le conducteur l'a refusée.`);
        return true;
      }
      avis(`la note proposée (« ${enAttente.objet || extrait(enAttente.texte, 60)} ») n'a pas été déposée : la dictée qui suit ne la confirme pas.`);
      return false;
    },

    // Réponse de Claude : retire le bloc de note de ce qui sera lu et garde la note en attente
    // de confirmation. Rend { texte, extra }.
    extraire(reponse, filAuDepart) {
      if (!/<note_bureau\b/i.test(reponse)) return { texte: reponse };
      const blocs = [...reponse.matchAll(BLOC)];
      let dit = reponse.replace(BLOC, '');
      const ouvert = dit.search(/<note_bureau\b/i); // bloc tronqué : jamais lu, jamais déposé
      if (ouvert >= 0) dit = dit.slice(0, ouvert);
      dit = dit.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const dernier = blocs.at(-1);
      const texte = dernier?.[2].trim();
      if (!texte || filAuDepart !== filCourant()) return { texte: dit || M.abandon };

      const e = etat();
      const dictee = [...e.messages].reverse().find((x) => x.role === 'moi' && x.fil === filAuDepart)?.texte ?? null;
      const objet = dernier[1]?.trim() || null;
      e.note = { attente: 'confirmation', heure: new Date().toISOString(), fil: filAuDepart, objet, texte: texte.slice(0, 4000), dictee };
      sauver();
      if (!dit) dit = `Je note pour le bureau : ${extrait(texte)}`;
      if (!/\?\s*$/.test(dit)) dit = `${dit.replace(/[.!…\s]*$/, '.')} Je la dépose ?`;
      return { texte: dit, extra: { noteProposee: { objet, texte: e.note.texte } } };
    },

    // Avis du relais à joindre en tête de la prochaine dictée transmise à la conversation.
    prefixer(texte) {
      const e = etat();
      if (!e.noteAvis?.length) return texte;
      const p = e.noteAvis.map((a) => `[Relais : ${a}]`).join('\n');
      e.noteAvis = [];
      sauver();
      return `${p}\n${texte}`;
    },

    // Nouvelle conversation : la note en attente et les avis ne la suivent pas.
    oublier() {
      const e = etat();
      e.note = null;
      e.noteAvis = [];
      sauver();
    },
  };
}
