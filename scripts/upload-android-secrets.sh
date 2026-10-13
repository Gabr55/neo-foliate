#!/usr/bin/env bash
# Uploads the Android signing key to the repository's GitHub Actions secrets.
# Usage: scripts/upload-android-secrets.sh path/to/keystore.properties
# keystore.properties holds storeFile, storePassword, keyAlias and keyPassword.
set -euo pipefail

props="${1:?usage: $0 path/to/keystore.properties}"
get() { grep -E "^$1=" "$props" | head -1 | cut -d= -f2-; }

store_file="$(get storeFile)"
[ -f "$store_file" ] || { echo "Keystore not found: $store_file" >&2; exit 1; }

base64 < "$store_file" | tr -d '\n' | gh secret set ANDROID_KEYSTORE_BASE64
get storePassword | gh secret set ANDROID_KEYSTORE_PASSWORD
get keyAlias | gh secret set ANDROID_KEY_ALIAS
get keyPassword | gh secret set ANDROID_KEY_PASSWORD
echo "Android signing secrets uploaded."
