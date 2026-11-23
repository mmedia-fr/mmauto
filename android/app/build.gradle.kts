plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "fr.mmedia.claudevoiture"
    compileSdk = 34

    defaultConfig {
        applicationId = "fr.mmedia.claudevoiture"
        minSdk = 29
        targetSdk = 34
        // Minutes depuis 1970 : chaque construction remplace la précédente sans calcul à la main.
        versionCode = (System.currentTimeMillis() / 60000).toInt()
        versionName = "0.3.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.lifecycle:lifecycle-service:2.8.4")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // Seulement pour CarConnection : savoir quand le téléphone est relié à la voiture
    // (accueil, et début et fin des trajets du carnet de route).
    implementation("androidx.car.app:app:1.4.0")
}
