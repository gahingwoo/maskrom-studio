# Building and tests

## Building

Needs Node.js 22.

```sh
npm ci
npm run writer              # the elevated writer: Node.js packed with pkg; on macOS a C helper (needs cc)
sh scripts/build-wasm.sh    # rkdeveloptool in WebAssembly; needs emsdk 3.1.48, or take the CI artifact
npm run build
npm start
```

## Tests

```sh
npm test                               # layout, GPT, FAT32, exFAT, UDF, WIM, MaskROM through the WASM against a pretend board
node scripts/electron-woa-e2e.mjs      # the staged install inside Electron against a pretend TaishanPi 3M
node scripts/electron-retry-e2e.mjs    # a board that goes away: Try again, Report a problem
node scripts/electron-maskrom-e2e.mjs  # Roxora Imager's MaskROM path inside Electron
node --test test/webflash/*.test.js    # modules copied from edk2-webflash
node scripts/shots.mjs dev/shots       # screenshots, light and dark
node scripts/readme-shots.mjs docs/imgs  # the README and docs/screenshots.md set
```

The file system tests use mkfs.vfat and mtools, sfdisk and sgdisk, and
exfatprogs' fsck.exfat when they are installed (CI installs them).

None of this is a board. What still needs one is in [testing](testing.md).
