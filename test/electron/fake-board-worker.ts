// The app's WoA worker with a pretend TaishanPi 3M that runs edk2-rk3576
// 0.4.1 with saved UEFI settings and Windows' partition table: for the
// screenshots of a firmware upgrade's confirmation and progress
// (scripts/readme-shots.mjs). Never part of the app.
import { FakeBoard } from '../fake-rockchip';
import { edk2Image, store } from '../edk2-fixture';
import head from '../fixtures/tspi3m-emmc-head.bin';

const board = new FakeBoard({ storages: { 1: 62008590336 }, defaultStorage: 1 });
const emmc = board.storages.get(1)!;
emmc.write(0, edk2Image({ version: '0.4.1', nvdata: store() }));
emmc.write(0, head);
Object.defineProperty(navigator, 'usb', { value: board.usb(), configurable: true });

await import('../../src/woa/woa-worker');
