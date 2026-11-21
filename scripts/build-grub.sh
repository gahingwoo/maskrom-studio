#!/bin/sh
# Builds resources/armbian/grubaa64.efi: a standalone arm64-efi GRUB for
# Armbian under edk2-rk3576 (src/woa/armbian.ts). Needs an arm64 Debian or
# Ubuntu with grub-efi-arm64-bin (the modules) and grub-common
# (grub-mkstandalone). The embedded config is fixed: it reads grub.cfg next
# to the EFI file on the EFI partition, which the imager writes for each
# install. Run from the repository root; prints the SHA-256 to record in
# src/woa/armbian.ts (GRUB_EFI).
set -eu
out=resources/armbian/grubaa64.efi
dir=/usr/lib/grub/arm64-efi
[ -f "$dir/linux.mod" ] || { echo "no $dir: install grub-efi-arm64-bin" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp resources/armbian/embedded.cfg "$work/grub.cfg"
# Only what the configs use; their dependencies come along.
mods="part_gpt part_msdos fat ext2 search search_fs_uuid search_fs_file configfile normal linux chain test echo regexp sleep reboot halt efifwsetup ls cat"
SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-1763683200} grub-mkstandalone -O arm64-efi -o "$out" \
  --modules="$mods" --install-modules="$mods" \
  --locales= --fonts= --themes= --compress=no \
  "boot/grub/grub.cfg=$work/grub.cfg"
dpkg-query -W -f='${Package} ${Version}\n' grub-efi-arm64-bin grub-common 2>/dev/null || true
ls -l "$out"
sha256sum "$out"
