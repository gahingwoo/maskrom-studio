// What the "Get ready" page says about the USB devices it sees (UX audit D2).
import { describe, expect, it } from 'vitest';
import { maskromStatus } from '../src/shared/maskrom-detect';

const rk3576 = { vendorId: 0x2207, productId: 0x350e, opens: null };

describe('the live MaskROM line', () => {
  it('says nothing is there without a Rockchip device', () => {
    expect(maskromStatus([])).toEqual({ kind: 'none' });
    expect(maskromStatus([{ vendorId: 0x046d, productId: 0xc52b, opens: true }])).toEqual({ kind: 'none' });
  });
  it('finds an RK3576 in MaskROM mode', () => {
    expect(maskromStatus([rk3576])).toEqual({ kind: 'ready' });
    expect(maskromStatus([{ ...rk3576, opens: true }])).toEqual({ kind: 'ready' });
  });
  it('tells a missing WinUSB driver apart (Windows)', () => {
    expect(maskromStatus([{ ...rk3576, opens: false }])).toEqual({ kind: 'no-driver' });
  });
  it('names another Rockchip chip by its USB ID, and several devices as such', () => {
    expect(maskromStatus([{ vendorId: 0x2207, productId: 0x350b, opens: null }])).toEqual({ kind: 'other-soc', pid: '2207:350b' });
    expect(maskromStatus([rk3576, rk3576])).toEqual({ kind: 'several', count: 2 });
  });
});
