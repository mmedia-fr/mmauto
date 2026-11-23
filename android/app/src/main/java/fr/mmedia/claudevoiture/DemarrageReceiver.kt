package fr.mmedia.claudevoiture

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Remet la veille en place après un redémarrage du téléphone ou une mise à jour de l'application. */
class DemarrageReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            Diag.noter(
                ctx,
                if (intent.action == Intent.ACTION_BOOT_COMPLETED) "téléphone redémarré : veille relancée" else "application mise à jour : veille relancée"
            )
            VeilleService.demarrer(ctx)
        }
    }
}
