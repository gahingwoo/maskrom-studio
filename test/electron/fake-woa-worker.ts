// The app's WoA worker with a pretend TaishanPi 3M on navigator.usb: an eMMC
// of 62008590336 bytes holding the edk2-rk3576 partition table. For
// scripts/electron-woa-e2e.mjs; never part of the app.
import { FakeBoard } from '../fake-rockchip';
import { parsePrimaryGpt } from '../../src/woa/gpt';

const board = new FakeBoard({ storages: { 1: 62008590336 }, defaultStorage: 1 });
Object.defineProperty(navigator, 'usb', { value: board.usb(), configurable: true });

self.addEventListener('message', (e: MessageEvent) => {
  if (e.data?.type === 'seed') board.storages.get(1)!.write(0, new Uint8Array(e.data.head));
  if (e.data?.type === 'dump') {
    const st = board.storages.get(1)!;
    const t = parsePrimaryGpt(st.read(0, 34 * 512));
    const parts = t.partitions.map((p) => ({ name: p.name, first: p.firstLba, last: p.lastLba }));
    const boot = t.partitions.find((p) => p.name === 'WOA-STAGE-BOOT')!;
    const data = t.partitions.find((p) => p.name === 'WOA-STAGE-DATA')!;
    (self as unknown as Worker).postMessage({
      type: 'dump', parts, resets: board.resets,
      bootSector: Array.from(st.read(boot.firstLba * 512, 512)),
      dataSector: Array.from(st.read(data.firstLba * 512, 512)),
      backupSig: new TextDecoder().decode(st.read((62008590336 / 512 - 1) * 512, 8)),
    });
  }
});

await import('../../src/woa/woa-worker');
