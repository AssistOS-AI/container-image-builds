#!/bin/sh
set -eu

contract=/usr/local/share/ploinky/webtty.contract
app_root=/opt/webtty-agent

fail() {
    echo "[webtty] ERROR: $*" >&2
    exit 1
}

test -f "$contract" && test ! -L "$contract" || \
    fail "WebTTY v5 image contract marker is missing; publish and pin the verified v5 image before activation"
test "$(stat -c '%u:%g:%a' "$contract")" = '0:0:444' || \
    fail "WebTTY v5 image contract marker ownership or mode is invalid"
test "$(wc -l < "$contract")" -eq 5 || \
    fail "WebTTY v5 image contract marker has an invalid shape"
test "$(sed -n '1p' "$contract")" = 'contract_version=5' || \
    fail "WebTTY image contract version is not v5"

verify_entry() {
    key="$1"
    target="$2"
    expected="$(sed -n "s/^${key}=//p" "$contract")"
    test "$(printf '%s' "$expected" | wc -c)" -eq 64 || \
        fail "WebTTY v5 image contract is missing ${key}"
    actual="$(sha256sum "$target" | awk '{print $1}')"
    test "$actual" = "$expected" || \
        fail "WebTTY v5 ${key} digest does not match the immutable image contract"
}

verify_entry package_lock_sha256 "$app_root/package-lock.json"
verify_entry server_sha256 "$app_root/server.mjs"
verify_entry public_archive_sha256 "$app_root/public.tar"
verify_entry start_script_sha256 /usr/local/bin/webtty-start

test -d "$app_root/public" && test ! -L "$app_root/public" || \
    fail "WebTTY v5 public asset directory is missing or replaced"
actual_public_sha="$(tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner \
    -C "$app_root/public" -cf - . | sha256sum | awk '{print $1}')"
expected_public_sha="$(sha256sum "$app_root/public.tar" | awk '{print $1}')"
test "$actual_public_sha" = "$expected_public_sha" || \
    fail "WebTTY v5 public asset bytes do not match the immutable image contract"

exec node "$app_root/server.mjs"
