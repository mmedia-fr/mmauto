package fr.mmedia.claudevoiture

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors

/**
 * Relevé de diagnostic envoyé au relais : ce que voit l'application (veille, connexion à la
 * voiture, ouverture d'un trajet ou raison de ne pas l'ouvrir), jamais le contenu des
 * messages ni les positions. Il dit, par exemple, pourquoi un trajet n'a pas été ouvert.
 *
 * Les lignes attendent le réseau dans le stockage privé ([MAX] au plus, les plus anciennes
 * tombent) et partent par lots, dans l'ordre. Le relais les écrit dans son journal.
 */
object Diag {
    private const val TAG = "MMautoDiag"
    private const val MAX = 300
    private const val LOT = 25
    private val verrou = Any()
    private val envoi = Executors.newSingleThreadExecutor()

    fun noter(ctx: Context, texte: String) {
        Log.i(TAG, texte)
        val app = ctx.applicationContext
        synchronized(verrou) {
            val r = Reglages(app)
            val n = r.diagNumero + 1
            r.diagNumero = n
            val f = JSONArray(r.fileDiag)
            while (f.length() >= MAX) f.remove(0)
            f.put(JSONObject().put("n", n).put("heure", Carnet.iso(System.currentTimeMillis())).put("texte", texte.take(300)))
            r.fileDiag = f.toString()
        }
        envoi.execute { envoyerSync(app) }
    }

    fun enAttente(ctx: Context): Boolean = synchronized(verrou) { JSONArray(Reglages(ctx).fileDiag).length() > 0 }

    /** Envoie le relevé en attente ; le garde tant que le relais ne l'a pas reçu. */
    fun envoyerSync(ctx: Context) {
        val r = Reglages(ctx)
        if (!r.configure) return
        while (true) {
            val lot = synchronized(verrou) {
                val f = JSONArray(r.fileDiag)
                JSONArray().also { l -> for (i in 0 until minOf(LOT, f.length())) l.put(f.get(i)) }
            }
            if (lot.length() == 0) return
            val code = try {
                Relais(r).diag(lot)
            } catch (e: IOException) {
                return
            }
            // 400 : lot illisible pour le relais, le garder bloquerait les suivants.
            if (code !in 200..299 && code != 400) return
            val dernier = lot.getJSONObject(lot.length() - 1).getLong("n")
            synchronized(verrou) {
                val f = JSONArray(r.fileDiag)
                val reste = JSONArray()
                for (i in 0 until f.length()) f.getJSONObject(i).let { if (it.getLong("n") > dernier) reste.put(it) }
                r.fileDiag = reste.toString()
            }
        }
    }
}
