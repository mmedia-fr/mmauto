package fr.mmedia.claudevoiture

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.location.LocationRequest
import android.os.Build
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.Instant
import java.util.UUID
import kotlin.concurrent.thread

/**
 * Carnet de route : relève chaque trajet en voiture et le signale au relais, qui pose la
 * question du motif, nomme les lieux et tient le registre.
 *
 * - départ : connexion à la voiture ; position au premier point GPS précis ; véhicule
 *   d'après l'appareil Bluetooth de la voiture ;
 * - distance : somme des segments GPS, points imprécis ou aberrants écartés ;
 * - arrivée : déconnexion confirmée au bout de [DELAI_FIN] ; une micro-coupure de la
 *   liaison ne coupe pas le trajet.
 *
 * Les événements partent par une file persistante, dans l'ordre : un trajet fait sans
 * réseau est transmis dès que le relais répond. Sans relais au départ, le téléphone pose
 * lui-même la question, et la réponse attend dans la même file.
 */
class Carnet(private val service: VeilleService) {
    private val ctx: Context = service.applicationContext
    private val reglages = Reglages(ctx)
    private val lm = ctx.getSystemService(LocationManager::class.java)
    private var ecoute: LocationListener? = null
    private var fin: Job? = null
    private var annonce: Job? = null

    /** Le GPS est suivi : le service doit être de premier plan de type « localisation ». */
    val gpsVoulu: Boolean get() = ecoute != null

    private fun courant(): JSONObject? = reglages.trajetCourant.takeIf { it.isNotEmpty() }?.let { JSONObject(it) }

    private fun enregistrer(t: JSONObject) {
        reglages.trajetCourant = t.toString()
    }

    /** Arrivée en voiture (ou reprise du service pendant un trajet). */
    fun connexion() {
        if (!actif(ctx) || !reglages.configure) {
            Diag.noter(ctx, "carnet : connexion ignorée (localisation « tout le temps » ${if (actif(ctx)) "accordée" else "non accordée"}, configuré ${reglages.configure})")
            return
        }
        fin?.cancel()
        fin = null
        val t = courant()
        if (t != null) {
            // Reconnexion avant la confirmation de l'arrivée : c'est le même trajet.
            Diag.noter(
                ctx, "carnet : trajet ${t.getString("id").take(8)} repris" +
                    (if (t.has("finProvisoire")) " avant la confirmation de l'arrivée" else " (veille relancée en route)") +
                    (if (t.optBoolean("annonce")) ", départ déjà annoncé" else "")
            )
            if (t.has("finProvisoire")) {
                t.remove("finProvisoire")
                enregistrer(t)
            }
            suivreGps()
            if (!t.optBoolean("annonce") && annonce?.isActive != true) {
                annonce = service.lifecycleScope.launch { annoncerDepart(t.getString("id")) }
            }
            return
        }
        val id = UUID.randomUUID().toString()
        enregistrer(JSONObject().put("id", id).put("debut", System.currentTimeMillis()))
        Log.i(TAG, "départ $id")
        Diag.noter(ctx, "carnet : trajet ${id.take(8)} ouvert")
        suivreGps()
        vehicule { nom ->
            val c = courant()
            if (nom != null && c != null && c.getString("id") == id) {
                c.put("vehicule", nom)
                enregistrer(c)
            }
        }
        annonce = service.lifecycleScope.launch { annoncerDepart(id) }
    }

    /** Départ de la voiture : l'arrivée n'est retenue qu'au bout de [DELAI_FIN]. */
    fun deconnexion() {
        val t = courant() ?: return
        if (!t.has("finProvisoire")) Diag.noter(ctx, "carnet : trajet ${t.getString("id").take(8)} interrompu, arrivée dans ${DELAI_FIN / 60_000} min sans reconnexion")
        arreterGps()
        val depuis = if (t.has("finProvisoire")) t.getLong("finProvisoire") else {
            val maintenant = System.currentTimeMillis()
            t.put("finProvisoire", maintenant)
            enregistrer(t)
            maintenant
        }
        fin?.cancel()
        fin = service.lifecycleScope.launch {
            delay(maxOf(0L, depuis + DELAI_FIN - System.currentTimeMillis()))
            clore()
        }
    }

