// The WoA RK3576 Imager page: one wizard (board, what to write, the Windows
// image, how Windows comes out, review), then the write itself in place of
// the wizard. Every text goes through useI18n() (messages.ts).
import { useEffect, useRef, useState } from 'react';
import {
  ActionList, ActionListGroup, ActionListItem, Alert, AlertActionCloseButton, AlertActionLink, Button, Card, CardBody,
  CardTitle, Checkbox, CodeBlock, CodeBlockCode, Content, DescriptionList, DescriptionListDescription, DescriptionListGroup,
  DescriptionListTerm, ExpandableSection, Flex, FlexItem, Form, FormGroup, FormHelperText, HelperText, HelperTextItem,
  List, ListItem, Modal, ModalBody, ModalFooter, ModalHeader, OrderType, PageSection, Progress, ProgressMeasureLocation,
  Radio, Stack, StackItem, Switch, TextArea, TextInput, Title, Wizard, WizardFooterWrapper, WizardStep, useWizardContext,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { formatBytes } from '../shared/format';
import type { BoardHereInfo, DriverFolder, JobProgress, JobResult, Releases, Served, WindowsChoice } from '../shared/ipc';
import type { Target } from '../shared/targets';
import type { UpdateOffer } from '../shared/update';
import { firmwareTargets, WOA_BOARDS, woaBoard, type BoardId, type WoaBoard } from '../woa/boards';
import type { WebflashTarget } from '../web/webflash/boards';
import type { WoaJob, WoaWorkerEvent, WoaWorkerRequest } from '../woa/woa-worker';
import type { RegionResult, RegionStage } from '../woa/maskrom-regions';
import { accountProblem, DEFAULT_SETUP, OPENSSH, sshKeyProblem, type Account, type SetupOptions } from '../woa/setup-files';
import { api, DriversNote, SettingsModal, Shell, StepPage, UpdateModal } from './common';
import { useI18n } from './i18n';
import { applyTheme, readTheme, type Theme } from './theme';

type Task = 'windows' | 'uefi' | 'uefi-keep' | 'stick';
type Via = 'maskrom' | 'here';
type Dest = 'emmc' | 'sd' | 'nvme';
type Method = 'stage' | 'host';
const WIN_HOST = api.platform === 'win32';

const GB = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
const LOADER = 'rk3576_spl_loader.bin';

interface Stage { id: string; label: string; percent: number | null; note?: string }
interface Run {
  title: string;
  stages: Stage[];
  log: string[];
  confirm: StageSummary | FirmwareSummary | null;
  result: { ok: boolean; title: string; text?: string; detail?: string; next?: string[] } | null;
}
interface StageSummary { kind: 'stage'; capacity: number; windowsBytes: number; totalBytes: number; removed: Array<{ name: string; bytes: number }> }
interface FirmwareSummary { kind: 'firmware'; board: string; target: string; lba: number; bytes: number; capacity: number | null; dropped: Array<{ name: string; bytes: number }>; erases: string }

const EMPTY_ACCOUNT: Account = { user: '', password: '', computerName: '', locale: '', keyboard: '', timeZone: '', autoLogonAlways: false };

function ProgressList({ stages, waiting }: { stages: Stage[]; waiting: string }) {
  return (
    <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsXl' }}>
      {stages.map((s) => (
        <FlexItem key={s.id}>
          <Progress title={s.label} value={s.percent ?? 0} measureLocation={ProgressMeasureLocation.top} aria-label={s.label}
            {...(s.percent === null ? { label: s.note ?? waiting, valueText: s.note ?? waiting } : s.note ? { label: s.note } : {})} />
        </FlexItem>
      ))}
    </Flex>
  );
}

function Review({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <DescriptionList isHorizontal>
      {rows.map(([k, v]) => (
        <DescriptionListGroup key={k}><DescriptionListTerm>{k}</DescriptionListTerm><DescriptionListDescription>{v}</DescriptionListDescription></DescriptionListGroup>
      ))}
    </DescriptionList>
  );
}

function ReviewFooter({ label, disabled, why, onGo }: { label: string; disabled: boolean; why: string | null; onGo: () => void }) {
  const { goToPrevStep } = useWizardContext();
  const { t } = useI18n();
  return (
    <WizardFooterWrapper>
      <Stack hasGutter>
        {why && <Content component="p" className="footer-note">{why}</Content>}
        <ActionList>
          <ActionListGroup>
            <ActionListItem><Button variant="secondary" onClick={goToPrevStep}>{t('back')}</Button></ActionListItem>
            <ActionListItem><Button variant="primary" onClick={onGo} isDisabled={disabled}>{label}</Button></ActionListItem>
          </ActionListGroup>
        </ActionList>
      </Stack>
    </WizardFooterWrapper>
  );
}

export function App() {
  const { t, lang, msg } = useI18n();
  const [theme, setThemeState] = useState<Theme>(readTheme());
  const setTheme = (th: Theme) => { setThemeState(th); applyTheme(th); };
  const [releases, setReleases] = useState<Releases | null>(null);
  const [here, setHere] = useState<BoardHereInfo | null>(null);
  const [boardId, setBoardId] = useState<BoardId | null>(null);
  const [via, setVia] = useState<Via>('maskrom');
  const [task, setTask] = useState<Task | null>(null);
  const [windows, setWindows] = useState<WindowsChoice | null>(null);
  const [windowsError, setWindowsError] = useState<string | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [skip, setSkip] = useState(DEFAULT_SETUP.skipSetup !== null);
  const [account, setAccount] = useState<Account>(EMPTY_ACCOUNT);
  const [password2, setPassword2] = useState('');
  const [ssh, setSsh] = useState(DEFAULT_SETUP.ssh);
  const [sshKey, setSshKey] = useState('');
  const [drivers, setDrivers] = useState<DriverFolder | null>(null);
  const [driversError, setDriversError] = useState<string | null>(null);
  const [drives, setDrives] = useState<Target[] | null>(null);
  const [stick, setStick] = useState<string | null>(null);
  const [dest, setDest] = useState<Dest>('emmc');
  const [method, setMethod] = useState<Method>('stage');
  const [disk, setDisk] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [settings, setSettings] = useState(false);
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [updating, setUpdating] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => { try { return localStorage.getItem('updateDismissed'); } catch { return null; } });
  const worker = useRef<Worker | null>(null);
  const servedTokens = useRef<string[]>([]);

  useEffect(() => { api.releases().then(setReleases); }, []);
  useEffect(() => {
    api.boardHere().then((h) => {
      setHere(h);
      if (h.boardId) { setBoardId(h.boardId); setVia('here'); }
    });
  }, []);
  useEffect(() => {
    const look = () => { api.checkUpdate(false).then((r) => { if (r?.state === 'newer') setOffer(r.offer); }); };
    look();
    const timer = setInterval(look, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  const board = boardId ? woaBoard(boardId)! : null;
  const onBoard = via === 'here' && !!here?.boardId && here.boardId === boardId;
  const edition = windows?.editions.find((e) => e.index === index) ?? null;
  const fwRelease = releases?.firmware && boardId ? releases.firmware.boards[boardId] : undefined;

  // Text from edk2-webflash's board list: its English, or this page's Chinese for the same thing.
  const fwText = (b: WoaBoard, tg: WebflashTarget, field: 'label' | 'note' | 'erases' | 'done'): string => {
    if (field === 'label') return t(b.id === 'rock4d' && tg.id === 'uefi' ? 'fw.rock4d.uefi.label' : `fw.${tg.id}.label`);
    const original = (tg[field] as string | undefined) ?? '';
    return lang === 'en' ? original : (t(`fw.${b.id}.${tg.id}.${field}`) || original);
  };
  const maskromSteps = (b: WoaBoard): string[] => b.webflash.maskrom.map((s, i) => {
    if (lang === 'en') return s;
    const key = b.id === 'tspi3m' ? `maskrom.tspi3m.${i + 1}` : `maskrom.button.${i + 1}`;
    return t(key) || s;
  });
  const refuseText = (r: string): string => {
    if (lang === 'en') return r;
    const build = /build (\d+)\./.exec(r);
    if (build && /24H2/.test(r)) return t('win.refuse.new', { build: build[1] });
    const arch = /for (\S+), not ARM64/.exec(r);
    if (arch) return t('win.refuse.arch', { arch: arch[1] });
    return r;
  };
  const errorText = (e: string) => (/^[a-z]+\.[a-z.]+$/.test(e) ? t(e) : msg(e));

  const setup: SetupOptions = { skipSetup: skip ? account : null, ssh, sshKey: ssh ? sshKey : '' };
  const accountErr = skip ? accountProblem(account) : null;
  const passwordMismatch = skip && account.password !== password2;
  const keyErr = ssh ? sshKeyProblem(sshKey) : null;
  const setupOk = !accountErr && !passwordMismatch && !keyErr;

  const refreshDrives = (min = 600e6) => { setDrives(null); api.listDrives(min).then((dl) => setDrives(dl.targets.filter((x) => !x.disabled))); };
  const onPc = task === 'windows' && dest !== 'emmc';
  const destOk = !(onPc && api.platform === 'darwin' && method === 'stage');

  const chooseWindows = async (pick: () => Promise<WindowsChoice | { error: string } | null>) => {
    setWindowsError(null);
    const r = await pick();
    if (!r) return;
    if ('error' in r) { setWindowsError(errorText(r.error)); setWindows(null); setIndex(null); return; }
    setWindows(r);
    const ok = r.editions.filter((e) => !e.refuse);
    const pro = ok.find((e) => /\bpro\b/i.test(e.name) && !/workstation|education/i.test(e.name));
    setIndex((pro ?? ok[0])?.index ?? null);
  };

  const chooseDrivers = async () => {
    setDriversError(null);
    const r = await api.pickDrivers();
    if (!r) return;
    if ('error' in r) { setDriversError(errorText(r.error)); return; }
    setDrivers(r);
  };

  // --- running -----------------------------------------------------------------
  const update = (f: (r: Run) => Run) => setRun((cur) => (cur ? f(cur) : cur));
  const setStage = (id: string, patch: Partial<Stage>) => update((r) => ({ ...r, stages: r.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const addLog = (line: string) => update((r) => ({ ...r, log: [...r.log.slice(-600), line] }));
  const finish = (result: Run['result']) => update((r) => ({ ...r, result, confirm: null }));

  const withProgress = async <R,>(id: string, fn: () => Promise<R>): Promise<R> => {
    const off = api.onProgress((p: JobProgress) => {
      setStage(id, {
        percent: p.total > 0 ? Math.min(100, Math.floor((p.bytes * 100) / p.total)) : 0,
        note: t(`progress.${p.stage}`, { done: formatBytes(p.bytes), total: formatBytes(p.total) }),
      });
    });
    try { return await fn(); } finally { off(); }
  };

  const resultOf = (r: JobResult | RegionResult, okTitle: string, next?: string[]): Run['result'] => {
    if (r.ok) {
      let text: string | undefined;
      if ('checks' in r && r.checks) {
        const c = r.checks;
        text = c.matched === c.samples
          ? t('result.samples.all', { n: c.samples })
          : t('result.samples.some', { m: c.matched, n: c.samples, k: c.filler + c.unsure, filler: c.filler ? t('result.samples.filler', { n: c.filler }) : '' });
      }
      return { ok: true, title: okTitle, ...(text ? { text } : {}), ...(next ? { next } : {}) };
    }
    return { ok: false, title: errorText(r.reason), ...('detail' in r && r.detail ? { detail: r.detail } : {}) };
  };

  const STAGE_NEXT = ['next.stage.1', 'next.stage.2', 'next.stage.3', 'next.stage.4'].map((k) => t(k));

  const startMaskrom = async (jobFor: (served: Record<string, Served>, extras: Array<{ path: string; data: Uint8Array }>) => WoaJob,
    prep: Array<{ id: string; get: () => Promise<Served | { error: string }> }>, extras: { ssh: boolean; drivers: string | null } | null) => {
    const served: Record<string, Served> = {};
    for (const p of prep) {
      setStage(p.id, { percent: 0, note: t('run.starting') });
      const s = await withProgress(p.id, p.get);
      if ('error' in s) { finish({ ok: false, title: errorText(s.error) }); return; }
      served[p.id] = s;
      servedTokens.current.push(s.token);
      setStage(p.id, { percent: 100, note: `${s.name}, ${formatBytes(s.size)}` });
    }
    let extraFiles: Array<{ path: string; data: Uint8Array }> = [];
    if (extras && (extras.ssh || extras.drivers)) {
      setStage('extras', { percent: 0, note: t('run.starting') });
      const x = await withProgress('extras', () => api.prepareExtras(extras));
      if ('error' in x) { finish({ ok: false, title: errorText(x.error) }); return; }
      extraFiles = x.files;
      setStage('extras', { percent: 100, note: formatBytes(extraFiles.reduce((a, f) => a + f.data.length, 0)) });
    }
    const loader = await api.getLoader(LOADER);
    if ('error' in loader) { finish({ ok: false, title: t('result.loader'), detail: loader.error }); return; }
    const settingsNow = await api.getSettings();
    const job = jobFor(served, extraFiles);
    if (job.kind === 'firmware') job.resetAfter = settingsNow.resetAfterMaskrom;
    const w = new Worker('woa-worker.js', { type: 'module' });
    worker.current = w;
    const at = (p: string) => new URL(p, document.baseURI).href;
    w.onmessage = (e: MessageEvent<WoaWorkerEvent>) => {
      const m = e.data;
      if (m.type === 'log') addLog(m.line);
      else if (m.type === 'stage') {
        if (m.stage === 'write' || m.stage === 'check' || m.stage === 'reset') setStage('board', { percent: 100, note: t('run.connected') });
        if (m.stage === 'check') setStage('write', { percent: 100, note: t('run.written') });
        const target = m.stage === 'write' ? 'write' : m.stage === 'check' || m.stage === 'reset' ? 'check' : 'board';
        setStage(target, { note: t(`stage.${m.stage as RegionStage}`) });
      } else if (m.type === 'progress') {
        setStage('write', { percent: Math.min(100, Math.floor((m.done * 100) / Math.max(1, m.total))), note: t('run.of', { done: formatBytes(m.done), total: formatBytes(m.total) }) });
      } else if (m.type === 'planned') {
        update((r) => ({ ...r, confirm: m.summary as StageSummary | FirmwareSummary }));
      } else if (m.type === 'result') {
        w.terminate();
        worker.current = null;
        finish(resultOf(m.result, job.kind === 'stage' ? t('result.staged') : job.kind === 'vhd' ? t('result.hostEmmc') : t('result.firmware'),
          job.kind === 'stage' ? STAGE_NEXT : job.kind === 'vhd' ? [t('next.hostEmmc')] : undefined));
        if (m.result.ok) update((r) => ({ ...r, stages: r.stages.map((s) => ({ ...s, percent: 100 })) }));
      }
    };
    w.onerror = (e) => { finish({ ok: false, title: t('result.workerStopped'), detail: e.message }); w.terminate(); };
    w.postMessage({ type: 'woa-start', job, moduleUrl: at('wasm/rkdeveloptool.js'), wasmUrl: at('wasm/rkdeveloptool.wasm'), loaderUrl: loader.url } satisfies WoaWorkerRequest);
  };

  const answer = (ok: boolean) => {
    update((r) => ({ ...r, confirm: null }));
    worker.current?.postMessage({ type: 'woa-confirm', ok } satisfies WoaWorkerRequest);
  };

  const storageWord = (b: WoaBoard, tk: Task) => t(tk === 'windows' || b.firmwareStorage === 'emmc' ? 'storage.emmc' : 'storage.spinor');

  const start = async () => {
    setAsk(false);
    if (!board || !task) return;
    if (task === 'stick') {
      setRun({ title: t('run.stick'), log: [], confirm: null, result: null, stages: [{ id: 'write', label: t('run.stick.stage'), percent: 0 }] });
      const r = await withProgress('write', () => api.writeWinpeStick(stick!));
      finish(resultOf(r, t('result.stick'), [t('next.stick.1'), t('next.stick.2')]));
      return;
    }
    if (task === 'windows' && (dest !== 'emmc' || method === 'host')) {
      const req = { target: dest, boardId: board.id, windowsToken: windows!.token, index: index!, setup, drivers: drivers?.token ?? null };
      if (method === 'host') {
        setRun({ title: t('run.host'), log: [], confirm: null, result: null, stages: [
          { id: 'build', label: dest === 'emmc' ? t('run.host.vhd') : t('run.host.disk'), percent: null },
          ...(dest === 'emmc' ? [{ id: 'board', label: t('run.board'), percent: null }, { id: 'write', label: t('run.write'), percent: 0 }, { id: 'check', label: t('run.check'), percent: null }] : []),
        ] });
        const off = api.onProgress((p) => { if (p.note) addLog(p.note); setStage('build', { note: p.note ?? t(`progress.${p.stage}`, { done: formatBytes(p.bytes), total: formatBytes(p.total) }) }); });
        const r = await api.hostBuild({ ...req, ...(dest !== 'emmc' ? { device: disk! } : {}) }).finally(off);
        if (!r.ok) { finish({ ok: false, title: errorText(r.reason), ...(r.detail ? { detail: r.detail } : {}) }); return; }
        setStage('build', { percent: 100, note: t('run.written') });
        if (dest !== 'emmc') { finish({ ok: true, title: t('result.hostDisk'), next: [t(`next.disk.${dest}`), t('next.disk.boot')] }); return; }
        servedTokens.current.push(r.vhd!.token);
        await startMaskrom(() => ({ kind: 'vhd', boardId: board.id, vhd: { url: r.vhd!.url, size: r.vhd!.size }, spotCheck: true, resetAfter: true }), [], null);
        return;
      }
      setRun({ title: t('run.stagingDisk'), log: [], confirm: null, result: null, stages: [{ id: 'write', label: t('run.stagingDisk.stage'), percent: 0 }] });
      const r = await withProgress('write', () => api.writeBoard({ kind: 'stage-disk', ...req, target: dest as 'sd' | 'nvme', device: disk! }));
      finish(resultOf(r, t('result.stagedDisk'), [t(`next.disk.${dest}`), t('next.disk.boot'), ...STAGE_NEXT.slice(1)]));
      return;
    }
    if (onBoard) {
      setRun({ title: task === 'windows' ? t('run.stagingHere') : t('run.firmware'), log: [], confirm: null, result: null,
        stages: [{ id: 'write', label: task === 'windows' ? t('run.here.windows') : t('run.here.firmware', { storage: storageWord(board, task) }), percent: 0 }] });
      const device = board.firmwareStorage === 'spinor' && task !== 'windows' ? here!.mtd[0]?.device : here!.emmc?.device;
      const r = await withProgress('write', () => api.writeBoard(
        task === 'windows' ? { kind: 'stage', boardId: board.id, device: device!, windowsToken: windows!.token, index: index!, setup, drivers: drivers?.token ?? null }
          : board.firmwareStorage === 'spinor' ? { kind: 'spinor', boardId: board.id, device: device! }
            : { kind: 'firmware', boardId: board.id, device: device!, targetId: task },
      ));
      finish(resultOf(r, task === 'windows' ? t('result.stagedHere') : t('result.firmwareHere'),
        task === 'windows' ? [t('next.here.1'), ...STAGE_NEXT.slice(1)] : [t('next.fw.restart')]));
      return;
    }
    if (task === 'windows') {
      const ed = edition!;
      setRun({ title: t('run.staging'), log: [], confirm: null, result: null, stages: [
        { id: 'winpe', label: t('run.winpe', { tag: releases?.winpe?.tag ?? '' }), percent: null },
        { id: 'image', label: t('run.image', { file: windows!.fileName }), percent: null },
        ...(ssh || drivers ? [{ id: 'extras', label: t('run.extras'), percent: null }] : []),
        { id: 'board', label: t('run.board'), percent: null },
        { id: 'write', label: t('run.write'), percent: 0 },
        { id: 'check', label: t('run.check'), percent: null },
      ] });
      const hash = await withProgress('image', () => api.hashWindows(windows!.token));
      if ('error' in hash) { finish({ ok: false, title: errorText(hash.error) }); return; }
      await startMaskrom((s, extras) => ({
        kind: 'stage', boardId: board.id, appVersion: api.version, spotCheck: true, resetAfter: true, setup, extras,
        winpe: { url: s.winpe.url, size: s.winpe.size },
        image: { url: s.image.url, size: s.image.size, extents: windows!.extents, name: windows!.imageName, imageSize: windows!.imageSize,
          sha256: hash.sha256, index: ed.index, edition: ed.name, build: ed.build ?? 0 },
      }), [
        { id: 'winpe', get: () => api.prepareWinpe() },
        { id: 'image', get: () => api.serveWindows(windows!.token) },
      ], { ssh, drivers: drivers?.token ?? null });
      return;
    }
    setRun({ title: t('run.firmware'), log: [], confirm: null, result: null, stages: [
      { id: 'fw', label: t('run.fw', { tag: releases?.firmware?.tag ?? '' }), percent: null },
      { id: 'board', label: t('run.board'), percent: null },
      { id: 'write', label: t('run.writeTo', { storage: storageWord(board, task) }), percent: 0 },
      { id: 'check', label: t('run.check'), percent: null },
    ] });
    await startMaskrom((s) => ({ kind: 'firmware', boardId: board.id, targetId: task, image: { url: s.fw.url, size: s.fw.size }, spotCheck: true, resetAfter: true }),
      [{ id: 'fw', get: () => api.prepareFirmware(board.id) }], null);
  };

  const cancel = () => {
    if (worker.current) {
      worker.current.terminate();
      worker.current = null;
      finish({ ok: false, title: t('result.cancelled') });
    } else api.cancel();
  };
  const closeRun = () => {
    for (const tok of servedTokens.current) api.releaseServed(tok);
    servedTokens.current = [];
    setRun(null);
  };

  // --- steps -------------------------------------------------------------------
  const boardStep = (
    <StepPage title={t('step.board')} lead={t('board.lead')}>
      {here?.rk3576 && (
        <Alert isInline variant="info" title={here.boardName ? t('board.here.title', { board: here.boardName }) : t('board.here.unknown')}>
          {here.boardName ? t('board.here.text') : t('board.here.notRecognised', { ids: here.compatible.join(', ') || '-' })}
        </Alert>
      )}
      <Form onSubmit={(e) => e.preventDefault()}>
        <FormGroup role="radiogroup" fieldId="board" label={t('board.label')} isStack>
          {WOA_BOARDS.map((b) => (
            <Radio key={b.id} id={`board-${b.id}`} name="board" label={b.name} isChecked={boardId === b.id}
              description={b.windows ? t(b.id === 'tspi3m' ? 'board.desc.windows.pads' : 'board.desc.windows.button') : t('board.desc.spi')}
              onChange={() => {
                setBoardId(b.id);
                if (b.id !== here?.boardId) setVia('maskrom');
                if (task === 'windows' && !b.windows) setTask(null);
                if (task === 'uefi-keep' && b.firmwareStorage !== 'emmc') setTask(null);
              }} />
          ))}
        </FormGroup>
        {board && here?.boardId === board.id && (
          <FormGroup role="radiogroup" fieldId="via" label={t('via.label')} isStack>
            <Radio id="via-here" name="via" label={t('via.here')} isChecked={via === 'here'} onChange={() => setVia('here')} description={t('via.here.desc')} />
            <Radio id="via-maskrom" name="via" label={t('via.maskrom')} isChecked={via === 'maskrom'} onChange={() => setVia('maskrom')} description={t('via.maskrom.desc')} />
          </FormGroup>
        )}
      </Form>
    </StepPage>
  );

  const taskStep = board && (
    <StepPage title={t('step.task')} lead={t('task.lead', { board: board.name })}>
      {releases && releases.problems.length > 0 && (
        <Alert isInline variant="warning" title={t('task.problems')}
          actionLinks={<AlertActionLink onClick={() => api.releases(true).then(setReleases)}>{t('task.retry')}</AlertActionLink>}>
          <List>{releases.problems.map((p) => <ListItem key={p}>{msg(p)}</ListItem>)}</List>
        </Alert>
      )}
      <Form onSubmit={(e) => e.preventDefault()}>
        <FormGroup role="radiogroup" fieldId="task" label={t('task.label')} isStack>
          <Radio id="task-windows" name="task" label={t('task.windows.any')} isChecked={task === 'windows'} isDisabled={onBoard && !board.windows}
            onChange={() => { setTask('windows'); if (!board.windows) setDest('nvme'); }} description={board.windows ? t('task.windows.desc') : t('task.windows.rock4d')} />
          {firmwareTargets(board).map((tg) => (
            <Radio key={tg.id} id={`task-${tg.id}`} name="task" label={fwText(board, tg, 'label')} isChecked={task === tg.id}
              onChange={() => setTask(tg.id as Task)}
              description={`${fwText(board, tg, 'note')} ${fwRelease ? t('task.release', { tag: releases!.firmware!.tag, file: fwRelease.file }) : ''}`.trim()} />
          ))}
          {board.windows && (
            <Radio id="task-stick" name="task" label={t('task.stick')} isChecked={task === 'stick'} isDisabled={onBoard}
              onChange={() => { setTask('stick'); refreshDrives(); }} description={t('task.stick.desc')} />
          )}
        </FormGroup>
      </Form>
      {task === 'windows' && (
        <Form onSubmit={(e) => e.preventDefault()}>
          <FormGroup role="radiogroup" fieldId="dest" label={t('dest.label')} isStack>
            <Radio id="dest-emmc" name="dest" label={t('dest.emmc')} isChecked={dest === 'emmc'} isDisabled={!board.windows}
              onChange={() => setDest('emmc')} description={board.windows ? t('dest.emmc.desc') : t('task.windows.rock4d')} />
            <Radio id="dest-sd" name="dest" label={t('dest.sd')} isChecked={dest === 'sd'} isDisabled={onBoard}
              onChange={() => { setDest('sd'); setDisk(null); refreshDrives(30e9); }} description={t(`dest.sd.desc.${board.id === 'tspi3m' ? 'tspi3m' : 'other'}`)} />
            <Radio id="dest-nvme" name="dest" label={t('dest.nvme')} isChecked={dest === 'nvme'} isDisabled={onBoard}
              onChange={() => { setDest('nvme'); setDisk(null); refreshDrives(30e9); }} description={t('dest.nvme.desc')} />
          </FormGroup>
          <FormGroup role="radiogroup" fieldId="method" label={t('method.label')} isStack>
            <Radio id="method-stage" name="method" label={t('method.stage')} isChecked={method === 'stage'} onChange={() => setMethod('stage')}
              description={t('method.stage.desc')} isDisabled={onPc && api.platform === 'darwin'} />
            <Radio id="method-host" name="method" label={t('method.host')} isChecked={method === 'host'} onChange={() => setMethod('host')}
              isDisabled={!WIN_HOST || onBoard} description={WIN_HOST ? t('method.host.desc') : t('method.host.notHere')} />
          </FormGroup>
          {board.id === 'rock4d' && <Alert isInline variant="warning" title={t('rock4d.acpi.title')}>{t('rock4d.acpi.text')}</Alert>}
          {onPc && api.platform === 'darwin' && <Alert isInline variant="warning" title={t('host.macDisk')} />}
        </Form>
      )}
      {onBoard && task === 'windows' && here?.emmcRefusal && (
        <Alert isInline variant="danger" title={t('task.emmcRefused')}>{msg(here.emmcRefusal)}</Alert>
      )}
      {onBoard && task !== 'windows' && board.firmwareStorage === 'spinor' && here?.mtd.length === 0 && (
        <Alert isInline variant="warning" title={t('task.noMtd')}>{msg(here.noMtdHelp)}</Alert>
      )}
    </StepPage>
  );

  const windowsStep = (
    <StepPage title={t('step.windows')} lead={t('win.lead')}>
      <Alert isInline variant="info" title={t('win.24h2.title')}>{t('win.24h2.text')}</Alert>
      <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
        <FlexItem><Button variant="secondary" onClick={() => chooseWindows(() => api.pickWindows())}>{t('win.choose')}</Button></FlexItem>
        {windows && (
          <FlexItem>
            {windows.fileName}: {windows.container === 'iso' ? t('win.inIso', { name: windows.imageName }) : windows.imageName}, {formatBytes(windows.imageSize)}
          </FlexItem>
        )}
      </Flex>
      <div className="drop" onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) chooseWindows(() => api.dropWindows(f)); }}>
        {t('win.drop')}
      </div>
      {windowsError && <Alert isInline variant="danger" title={windowsError} />}
      {windows && (
        <Table aria-label={t('win.col.edition')} variant="compact">
          <Thead><Tr><Th screenReaderText="-" /><Th>{t('win.col.edition')}</Th><Th>{t('win.col.build')}</Th><Th>{t('win.col.installed')}</Th></Tr></Thead>
          <Tbody>
            {windows.editions.map((e) => (
              <Tr key={e.index}>
                <Td select={{ rowIndex: e.index, isSelected: index === e.index, onSelect: () => setIndex(e.index), isDisabled: !!e.refuse, variant: 'radio' }} />
                <Td dataLabel={t('win.col.edition')}>{e.name}{e.refuse && <div className="muted">{refuseText(e.refuse)}</div>}</Td>
                <Td dataLabel={t('win.col.build')}>{e.build ?? '?'}{e.spBuild ? `.${e.spBuild}` : ''}</Td>
                <Td dataLabel={t('win.col.installed')}>{e.totalBytes > 1e6 ? formatBytes(e.totalBytes) : ''}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </StepPage>
  );

  const field = (id: keyof Account, label: string, type: 'text' | 'password' = 'text') => (
    <FormGroup label={label} fieldId={`acc-${id}`} isRequired={id === 'user' || id === 'password'}>
      <TextInput id={`acc-${id}`} type={type} value={account[id] as string} autoComplete="off" spellCheck={false}
        onChange={(_e, v) => setAccount((a) => ({ ...a, [id]: v }))} />
    </FormGroup>
  );

  const setupStep = (
    <StepPage title={t('step.setup')} lead={t('setup.lead')}>
      <Form onSubmit={(e) => e.preventDefault()} className="setup-form">
        <FormGroup role="radiogroup" fieldId="first" label={t('setup.first')} isStack>
          <Radio id="first-oobe" name="first" label={t('setup.oobe')} isChecked={!skip} onChange={() => setSkip(false)} description={t('setup.oobe.desc')} />
          <Radio id="first-skip" name="first" label={t('setup.skip')} isChecked={skip} onChange={() => setSkip(true)} description={t('setup.skip.desc')} />
        </FormGroup>
        {skip && (
          <>
            {field('user', t('setup.user'))}
            {field('password', t('setup.password'), 'password')}
            <FormGroup label={t('setup.password2')} fieldId="acc-password2" isRequired>
              <TextInput id="acc-password2" type="password" value={password2} autoComplete="off" onChange={(_e, v) => setPassword2(v)}
                validated={passwordMismatch && password2 ? 'error' : 'default'} />
            </FormGroup>
            {field('computerName', t('setup.computer'))}
            {field('locale', t('setup.locale'))}
            {field('keyboard', t('setup.keyboard'))}
            {field('timeZone', t('setup.timezone'))}
            <Checkbox id="acc-auto" label={t('setup.autologon')} description={t('setup.autologon.desc')} isChecked={account.autoLogonAlways}
              onChange={(_e, v) => setAccount((a) => ({ ...a, autoLogonAlways: v }))} />
            {(accountErr || (passwordMismatch && password2)) && (
              <HelperText><HelperTextItem variant="error">{accountErr ? t(accountErr) : t('setup.password.mismatch')}</HelperTextItem></HelperText>
            )}
            <Content component="p" className="muted">{t('setup.secret')}</Content>
          </>
        )}
        <FormGroup label={t('setup.ssh')} fieldId="ssh" role="group">
          <Switch id="ssh" label={t('setup.ssh.on')} isChecked={ssh} onChange={(_e, v) => setSsh(v)} />
          <FormHelperText><HelperText><HelperTextItem>{t('setup.ssh.desc', { version: OPENSSH.version })}</HelperTextItem></HelperText></FormHelperText>
        </FormGroup>
        {ssh && (
          <FormGroup label={t('setup.ssh.key')} fieldId="ssh-key">
            <TextArea id="ssh-key" value={sshKey} onChange={(_e, v) => setSshKey(v)} rows={2} resizeOrientation="vertical" spellCheck={false}
              validated={keyErr ? 'error' : 'default'} />
            <FormHelperText><HelperText><HelperTextItem variant={keyErr ? 'error' : 'default'}>{keyErr ? t(keyErr) : t('setup.ssh.key.help')}</HelperTextItem></HelperText></FormHelperText>
          </FormGroup>
        )}
        <FormGroup label={t('setup.drivers')} fieldId="drivers" role="group">
          <Content component="p">{t('setup.drivers.always')}</Content>
          <Content component="p" className="muted">{t('setup.drivers.desc')}</Content>
          <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
            <FlexItem><Button variant="secondary" onClick={chooseDrivers}>{t('setup.drivers.choose')}</Button></FlexItem>
            {drivers && (
              <FlexItem>
                {t('setup.drivers.chosen', { name: drivers.name, infs: drivers.infs, files: drivers.files, size: formatBytes(drivers.bytes) })}{' '}
                <Button variant="link" isInline onClick={() => setDrivers(null)}>{t('setup.drivers.remove')}</Button>
              </FlexItem>
            )}
          </Flex>
          {driversError && <Alert isInline variant="danger" title={driversError} />}
        </FormGroup>
      </Form>
    </StepPage>
  );

  const maskromCard = board && !onBoard && task !== 'stick' && !onPc && (
    <Card>
      <CardTitle>{t('maskrom.title')}</CardTitle>
      <CardBody>
        <Stack hasGutter>
          <List component="ol" type={OrderType.number}>{maskromSteps(board).map((s) => <ListItem key={s}>{s}</ListItem>)}</List>
          {board.webflash.maskromNote && <Content component="p">{lang === 'en' ? board.webflash.maskromNote : t('maskrom.tspi3m.note')}</Content>}
          <DriversNote />
        </Stack>
      </CardBody>
    </Card>
  );

  let reviewRows: Array<[string, React.ReactNode]> = [];
  let why: string | null = null;
  let goLabel = t('go.connect');
  if (board && task) {
    reviewRows.push([t('review.board'), onBoard ? t('review.board.here', { board: board.name }) : t('review.board.maskrom', { board: board.name })]);
    if (task === 'windows') {
      reviewRows = reviewRows.concat([
        [t('review.windows'), edition ? t('review.windows.value', { edition: edition.name, build: `${edition.build}${edition.spBuild ? `.${edition.spBuild}` : ''}`, file: windows!.fileName }) : t('review.notChosen')],
        [t('review.winpe'), releases?.winpe ? `woa-rk3576 ${releases.winpe.tag} (${releases.winpe.file})` : t('review.unavailable')],
        [t('review.setup'), skip ? t('review.setup.skip', { user: account.user, auto: account.autoLogonAlways ? t('review.setup.auto') : '' }) : t('review.setup.oobe')],
        [t('review.ssh'), ssh ? t('review.ssh.on', { key: sshKey.trim() ? t('review.ssh.key') : '' }) : t('review.ssh.off')],
        [t('review.drivers'), t('review.drivers.value', { extra: drivers ? t('review.drivers.extra', { name: drivers.name }) : '' })],
        [t('review.target'), t(`review.target.${dest}.${method}`)],
        [t('review.erased'), dest === 'emmc' ? t('review.erased.windows') : disk ? t('review.erased.disk', { drive: drives?.find((x) => x.device === disk)?.description ?? disk }) : t('review.disk.choose')],
        ...(method === 'stage' ? [
          [t('review.written'), t('review.written.windows', { size: windows ? formatBytes(windows.imageSize + 560e6) : '' }) + (onBoard || dest !== 'emmc' ? '' : t('review.written.maskrom'))],
          [t('review.checked'), onBoard || dest !== 'emmc' ? t('review.checked.here') : t('review.checked.maskrom')],
          [t('review.then'), t('review.then.windows')],
        ] as Array<[string, string]> : [
          [t('review.checked'), dest === 'emmc' ? t('review.checked.host.emmc') : t('review.checked.host.disk')],
        ] as Array<[string, string]>),
      ]);
      if (!edition) why = t('why.windows');
      else if (!setupOk) why = t('why.setup');
      if (!releases?.winpe) why = t('why.winpe');
      if (onBoard && here?.emmcRefusal) why = msg(here.emmcRefusal);
      if (dest !== 'emmc' && !disk) why = t('review.disk.choose');
      if (!destOk) why = t('host.macDisk');
      goLabel = onBoard || dest !== 'emmc' || method === 'host' ? t('go.erase') : t('go.connect');
    } else if (task === 'stick') {
      reviewRows = reviewRows.concat([
        [t('review.written'), releases?.winpe ? t('review.stick.written', { tag: releases.winpe.tag, file: releases.winpe.file }) : t('review.unavailable')],
        [t('review.erased'), stick ? t('review.stick.erased', { drive: drives?.find((x) => x.device === stick)?.description ?? stick }) : t('review.stick.choose')],
        [t('review.checked'), t('review.stick.checked')],
      ]);
      if (!stick) why = t('why.stick');
      goLabel = t('go.erase');
    } else {
      const tg = firmwareTargets(board).find((x) => x.id === task)!;
      reviewRows = reviewRows.concat([
        [t('review.firmware'), fwRelease ? `edk2-rk3576 ${releases!.firmware!.tag}, ${fwRelease.file}` : t('review.unavailable')],
        [t('review.written'), tg.slice ? t('review.fw.slice', { a: tg.slice[0], b: tg.slice[1], lba: tg.lba }) : t('review.fw.whole', { lba: tg.lba })],
        [t('review.erased'), fwText(board, tg, 'erases')],
        [t('review.checked'), onBoard ? t('review.checked.fw.here') : t('review.checked.fw.maskrom')],
        [t('review.then'), fwText(board, tg, 'done')],
      ]);
      if (!fwRelease) why = t('why.firmware');
      if (onBoard && board.firmwareStorage === 'emmc' && here?.emmcRefusal) why = msg(here.emmcRefusal);
      if (onBoard && board.firmwareStorage === 'spinor' && !here?.mtd.length) why = t('why.mtd');
      goLabel = onBoard ? t('go.erase') : t('go.connect');
    }
  }

  const reviewStep = (
    <StepPage title={t('step.review')}>
      <Review rows={reviewRows} />
      {onPc && (
        <FormGroup role="radiogroup" fieldId="disk" label={t(`review.drive.${dest}`)} isStack>
          {drives === null ? <Content component="p">{t('review.usb.looking')}</Content>
            : drives.length === 0 ? <Content component="p">{t('review.drive.none')}</Content>
              : drives.map((x) => (
                <Radio key={x.device} id={`disk-${x.device}`} name="disk" isChecked={disk === x.device} onChange={() => setDisk(x.device)}
                  label={`${x.description} (${formatBytes(x.size)})`} description={x.device} />
              ))}
          <Button variant="link" isInline onClick={() => refreshDrives(30e9)}>{t('refresh')}</Button>
        </FormGroup>
      )}
      {task === 'stick' && (
        <FormGroup role="radiogroup" fieldId="stick" label={t('review.usb')} isStack>
          {drives === null ? <Content component="p">{t('review.usb.looking')}</Content>
            : drives.length === 0 ? <Content component="p">{t('review.usb.none')}</Content>
              : drives.map((x) => (
                <Radio key={x.device} id={`stick-${x.device}`} name="stick" isChecked={stick === x.device} onChange={() => setStick(x.device)}
                  label={`${x.description} (${formatBytes(x.size)})`} description={x.device} />
              ))}
          <Button variant="link" isInline onClick={() => refreshDrives()}>{t('refresh')}</Button>
        </FormGroup>
      )}
      {maskromCard}
    </StepPage>
  );

  const windowsNeeded = task === 'windows';
  const c = run?.confirm;
  const confirmText = c && (c.kind === 'stage' ? (
    <Stack hasGutter>
      <Content component="p">{t('confirm.answered', { size: GB(c.capacity) })}</Content>
      <Review rows={[
        [t('confirm.kept'), t('confirm.kept.value')],
        [t('confirm.removed'), c.removed.length ? c.removed.map((p) => `${p.name} (${GB(p.bytes)})`).join(', ') : t('confirm.removed.none')],
        [t('confirm.windowsGets'), t('confirm.windowsGets.value', { size: GB(c.windowsBytes) })],
        [t('confirm.sent'), formatBytes(c.totalBytes)],
      ]} />
    </Stack>
  ) : (
    <Review rows={[
      [t('confirm.write'), t('confirm.write.value', { target: c.target, size: formatBytes(c.bytes), lba: c.lba })],
      [t('confirm.storage'), c.capacity ? GB(c.capacity) : t('confirm.storage.unknown')],
      ...(c.dropped.length ? [[t('confirm.dropped'), c.dropped.map((p) => `${p.name} (${GB(p.bytes)})`).join(', ')] as [string, string]] : []),
    ]} />
  ));

  const askTitle = !board || !task ? '' : task === 'stick' ? t('ask.stick.title')
    : onPc ? t('ask.disk.title') : task === 'windows' && method === 'host' ? t('ask.host.title')
    : onBoard ? t('ask.here.title', { storage: storageWord(board, task) }) : t('ask.connect.title');
  const askText = !board || !task ? '' : task === 'stick' ? t('ask.stick.text')
    : onPc ? t('ask.disk.text', { drive: drives?.find((x) => x.device === disk)?.description ?? disk ?? '' })
      : task === 'windows' && method === 'host' ? t('ask.host.text')
    : onBoard ? `${here?.emmc && (task === 'windows' || board.firmwareStorage === 'emmc') ? `${here.emmc.model}, ${here.emmc.device}, ${GB(here.emmc.bytes)}. ` : ''}${task === 'windows' ? t('ask.here.windows') : ''}${t('ask.here.password')}`
      : t('ask.connect.text');

  return (
    <Shell onSettings={() => setSettings(true)}>
      {!run && offer && dismissed !== offer.version && (
        <PageSection aria-label={t('settings.updates')} className="update-notice">
          <Alert isInline variant="info" title={t('update.available', { version: `${offer.version}${offer.beta ? ' (beta)' : ''}` })}
            actionClose={<AlertActionCloseButton onClose={() => { setDismissed(offer.version); try { localStorage.setItem('updateDismissed', offer.version); } catch { /* none */ } }} />}
            actionLinks={<><AlertActionLink onClick={() => setUpdating(true)}>{t('settings.update')}</AlertActionLink><AlertActionLink component="a" href={offer.url} target="_blank">{t('update.notes')}</AlertActionLink></>}>
            {offer.notes}
          </Alert>
        </PageSection>
      )}
      {run ? (
        <PageSection isFilled aria-label={run.title}>
          <Stack hasGutter className="step">
            <Title headingLevel="h2">{run.result ? (run.result.ok ? t('run.done') : t('run.stopped')) : run.title}</Title>
            <ProgressList stages={run.stages} waiting={t('run.waiting')} />
            {run.confirm && (
              <Card>
                <CardTitle>{t('confirm.title')}</CardTitle>
                <CardBody>
                  <Stack hasGutter>
                    {confirmText}
                    <ActionList>
                      <ActionListGroup>
                        <ActionListItem><Button variant="danger" onClick={() => answer(true)}>{t('go.erase')}</Button></ActionListItem>
                        <ActionListItem><Button variant="secondary" onClick={() => answer(false)}>{t('confirm.stop')}</Button></ActionListItem>
                      </ActionListGroup>
                    </ActionList>
                  </Stack>
                </CardBody>
              </Card>
            )}
            {run.result && (
              <Alert isInline variant={run.result.ok ? 'success' : 'danger'} title={run.result.title}>
                {run.result.text && <p>{run.result.text}</p>}
                {run.result.detail && <p className="detail">{run.result.detail}</p>}
              </Alert>
            )}
            {run.result?.ok && run.result.next && (
              <Card>
                <CardTitle>{t('next.title')}</CardTitle>
                <CardBody><List component="ol" type={OrderType.number}>{run.result.next.map((n) => <ListItem key={n}>{n}</ListItem>)}</List></CardBody>
              </Card>
            )}
            <StackItem>
              {!run.result ? <Button variant="secondary" onClick={cancel}>{t('cancel')}</Button>
                : <Button variant="primary" onClick={closeRun}>{t('done')}</Button>}
            </StackItem>
            {run.log.length > 0 && (
              <ExpandableSection toggleText={t('log')} className="log">
                <CodeBlock><CodeBlockCode>{run.log.slice(-400).join('\n')}</CodeBlockCode></CodeBlock>
              </ExpandableSection>
            )}
          </Stack>
        </PageSection>
      ) : (
        <PageSection type="wizard" isFilled hasBodyWrapper={false} aria-label={t('app.name')}>
          <Wizard navAriaLabel="Steps" isVisitRequired>
            <WizardStep name={t('step.board')} id="board" footer={{ isNextDisabled: !board, isCancelHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{boardStep}</WizardStep>
            <WizardStep name={t('step.task')} id="task" isDisabled={!board} footer={{ isNextDisabled: !task, isCancelHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{taskStep}</WizardStep>
            <WizardStep name={t('step.windows')} id="windows" isHidden={!windowsNeeded} footer={{ isNextDisabled: !edition, isCancelHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{windowsStep}</WizardStep>
            <WizardStep name={t('step.setup')} id="setup" isHidden={!windowsNeeded} isDisabled={!edition} footer={{ isNextDisabled: !setupOk, isCancelHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{setupStep}</WizardStep>
            <WizardStep name={t('step.review')} id="review" isDisabled={!task || (windowsNeeded && (!edition || !setupOk))}
              footer={<ReviewFooter label={goLabel} disabled={!!why} why={why} onGo={() => setAsk(true)} />}>
              {reviewStep}
            </WizardStep>
          </Wizard>
        </PageSection>
      )}
      <Modal isOpen={ask} onClose={() => setAsk(false)} variant="small" aria-labelledby="ask-title">
        <ModalHeader title={askTitle} labelId="ask-title" />
        <ModalBody>{askText}</ModalBody>
        <ModalFooter>
          <Button variant={onBoard || task === 'stick' || onPc ? 'danger' : 'primary'} onClick={start}>{onBoard || task === 'stick' || onPc ? t('go.erase') : t('ask.connect')}</Button>
          <Button variant="link" onClick={() => setAsk(false)}>{t('cancel')}</Button>
        </ModalFooter>
      </Modal>
      <SettingsModal open={settings} onClose={() => setSettings(false)} theme={theme} setTheme={setTheme}
        onOffer={(o) => setOffer(o)} onUpdate={() => { setSettings(false); setUpdating(true); }} writing={!!run && !run.result} />
      {updating && <UpdateModal offer={offer} onClose={() => setUpdating(false)} />}
    </Shell>
  );
}
