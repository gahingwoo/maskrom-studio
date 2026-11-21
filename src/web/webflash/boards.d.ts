// Types for boards.js and flash.js (edk2-webflash), which are plain JavaScript.
export interface WebflashTarget {
  id: string;
  label: string;
  image?: string;
  file?: string;
  lba: number;
  slice?: [number, number];
  /** Set on a write that stops before the FIT's nvdata slot, so the saved UEFI settings stay. */
  keepsSettings?: { fitLba: number; nvdataLba: number };
  note?: string;
  erases: string;
  done: string;
  blob?: Blob;
  fileName?: string;
}
export interface WebflashBoard {
  id: 'rock4d' | 'cm5io' | 'tspi3m';
  name: string;
  storage: string;
  storageBytes?: number;
  maskrom: string[];
  maskromNote?: string;
  maskromLink?: { text: string; href: string };
  targets: WebflashTarget[];
}
export const BOARDS: WebflashBoard[];
export function boardById(id: string): WebflashBoard | undefined;
export function customTarget(file: File): WebflashTarget;
