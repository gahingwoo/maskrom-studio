// The app's WoA worker with a pretend TaishanPi 3M whose firmware is the
// build of test/fixtures/edk2-features.json and whose UEFI settings are the
// real sanitised store with believable boot entries (boot-fixture.ts): for
// the screenshots of the UEFI settings view (scripts/shots.mjs). Never part
// of the app.
import { FakeBoard } from '../fake-rockchip';
import { edk2Image } from '../edk2-fixture';
import { TSPI_ENTRIES, withBootEntries } from '../boot-fixture';
import head from '../fixtures/tspi3m-emmc-head.bin';
import storeGz from '../fixtures/nvdata-tspi3m.bin.gz';

const gunzip = async (b: Uint8Array) => new Uint8Array(await new Response(new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());

const board = new FakeBoard({ storages: { 1: 62008590336 }, defaultStorage: 1 });
const emmc = board.storages.get(1)!;
Object.defineProperty(navigator, 'usb', { value: board.usb(), configurable: true });
// The worker listens first, so the page's start message is not lost while the store is unpacked
// (the board is read only after the loader has been sent, long after this).
const started = import('../../src/woa/woa-worker');
const nvdata = withBootEntries(await gunzip(storeGz), TSPI_ENTRIES);
emmc.write(0, edk2Image({ version: 'eaa3a34', nvdata }));
emmc.write(0, head);
await started;
