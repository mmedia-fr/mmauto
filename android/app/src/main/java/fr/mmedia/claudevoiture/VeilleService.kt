package fr.mmedia.claudevoiture

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.car.app.connection.CarConnection
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Service de premier plan (type « messagerie à distance », plus « localisation » pendant
 * un trajet) :
 * - observe la connexion à la voiture (CarConnection) ;
 * - à l'arrivée en voiture, ouvre un trajet du carnet de route (le relais pose alors la
 *   question du motif) ; sans carnet, pose un message d'accueil ;
 * - tant qu'il est en voiture, ou qu'une réponse est attendue, interroge le relais
 *   par interrogation longue et présente chaque réponse comme un message.
 */
class VeilleService : LifecycleService() {
    private lateinit var reglages: Reglages
    private lateinit var carnet: Carnet
    private var boucle: Job? = null
    private var enVoiture = false
    private var connexionReelle = false
    private var premiereLecture = true
    private var relaisPerdu = false

    /** Essai sans voiture (adb, en root) : force l'état de la connexion. */
    private var simulation: Boolean? = null

    override fun onCreate() {
        super.onCreate()
        reglages = Reglages(this)
        carnet = Carnet(this)
        Conversation.canaux(this)
        premierPlan()
        Diag.noter(this, etatDepart())
        // Avis de nouvelle version : peu après le démarrage (la connexion à la voiture est
        // alors connue), puis une fois par jour, jamais en voiture.
        lifecycleScope.launch {
            delay(60_000L)
            while (isActive) {
                if (!enVoiture) MiseAJour.verifierSiDu(this@VeilleService)
                delay(3_600_000L)
            }
        }
        CarConnection(this).type.observe(this) { type ->
            Log.i(TAG, "connexion voiture : type=$type")
            Diag.noter(this, "connexion voiture : " + when (type) {
                CarConnection.CONNECTION_TYPE_PROJECTION -> "Android Auto"
                CarConnection.CONNECTION_TYPE_NATIVE -> "système de la voiture"
                CarConnection.CONNECTION_TYPE_NOT_CONNECTED -> "aucune"
                else -> "type $type"
            })
            connexionReelle = type == CarConnection.CONNECTION_TYPE_PROJECTION ||
                type == CarConnection.CONNECTION_TYPE_NATIVE
            majVoiture()
        }
    }

    override fun onDestroy() {
        Diag.noter(this, "veille arrêtée")
        super.onDestroy()
    }

