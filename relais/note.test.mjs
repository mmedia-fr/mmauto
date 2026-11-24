// Essais de la note pour le bureau, sans réseau ni boîte réelle : node --test relais/note.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { utf7Imap, composerMessage, deposerImap, creerNotes } from './note.mjs';

test('nom de dossier en UTF-7 modifié', () => {
  assert.equal(utf7Imap('Notes de la voiture'), 'Notes de la voiture');
  assert.equal(utf7Imap('Brouillon préparé'), 'Brouillon pr&AOk-par&AOk-');
  assert.equal(utf7Imap('A&B'), 'A&-B');
});

test('message : en-têtes, objet encodé, corps en base64 CRLF', () => {
  const brut = composerMessage({
    de: 'MMauto <notes@exemple.fr>',
    a: 'notes@exemple.fr',
    objet: 'Note de la voiture — rappeler le garage pour le devis',
    corps: 'ligne 1\nligne 2 é',
    date: new Date('2026-11-24T15:04:05Z'),
    id: 'abc',
  }).toString('utf8');
  const [tete, corps] = brut.split('\r\n\r\n');
  assert.match(tete, /^From: MMauto <notes@exemple\.fr>\r\n/);
  assert.match(tete, /\r\nDate: Tue, 24 Nov 2026 15:04:05 \+0000\r\n/);
  assert.match(tete, /\r\nMessage-ID: <mmauto\.abc@exemple\.fr>\r\n/);
  assert.match(tete, /\r\nSubject: =\?UTF-8\?B\?/);
  assert.ok(!/[^\x00-\x7f]/.test(brut), 'message entièrement ASCII');
  const objet = tete
    .match(/Subject: ([\s\S]*?)\r\n(?=\S)/)[1]
    .split(/\r\n /)
    .map((m) => Buffer.from(m.match(/=\?UTF-8\?B\?(.*)\?=/)[1], 'base64').toString('utf8'))
    .join('');
  assert.equal(objet, 'Note de la voiture — rappeler le garage pour le devis');
  assert.equal(Buffer.from(corps.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'ligne 1\r\nligne 2 é');
});

// Serveur IMAP d'essai : juste ce qu'il faut pour LOGIN, APPEND (littéral synchronisé),
// CREATE, SUBSCRIBE et LOGOUT. `motDePasse` attendu ; le dossier n'existe qu'après CREATE.
function serveurImap({ motDePasse, dossierExiste = false }) {
  const recu = { commandes: [], depots: [] };
  const srv = net.createServer((s) => {
    let tampon = Buffer.alloc(0);
    let litteral = null; // { tag, dossier, taille }
    s.write('* OK [CAPABILITY IMAP4rev1] essai prêt\r\n');
    s.on('data', (d) => {
      tampon = Buffer.concat([tampon, d]);
      for (;;) {
        if (litteral) {
          if (tampon.length < litteral.taille + 2) return;
          const corps = tampon.subarray(0, litteral.taille);
          tampon = tampon.subarray(litteral.taille + 2);
          recu.depots.push({ dossier: litteral.dossier, corps: corps.toString('utf8') });
          s.write(`${litteral.tag} OK [APPENDUID 1 ${recu.depots.length + 6}] Append completed.\r\n`);
          litteral = null;
          continue;
        }
        const i = tampon.indexOf('\r\n');
        if (i < 0) return;
        const l = tampon.subarray(0, i).toString('utf8');
        tampon = tampon.subarray(i + 2);
        recu.commandes.push(l.replace(/^(\w+ LOGIN "[^"]*") .*/, '$1 ***'));
        const [tag, cmd] = l.split(' ');
        if (cmd === 'LOGIN') {
          s.write(l.endsWith(`"${motDePasse}"`) ? `${tag} OK Logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Authentication failed.\r\n`);
        } else if (cmd === 'APPEND') {
          const m = l.match(/^\w+ APPEND "([^"]*)" \(\) \{(\d+)\}$/);
          if (!dossierExiste) s.write(`${tag} NO [TRYCREATE] Mailbox doesn't exist: ${m[1]}\r\n`);
          else {
            litteral = { tag, dossier: m[1], taille: Number(m[2]) };
            s.write('+ OK\r\n');
          }
        } else if (cmd === 'CREATE') {
          dossierExiste = true;
          s.write(`${tag} OK Create completed.\r\n`);
        } else if (cmd === 'SUBSCRIBE') s.write(`${tag} OK Subscribe completed.\r\n`);
        else if (cmd === 'LOGOUT') {
          s.write(`* BYE Logging out\r\n${tag} OK Logout completed.\r\n`);
          s.end();
        } else s.write(`${tag} BAD inconnu\r\n`);
      }
    });
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok({ srv, recu, port: srv.address().port })));
}

test('dépôt IMAP : dossier créé à la demande, message intact', async () => {
  const { srv, recu, port } = await serveurImap({ motDePasse: 'bon-mot' });
  const message = composerMessage({ de: 'a@b.fr', a: 'a@b.fr', objet: 'Essai', corps: 'Texte é\n', id: 'x' });
  const r = await deposerImap({
    utilisateur: 'a@b.fr',
    motDePasse: 'bon-mot',
    dossier: 'Brouillon préparé',
    message,
    connecter: () => net.connect(port, '127.0.0.1'),
  });
  srv.close();
  assert.deepEqual(r, { uid: 7 });
  assert.deepEqual(
    recu.commandes.map((c) => c.split(' ').slice(1, 2)[0]),
    ['LOGIN', 'APPEND', 'CREATE', 'SUBSCRIBE', 'APPEND', 'LOGOUT']
  );
  assert.equal(recu.depots.length, 1);
  assert.equal(recu.depots[0].dossier, 'Brouillon pr&AOk-par&AOk-');
  assert.equal(recu.depots[0].corps, message.toString('utf8'));
});

test('dépôt IMAP : mot de passe refusé, aucun dépôt, erreur marquée « auth »', async () => {
  const { srv, recu, port } = await serveurImap({ motDePasse: 'bon-mot', dossierExiste: true });
  await assert.rejects(
    deposerImap({ utilisateur: 'a@b.fr', motDePasse: 'faux', dossier: 'INBOX', message: 'x', connecter: () => net.connect(port, '127.0.0.1') }),
    (e) => e.auth === true && !e.message.includes('faux')
  );
  srv.close();
  assert.equal(recu.depots.length, 0);
});

// --- Les deux voies, avec un dépôt simulé -------------------------------------------------

function banc({ deposer, modeSecret = 0o600 } = {}) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'mmauto-note-'));
  const secret = path.join(dossier, 'secret');
  fs.writeFileSync(secret, 'mot-de-passe\n', { mode: modeSecret });
  fs.chmodSync(secret, modeSecret);
  const etat = { seq: 0, fil: { id: 'fil-1', session: 'sess-1' }, messages: [] };
  const lus = [];
  const depots = [];
  const ajouter = (role, texte, extra = {}) => {
    const m = { seq: ++etat.seq, role, texte, fil: etat.fil.id, ...extra };
    etat.messages.push(m);
    if (role !== 'moi') lus.push({ role, texte });
    return m;
  };
  const notes = creerNotes({
    profil: {
      repertoire: '/projet',
      note: { imap: { hote: 'imap.exemple.fr', utilisateur: 'notes@exemple.fr' }, dossier: 'Notes de la voiture', objet: 'Note de la voiture' },
    },
    fichierSecret: secret,
    lireEtat: () => etat,
    sauver: () => {},
    ajouter,
    journal: () => {},
    deposer:
      deposer ??
      (async (o) => {
        depots.push(o);
        return { uid: 42 };
      }),
  });
  const dicter = (texte) => notes.intercepter(texte, ajouter('moi', texte));
  return { notes, etat, lus, depots, dicter };
}

