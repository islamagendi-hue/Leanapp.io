buildscript {
    val localProps = java.io.File(rootDir, "local.properties")
    val hasAndroidSdk = System.getenv("ANDROID_HOME") != null ||
        System.getenv("ANDROID_SDK_ROOT") != null ||
        (localProps.exists() && localProps.readText().contains("sdk.dir"))
    repositories {
        if (hasAndroidSdk) google()
        mavenCentral()
        gradlePluginPortal()
    }
    dependencies {
        // Both plugins sit on the root classpath so the Kotlin plugin can see the Android plugin.
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.1.21")
        if (hasAndroidSdk) classpath("com.android.tools.build:gradle:8.7.3")
    }
}

allprojects {
    group = "io.leanapp"
    version = "0.1.0"
}
