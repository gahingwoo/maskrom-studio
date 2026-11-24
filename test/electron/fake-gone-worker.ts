// The app's WoA worker with a pretend TaishanPi 3M that takes the loader and
// never comes back, as a board does when its USB cable is pulled during the
// job: for the retry end-to-end test (scripts/electron-retry-e2e.mjs).
// Never part of the app.
import { FakeBoard } from '../fake-rockchip';
import { edk2Image, store } from '../edk2-fixture';
import head from '../fixtures/tspi3m-emmc-head.bin';

const board = new FakeBoard({ storages: { 1: 62008590336 }, defaultStorage: 1, stayAway: true });
const emmc = board.storages.get(1)!;
emmc.write(0, edk2Image({ version: '0.4.1', nvdata: store() }));
emmc.write(0, head);
Object.defineProperty(navigator, 'usb', { value: board.usb(), configurable: true });

await import('../../src/woa/woa-worker');
