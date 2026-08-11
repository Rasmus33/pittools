#!/bin/bash
# APK-Build ohne Gradle (siehe README). Voraussetzungen: JDK 17+, Android SDK
# mit build-tools;34.0.0 + platforms;android-34, SDK-Pfad in $ANDROID_SDK.
set -e
SDK="${ANDROID_SDK:-$HOME/android-sdk}"
BT="$SDK/build-tools/34.0.0"
AJ="$SDK/platforms/android-34/android.jar"
rm -rf build && mkdir -p build/classes build/apk
# Aktuelles Script als Offline-Fallback bündeln
cp ../sbc-optimizer/ea-fc-sbc-optimizer.user.js assets/sbc-optimizer.user.js 2>/dev/null || true
javac --release 11 -encoding UTF-8 -classpath "$AJ" -d build/classes java/com/sbctools/browser/MainActivity.java
"$BT/d8" --release --lib "$AJ" --output build/apk build/classes/com/sbctools/browser/*.class
"$BT/aapt2" link -o build/base.apk --manifest AndroidManifest.xml -I "$AJ" -A assets --min-sdk-version 26 --target-sdk-version 34
(cd build/apk && zip -q ../base.apk classes.dex)
"$BT/zipalign" -f 4 build/base.apk build/aligned.apk
[ -f debug.keystore ] || keytool -genkeypair -keystore debug.keystore -storepass android -keypass android \
    -alias sbctools -dname "CN=SBC Tools" -keyalg RSA -keysize 2048 -validity 10000
"$BT/apksigner" sign --ks debug.keystore --ks-pass pass:android --key-pass pass:android \
    --out build/pittools.apk build/aligned.apk
echo "Fertig: build/pittools.apk"
