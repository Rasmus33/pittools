# SDK-/build-tools-/Platform-Erkennung, gemeinsam genutzt von build.sh und
# compile-check.sh (Q4/Q5 - sonst driftet der SDK-Fallback zwischen dem
# vollen Signier-Build und dem keystore-freien Compile-Gate unbemerkt
# auseinander). Wird per `source` eingebunden, nicht direkt ausgefuehrt:
# setzt SDK/BTV/BT/PLATV/AJ im Scope des aufrufenden Skripts.

# ---- SDK finden ------------------------------------------------------------
SDK="${ANDROID_SDK:-${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}}"
[ -d "$SDK" ] || { echo "FEHLER: Android SDK nicht gefunden ($SDK)."; exit 1; }

# Hoechste STABILE build-tools nehmen (rc/beta ueberspringen) - hart kodierte
# 34.0.0 war auf einem Rechner mit nur 36.x installiert nicht auffindbar.
BTV="${BUILD_TOOLS_VERSION:-$(ls "$SDK/build-tools" 2>/dev/null \
      | grep -E '^[0-9]+\.[0-9]+\.[0-9]+$' | sort -V | tail -1)}"
[ -n "$BTV" ] || { echo "FEHLER: keine stabilen build-tools in $SDK/build-tools."; exit 1; }
BT="$SDK/build-tools/$BTV"

# Hoechste installierte Platform nehmen.
PLATV="${PLATFORM_VERSION:-$(ls "$SDK/platforms" 2>/dev/null \
        | grep -E '^android-[0-9]+$' | sed 's/android-//' | sort -n | tail -1)}"
[ -n "$PLATV" ] || { echo "FEHLER: keine Platform in $SDK/platforms."; exit 1; }
AJ="$SDK/platforms/android-$PLATV/android.jar"
[ -f "$AJ" ] || { echo "FEHLER: $AJ fehlt."; exit 1; }
echo "SDK   : $SDK"
echo "Tools : build-tools $BTV / android-$PLATV"
