#!/bin/sh
# Read every store the tests wrote (VARSTORE_OUT=<dir> npx vitest run
# test/uefi-vars.test.ts test/boot-options.test.ts) with the two checkers made from EDK2, and compare
# what they list with what the app meant to write (<name>.txt):
#   check.py        written from VariableFormat.h and VariableParsing.c
#   edk2-check.c    compiled against EDK2's own headers
#   check-all.sh <edk2 tree with MdePkg/Include and MdeModulePkg/Include> <dir>
set -eu
edk2=$1
dir=$2
here=$(dirname "$0")
case $(uname -m) in
  x86_64) arch=X64 ;;
  aarch64|arm64) arch=AArch64 ;;
  *) echo "unknown machine $(uname -m)"; exit 1 ;;
esac
bin=$(mktemp -d)/edk2-check
# -fshort-wchar: CHAR16 is 2 bytes, as in every EDK2 build (Base.h asserts it).
gcc -O1 -fshort-wchar -I "$edk2/MdePkg/Include" -I "$edk2/MdePkg/Include/$arch" -I "$edk2/MdeModulePkg/Include" "$here/edk2-check.c" -o "$bin"
n=0
for f in "$dir"/*.bin; do
  want=${f%.bin}.txt
  python3 -I "$here/check.py" "$f" --expect "$want"
  if ! "$bin" "$f" | cmp -s - "$want"; then
    echo "FAIL: edk2-check lists $f differently from $want"
    "$bin" "$f" | diff - "$want" | head -20
    exit 1
  fi
  echo "ok $f (edk2-check)"
  n=$((n + 1))
done
[ "$n" -gt 0 ] || { echo "no stores in $dir"; exit 1; }
echo "$n stores read the same by both checkers as the app wrote them"
