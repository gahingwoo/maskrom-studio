// The app's WoA worker with a pretend ArmSoM CM5-IO on navigator.usb: an eMMC
// of 31272730624 bytes with an SPL at sector 64, as the edk2-rk3576 image
// writes it. For scripts/electron-cm5io-hybrid-e2e.mjs; never part of the app.
import { FakeBoard } from '../fake-rockchip';

const board = new FakeBoard({ storages: { 1: 31272730624 }, defaultStorage: 1 });
// ?spl=once: the SPL of edk2-rk3576 0.5.0 (U-Boot v2026.10 with the Armbian one-shot); else an older release's SPL.
const once = new URL(self.location.href).searchParams.get('spl') === 'once';
const spl = new Uint8Array(1024 * 1024).fill(0x11);
spl.set(new TextEncoder().encode(once ? 'U-Boot SPL 2026.10-edk2-rk3576\0ArmbianOnce/1\0' : 'U-Boot SPL 2026.04-ge3405917a180\0'), 0x2f0a0);
board.storages.get(1)!.write(64 * 512, spl);
Object.defineProperty(navigator, 'usb', { value: board.usb(), configurable: true });

self.addEventListener('message', (e: MessageEvent) => {
  if (e.data?.type !== 'dump') return;
  (self as unknown as Worker).postMessage({ type: 'dump', resets: board.resets, splKept: board.storages.get(1)!.read(64 * 512, spl.length).every((b, i) => b === spl[i]) });
});

await import('../../src/woa/woa-worker');