    private suspend fun annoncerDepart(id: String) {
        // Attendre un point précis, vingt secondes au plus : la question part sans tarder.
        val limite = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < limite && courant()?.has("depart") == false) delay(1_000)
        val t = courant()?.takeIf { it.getString("id") == id && !it.optBoolean("annonce") } ?: return
        val e = evenement("depart", t, t.optJSONObject("depart") ?: dernierePositionConnue())
        Diag.noter(
            ctx, "carnet : départ ${id.take(8)}, position " + when {
                t.has("depart") -> "GPS"
                e.has("position") -> "dernière connue"
                else -> "inconnue"
            } + ", GPS suivi ${if (gpsVoulu) "oui" else "non"}"
        )
        t.put("annonce", true)
        enregistrer(t)
        val envoye = withContext(Dispatchers.IO) {
            viderSync(ctx) && runCatching { Relais(reglages).trajet(e) in 200..299 }.getOrDefault(false)
        }
        if (!envoye) {
            // Relais injoignable : le téléphone pose la question ; l'événement attend.
            ajouterFile(ctx, e.put("questionPosee", true))
            questionPosee(ctx, id, "depart", QUESTION)
            Conversation.ajouter(ctx, deMoi = false, texte = QUESTION, alerter = true)
            Log.i(TAG, "relais injoignable au départ : question posée par le téléphone")
            Diag.noter(ctx, "carnet : relais injoignable au départ ${id.take(8)}, question posée par le téléphone")
        }
    }

    private fun clore() {
        val t = courant() ?: return
        annonce?.cancel()
        if (!t.optBoolean("annonce")) {
            // Trajet trop bref pour l'annonce : le départ part sans question.
            ajouterFile(ctx, evenement("depart", t, t.optJSONObject("depart")).put("questionPosee", true))
        }
        val e = evenement("arrivee", t, t.optJSONObject("arrivee"))
            .put("heure", iso(t.getLong("finProvisoire")))
            .put("points", t.optInt("points"))
        // Sans aucun point GPS, la distance est inconnue, pas nulle.
        if (t.optInt("points") > 0) e.put("km", t.optDouble("metres", 0.0) / 1000.0)
        ajouterFile(ctx, e)
        reglages.trajetCourant = ""
        Log.i(TAG, "arrivée ${t.getString("id")} : ${t.optDouble("metres", 0.0).toInt()} m, ${t.optInt("points")} points")
        Diag.noter(ctx, "carnet : trajet ${t.getString("id").take(8)} clos, ${t.optDouble("metres", 0.0).toInt()} m, ${t.optInt("points")} points")
        // Écouter le relais encore dix minutes : il peut poser la question du motif.
        reglages.attenteJusqua = maxOf(reglages.attenteJusqua, System.currentTimeMillis() + 10 * 60_000)
        vider(ctx)
        VeilleService.ecouter(ctx)
    }

    private fun evenement(type: String, t: JSONObject, position: JSONObject?): JSONObject {
        val e = JSONObject()
            .put("type", type)
            .put("id", t.getString("id"))
            .put("heure", iso(t.getLong("debut")))
            .put("debut", iso(t.getLong("debut")))
        if (t.has("vehicule")) e.put("vehicule", t.getString("vehicule"))
        if (position != null) e.put("position", position)
        return e
    }

    // --- GPS -------------------------------------------------------------------

    @SuppressLint("MissingPermission")
    private fun suivreGps() {
        if (ecoute != null || !actif(ctx)) return
        val l = LocationListener { point(it) }
        ecoute = l
        service.premierPlan()
        try {
            if (Build.VERSION.SDK_INT >= 31) {
                // Haute précision : en précision « équilibrée », le service de localisation de
                // Google peut se contenter du réseau et ne jamais allumer le GPS (essai du 22/11 :
                // aucun point en deux minutes de trajet simulé).
                val demande = LocationRequest.Builder(5_000L)
                    .setQuality(LocationRequest.QUALITY_HIGH_ACCURACY)
                    .setMinUpdateDistanceMeters(10f)
                    .build()
                val fournisseur =
                    if (lm.hasProvider(LocationManager.FUSED_PROVIDER)) LocationManager.FUSED_PROVIDER else LocationManager.GPS_PROVIDER
                lm.requestLocationUpdates(fournisseur, demande, ContextCompat.getMainExecutor(ctx), l)
            } else {
                lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5_000L, 10f, l, Looper.getMainLooper())
            }
        } catch (e: Exception) {
            Log.w(TAG, "GPS refusé : ${e.message}")
            Diag.noter(ctx, "carnet : GPS refusé : ${e.javaClass.simpleName} ${e.message ?: ""}")
            ecoute = null
            service.premierPlan()
        }
    }

    private fun arreterGps() {
        ecoute?.let { runCatching { lm.removeUpdates(it) } }
        if (ecoute != null) {
            ecoute = null
            service.premierPlan()
        }
    }

    private fun point(p: Location) {
        val t = courant() ?: return
        if (t.has("finProvisoire")) return
        // Point mis en cache avant le départ : écarté.
        if (SystemClock.elapsedRealtimeNanos() - p.elapsedRealtimeNanos > 120_000_000_000L) return
        val precision = if (p.hasAccuracy()) p.accuracy else 0f
        if (precision > 100f) return
        val ici = position(p)
        if (!t.has("depart")) t.put("depart", ici)
        t.put("arrivee", ici)
        if (precision <= 50f) {
            val repere = t.optJSONObject("repere")
            if (repere == null) {
                t.put("repere", ici)
            } else {
                val d = FloatArray(1)
                Location.distanceBetween(repere.getDouble("lat"), repere.getDouble("lon"), p.latitude, p.longitude, d)
                if (d[0] >= 20f) {
                    // Plus de 250 km/h entre deux points : saut du GPS, pas un déplacement.
                    val s = (p.time - repere.getLong("t")) / 1000.0
                    if (s <= 0 || d[0] / s < 70.0) t.put("metres", t.optDouble("metres", 0.0) + d[0])
                    t.put("repere", ici)
                }
            }
            t.put("points", t.optInt("points") + 1)
        }
        enregistrer(t)
    }

    private fun position(p: Location) = JSONObject()
        .put("lat", p.latitude)
        .put("lon", p.longitude)
        .put("precision", (if (p.hasAccuracy()) p.accuracy else 0f).toDouble())
        .put("t", p.time)

    @SuppressLint("MissingPermission")
    private fun dernierePositionConnue(): JSONObject? = runCatching {
        listOf(LocationManager.FUSED_PROVIDER, LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { lm.allProviders.contains(it) }
            .mapNotNull { lm.getLastKnownLocation(it) }
            .filter { System.currentTimeMillis() - it.time < 10 * 60_000 }
            .maxByOrNull { it.time }
            ?.let { position(it) }
    }.getOrNull()

    // --- Véhicule : nom de l'appareil Bluetooth de la voiture (profil mains libres) ---

    @SuppressLint("MissingPermission")
    private fun vehicule(rappel: (String?) -> Unit) {
        if (Build.VERSION.SDK_INT >= 31 &&
            ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED
        ) return rappel(null)
        val bt = ctx.getSystemService(BluetoothManager::class.java)?.adapter ?: return rappel(null)
        val demande = runCatching {
            bt.getProfileProxy(ctx, object : BluetoothProfile.ServiceListener {
                override fun onServiceConnected(profil: Int, proxy: BluetoothProfile) {
                    val nom = runCatching { proxy.connectedDevices.firstOrNull()?.name }.getOrNull()
                    runCatching { bt.closeProfileProxy(profil, proxy) }
                    rappel(nom)
                }

                override fun onServiceDisconnected(profil: Int) {}
            }, BluetoothProfile.HEADSET)
        }.getOrDefault(false)
        if (!demande) rappel(null)
    }

    companion object {
        private const val TAG = "MMautoCarnet"
        const val QUESTION = "Vers où va-t-on, et pour quoi faire ?"
        const val DELAI_FIN = 3 * 60_000L
        private const val FILE_MAX = 500
        private val verrouFile = Any()
        private val verrouEnvoi = Any()

        /** Carnet actif : localisation précise accordée, y compris en arrière-plan. */
        fun actif(ctx: Context): Boolean =
            ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED &&
                ctx.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED

        fun iso(ms: Long): String = Instant.ofEpochMilli(ms).toString()

        /** Une question du carnet attend sa réponse : la prochaine dictée lui revient. */
        fun questionPosee(ctx: Context, id: String, nature: String?, texte: String) {
            val r = Reglages(ctx)
            r.questionTrajet = id
            r.questionTrajetTexte = texte
            r.questionTrajetNature = nature ?: ""
            r.questionTrajetHeure = System.currentTimeMillis()
        }

        /**
         * Trajet dont une question attend encore sa réponse. Une question posée en route
         * expire au bout de 45 minutes ; celle posée à l'arrivée, ou pour compléter une
         * réponse, au bout de 12 heures (on y répond souvent plus tard, du téléphone).
         */
        fun questionEnCours(ctx: Context): String? {
            val r = Reglages(ctx)
            val id = r.questionTrajet.ifEmpty { return null }
            val duree = if (r.questionTrajetNature in setOf("arrivee", "complement")) 12 * 3_600_000L else 45 * 60_000L
            return id.takeIf { System.currentTimeMillis() - r.questionTrajetHeure < duree }
        }

        fun repondre(ctx: Context, id: String, texte: String) {
            Reglages(ctx).questionTrajet = ""
            ajouterFile(
                ctx,
                JSONObject().put("type", "reponse").put("id", id).put("heure", iso(System.currentTimeMillis())).put("texte", texte)
            )
            vider(ctx)
        }

        fun ajouterFile(ctx: Context, e: JSONObject) = synchronized(verrouFile) {
            val r = Reglages(ctx)
            val f = JSONArray(r.fileCarnet)
            if (f.length() >= FILE_MAX) f.remove(0)
            f.put(e)
            r.fileCarnet = f.toString()
        }

        fun enAttente(ctx: Context): Int = JSONArray(Reglages(ctx).fileCarnet).length()

        fun vider(ctx: Context) {
            if (enAttente(ctx) > 0) thread { viderSync(ctx.applicationContext) }
        }

        /**
         * Envoie la file dans l'ordre ; s'arrête au premier échec. Un événement refusé comme
         * illisible (400) est retiré : le garder bloquerait les suivants. Rend vrai si la file
         * est vide.
         */
        fun viderSync(ctx: Context): Boolean = synchronized(verrouEnvoi) {
            val r = Reglages(ctx)
            while (true) {
                val e = synchronized(verrouFile) { JSONArray(r.fileCarnet).optJSONObject(0) } ?: return true
                val code = try {
                    Relais(r).trajet(e)
                } catch (ex: IOException) {
                    Log.w(TAG, "relais injoignable : ${ex.message}")
                    return false
                }
                if (code !in 200..299 && code != 400) return false
                synchronized(verrouFile) {
                    val f = JSONArray(r.fileCarnet)
                    if (f.length() > 0 && f.getJSONObject(0).toString() == e.toString()) f.remove(0)
                    r.fileCarnet = f.toString()
                }
            }
            @Suppress("UNREACHABLE_CODE")
            true
        }
    }
}
