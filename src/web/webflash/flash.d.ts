import type { WebflashBoard, WebflashTarget } from './boards';
/** The part of `blob` the target writes, after the size checks edk2-webflash makes before any device is involved. */
export function prepare(board: WebflashBoard, target: WebflashTarget, blob: { size: number; slice(a: number, b: number): any }): any;
/** Refuses (throws) unless the FIT in `blob` has its nvdata slot exactly where `target.slice` stops. */
export function checkSettingsSlot(blob: { slice(a: number, b: number): { arrayBuffer(): Promise<ArrayBuffer> } }, target: WebflashTarget, layout: { fitLba: number; nvdataLba: number }): Promise<void>;
export const LOADER: string;
export function runFlash(o: unknown): Promise<void>;
