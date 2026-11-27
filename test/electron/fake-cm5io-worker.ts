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

// Before each result, a log line on what the firmware's slot (eMMC sector 0x10000) holds, so the e2e run can see it.
const post = self.postMessage.bind(self) as (m: unknown) => void;
(self as unknown as { postMessage: (m: unknown) => void }).postMessage = (m: unknown) => {
  if ((m as { type?: string })?.type === 'result') {
    const head = board.storages.get(1)!.read(0x10000 * 512, 4);
    const fit = head[0] === 0xd0 && head[1] === 0x0d && head[2] === 0xfe && head[3] === 0xed;
    post({ type: 'log', line: `fake board: the eMMC slot ${fit ? 'holds a U-Boot FIT' : 'is empty'}; resets: ${board.resets}` });
  }
  post(m);
};

self.addEventListener('message', (e: MessageEvent) => {
  if (e.data?.type !== 'dump') return;
  (self as unknown as Worker).postMessage({ type: 'dump', resets: board.resets, splKept: board.storages.get(1)!.read(64 * 512, spl.length).every((b, i) => b === spl[i]) });
});

await import('../../src/woa/woa-worker');
