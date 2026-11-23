package fr.mmedia.claudevoiture

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONArray
import org.json.JSONObject

/**
 * La conversation avec Claude, présentée comme une messagerie : une notification
 * MessagingStyle avec une action « Répondre » (dictée) et une action « Marquer comme lu ».
 * C'est la forme qu'Android Auto lit à voix haute et à laquelle il fait répondre par la voix.
 */
object Conversation {
    const val CANAL = "conversation"
    const val CANAL_VEILLE = "veille"
    const val ID_NOTIF = 1
    const val CLE_REPONSE = "reponse"
    const val ACTION_REPONDRE = "fr.mmedia.claudevoiture.REPONDRE"
    const val ACTION_LU = "fr.mmedia.claudevoiture.LU"
    private const val GARDES = 12

    /**
     * [lu] : déjà entendu en voiture. [provisoire] : avis d'attente du relais
     * (« Je regarde, la réponse arrive. »), qui s'efface devant la réponse.
     */
    data class Ligne(
        val deMoi: Boolean,
        val texte: String,
        val heure: Long,
        val lu: Boolean = true,
        val provisoire: Boolean = false,
    )

    fun canaux(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CANAL, "Conversation avec Claude", NotificationManager.IMPORTANCE_HIGH)
        )
        nm.createNotificationChannel(
            NotificationChannel(CANAL_VEILLE, "Veille", NotificationManager.IMPORTANCE_MIN).apply {
                setShowBadge(false)
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(MiseAJour.CANAL, "Nouvelles versions", NotificationManager.IMPORTANCE_DEFAULT)
        )
    }

    @Synchronized
    fun lignes(ctx: Context): List<Ligne> {
        val t = JSONArray(Reglages(ctx).historique)
        return (0 until t.length()).map {
            val o = t.getJSONObject(it)
            // Historique de la 0.1.0, sans « lu » : compté comme entendu, rien n'est
            // relu après la mise à jour.
            Ligne(
                o.getBoolean("moi"), o.getString("texte"), o.getLong("heure"),
                o.optBoolean("lu", true), o.optBoolean("provisoire", false)
            )
        }
    }

    @Synchronized
    fun ajouter(ctx: Context, deMoi: Boolean, texte: String, alerter: Boolean, provisoire: Boolean = false) {
        var liste = lignes(ctx)
        liste = when {
            // Le conducteur répond : tout ce qui précède a été entendu.
            deMoi -> liste.map { it.copy(lu = true) }
            // La réponse arrive : l'avis d'attente n'est plus à lire.
            !provisoire -> liste.map { if (it.provisoire) it.copy(lu = true) else it }
            else -> liste
        }
        liste = (liste + Ligne(deMoi, texte, System.currentTimeMillis(), lu = deMoi, provisoire = provisoire))
            .takeLast(GARDES)
        enregistrer(ctx, liste)
        afficher(ctx, silencieux = !alerter)
    }

    /** « Marquer comme lu » (Android Auto, après lecture) : plus rien à relire. */
    @Synchronized
    fun marquerLu(ctx: Context) {
        enregistrer(ctx, lignes(ctx).map { it.copy(lu = true) })
        afficher(ctx, silencieux = true)
    }

    private fun enregistrer(ctx: Context, liste: List<Ligne>) {
        val t = JSONArray()
        liste.forEach {
            t.put(
                JSONObject().put("moi", it.deMoi).put("texte", it.texte).put("heure", it.heure)
                    .put("lu", it.lu).put("provisoire", it.provisoire)
            )
        }
        Reglages(ctx).historique = t.toString()
    }

    @Synchronized
    fun afficher(ctx: Context, silencieux: Boolean) {
        val nm = NotificationManagerCompat.from(ctx)
        if (!nm.areNotificationsEnabled()) return
        val moi = Person.Builder().setName("Moi").setKey("moi").build()
        val claude = Person.Builder()
            .setName("Claude")
            .setKey("claude")
            .setBot(true)
            .setIcon(IconCompat.createWithResource(ctx, R.drawable.ic_lanceur))
            .build()

        val style = NotificationCompat.MessagingStyle(moi).setGroupConversation(false)
        // Android Auto lit tous les messages de Claude que porte la notification. Elle ne
        // porte donc que ce qui suit la dernière réponse déjà entendue (0.1.1) : la 0.1.0
        // y remettait les douze derniers messages, relus en entier à chaque réponse.
        // Tout est entendu : la notification garde à l'écran la question du carnet de route
        // qui attend sa réponse (0.2.2 : une fois la question lue, l'écran de la voiture ne
        // montrait plus que « Je vous écoute », et le conducteur ne savait plus ce qu'on lui
        // demandait).
        val toutes = lignes(ctx)
        val enAttente = Carnet.questionEnCours(ctx)?.let { Reglages(ctx).questionTrajetTexte.ifEmpty { Carnet.QUESTION } }
        val liste = toutes.drop(toutes.indexOfLast { !it.deMoi && it.lu } + 1)
            .ifEmpty { listOf(Ligne(false, enAttente ?: "Je vous écoute.", System.currentTimeMillis())) }
        liste.forEach { style.addMessage(it.texte, it.heure, if (it.deMoi) null else claude) }

        // Intentions explicites : modifiables (la dictée y est déposée) sans être détournables.
        val reponse = PendingIntent.getBroadcast(
            ctx, 1,
            Intent(ctx, ReponseReceiver::class.java).setAction(ACTION_REPONDRE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE
        )
        val lu = PendingIntent.getBroadcast(
            ctx, 2,
            Intent(ctx, ReponseReceiver::class.java).setAction(ACTION_LU),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val ouvrir = PendingIntent.getActivity(
            ctx, 3, Intent(ctx, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )

        val actionReponse = NotificationCompat.Action.Builder(R.drawable.ic_claude, "Répondre", reponse)
            .addRemoteInput(RemoteInput.Builder(CLE_REPONSE).setLabel("Votre message").build())
            .setAllowGeneratedReplies(true)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .build()
        val actionLu = NotificationCompat.Action.Builder(R.drawable.ic_claude, "Marquer comme lu", lu)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()

        val n = NotificationCompat.Builder(ctx, CANAL)
            .setSmallIcon(R.drawable.ic_claude)
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(ouvrir)
            .addAction(actionReponse)
            .addInvisibleAction(actionLu)
            .setSilent(silencieux)
            .setOnlyAlertOnce(silencieux)
            .build()
        try {
            nm.notify(ID_NOTIF, n)
        } catch (_: SecurityException) {
            // autorisation des notifications retirée : rien à afficher
        }
    }
}
