package fr.mmedia.claudevoiture

import android.content.Context

/** Réglages et état persistant, dans le stockage privé de l'application. */
class Reglages(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("reglages", Context.MODE_PRIVATE)

    var url: String
        get() = p.getString("url", URL_PAR_DEFAUT) ?: URL_PAR_DEFAUT
        set(v) = p.edit().putString("url", v.trim()).apply()

    var jeton: String
        get() = p.getString("jeton", "") ?: ""
        set(v) = p.edit().putString("jeton", v.trim()).apply()

    /** Numéro du dernier message du relais déjà présenté ; -1 avant la première lecture. */
    var dernierVu: Long
        get() = p.getLong("dernierVu", -1)
        set(v) = p.edit().putLong("dernierVu", v).apply()

    /** Écouter le relais jusqu'à cette heure (ms), même hors de la voiture : une réponse est attendue. */
    var attenteJusqua: Long
        get() = p.getLong("attenteJusqua", 0)
        set(v) = p.edit().putLong("attenteJusqua", v).apply()

    var derniereSalutation: Long
        get() = p.getLong("derniereSalutation", 0)
        set(v) = p.edit().putLong("derniereSalutation", v).apply()

    var historique: String
        get() = p.getString("historique", "[]") ?: "[]"
        set(v) = p.edit().putString("historique", v).apply()

    // --- Carnet de route ---

    /** Trajet en cours (JSON), vide hors trajet. */
    var trajetCourant: String
        get() = p.getString("trajetCourant", "") ?: ""
        set(v) = p.edit().putString("trajetCourant", v).apply()

    /** Événements du carnet pas encore reçus par le relais (tableau JSON, dans l'ordre). */
    var fileCarnet: String
        get() = p.getString("fileCarnet", "[]") ?: "[]"
        set(v) = p.edit().putString("fileCarnet", v).apply()

    /** Trajet dont une question attend la réponse, nature de la question, heure où elle a été posée. */
    var questionTrajet: String
        get() = p.getString("questionTrajet", "") ?: ""
        set(v) = p.edit().putString("questionTrajet", v).apply()

    var questionTrajetNature: String
        get() = p.getString("questionTrajetNature", "") ?: ""
        set(v) = p.edit().putString("questionTrajetNature", v).apply()

    /** Texte de la question en attente : la notification le garde à l'écran une fois lu. */
    var questionTrajetTexte: String
        get() = p.getString("questionTrajetTexte", "") ?: ""
        set(v) = p.edit().putString("questionTrajetTexte", v).apply()

    var questionTrajetHeure: Long
        get() = p.getLong("questionTrajetHeure", 0)
        set(v) = p.edit().putLong("questionTrajetHeure", v).apply()

    // --- Relevé de diagnostic (Diag) ---

    /** Lignes du relevé pas encore reçues par le relais (tableau JSON, dans l'ordre). */
    var fileDiag: String
        get() = p.getString("fileDiag", "[]") ?: "[]"
        set(v) = p.edit().putString("fileDiag", v).apply()

    var diagNumero: Long
        get() = p.getLong("diagNumero", 0)
        set(v) = p.edit().putLong("diagNumero", v).apply()

    // --- Avis de nouvelle version (MiseAJour) ---

    /** Heure (ms) de la dernière réponse de GitHub. */
    var majVerifiee: Long
        get() = p.getLong("majVerifiee", 0)
        set(v) = p.edit().putLong("majVerifiee", v).apply()

    /** Version plus récente publiée, vide s'il n'y en a pas. */
    var versionDisponible: String
        get() = p.getString("versionDisponible", "") ?: ""
        set(v) = p.edit().putString("versionDisponible", v).apply()

    /** Dernière version annoncée par une notification : une seule annonce par version. */
    var versionAnnoncee: String
        get() = p.getString("versionAnnoncee", "") ?: ""
        set(v) = p.edit().putString("versionAnnoncee", v).apply()

    val configure: Boolean get() = jeton.isNotEmpty() && url.startsWith("http")

    companion object {
        /** Pas d'adresse par défaut : celle du relais se saisit à l'écran, ou par adb. */
        const val URL_PAR_DEFAUT = ""
    }
}