    /** État utile au diagnostic, noté à chaque démarrage de la veille. */
    private fun etatDepart(): String {
        fun oui(b: Boolean) = if (b) "oui" else "non"
        fun accorde(p: String) = checkSelfPermission(p) == android.content.pm.PackageManager.PERMISSION_GRANTED
        val version = runCatching { packageManager.getPackageInfo(packageName, 0).versionName }.getOrNull() ?: "?"
        val notif = androidx.core.app.NotificationManagerCompat.from(this).areNotificationsEnabled()
        val energie = getSystemService(android.os.PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) == true
        return "veille démarrée : version $version, configurée ${oui(reglages.configure)}, " +
            "notifications ${oui(notif)}, localisation précise ${oui(accorde(android.Manifest.permission.ACCESS_FINE_LOCATION))}, " +
            "en arrière-plan ${oui(accorde(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION))}, " +
            "hors économie d'énergie ${oui(energie)}, trajet en cours ${oui(reglages.trajetCourant.isNotEmpty())}"
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)
        when (intent?.action) {
            ACTION_SALUER -> saluer(force = true)
            ACTION_SIMULER -> {
                simulation = if (intent.hasExtra("voiture")) intent.getBooleanExtra("voiture", false) else null
                Log.i(TAG, "simulation de la voiture : $simulation")
                Diag.noter(this, "simulation de la voiture : " + (simulation?.let { if (it) "en voiture" else "hors voiture" } ?: "levée"))
                majVoiture()
            }
        }
        majEcoute()
        return START_STICKY
    }

    private fun majVoiture() {
        val avant = enVoiture
        enVoiture = simulation ?: connexionReelle
        if (premiereLecture || enVoiture != avant) {
            premiereLecture = false
            if (enVoiture) {
                // Avec le carnet, la question du motif tient lieu d'accueil.
                if (Carnet.actif(this) && reglages.configure) {
                    carnet.connexion()
                } else {
                    Diag.noter(this, "en voiture, carnet inactif (localisation « tout le temps » non accordée ou application non configurée)")
                    if (!avant) saluer()
                }
            } else {
                Diag.noter(this, if (simulation != null) "hors voiture (simulation)" else "hors voiture")
                carnet.deconnexion()
            }
        }
        premierPlan()
        majEcoute()
    }

    private fun saluer(force: Boolean = false) {
        val maintenant = System.currentTimeMillis()
        // Pas de nouvel accueil à chaque micro-coupure de la liaison avec la voiture.
        if (!force && maintenant - reglages.derniereSalutation < 15 * 60_000) return
        reglages.derniereSalutation = maintenant
        Conversation.ajouter(
            this, deMoi = false,
            texte = "Je vous écoute. Répondez à ce message pour me parler.",
            alerter = true
        )
    }

    private fun besoinEcoute() =
        reglages.configure && (enVoiture || reglages.attenteJusqua > System.currentTimeMillis())

    private fun majEcoute() {
        if (besoinEcoute()) {
            if (boucle?.isActive != true) boucle = lifecycleScope.launch(Dispatchers.IO) { ecouter() }
        } else {
            boucle?.cancel()
            boucle = null
        }
    }

    private suspend fun ecouter() {
        val relais = Relais(reglages)
        var pause = 2_000L
        while (kotlinx.coroutines.currentCoroutineContext().isActive && besoinEcoute()) {
            try {
                // Événements du carnet et relevé restés en attente faute de réseau.
                if (Carnet.enAttente(this) > 0) Carnet.viderSync(this)
                if (Diag.enAttente(this)) Diag.envoyerSync(this)
                if (reglages.dernierVu < 0) {
                    // Première lecture : se caler sur le relais sans rejouer l'historique.
                    reglages.dernierVu = relais.messages(0, 0).dernier
                }
                val l = relais.messages(reglages.dernierVu, ATTENTE_S)
                for (m in l.messages) {
                    if (m.role != "moi") {
                        Conversation.ajouter(
                            this, deMoi = false, texte = m.texte, alerter = true,
                            provisoire = m.role == "etat"
                        )
                    }
                    // Question du carnet de route : la prochaine dictée y répond.
                    if (m.trajet != null) Carnet.questionPosee(this, m.trajet, m.question, m.texte)
                    if (m.role == "claude" || m.role == "erreur") reglages.attenteJusqua = 0
                }
                reglages.dernierVu = maxOf(reglages.dernierVu, l.dernier)
                if (relaisPerdu) {
                    relaisPerdu = false
                    Diag.noter(this@VeilleService, "relais de nouveau joignable")
                }
                if (l.enCours) reglages.attenteJusqua = maxOf(reglages.attenteJusqua, System.currentTimeMillis() + 60_000)
                pause = 2_000L
            } catch (e: Exception) {
                Log.w(TAG, "relais injoignable : ${e.message}")
                if (!relaisPerdu) {
                    relaisPerdu = true
                    Diag.noter(this@VeilleService, "relais injoignable : ${e.javaClass.simpleName} ${e.message ?: ""}")
                }
                delay(pause)
                pause = minOf(pause * 2, 30_000L)
            }
        }
        boucle = null
    }

    /** Notification de veille ; type « localisation » ajouté pendant le suivi d'un trajet. */
    internal fun premierPlan() {
        val ouvrir = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        val gps = ::carnet.isInitialized && carnet.gpsVoulu && Carnet.actif(this)
        val n = NotificationCompat.Builder(this, Conversation.CANAL_VEILLE)
            .setSmallIcon(R.drawable.ic_claude)
            .setContentTitle(
                when {
                    gps -> "En voiture : trajet en cours, Claude est à l'écoute"
                    enVoiture -> "En voiture : Claude est à l'écoute"
                    else -> "MMauto : en veille"
                }
            )
            .setContentIntent(ouvrir)
            .setOngoing(true)
            .setSilent(true)
            .build()
        var type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0
        if (gps) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        try {
            ServiceCompat.startForeground(this, ID_VEILLE, n, type)
            if (gps) Log.i(TAG, "premier plan : messagerie et localisation")
        } catch (e: Exception) {
            // Android refuse le type « localisation » sans l'autorisation « tout le temps » :
            // la veille continue, le trajet sera relevé avec moins de points.
            Log.w(TAG, "premier plan « localisation » refusé : ${e.message}")
            ServiceCompat.startForeground(this, ID_VEILLE, n, type and ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION.inv())
        }
    }

    companion object {
        private const val TAG = "ClaudeVoiture"
        private const val ID_VEILLE = 2
        private const val ATTENTE_S = 45
        const val ACTION_ECOUTER = "fr.mmedia.claudevoiture.ECOUTER"
        const val ACTION_SALUER = "fr.mmedia.claudevoiture.SALUER"
        const val ACTION_SIMULER = "fr.mmedia.claudevoiture.SIMULER"

        fun demarrer(ctx: Context, action: String? = null) {
            val i = Intent(ctx, VeilleService::class.java)
            if (action != null) i.action = action
            try {
                ContextCompat.startForegroundService(ctx, i)
            } catch (e: Exception) {
                Log.w(TAG, "démarrage de la veille refusé : ${e.message}")
            }
        }

        fun ecouter(ctx: Context) = demarrer(ctx, ACTION_ECOUTER)
    }
}