const corpsDe = (depot) => Buffer.from(depot.message.toString('utf8').split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');

test('dictée directe : déposée sans la conversation, relue, signalée à la conversation', async () => {
  const b = banc();
  assert.equal(b.dicter('Note pour le bureau : rappeler le garage pour le devis'), true);
  await b.notes.termine();
  assert.equal(b.depots.length, 1);
  assert.equal(b.depots[0].dossier, 'Notes de la voiture');
  assert.equal(b.depots[0].motDePasse, 'mot-de-passe');
  assert.match(corpsDe(b.depots[0]), /^rappeler le garage pour le devis\r\n/);
  assert.match(corpsDe(b.depots[0]), /session Claude Code sess-1/);
  assert.deepEqual(b.lus.at(-1), { role: 'note', texte: 'Note déposée pour le bureau : rappeler le garage pour le devis.' });
  assert.equal(b.etat.notes[0].statut, 'déposée');
  assert.equal(b.etat.notes[0].uid, 42);
  assert.equal(b.notes.prefixer('bonjour'), '[Relais : note « rappeler le garage pour le devis » déposée pour le bureau.]\nbonjour');
  assert.equal(b.notes.prefixer('encore'), 'encore');
});

test('dictée directe en deux temps, et annulation', async () => {
  const b = banc();
  assert.equal(b.dicter('notes pour le bureau.'), true);
  assert.equal(b.lus.at(-1).texte, 'Je vous écoute : dictez la note pour le bureau.');
  assert.equal(b.dicter('Commander deux disques pour le NAS'), true);
  await b.notes.termine();
  assert.equal(b.depots.length, 1);
  assert.equal(b.dicter('note pour le bureau'), true);
  assert.equal(b.dicter('non'), true);
  assert.equal(b.lus.at(-1).texte, 'Note abandonnée.');
  assert.equal(b.dicter('quelle heure est-il ?'), false);
  assert.equal(b.depots.length, 1);
});

test('proposition de la conversation : bloc retiré, dépôt seulement après « oui »', async () => {
  const b = banc();
  b.dicter('faudra rappeler le garage pour le devis');
  const lu = b.notes.extraire(
    'Je note pour le bureau : rappeler le garage pour le devis. Je la dépose ?\n\n<note_bureau objet="Rappeler le garage">Rappeler le garage pour le devis de jeudi.</note_bureau>',
    'fil-1'
  );
  assert.equal(lu.texte, 'Je note pour le bureau : rappeler le garage pour le devis. Je la dépose ?');
  assert.deepEqual(lu.extra.noteProposee, { objet: 'Rappeler le garage', texte: 'Rappeler le garage pour le devis de jeudi.' });
  assert.equal(b.depots.length, 0);
  assert.equal(b.dicter('Oui, vas-y.'), true);
  await b.notes.termine();
  assert.equal(b.depots.length, 1);
  const c = corpsDe(b.depots[0]);
  assert.match(c, /^Rappeler le garage pour le devis de jeudi\.\r\n/);
  assert.match(c, /Dictée qui l'a demandée : « faudra rappeler le garage pour le devis »/);
  assert.match(b.depots[0].message.toString('utf8'), /\r\nSubject: =\?UTF-8\?B\?/);
  assert.equal(b.lus.at(-1).texte, 'Note déposée pour le bureau.');
});

test('proposition : une autre dictée l’abandonne et la conversation le sait ; « non » l’annule', () => {
  const b = banc();
  b.notes.extraire('<note_bureau objet="A">Texte A</note_bureau>', 'fil-1');
  assert.equal(b.dicter('non, plutôt le mettre pour vendredi'), false);
  assert.match(b.notes.prefixer('x'), /^\[Relais : la note proposée \(« A »\) n'a pas été déposée : la dictée qui suit ne la confirme pas\.\]\nx$/);
  assert.equal(b.dicter('oui'), false, 'plus rien en attente');
  const lu = b.notes.extraire('Texte seul, sans question.<note_bureau>Texte B</note_bureau>', 'fil-1');
  assert.equal(lu.texte, 'Texte seul, sans question. Je la dépose ?');
  assert.equal(b.dicter('non merci'), true);
  assert.equal(b.lus.at(-1).texte, 'Note abandonnée.');
  assert.equal(b.depots.length, 0);
});

test('proposition : bloc tronqué jamais lu ni déposé ; autre fil ignoré ; réponse sans bloc intacte', () => {
  const b = banc();
  assert.equal(b.notes.extraire('Voilà.\n<note_bureau objet="A">début coupé', 'fil-1').texte, 'Voilà.');
  assert.equal(b.etat.note ?? null, null);
  b.notes.extraire('Ok. <note_bureau>Texte</note_bureau>', 'autre-fil');
  assert.equal(b.etat.note ?? null, null);
  const brut = 'Réponse ordinaire.\n\n  Deuxième paragraphe.';
  assert.equal(b.notes.extraire(brut, 'fil-1').texte, brut);
});

test('refus du mot de passe : dépôt suspendu, plus aucune tentative', async () => {
  let essais = 0;
  const b = banc({
    deposer: async () => {
      essais++;
      throw Object.assign(new Error('authentification IMAP refusée'), { auth: true });
    },
  });
  b.dicter('note pour le bureau : un');
  await b.notes.termine();
  b.dicter('note pour le bureau : deux');
  await b.notes.termine();
  assert.equal(essais, 1);
  assert.deepEqual(b.etat.notes.map((n) => n.statut), ['échec', 'échec']);
  assert.match(b.etat.notes[1].erreur, /suspendu/);
  assert.equal(b.lus.at(-1).role, 'erreur');
});

test('fichier du mot de passe lisible par d’autres : refusé', async () => {
  const b = banc({ modeSecret: 0o644 });
  b.dicter('note pour le bureau : un');
  await b.notes.termine();
  assert.equal(b.depots.length, 0);
  assert.match(b.etat.notes[0].erreur, /chmod 600/);
});
