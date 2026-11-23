package fr.mmedia.claudevoiture

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Avis de nouvelle version, comme MMail et MMdedit sous Android : l'application demande à
 * l'API de GitHub la dernière publication de son dépôt public. Si son numéro est plus récent
 * que le sien, elle l'annonce (notification, et bouton à l'écran) ; l'un et l'autre ouvrent la
 * page de la publication, d'où l'APK se télécharge. Rien ne s'installe seul, et rien d'autre
 * que cette demande n'est envoyé.
 *
 * Au démarrage de la veille, puis une fois par jour, jamais en voiture. Seules comptent les
 * publications numérotées vX.Y.Z (ni brouillon ni préversion : l'API ne les rend pas comme
 * « dernière »).
 */
object MiseAJour {
    const val DEPOT = "mmedia-fr/mmauto"
    const val CANAL = "mises_a_jour"
    private const val API = "https://api.github.com/repos/$DEPOT/releases/latest"
    private const val TAG = "MMautoMaj"
    private const val ID_NOTIF = 3
    private const val INTERVALLE = 24 * 3600_000L
    private val enCours = AtomicBoolean(false)

    fun versionActuelle(ctx: Context): String =
        runCatching { ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName }.getOrNull() ?: "0"

    fun page(version: String) = "https://github.com/$DEPOT/releases/tag/v$version"

    /** Numéro d'une étiquette « vX.Y.Z » entièrement numérique, null sinon. */
    fun numero(etiquette: String): List<Int>? =
        Regex("""^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})$""").matchEntire(etiquette)?.groupValues?.drop(1)?.map { it.toInt() }

    /** Vrai si la version [a] (« X.Y.Z ») est plus récente que [b]. */
    fun plusRecente(a: String, b: String): Boolean {
        val x = numero("v$a") ?: return false
        val y = numero("v${b.substringBefore('-')}") ?: return true
        for (i in 0..2) if (x[i] != y[i]) return x[i] > y[i]
        return false
    }

    /** Version plus récente déjà signalée par GitHub, null s'il n'y en a pas. */
    fun disponible(ctx: Context): String? =
        Reglages(ctx).versionDisponible.takeIf { it.isNotEmpty() && plusRecente(it, versionActuelle(ctx)) }

    /**
     * Interroge GitHub en arrière-plan si la dernière réponse date de plus d'un jour ;
     * [ensuite] est appelé, hors du fil principal, une fois la réponse traitée.
     */
    fun verifierSiDu(ctx: Context, ensuite: (() -> Unit)? = null) {
        val app = ctx.applicationContext
        if (System.currentTimeMillis() - Reglages(app).majVerifiee < INTERVALLE) return
        if (!enCours.compareAndSet(false, true)) return
        thread(name = "mise-a-jour") {
            try {
                verifierSync(app)
                ensuite?.invoke()
            } catch (e: Exception) {
                // Pas de réseau, GitHub indisponible : nouvel essai à la prochaine occasion.
                Log.w(TAG, "vérification impossible : ${e.message}")
            } finally {
                enCours.set(false)
            }
        }
    }

    private fun verifierSync(ctx: Context) {
        val actuelle = versionActuelle(ctx)
        val c = URL(API).openConnection() as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 15_000
        c.setRequestProperty("Accept", "application/vnd.github+json")
        c.setRequestProperty("User-Agent", "MMauto/$actuelle")
        val code = c.responseCode
        val r = Reglages(ctx)
        if (code == 404) {
            // Aucune publication encore : rien à proposer.
            r.majVerifiee = System.currentTimeMillis()
            r.versionDisponible = ""
            return
        }
        if (code != 200) error("HTTP $code")
        val o = JSONObject(c.inputStream.bufferedReader().use { it.readText() })
        r.majVerifiee = System.currentTimeMillis()
        val etiquette = o.optString("tag_name")
        val v = etiquette.removePrefix("v")
        if (o.optBoolean("draft") || o.optBoolean("prerelease") || numero(etiquette) == null || !plusRecente(v, actuelle)) {
            r.versionDisponible = ""
            return
        }
        r.versionDisponible = v
        if (r.versionAnnoncee != v) {
            r.versionAnnoncee = v
            Diag.noter(ctx, "version $v disponible (installée : $actuelle)")
            annoncer(ctx, v)
        }
    }

    /** Une seule notification par version ; le bouton de l'écran reste jusqu'à l'installation. */
    private fun annoncer(ctx: Context, v: String) {
        val ouvrir = PendingIntent.getActivity(
            ctx, ID_NOTIF, Intent(Intent.ACTION_VIEW, Uri.parse(page(v))), PendingIntent.FLAG_IMMUTABLE
        )
        val n = NotificationCompat.Builder(ctx, CANAL)
            .setSmallIcon(R.drawable.ic_claude)
            .setContentTitle("MMauto $v disponible")
            .setContentText("Touchez pour ouvrir la page de la version et télécharger l'APK.")
            .setContentIntent(ouvrir)
            .setAutoCancel(true)
            .build()
        runCatching { NotificationManagerCompat.from(ctx).notify(ID_NOTIF, n) }
            .onFailure { Log.w(TAG, "notification refusée : ${it.message}") }
    }

    fun ouvrirPage(ctx: Context, v: String) {
        runCatching {
            ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(page(v))).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }
}
