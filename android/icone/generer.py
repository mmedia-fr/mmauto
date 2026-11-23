#!/usr/bin/env python3
"""Icône de MMauto, au style de MMail et MMdedit.

Le fond en dégradé et le M rouge sont repris tels quels de l'icône de MMdedit
(mmedia-fr/mmdedit, packaging/), dont l'objet du bas (la page) est effacé et
remplacé par une voiture vue de face, blanche à touches bleu ciel comme
l'enveloppe de MMail et la page de MMdedit.

Usage : generer.py <dossier des PNG de MMdedit> <dossier res/ de destination> [aperçu.png]
Le dossier source contient mmdedit-512.png, ic_launcher-<densité>.png et
ic_launcher_foreground-<densité>.png.
"""
import math
import os
import sys
from PIL import Image, ImageDraw

ROUGE = (239, 52, 53, 255)      # M, mesuré sur l'icône de MMdedit
CIEL = (23, 180, 231, 255)      # #17B4E7, touches de l'enveloppe et de la page
MARINE = (11, 34, 95, 255)      # filets sombres
BLANC = (255, 255, 255, 255)
DENSITES = ('mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi')
SUR = 4                          # suréchantillonnage du dessin


def arrondi(points, r, pas=6):
    """Polygone aux sommets arrondis (rayon r), pour un trait plat sans angle vif."""
    n = len(points)
    sortie = []
    for i in range(n):
        p0, p1, p2 = points[i - 1], points[i], points[(i + 1) % n]
        v1 = (p0[0] - p1[0], p0[1] - p1[1])
        v2 = (p2[0] - p1[0], p2[1] - p1[1])
        l1, l2 = math.hypot(*v1), math.hypot(*v2)
        u1, u2 = (v1[0] / l1, v1[1] / l1), (v2[0] / l2, v2[1] / l2)
        a = min(r, l1 / 2, l2 / 2)
        d1 = (p1[0] + u1[0] * a, p1[1] + u1[1] * a)
        d2 = (p1[0] + u2[0] * a, p1[1] + u2[1] * a)
        for k in range(pas + 1):  # courbe de Bézier quadratique d1 → p1 → d2
            t = k / pas
            sortie.append((
                (1 - t) ** 2 * d1[0] + 2 * (1 - t) * t * p1[0] + t * t * d2[0],
                (1 - t) ** 2 * d1[1] + 2 * (1 - t) * t * p1[1] + t * t * d2[1],
            ))
    return sortie


def voiture(taille):
    """Calque RGBA de la voiture, dessiné dans le repère 512 de l'icône."""
    k = taille * SUR / 512
    c = Image.new('RGBA', (taille * SUR, taille * SUR), (0, 0, 0, 0))
    d = ImageDraw.Draw(c)

    def poly(pts, couleur, r):
        d.polygon([(x * k, y * k) for x, y in arrondi(pts, r)], fill=couleur)

    def rect(x0, y0, x1, y1, couleur, r):
        d.rounded_rectangle([x0 * k, y0 * k, x1 * k, y1 * k], radius=r * k, fill=couleur)

    rect(132, 404, 186, 448, BLANC, 11)                  # roues
    rect(326, 404, 380, 448, BLANC, 11)
    rect(102, 338, 132, 358, BLANC, 8)                   # rétroviseurs
    rect(380, 338, 410, 358, BLANC, 8)
    poly([(184, 300), (328, 300), (364, 356), (148, 356)], BLANC, 18)   # habitacle
    rect(110, 344, 402, 420, BLANC, 24)                  # caisse
    poly([(196, 314), (316, 314), (342, 346), (170, 346)], CIEL, 7)     # pare-brise
    rect(134, 364, 196, 390, CIEL, 12)                   # phares
    rect(316, 364, 378, 390, CIEL, 12)
    rect(214, 366, 298, 390, MARINE, 9)                  # calandre
    rect(142, 400, 370, 407, MARINE, 3)                  # pare-chocs
    return c.resize((taille, taille), Image.LANCZOS)


def maitre(source512):
    """Icône 512 : fond et M de MMdedit, page effacée, voiture dessinée."""
    im = Image.open(source512).convert('RGBA')
    px = im.load()
    # Effacer la page : chaque ligne reprend le dégradé, interpolé entre les deux bords.
    x0, x1, y0, y1 = 96, 416, 292, 462
    for y in range(y0, y1):
        g, dr = px[x0 - 6, y], px[x1 + 6, y]
        for x in range(x0, x1):
            t = (x - x0) / (x1 - x0)
            px[x, y] = tuple(round(g[i] * (1 - t) + dr[i] * t) for i in range(3)) + (255,)
    # Rendre aux jambages et à la pointe du M le bas que la page recouvrait.
    k = SUR
    m = Image.new('RGBA', (512 * k, 512 * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([109 * k, 270 * k, 162.5 * k, 300 * k], radius=3 * k, fill=ROUGE)
    d.rounded_rectangle([347.5 * k, 270 * k, 401 * k, 300 * k], radius=3 * k, fill=ROUGE)
    pente = 0.528
    pts = []
    for y in (270, 300):
        g = 164 + pente * (y - 157)
        pts.append((g, y))
    pts += [(511 - pts[1][0], 300), (511 - pts[0][0], 270)]
    d.polygon([(x * k, y * k) for x, y in pts], fill=ROUGE)
    im.alpha_composite(m.resize((512, 512), Image.LANCZOS))
    im.alpha_composite(voiture(512))
    return im


def boite_m(im):
    px = im.load()
    W, H = im.size
    pts = [(x, y) for y in range(H) for x in range(W)
           if px[x, y][0] > 200 and px[x, y][1] < 90 and px[x, y][3] > 200]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def main():
    src, dest = sys.argv[1], sys.argv[2]
    m512 = maitre(os.path.join(src, 'mmdedit-512.png'))
    bm = boite_m(Image.open(os.path.join(src, 'mmdedit-512.png')).convert('RGBA'))
    for dens in DENSITES:
        os.makedirs(os.path.join(dest, f'mipmap-{dens}'), exist_ok=True)
        # Icône d'avant Android 8 : l'icône entière, réduite.
        n = Image.open(os.path.join(src, f'ic_launcher-{dens}.png')).size[0]
        m512.resize((n, n), Image.LANCZOS).save(os.path.join(dest, f'mipmap-{dens}', 'ic_launcher.png'))
        # Premier plan de l'icône adaptative : celui de MMdedit (fond prolongé jusqu'aux
        # bords), sur lequel l'icône réduite vient se poser à la place exacte de la sienne.
        fg = Image.open(os.path.join(src, f'ic_launcher_foreground-{dens}.png')).convert('RGBA')
        bf = boite_m(fg)
        s = (bf[2] - bf[0] + 1) / (bm[2] - bm[0] + 1)
        t = round(512 * s)
        ox, oy = round(bf[0] - bm[0] * s), round(bf[1] - bm[1] * s)
        fg.alpha_composite(m512.resize((t, t), Image.LANCZOS), (ox, oy))
        fg.save(os.path.join(dest, f'mipmap-{dens}', 'ic_launcher_foreground.png'))
    if len(sys.argv) > 3:
        m512.save(sys.argv[3])


if __name__ == '__main__':
    main()
