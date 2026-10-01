/* The game is the web build one directory up. It is copied into the APK's
   assets at build time rather than kept here, so there is one copy of the
   game in the repo and the APK can never drift from what the site serves. */
plugins { id("com.android.application") }

val web = rootProject.layout.projectDirectory.dir("..")
val wwwOut = layout.buildDirectory.dir("www-assets")

val copyWeb by tasks.registering(Sync::class) {
    from(web) {
        include("index.html", "app.webmanifest", "icon-*.png", "src/**", "styles/**", "vendor/**")
    }
    into(wwwOut.map { it.dir("www") })
}

android {
    namespace = "io.github.abdulalrubat.tarponreach"
    compileSdk = 35
    defaultConfig {
        applicationId = "io.github.abdulalrubat.tarponreach"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.3-debug"
    }
    /* A committed debug key, not the per-machine one AGP generates. Every
       build signed with a different key cannot install over the last one,
       and uninstalling to get past that deletes the save. The debug key is
       not a secret: its password is "android" everywhere. */
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
    sourceSets["main"].assets.srcDir(wwwOut)
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

tasks.named("preBuild") { dependsOn(copyWeb) }

dependencies {
    implementation("androidx.webkit:webkit:1.12.1")
}
