// The live line on the "Get ready" page and the MaskROM card: is a board in
// MaskROM mode connected? Asked through WebUSB (main/usb.ts lets the app's
// pages see Rockchip devices) every 1.5 s while the page is shown and the
// window is visible, and at once when a device comes or goes. On Windows a
// device seen for the first time is opened once and closed again: if that
// fails, WinUSB is not installed for it yet (the Zadig steps are below).

import { useEffect, useState } from 'react';
import { Alert } from '@patternfly/react-core';
import { maskromStatus, ROCKCHIP_VID, type MaskromStatus } from '../shared/maskrom-detect';
import { api } from './common';
import { useI18n } from './i18n';

const opened = new WeakMap<object, boolean>();

type UsbLike = { vendorId: number; productId: number; opened?: boolean; open(): Promise<void>; close(): Promise<void> };

async function look(): Promise<MaskromStatus> {
  const usb = (navigator as unknown as { usb?: { getDevices(): Promise<UsbLike[]> } }).usb;
  if (!usb) return { kind: 'none' };
  const list = (await usb.getDevices()).filter((d) => d.vendorId === ROCKCHIP_VID);
  const seen = [];
  for (const d of list) {
    let opens: boolean | null = null;
    if (api.platform === 'win32') {
      if (!opened.has(d)) {
        let ok = true;
        try { if (!d.opened) { await d.open(); await d.close(); } } catch { ok = false; }
        opened.set(d, ok);
      }
      opens = opened.get(d) ?? null;
    }
    seen.push({ vendorId: d.vendorId, productId: d.productId, opens });
  }
  return maskromStatus(seen);
}

export function MaskromLive({ board, onStatus }: { board: string; onStatus?: (s: MaskromStatus) => void }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<MaskromStatus | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      look().then((s) => { if (alive) { setStatus(s); onStatus?.(s); } }, () => {});
    };
    tick();
    const id = setInterval(tick, 1500);
    const usb = (navigator as unknown as { usb?: EventTarget }).usb;
    usb?.addEventListener('connect', tick);
    usb?.addEventListener('disconnect', tick);
    document.addEventListener('visibilitychange', tick);
    return () => {
      alive = false;
      clearInterval(id);
      usb?.removeEventListener('connect', tick);
      usb?.removeEventListener('disconnect', tick);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);
  if (!status) return null;
  const s = status;
  return (
    <Alert isInline id="maskrom-live" variant={s.kind === 'ready' ? 'success' : s.kind === 'none' ? 'info' : 'warning'}
      title={s.kind === 'ready' ? t('live.ready', { board })
        : s.kind === 'no-driver' ? t('live.noDriver')
        : s.kind === 'other-soc' ? t('live.other', { pid: s.pid })
        : s.kind === 'several' ? t('live.several', { n: s.count })
        : t('live.none')}>
      {s.kind === 'ready' ? t('live.ready.text', { board }) : s.kind === 'no-driver' ? t('live.noDriver.text') : s.kind === 'none' ? t('live.none.text') : null}
    </Alert>
  );
}
