package fr.mmedia.claudevoiture

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Message tel que le relais le rend. Rôles : moi, claude, carnet, etat, avis, erreur.
 * [trajet] et [question] : question du carnet de route à laquelle répondre.
 */
data class MessageRelais(
    val seq: Long,
    val role: String,
    val texte: String,
    val trajet: String? = null,
    val question: String? = null,
)

data class Lecture(val messages: List<MessageRelais>, val dernier: Long, val enCours: Boolean)

/** Client du relais. Appels bloquants : jamais sur le fil principal. */
class Relais(private val reglages: Reglages) {

    private fun ouvrir(chemin: String, methode: String, delaiLectureMs: Int): HttpURLConnection {
        val base = reglages.url.trimEnd('/')
        val c = URL("$base/$chemin").openConnection() as HttpURLConnection
        c.requestMethod = methode
        c.connectTimeout = 15_000
        c.readTimeout = delaiLectureMs
        c.setRequestProperty("X-Voiture-Jeton", reglages.jeton)
        c.setRequestProperty("Accept", "application/json")
        return c
    }

    private fun lire(c: HttpURLConnection): JSONObject {
        val code = c.responseCode
        val flux = if (code in 200..299) c.inputStream else c.errorStream
        val corps = flux?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        c.disconnect()
        if (code !in 200..299) throw IOException("relais : HTTP $code")
        return if (corps.isBlank()) JSONObject() else JSONObject(corps)
    }

    private fun poster(c: HttpURLConnection, corps: JSONObject) {
        c.doOutput = true
        c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
        c.outputStream.use { it.write(corps.toString().toByteArray(Charsets.UTF_8)) }
    }

    fun sante(): Boolean = lire(ouvrir("v1/sante", "GET", 10_000)).optBoolean("ok")

    fun etat(): JSONObject = lire(ouvrir("v1/etat", "GET", 10_000))

    fun envoyer(texte: String): Long {
        val c = ouvrir("v1/messages", "POST", 20_000)
        poster(c, JSONObject().put("texte", texte))
        return lire(c).optLong("seq")
    }

    fun nouveauFil(): Long = lire(ouvrir("v1/fil", "POST", 20_000).apply { doOutput = true; outputStream.close() }).optLong("seq")

    /** Événement du carnet de route. Rend le code HTTP ; réseau injoignable : IOException. */
    fun trajet(evenement: JSONObject): Int {
        val c = ouvrir("v1/trajets", "POST", 20_000)
        poster(c, evenement)
        val code = c.responseCode
        runCatching { (if (code in 200..299) c.inputStream else c.errorStream)?.close() }
        c.disconnect()
        return code
    }

    /** Lot du relevé de diagnostic. Rend le code HTTP ; réseau injoignable : IOException. */
    fun diag(lignes: JSONArray): Int {
        val c = ouvrir("v1/diag", "POST", 20_000)
        poster(c, JSONObject().put("lignes", lignes))
        val code = c.responseCode
        runCatching { (if (code in 200..299) c.inputStream else c.errorStream)?.close() }
        c.disconnect()
        return code
    }

    /** Carnet de route d'un mois (AAAA-MM), en CSV. */
    fun carnet(mois: String): ByteArray {
        val c = ouvrir("v1/carnet?mois=$mois", "GET", 30_000)
        c.setRequestProperty("Accept", "text/csv")
        val code = c.responseCode
        if (code !in 200..299) {
            runCatching { c.errorStream?.close() }
            c.disconnect()
            throw IOException("relais : HTTP $code")
        }
        val octets = c.inputStream.use { it.readBytes() }
        c.disconnect()
        return octets
    }

    /** Interrogation longue : le relais garde la requête ouverte jusqu'à [attenteS] secondes. */
    fun messages(apres: Long, attenteS: Int): Lecture {
        val r = lire(ouvrir("v1/messages?apres=$apres&attente=$attenteS", "GET", (attenteS + 20) * 1000))
        val t = r.optJSONArray("messages")
        val liste = buildList {
            if (t != null) for (i in 0 until t.length()) {
                val m = t.getJSONObject(i)
                add(
                    MessageRelais(
                        m.getLong("seq"), m.getString("role"), m.getString("texte"),
                        m.optString("trajet").ifEmpty { null }, m.optString("question").ifEmpty { null }
                    )
                )
            }
        }
        return Lecture(liste, r.optLong("dernier", apres), r.optBoolean("enCours"))
    }
}
