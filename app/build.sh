#!/bin/bash
# APK-Build ohne Gradle (siehe README).
# Voraussetzungen: JDK 17+, Android SDK mit build-tools + platform (>= 34).
# SDK-Pfad: $ANDROID_SDK, $ANDROID_HOME oder $ANDROID_SDK_ROOT.
set -e
cd "$(dirname "$0")"

# ---- SDK finden ------------------------------------------------------------
# Ausgelagert nach sdk-env.sh, geteilt mit compile-check.sh (Q4/Q5).
source "$(dirname "$0")/sdk-env.sh"

# Tool-Namen aufloesen: unter Windows heissen sie d8.bat / aapt2.exe / ...,
# unter Linux/macOS ohne Endung.
bt() {
    for cand in "$BT/$1" "$BT/$1.bat" "$BT/$1.exe" "$BT/$1.cmd"; do
        [ -f "$cand" ] && { echo "$cand"; return 0; }
    done
    echo "FEHLER: $1 nicht in $BT gefunden." >&2
    return 1
}
D8="$(bt d8)"
AAPT2="$(bt aapt2)"
ZIPALIGN="$(bt zipalign)"
APKSIGNER="$(bt apksigner)"

# ---- Keystore: NIEMALS still einen neuen erzeugen --------------------------
# Ein anderer Keystore => die APK laesst sich nicht ueber die installierte
# Version druebersinstallieren (Rasmus muesste deinstallieren). Deshalb harter
# Abbruch statt keytool-Automatik.
if [ ! -f debug.keystore ]; then
    if [ "${ALLOW_NEW_KEYSTORE:-0}" = "1" ]; then
        echo "WARNUNG: erzeuge NEUEN debug.keystore - Updates in-place unmoeglich!"
        keytool -genkeypair -keystore debug.keystore -storepass android \
            -keypass android -alias sbctools -dname "CN=SBC Tools" \
            -keyalg RSA -keysize 2048 -validity 10000
    else
        echo "FEHLER: app/debug.keystore fehlt."
        echo "  Ohne DIESEN Keystore ist kein Update-in-place moeglich."
        echo "  Bewusst neu erzeugen: ALLOW_NEW_KEYSTORE=1 ./build.sh"
        exit 1
    fi
fi

rm -rf build && mkdir -p build/classes build/apk

# ---- Aktuelles Script als Offline-Fallback buendeln ------------------------
# Der alte Pfad (../sbc-optimizer/...) existiert in dieser Repo-Struktur nicht
# und wurde per "|| true" still geschluckt -> das gebuendelte Asset veraltete
# unbemerkt. Jetzt: fester Pfad, harter Fehler.
SRC="../ea-fc-sbc-optimizer.user.js"
[ -f "$SRC" ] || { echo "FEHLER: $SRC nicht gefunden."; exit 1; }
mkdir -p assets
cp "$SRC" assets/sbc-optimizer.user.js
echo "Asset : $(basename "$SRC") -> assets/ ($(wc -c < assets/sbc-optimizer.user.js) Bytes)"

# ---- Java -> dex -----------------------------------------------------------
javac --release 11 -encoding UTF-8 -classpath "$AJ" \
    -d build/classes java/com/sbctools/browser/MainActivity.java
"$D8" --release --lib "$AJ" --output build/apk \
    build/classes/com/sbctools/browser/*.class

# ---- Ressourcen (Icons!) + Manifest -> base.apk ----------------------------
# Das Manifest referenziert @mipmap/ic_launcher; ohne compilierte Resources
# bricht aapt2 link ab (im alten Script fehlte der res-Schritt komplett).
"$AAPT2" compile --dir res -o build/res.zip
"$AAPT2" link -o build/base.apk --manifest AndroidManifest.xml \
    -I "$AJ" -A assets -R build/res.zip --auto-add-overlay \
    --min-sdk-version 26 --target-sdk-version "$PLATV"

# ---- classes.dex ins APK ---------------------------------------------------
# "zip" fehlt in Git Bash unter Windows. Fallbacks: Python (Achtung, "python3"
# ist dort oft nur ein Store-Stub, der nichts ausfuehrt -> jeden Kandidaten
# testen) und zuletzt "jar" aus dem JDK.
add_dex() {
    if command -v zip >/dev/null 2>&1; then
        (cd build/apk && zip -q ../base.apk classes.dex) && return 0
    fi
    for py in python3 python py; do
        command -v "$py" >/dev/null 2>&1 || continue
        "$py" -c "import zipfile" >/dev/null 2>&1 || continue   # Store-Stub aussortieren
        "$py" -c "import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'a',zipfile.ZIP_DEFLATED)
z.write(sys.argv[2],'classes.dex')
z.close()" build/base.apk build/apk/classes.dex && return 0
    done
    if command -v jar >/dev/null 2>&1; then
        (cd build/apk && jar uf ../base.apk classes.dex) && return 0
    fi
    echo "FEHLER: kein Packer gefunden (zip / python / jar)."
    return 1
}
add_dex

# ---- align + signieren -----------------------------------------------------
"$ZIPALIGN" -f 4 build/base.apk build/aligned.apk
"$APKSIGNER" sign --ks debug.keystore --ks-pass pass:android \
    --key-pass pass:android --out build/pittools.apk build/aligned.apk

VN="$(grep -o 'versionName="[^"]*"' AndroidManifest.xml | cut -d'"' -f2)"
cp build/pittools.apk "build/pittools-v$VN.apk"
"$APKSIGNER" verify --print-certs build/pittools.apk | head -4
echo "Fertig: app/build/pittools-v$VN.apk"
