package fr.mmedia.claudevoiture

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput
import kotlin.concurrent.thread

/** Actions de la notification : réponse dictée, marquage comme lu. */
class ReponseReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.action) {
            Conversation.ACTION_REPONDRE -> {
                val texte = RemoteInput.getResultsFromIntent(intent)
                    ?.getCharSequence(Conversation.CLE_REPONSE)?.toString()?.trim()
                if (texte.isNullOrEmpty()) {
                    Conversation.afficher(ctx, silencieux = true)
                    return
                }
                envoyer(ctx, texte, goAsync())
            }
            Conversation.ACTION_LU -> Conversation.marquerLu(ctx)
        }
    }

    companion object {
        /** Commun à la dictée et à la saisie dans l'application. */
        fun envoyer(ctx: Context, texte: String, fin: PendingResult? = null) {
            val app = ctx.applicationContext
            Conversation.ajouter(app, deMoi = true, texte = texte, alerter = false)
            val reglages = Reglages(app)
            reglages.attenteJusqua = System.currentTimeMillis() + 12 * 60_000
            VeilleService.ecouter(app)
            // Réponse à une question du carnet de route : elle part par la file du carnet,
            // après les événements du trajet, et n'est pas perdue faute de réseau.
            Carnet.questionEnCours(app)?.let { trajet ->
                Diag.noter(app, "dictée prise pour réponse au carnet (trajet ${trajet.take(8)})")
                Carnet.repondre(app, trajet, texte)
                fin?.finish()
                return
            }
            thread {
                try {
                    Relais(reglages).envoyer(texte)
                } catch (e: Exception) {
                    Diag.noter(app, "dictée non transmise : ${e.javaClass.simpleName} ${e.message ?: ""}")
                    Conversation.ajouter(
                        app, deMoi = false,
                        texte = "Le relais ne répond pas : votre message n'est pas parti. Réessayez dans un instant.",
                        alerter = true
                    )
                } finally {
                    fin?.finish()
                }
            }
        }
    }
}
