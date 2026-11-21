import type { WebflashBoard, WebflashTarget } from './boards';
/** The part of `blob` the target writes, after the size checks edk2-webflash makes before any device is involved. */
export function prepare(board: WebflashBoard, target: WebflashTarget, blob: { size: number; slice(a: number, b: number): any }): any;
export const LOADER: string;
export function runFlash(o: unknown): Promise<void>;
