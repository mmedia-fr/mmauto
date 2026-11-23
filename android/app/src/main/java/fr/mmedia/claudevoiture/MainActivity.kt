package fr.mmedia.claudevoiture

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.MediaStore
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

/**
 * Écran de réglage et d'essai, à l'arrêt seulement. En voiture, tout passe par
 * la notification et Android Auto.
 *
 * Réglage par adb (sans saisie sur le téléphone) :
 *   am start -n fr.mmedia.claudevoiture/.MainActivity --es jeton <jeton> [--es url <url>]
 */
class MainActivity : Activity() {
    private lateinit var reglages: Reglages
    private lateinit var etat: TextView
    private lateinit var version: TextView
    private lateinit var majBouton: Button
    private lateinit var etatCarnet: TextView
    private lateinit var fil: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        reglages = Reglages(this)
        intent?.getStringExtra("url")?.let { reglages.url = it }
        intent?.getStringExtra("jeton")?.let { reglages.jeton = it }
        Conversation.canaux(this)

        val d = resources.displayMetrics.density
        val marge = (16 * d).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(marge, marge * 2, marge, marge)
        }
        fun titre(t: String) = TextView(this).apply { text = t; textSize = 20f; setPadding(0, marge, 0, marge / 2) }
        fun bouton(t: String, f: () -> Unit) = Button(this).apply { text = t; isAllCaps = false; setOnClickListener { f() } }

        col.addView(titre("MMauto"))
        etat = TextView(this)
        col.addView(etat)
        version = TextView(this).apply { setPadding(0, marge / 2, 0, 0) }
        col.addView(version)
        majBouton = bouton("") { MiseAJour.disponible(this)?.let { MiseAJour.ouvrirPage(this, it) } }
            .apply { visibility = View.GONE }
        col.addView(majBouton)

        col.addView(titre("Relais"))
        val url = EditText(this).apply {
            setText(reglages.url)
            hint = "Adresse du relais (https://…/voiture/)"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        val jeton = EditText(this).apply {
            hint = if (reglages.jeton.isEmpty()) "Jeton du relais" else "Jeton enregistré — laisser vide pour le garder"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        col.addView(url)
        col.addView(jeton)
        col.addView(bouton("Enregistrer et tester") {
            reglages.url = url.text.toString()
            if (jeton.text.isNotBlank()) reglages.jeton = jeton.text.toString()
            jeton.setText("")
            tester()
        })

        col.addView(titre("Carnet de route"))
        etatCarnet = TextView(this)
        col.addView(etatCarnet)
        col.addView(bouton("Autoriser la localisation") { autoriserCarnet() })
        col.addView(bouton("Exporter le carnet du mois") { exporter(0) })
        col.addView(bouton("Exporter le carnet du mois précédent") { exporter(-1) })

        col.addView(titre("Essai à l'arrêt"))
        val saisie = EditText(this).apply { hint = "Message à Claude" }
        col.addView(saisie)
        col.addView(bouton("Envoyer") {
            val t = saisie.text.toString().trim()
            if (t.isNotEmpty()) {
                ReponseReceiver.envoyer(this, t)
                saisie.setText("")
                montrerFil()
            }
        })
        col.addView(bouton("Nouvelle conversation") {
            thread {
                val r = runCatching { Relais(reglages).nouveauFil() }
                runOnUiThread { etat.text = if (r.isSuccess) "Nouvelle conversation ouverte." else "Relais injoignable : ${r.exceptionOrNull()?.message}" }
                VeilleService.ecouter(this)
            }
        })
        col.addView(bouton("Simuler l'arrivée en voiture") { VeilleService.demarrer(this, VeilleService.ACTION_SALUER) })
        col.addView(bouton("Ne pas restreindre en arrière-plan") { exemptionBatterie() })

        col.addView(titre("Derniers messages"))
        fil = TextView(this).apply { setTextIsSelectable(true) }
        col.addView(fil)

        setContentView(ScrollView(this).apply { addView(col) })

        if (Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), DEMANDE_NOTIFICATIONS)
        }
        VeilleService.demarrer(this)
        if (reglages.configure) tester()
    }

    override fun onResume() {
        super.onResume()
        montrerFil()
        montrerCarnet()
        montrerVersion()
        MiseAJour.verifierSiDu(this) { runOnUiThread { if (!isDestroyed) montrerVersion() } }
    }

    /** Version installée ; bouton vers la page de la version plus récente, s'il y en a une. */
    private fun montrerVersion() {
        val d = MiseAJour.disponible(this)
        version.text = "Version ${MiseAJour.versionActuelle(this)}" +
            if (d != null) ". La version $d est disponible." else "."
        majBouton.text = "Installer la version $d"
        majBouton.visibility = if (d != null) View.VISIBLE else View.GONE
    }

    private fun tester() {
        etat.text = "Test du relais…"
        thread {
            val r = runCatching {
                val relais = Relais(reglages)
                if (!relais.sante()) error("réponse inattendue")
                relais.etat()
            }
            runOnUiThread {
                etat.text = r.fold(
                    { "Relais joignable, jeton accepté." + if (it.optInt("enAttente") > 0 || !it.isNull("enCours")) " Un calcul est en cours." else "" },
                    { "Relais injoignable ou jeton refusé : ${it.message}" }
                )
            }
        }
    }

    private fun montrerCarnet() {
        val t = reglages.trajetCourant.takeIf { it.isNotEmpty() }?.let { JSONObject(it) }
        val attente = Carnet.enAttente(this)
        etatCarnet.text = when {
            !Carnet.actif(this) -> "Inactif : la localisation doit être autorisée « tout le temps »."
            t != null -> "Actif. Trajet en cours : " +
                String.format(Locale.FRANCE, "%.1f", t.optDouble("metres", 0.0) / 1000) + " km."
            else -> "Actif : chaque trajet en voiture est relevé."
        } + if (attente > 0) " Envois en attente : $attente." else ""
    }

    /** Localisation précise (et Bluetooth, pour le nom du véhicule), puis « tout le temps ». */
    private fun autoriserCarnet() {
        val premieres = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (Build.VERSION.SDK_INT >= 31) premieres += Manifest.permission.BLUETOOTH_CONNECT
        val manquantes = premieres.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        when {
            manquantes.isNotEmpty() -> requestPermissions(manquantes.toTypedArray(), DEMANDE_LOCALISATION)
            checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) != PackageManager.PERMISSION_GRANTED -> {
                // Android ouvre alors ses réglages : y choisir « Toujours autoriser ».
                etatCarnet.text = "Dans l'écran qui s'ouvre, choisissez « Toujours autoriser »."
                requestPermissions(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION), DEMANDE_ARRIERE_PLAN)
            }
            else -> montrerCarnet()
        }
    }

    override fun onRequestPermissionsResult(code: Int, permissions: Array<out String>, resultats: IntArray) {
        super.onRequestPermissionsResult(code, permissions, resultats)
        if (code == DEMANDE_LOCALISATION &&
            checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        ) {
            autoriserCarnet()
        } else {
            montrerCarnet()
        }
    }

    /** Enregistre le carnet du mois dans Téléchargements, puis propose de l'envoyer. */
    private fun exporter(decalage: Int) {
        val mois = SimpleDateFormat("yyyy-MM", Locale.FRANCE).format(Calendar.getInstance().apply { add(Calendar.MONTH, decalage) }.time)
        etatCarnet.text = "Export du carnet de $mois…"
        thread {
            val r = runCatching {
                val csv = Relais(reglages).carnet(mois)
                val v = ContentValues().apply {
                    put(MediaStore.Downloads.DISPLAY_NAME, "carnet-de-route-$mois.csv")
                    put(MediaStore.Downloads.MIME_TYPE, "text/csv")
                    put(MediaStore.Downloads.IS_PENDING, 1)
                }
                val uri = contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v) ?: error("dossier Téléchargements inaccessible")
                contentResolver.openOutputStream(uri)!!.use { it.write(csv) }
                v.clear()
                v.put(MediaStore.Downloads.IS_PENDING, 0)
                contentResolver.update(uri, v, null, null)
                uri
            }
            runOnUiThread {
                r.fold({ uri ->
                    etatCarnet.text = "Carnet de $mois enregistré dans Téléchargements."
                    envoyer(uri)
                }, { etatCarnet.text = "Export impossible : ${it.message}" })
            }
        }
    }

    private fun envoyer(uri: Uri) {
        val i = Intent(Intent.ACTION_SEND)
            .setType("text/csv")
            .putExtra(Intent.EXTRA_STREAM, uri)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        runCatching { startActivity(Intent.createChooser(i, "Envoyer le carnet de route")) }
    }

    private fun montrerFil() {
        val f = SimpleDateFormat("HH:mm", Locale.FRANCE)
        fil.text = Conversation.lignes(this).reversed().joinToString("\n\n") {
            "${f.format(Date(it.heure))} ${if (it.deMoi) "Moi" else "Claude"} : ${it.texte}"
        }
    }

    private fun exemptionBatterie() {
        val pm = getSystemService(PowerManager::class.java)
        if (pm.isIgnoringBatteryOptimizations(packageName)) {
            etat.text = "Déjà exemptée des restrictions d'arrière-plan."
            return
        }
        startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
        )
    }

    companion object {
        private const val DEMANDE_NOTIFICATIONS = 1
        private const val DEMANDE_LOCALISATION = 2
        private const val DEMANDE_ARRIERE_PLAN = 3
    }
}
