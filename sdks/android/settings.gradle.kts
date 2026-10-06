pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "leanapp-android-sdk"

// The pure-Kotlin core (client, queue, transport) builds and tests on any JVM.
include(":leanapp-core")

// The Android library needs the Android SDK (ANDROID_HOME or local.properties sdk.dir) and Google's Maven.
// Without them only the core is built, so the core's tests still run on machines with no Android SDK.
val localProps = file("local.properties")
val hasAndroidSdk = System.getenv("ANDROID_HOME") != null ||
    System.getenv("ANDROID_SDK_ROOT") != null ||
    (localProps.exists() && localProps.readText().contains("sdk.dir"))
if (hasAndroidSdk) include(":leanapp-android")
