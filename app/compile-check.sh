#!/bin/bash
# Keystore-freies Compile-Gate: prueft NUR, ob MainActivity.java kompiliert.
# Kein d8/aapt2/zipalign/apksigner, kein Zugriff auf app/debug.keystore.
# Voraussetzungen wie build.sh: JDK 17+, Android SDK mit build-tools + platform.
set -e
cd "$(dirname "$0")"
source ./sdk-env.sh

rm -rf build/classes-check && mkdir -p build/classes-check

# Eigenes Ausgabeverzeichnis (build/classes-check), damit ein parallel
# laufendes build.sh seinen build/-Baum nicht verliert.
# Kein -Werror: build.sh setzt ebenfalls keins, das Gate darf nicht strenger
# abbrechen als der bestehende Build (die heute schon live reproduzierte
# Deprecation-Warnung ist kein Fehlschlag).
javac --release 11 -encoding UTF-8 -classpath "$AJ" \
    -d build/classes-check java/com/sbctools/browser/MainActivity.java

echo "Compile-Check OK: MainActivity.java kompiliert (ohne Keystore/d8/aapt2)."
