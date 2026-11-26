// The app's WoA worker with a pretend ROCK 4D on navigator.usb: a 16 MiB SPI
// NOR flash (storage 9) holding an older edk2-rk3576 firmware and saved UEFI
// settings, and a 128 MiB UFS module (storage 1) that the loader starts on.
// For scripts/electron-rock4d-e2e.mjs; never part of the app.
import { FakeBoard } from '../fake-rockchip';
import { spiImage, store } from '../edk2-fixture';

const MiB = 1024 * 1024;
const board = new FakeBoard({ storages: { 1: 128 * MiB, 9: 16 * MiB }, defaultStorage: 1 });
// ?spl=once: the SPL of the edk2-rk3576 build with the Armbian one-shot on the SD card (rock4d-parity); else a release's SPL.
const once = new URL(self.location.href).searchParams.get('spl') === 'once';
const before = spiImage({ version: '0.4.1', settings: store(), spl: once ? 'U-Boot SPL 2026.10-edk2-rk3576\0ArmbianOnce/1\0' : 'U-Boot SPL 2026.04-ge3405917a180\0' });
board.storages.get(9)!.write(0, before);
board.storages.get(1)!.write(0, new Uint8Array(MiB).fill(0x77));
Object.defineProperty(navigator, 'usb', { value: board.usb(), configurable: true });

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

self.addEventListener('message', (e: MessageEvent) => {
  if (e.data?.type !== 'dump') return;
  const spi = board.storages.get(9)!.read(0, 16 * MiB);
  const next = spiImage({ version: '0.4.2' });
  const cut = 32256 * 512;
  (self as unknown as Worker).postMessage({
    type: 'dump', resets: board.resets, spiUntouched: same(spi, before),
    firmwareIsNew: same(spi.subarray(0, cut), next.subarray(0, cut)),
    settingsKept: same(spi.subarray(cut), before.subarray(cut)),
    ufsUntouched: board.storages.get(1)!.read(0, MiB).every((b) => b === 0x77) && board.storages.get(1)!.read(MiB, 4 * MiB).every((b) => b === 0),
  });
});

await import('../../src/woa/woa-worker');
