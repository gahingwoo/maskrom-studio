// The WoA RK3576 Imager page: one wizard (board, what to write, the Windows
// image, review), then the write itself in place of the wizard.
import { useEffect, useRef, useState } from 'react';
import {
  ActionList, ActionListGroup, ActionListItem, Alert, AlertActionCloseButton, AlertActionLink, Button, Card, CardBody,
  CardTitle, CodeBlock, CodeBlockCode, Content, DescriptionList, DescriptionListDescription, DescriptionListGroup,
  DescriptionListTerm, ExpandableSection, Flex, FlexItem, Form, FormGroup, List, ListItem, Modal, ModalBody, ModalFooter,
  ModalHeader, OrderType, PageSection, Progress, ProgressMeasureLocation, Radio, Stack, StackItem, Title, Wizard,
  WizardFooterWrapper, WizardStep, useWizardContext,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { formatBytes } from '../shared/format';
import type { BoardHereInfo, JobProgress, JobResult, Releases, Served, WindowsChoice } from '../shared/ipc';
import type { Target } from '../shared/targets';
import type { UpdateOffer } from '../shared/update';
import { firmwareTargets, WOA_BOARDS, woaBoard, type BoardId } from '../woa/boards';
import type { WoaJob, WoaWorkerEvent, WoaWorkerRequest } from '../woa/woa-worker';
import type { RegionResult, RegionStage } from '../woa/maskrom-regions';
import { api, DriversNote, SettingsModal, Shell, StepPage, UpdateModal } from './common';
import { applyTheme, readTheme, type Theme } from './theme';

type Task = 'windows' | 'uefi' | 'uefi-keep' | 'stick';
type Via = 'maskrom' | 'here';

const GB = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
const LOADER = 'rk3576_spl_loader.bin';

interface Stage { id: string; label: string; percent: number | null; note?: string }
interface Run {
  title: string;
  stages: Stage[];
  log: string[];
  /** The plan the board answered with, waiting for the user's yes. */
  confirm: StageSummary | FirmwareSummary | null;
  result: { ok: boolean; title: string; text?: string; detail?: string; next?: string[] } | null;
}
interface StageSummary { kind: 'stage'; capacity: number; windowsBytes: number; totalBytes: number; removed: Array<{ name: string; bytes: number }> }
interface FirmwareSummary { kind: 'firmware'; board: string; target: string; lba: number; bytes: number; capacity: number | null; dropped: Array<{ name: string; bytes: number }>; erases: string }

const STAGE_WORDS: Record<RegionStage, string> = {
  detect: 'Looking for the board', loader: 'Sending the loader', reconnect: 'Waiting for the board to come back',
  probe: 'Reading the eMMC', confirm: 'Waiting for your confirmation', write: 'Writing', check: 'Reading samples back', reset: 'Restarting the board',
};

/** What the board does after a staged install was written, for the result page. */
const STAGE_NEXT = [
  'The board restarts from the eMMC into WinPE (about 2 minutes to the first text on screen). Keep the SD card slot and the USB ports empty, so the firmware boots the eMMC.',
  'WinPE waits 15 seconds, then partitions the free space, applies Windows (20 to 40 minutes), adds the RK3576 drivers and writes the boot files. The screen shows each step.',
  'It deletes the staging partitions, gives their space to Windows and restarts. Windows then sets itself up and restarts once more. OOBE finishes without a network.',
  'If anything fails, WinPE stops with the log on screen and the staging partitions stay: restarting the board runs the install again.',
];

function ProgressList({ stages }: { stages: Stage[] }) {
  return (
    <Flex direction={{ default: 'column' }} spaceItems={{ default: 'spaceItemsXl' }}>
      {stages.map((s) => (
        <FlexItem key={s.id}>
          <Progress title={s.label} value={s.percent ?? 0} measureLocation={ProgressMeasureLocation.top} aria-label={s.label}
            {...(s.percent === null ? { label: s.note ?? 'Waiting', valueText: s.note ?? 'Waiting' } : s.note ? { label: s.note } : {})} />
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
  return (
    <WizardFooterWrapper>
      <Stack hasGutter>
        {why && <Content component="p" className="footer-note">{why}</Content>}
        <ActionList>
          <ActionListGroup>
            <ActionListItem><Button variant="secondary" onClick={goToPrevStep}>Back</Button></ActionListItem>
            <ActionListItem><Button variant="primary" onClick={onGo} isDisabled={disabled}>{label}</Button></ActionListItem>
          </ActionListGroup>
        </ActionList>
      </Stack>
    </WizardFooterWrapper>
  );
}

function progressPercent(p: JobProgress): number {
  return p.total > 0 ? Math.min(100, Math.floor((p.bytes * 100) / p.total)) : 0;
}

export function App() {
  const [theme, setThemeState] = useState<Theme>(readTheme());
  const setTheme = (t: Theme) => { setThemeState(t); applyTheme(t); };
  const [releases, setReleases] = useState<Releases | null>(null);
  const [here, setHere] = useState<BoardHereInfo | null>(null);
  const [boardId, setBoardId] = useState<BoardId | null>(null);
  const [via, setVia] = useState<Via>('maskrom');
  const [task, setTask] = useState<Task | null>(null);
  const [windows, setWindows] = useState<WindowsChoice | null>(null);
  const [windowsError, setWindowsError] = useState<string | null>(null);
  const [index, setIndex] = useState<number | null>(null);
  const [drives, setDrives] = useState<Target[] | null>(null);
  const [stick, setStick] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [settings, setSettings] = useState(false);
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [updating, setUpdating] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => { try { return localStorage.getItem('updateDismissed'); } catch { return null; } });
  const worker = useRef<Worker | null>(null);

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
    const t = setInterval(look, 60 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  const board = boardId ? woaBoard(boardId)! : null;
  const onBoard = via === 'here' && !!here?.boardId && here.boardId === boardId;
  const edition = windows?.editions.find((e) => e.index === index) ?? null;
  const fwRelease = releases?.firmware && boardId ? releases.firmware.boards[boardId] : undefined;

  const refreshDrives = () => { setDrives(null); api.listDrives(600e6).then((d) => setDrives(d.targets.filter((t) => !t.disabled))); };

  const chooseWindows = async (pick: () => Promise<WindowsChoice | { error: string } | null>) => {
    setWindowsError(null);
    const r = await pick();
    if (!r) return;
    if ('error' in r) { setWindowsError(r.error); setWindows(null); setIndex(null); return; }
    setWindows(r);
    const ok = r.editions.filter((e) => !e.refuse);
    const pro = ok.find((e) => /\bpro\b/i.test(e.name) && !/workstation|education/i.test(e.name));
    setIndex((pro ?? ok[0])?.index ?? null);
  };

  // --- running -----------------------------------------------------------------
  const update = (f: (r: Run) => Run) => setRun((cur) => (cur ? f(cur) : cur));
  const setStage = (id: string, patch: Partial<Stage>) => update((r) => ({ ...r, stages: r.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) }));
  const addLog = (line: string) => update((r) => ({ ...r, log: [...r.log.slice(-600), line] }));
  const finish = (result: Run['result']) => update((r) => ({ ...r, result, confirm: null }));

  /** Run a main-process job, showing its progress on stage `id`. */
  const withProgress = async <T,>(id: string, fn: () => Promise<T>): Promise<T> => {
    const off = api.onProgress((p) => {
      const words: Record<JobProgress['stage'], string> = { download: 'Downloading', check: 'Checking', decompress: 'Unpacking', write: 'Writing', verify: 'Reading back' };
      setStage(id, { percent: progressPercent(p), note: `${words[p.stage]}: ${formatBytes(p.bytes)} of ${formatBytes(p.total)}` });
    });
    try { return await fn(); } finally { off(); }
  };

  const resultOf = (r: JobResult | RegionResult, okTitle: string, next?: string[]): Run['result'] => {
    if (r.ok) {
      let text: string | undefined;
      if ('checks' in r && r.checks) {
        const c = r.checks;
        text = c.matched === c.samples
          ? `All ${c.samples} samples read back as written.`
          : `${c.matched} of ${c.samples} samples read back as written. ${c.filler + c.unsure} lie past the first 32 MiB, where this loader's reads are not reliable${c.filler ? ` (${c.filler} came back as 0xCC filler)` : ''}; the board checks the image itself while it installs.`;
      }
      return { ok: true, title: okTitle, ...(text ? { text } : {}), ...(next ? { next } : {}) };
    }
    return { ok: false, title: r.reason, ...('detail' in r && r.detail ? { detail: r.detail } : {}) };
  };

  const startMaskrom = async (jobFor: (served: Record<string, Served>) => WoaJob, prep: Array<{ id: string; label: string; get: () => Promise<Served | { error: string }> }>) => {
    const served: Record<string, Served> = {};
    try {
      for (const p of prep) {
        setStage(p.id, { percent: 0, note: 'Starting' });
        const s = await withProgress(p.id, p.get);
        if ('error' in s) { finish({ ok: false, title: s.error }); return; }
        served[p.id] = s;
        setStage(p.id, { percent: 100, note: `${s.name}, ${formatBytes(s.size)}` });
      }
      const loader = await api.getLoader(LOADER);
      if ('error' in loader) { finish({ ok: false, title: 'The Maskrom loader could not be downloaded.', detail: loader.error }); return; }
      const settingsNow = await api.getSettings();
      const job = jobFor(served);
      if ('resetAfter' in job) job.resetAfter = job.kind === 'stage' ? true : settingsNow.resetAfterMaskrom;
      const w = new Worker('woa-worker.js', { type: 'module' });
      worker.current = w;
      const at = (p: string) => new URL(p, document.baseURI).href;
      w.onmessage = (e: MessageEvent<WoaWorkerEvent>) => {
        const m = e.data;
        if (m.type === 'log') addLog(m.line);
        else if (m.type === 'stage') {
          if (m.stage === 'write' || m.stage === 'check' || m.stage === 'reset') setStage('board', { percent: 100, note: 'Connected' });
          if (m.stage === 'check') setStage('write', { percent: 100, note: 'Written' });
          const target = m.stage === 'write' ? 'write' : m.stage === 'check' || m.stage === 'reset' ? 'check' : 'board';
          setStage(target, { note: STAGE_WORDS[m.stage] });
        } else if (m.type === 'progress') {
          setStage('write', { percent: Math.min(100, Math.floor((m.done * 100) / Math.max(1, m.total))), note: `${formatBytes(m.done)} of ${formatBytes(m.total)}` });
        } else if (m.type === 'planned') {
          update((r) => ({ ...r, confirm: m.summary as StageSummary | FirmwareSummary }));
        } else if (m.type === 'result') {
          w.terminate();
          worker.current = null;
          const next = job.kind === 'stage' ? STAGE_NEXT : undefined;
          finish(resultOf(m.result, job.kind === 'stage' ? 'Staged. The board now installs Windows by itself.' : 'The firmware is written.', next));
          if (m.result.ok) update((r) => ({ ...r, stages: r.stages.map((s) => ({ ...s, percent: 100 })) }));
        }
      };
      w.onerror = (e) => { finish({ ok: false, title: 'The Maskrom writer stopped.', detail: e.message }); w.terminate(); };
      w.postMessage({
        type: 'woa-start', job, moduleUrl: at('wasm/rkdeveloptool.js'), wasmUrl: at('wasm/rkdeveloptool.wasm'), loaderUrl: loader.url,
      } satisfies WoaWorkerRequest);
    } finally {
      // Files stay served while the worker reads them; released when the run view closes.
      servedTokens.current = Object.values(served).map((s) => s.token);
    }
  };
  const servedTokens = useRef<string[]>([]);

  const answer = (ok: boolean) => {
    update((r) => ({ ...r, confirm: null }));
    worker.current?.postMessage({ type: 'woa-confirm', ok } satisfies WoaWorkerRequest);
  };

  const start = async () => {
    setAsk(false);
    if (!board || !task) return;
    if (task === 'stick') {
      setRun({ title: 'Writing the WinPE stick', log: [], confirm: null, result: null, stages: [{ id: 'write', label: 'WinPE image to the USB drive', percent: 0 }] });
      const r = await withProgress('write', () => api.writeWinpeStick(stick!));
      finish(resultOf(r, 'The stick is written.', [
        'Add a partition in the free space of the stick (exFAT or NTFS) and copy sources\\install.wim from the Windows ISO onto it.',
        'Boot the stick on the board from a USB-A port and run woa-deploy\\deploy-windows.cmd, as woa-rk3576 docs/INSTALL.md describes.',
      ]));
      return;
    }
    if (onBoard) {
      const stages: Stage[] = task === 'windows'
        ? [{ id: 'write', label: 'Download, check and write to this board\'s eMMC', percent: 0 }]
        : [{ id: 'write', label: `Firmware to this board's ${board.firmwareStorage === 'emmc' ? 'eMMC' : 'SPI NOR flash'}`, percent: 0 }];
      setRun({ title: task === 'windows' ? 'Staging Windows on this board' : 'Writing the firmware', log: [], confirm: null, result: null, stages });
      const device = board.firmwareStorage === 'spinor' && task !== 'windows' ? here!.mtd[0]?.device : here!.emmc?.device;
      const r = await withProgress('write', () => api.writeBoard(
        task === 'windows' ? { kind: 'stage', boardId: board.id, device: device!, windowsToken: windows!.token, index: index! }
          : board.firmwareStorage === 'spinor' ? { kind: 'spinor', boardId: board.id, device: device! }
            : { kind: 'firmware', boardId: board.id, device: device!, targetId: task },
      ));
      finish(resultOf(r, task === 'windows' ? 'Staged and read back. Restart into the eMMC to install.' : 'The firmware is written and read back.', task === 'windows' ? [
        'Shut this system down. Take out the SD card or USB drive it runs from, so the firmware boots the eMMC.',
        ...STAGE_NEXT.slice(1),
      ] : ['Restart the board to use the new firmware.']));
      return;
    }
    // Over Maskrom.
    if (task === 'windows') {
      setRun({ title: 'Staging Windows on the eMMC', log: [], confirm: null, result: null, stages: [
        { id: 'winpe', label: `WinPE from woa-rk3576 ${releases?.winpe?.tag ?? ''}`, percent: null },
        { id: 'image', label: `Windows image: ${windows!.fileName}`, percent: null },
        { id: 'board', label: 'Board in Maskrom mode', percent: null },
        { id: 'write', label: 'Writing to the eMMC', percent: 0 },
        { id: 'check', label: 'Samples read back', percent: null },
      ] });
      const hash = await withProgress('image', () => api.hashWindows(windows!.token));
      if ('error' in hash) { finish({ ok: false, title: hash.error }); return; }
      const ed = edition!;
      await startMaskrom((s) => ({
        kind: 'stage', boardId: board.id, appVersion: api.version, spotCheck: true, resetAfter: true,
        winpe: { url: s.winpe.url, size: s.winpe.size },
        image: { url: s.image.url, size: s.image.size, extents: windows!.extents, name: windows!.imageName, imageSize: windows!.imageSize,
          sha256: hash.sha256, index: ed.index, edition: ed.name, build: ed.build ?? 0 },
      }), [
        { id: 'winpe', label: 'WinPE', get: () => api.prepareWinpe() },
        { id: 'image', label: 'Windows', get: () => api.serveWindows(windows!.token) },
      ]);
      return;
    }
    setRun({ title: 'Writing the firmware', log: [], confirm: null, result: null, stages: [
      { id: 'fw', label: `edk2-rk3576 ${releases?.firmware?.tag ?? ''}`, percent: null },
      { id: 'board', label: 'Board in Maskrom mode', percent: null },
      { id: 'write', label: `Writing to the ${board.webflash.storage}`, percent: 0 },
      { id: 'check', label: 'Samples read back', percent: null },
    ] });
    await startMaskrom((s) => ({ kind: 'firmware', boardId: board.id, targetId: task, image: { url: s.fw.url, size: s.fw.size }, spotCheck: true, resetAfter: true }),
      [{ id: 'fw', label: 'Firmware', get: () => api.prepareFirmware(board.id) }]);
  };

  const cancel = () => {
    if (worker.current) {
      worker.current.terminate();
      worker.current = null;
      finish({ ok: false, title: 'Cancelled. The eMMC may be only partly written: run the same write again before restarting the board.' });
    } else api.cancel();
  };
  const closeRun = () => {
    for (const t of servedTokens.current) api.releaseServed(t);
    servedTokens.current = [];
    setRun(null);
  };

  // --- steps -------------------------------------------------------------------
  const boardStep = (
    <StepPage title="Board" lead="The board to write. Windows goes on its eMMC; the firmware on the eMMC or, on the ROCK 4D, the SPI NOR flash.">
      {here?.rk3576 && (
        <Alert isInline variant="info" title={here.boardName ? `This computer is the board: ${here.boardName}` : 'This computer is an RK3576 board'}>
          {here.boardName
            ? 'The app can write this board directly, without Maskrom and without a second computer.'
            : `The board was not recognised (device tree: ${here.compatible.join(', ') || 'none'}). Choose it below to write it over Maskrom from another computer.`}
        </Alert>
      )}
      <Form onSubmit={(e) => e.preventDefault()}>
        <FormGroup role="radiogroup" fieldId="board" label="Board" isStack>
          {WOA_BOARDS.map((b) => (
            <Radio key={b.id} id={`board-${b.id}`} name="board" label={b.name} isChecked={boardId === b.id}
              description={b.windows ? `eMMC firmware and Windows. ${b.webflash.maskrom.length > 2 ? 'Maskrom button.' : 'No Maskrom button: MSK pads or F4 in the firmware.'}` : 'SPI NOR firmware only in this version.'}
              onChange={() => { setBoardId(b.id); if (b.id !== here?.boardId) setVia('maskrom'); if (task === 'windows' && !b.windows) setTask(null); if (task === 'uefi-keep' && b.firmwareStorage !== 'emmc') setTask(null); }} />
          ))}
        </FormGroup>
        {board && here?.boardId === board.id && (
          <FormGroup role="radiogroup" fieldId="via" label="How" isStack>
            <Radio id="via-here" name="via" label="Write this board directly" isChecked={via === 'here'} onChange={() => setVia('here')}
              description="Linux on this board writes its own eMMC or SPI NOR flash. The system must run from an SD card or a USB drive." />
            <Radio id="via-maskrom" name="via" label="Over USB from another computer (Maskrom)" isChecked={via === 'maskrom'} onChange={() => setVia('maskrom')}
              description="This computer writes a board connected to it in Maskrom mode." />
          </FormGroup>
        )}
      </Form>
    </StepPage>
  );

  const taskStep = board && (
    <StepPage title="What to write" lead={`For the ${board.name}.`}>
      {releases && releases.problems.length > 0 && (
        <Alert isInline variant="warning" title="Some release files could not be read"
          actionLinks={<AlertActionLink onClick={() => api.releases(true).then(setReleases)}>Try again</AlertActionLink>}>
          <List>{releases.problems.map((p) => <ListItem key={p}>{p}</ListItem>)}</List>
        </Alert>
      )}
      <Form onSubmit={(e) => e.preventDefault()}>
        <FormGroup role="radiogroup" fieldId="task" label="Write" isStack>
          <Radio id="task-windows" name="task" label="Windows 11 on the eMMC" isChecked={task === 'windows'} isDisabled={!board.windows}
            onChange={() => setTask('windows')}
            description={board.windows
              ? 'No USB stick needed. WinPE and your Windows image are written to the free space of the eMMC; the board then installs Windows from there by itself and removes them. Needs the edk2-rk3576 firmware on the eMMC first.'
              : board.windowsNote} />
          {firmwareTargets(board).map((t) => (
            <Radio key={t.id} id={`task-${t.id}`} name="task" label={t.label} isChecked={task === t.id}
              onChange={() => setTask(t.id as Task)}
              description={`${t.note ?? ''} ${fwRelease ? `edk2-rk3576 ${releases!.firmware!.tag}, ${fwRelease.file}.` : ''}`.trim()} />
          ))}
          {board.windows && (
            <Radio id="task-stick" name="task" label="WinPE USB stick (the procedure without this app)" isChecked={task === 'stick'} isDisabled={onBoard}
              onChange={() => { setTask('stick'); refreshDrives(); }}
              description="Writes woa-rk3576's WinPE image to a USB drive, to install from as woa-rk3576's INSTALL.md describes. You then add the Windows image to the stick yourself." />
          )}
        </FormGroup>
      </Form>
      {onBoard && task === 'windows' && here?.emmcRefusal && (
        <Alert isInline variant="danger" title="The eMMC cannot be written from this system">{here.emmcRefusal}</Alert>
      )}
      {onBoard && task !== 'windows' && board.firmwareStorage === 'spinor' && here?.mtd.length === 0 && (
        <Alert isInline variant="warning" title="No SPI NOR flash">{here.noMtdHelp}</Alert>
      )}
    </StepPage>
  );

  const windowsStep = (
    <StepPage title="Windows image" lead="A Windows 11 23H2 ARM64 ISO, or the install.wim or install.esd from one. Nothing is copied: the image is read from where it is while it is written.">
      <Alert isInline variant="info" title="Windows 11 24H2 and later cannot run on RK3576">
        RK3576 is ARMv8.0, and 24H2 (build 26100) needs ARMv8.1. Images newer than build 25999 are refused.
      </Alert>
      <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
        <FlexItem><Button variant="secondary" onClick={() => chooseWindows(() => api.pickWindows())}>Choose a file</Button></FlexItem>
        {windows && <FlexItem>{windows.fileName}: {windows.imageName}{windows.container === 'iso' ? ' in the ISO' : ''}, {formatBytes(windows.imageSize)}</FlexItem>}
      </Flex>
      <div className="drop" onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) chooseWindows(() => api.dropWindows(f)); }}>
        Or drop the file here.
      </div>
      {windowsError && <Alert isInline variant="danger" title={windowsError} />}
      {windows && (
        <Table aria-label="Editions" variant="compact">
          <Thead><Tr><Th screenReaderText="Choose" /><Th>Edition</Th><Th>Build</Th><Th>Installed</Th></Tr></Thead>
          <Tbody>
            {windows.editions.map((e) => (
              <Tr key={e.index}>
                <Td select={{ rowIndex: e.index, isSelected: index === e.index, onSelect: () => setIndex(e.index), isDisabled: !!e.refuse, variant: 'radio' }} />
                <Td dataLabel="Edition">{e.name}{e.refuse && <div className="muted">{e.refuse}</div>}</Td>
                <Td dataLabel="Build">{e.build ?? '?'}{e.spBuild ? `.${e.spBuild}` : ''}</Td>
                <Td dataLabel="Installed">{e.totalBytes > 1e6 ? formatBytes(e.totalBytes) : ''}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </StepPage>
  );

  const maskromCard = board && !onBoard && task !== 'stick' && (
    <Card isPlain={false}>
      <CardTitle>Put the board in Maskrom mode</CardTitle>
      <CardBody>
        <Stack hasGutter>
          <List component="ol" type={OrderType.number}>{board.webflash.maskrom.map((s) => <ListItem key={s}>{s}</ListItem>)}</List>
          {board.webflash.maskromNote && <Content component="p">{board.webflash.maskromNote}</Content>}
          <DriversNote />
        </Stack>
      </CardBody>
    </Card>
  );

  let reviewRows: Array<[string, React.ReactNode]> = [];
  let why: string | null = null;
  let goLabel = 'Connect and write';
  if (board && task) {
    reviewRows.push(['Board', `${board.name}${onBoard ? ' (this computer)' : ', over USB in Maskrom mode'}`]);
    if (task === 'windows') {
      reviewRows = reviewRows.concat([
        ['Windows', edition ? `${edition.name}, build ${edition.build}${edition.spBuild ? `.${edition.spBuild}` : ''}, from ${windows!.fileName}` : 'not chosen'],
        ['WinPE', releases?.winpe ? `woa-rk3576 ${releases.winpe.tag} (${releases.winpe.file})` : 'release not available'],
        ['Erased', 'Every partition on the eMMC except the firmware partition (sectors 64 to 131071), which is kept. The board tells what is there before anything is written, and you confirm again.'],
        ['Written', `WinPE and the image to the end of the eMMC, about ${windows ? formatBytes(windows.imageSize + 560e6) : ''}${onBoard ? '' : ' over USB (about 10 to 20 minutes over Maskrom)'}.`],
        ['Checked', onBoard ? 'Everything written is read back from the eMMC and compared.' : 'The partition table is read back; samples of the rest are read back where the loader allows. On the board, DISM checks every file of the image as it applies it.'],
        ['Then', 'The board starts WinPE from the eMMC and installs Windows by itself, 20 to 40 minutes, then restarts into Windows.'],
      ]);
      if (!edition) why = 'Choose the Windows image and an edition.';
      if (!releases?.winpe) why = 'The woa-rk3576 release could not be read.';
      if (onBoard && here?.emmcRefusal) why = here.emmcRefusal;
      goLabel = onBoard ? 'Erase and write' : 'Connect and write';
    } else if (task === 'stick') {
      reviewRows = reviewRows.concat([
        ['Written', releases?.winpe ? `woa-rk3576 ${releases.winpe.tag}, ${releases.winpe.file}, decompressed` : 'release not available'],
        ['Erased', stick ? `Everything on ${drives?.find((d) => d.device === stick)?.description ?? stick}` : 'Choose the USB drive below.'],
        ['Checked', 'The drive is read back and compared with the image.'],
      ]);
      if (!stick) why = 'Choose the USB drive.';
      goLabel = 'Erase and write';
    } else {
      const t = firmwareTargets(board).find((x) => x.id === task)!;
      reviewRows = reviewRows.concat([
        ['Firmware', fwRelease ? `edk2-rk3576 ${releases!.firmware!.tag}, ${fwRelease.file}` : 'release not available'],
        ['Written', t.slice ? `Bytes ${t.slice[0]} to ${t.slice[1]} of the image, to sector ${t.lba}` : `The whole image, from sector ${t.lba}`],
        ['Erased', t.erases],
        ['Checked', onBoard ? 'Read back from the storage and compared.' : 'Samples are read back; the first 32 MiB are read back reliably.'],
        ['Then', t.done],
      ]);
      if (!fwRelease) why = 'The edk2-rk3576 release could not be read.';
      if (onBoard && board.firmwareStorage === 'emmc' && here?.emmcRefusal) why = here.emmcRefusal;
      if (onBoard && board.firmwareStorage === 'spinor' && !here?.mtd.length) why = 'No SPI NOR flash device on this system.';
      goLabel = onBoard ? 'Erase and write' : 'Connect and write';
    }
  }

  const reviewStep = (
    <StepPage title="Review">
      <Review rows={reviewRows} />
      {task === 'stick' && (
        <FormGroup role="radiogroup" fieldId="stick" label="USB drive" isStack>
          {drives === null ? <Content component="p">Looking for drives</Content>
            : drives.length === 0 ? <Content component="p">No USB drive or SD card of at least 1 GB. Plug one in.</Content>
              : drives.map((d) => (
                <Radio key={d.device} id={`stick-${d.device}`} name="stick" isChecked={stick === d.device} onChange={() => setStick(d.device)}
                  label={`${d.description} (${formatBytes(d.size)})`} description={d.device} />
              ))}
          <Button variant="link" isInline onClick={refreshDrives}>Refresh</Button>
        </FormGroup>
      )}
      {maskromCard}
    </StepPage>
  );

  const windowsNeeded = task === 'windows';
  const confirmText = run?.confirm && (run.confirm.kind === 'stage' ? (
    <Stack hasGutter>
      <Content component="p">The board answered. Its eMMC is {GB(run.confirm.capacity)}.</Content>
      <Review rows={[
        ['Kept', 'The firmware partition (sectors 64 to 131071).'],
        ['Removed', run.confirm.removed.length ? run.confirm.removed.map((p) => `${p.name} (${GB(p.bytes)})`).join(', ') : 'Nothing: there are no other partitions.'],
        ['Windows gets', `${GB(run.confirm.windowsBytes)} at first, the whole rest of the eMMC once the staging space is freed.`],
        ['Sent over USB', formatBytes(run.confirm.totalBytes)],
      ]} />
    </Stack>
  ) : (
    <Stack hasGutter>
      <Review rows={[
        ['Write', `${run.confirm.target}: ${formatBytes(run.confirm.bytes)} from sector ${run.confirm.lba}`],
        ['Storage', run.confirm.capacity ? GB(run.confirm.capacity) : 'size not reported'],
        ['Erased', run.confirm.erases],
        ...(run.confirm.dropped.length ? [['Dropped from the partition table', run.confirm.dropped.map((p) => `${p.name} (${GB(p.bytes)})`).join(', ')] as [string, string]] : []),
      ]} />
    </Stack>
  ));

  return (
    <Shell onSettings={() => setSettings(true)}>
      {!run && offer && dismissed !== offer.version && (
        <PageSection aria-label="Update" className="update-notice">
          <Alert isInline variant="info" title={`WoA RK3576 Imager ${offer.version}${offer.beta ? ' (beta)' : ''} is available`}
            actionClose={<AlertActionCloseButton onClose={() => { setDismissed(offer.version); try { localStorage.setItem('updateDismissed', offer.version); } catch { /* none */ } }} />}
            actionLinks={<><AlertActionLink onClick={() => setUpdating(true)}>Update</AlertActionLink><AlertActionLink component="a" href={offer.url} target="_blank">Release notes</AlertActionLink></>}>
            {offer.notes}
          </Alert>
        </PageSection>
      )}
      {run ? (
        <PageSection isFilled aria-label={run.title}>
          <Stack hasGutter className="step">
            <Title headingLevel="h2">{run.result ? (run.result.ok ? 'Done' : 'Stopped') : run.title}</Title>
            <ProgressList stages={run.stages} />
            {run.confirm && (
              <Card>
                <CardTitle>Erase and write?</CardTitle>
                <CardBody>
                  <Stack hasGutter>
                    {confirmText}
                    <ActionList>
                      <ActionListGroup>
                        <ActionListItem><Button variant="danger" onClick={() => answer(true)}>Erase and write</Button></ActionListItem>
                        <ActionListItem><Button variant="secondary" onClick={() => answer(false)}>Stop</Button></ActionListItem>
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
                <CardTitle>What happens next</CardTitle>
                <CardBody>
                  <List component="ol" type={OrderType.number}>{run.result.next.map((n) => <ListItem key={n}>{n}</ListItem>)}</List>
                </CardBody>
              </Card>
            )}
            <StackItem>
              {!run.result ? <Button variant="secondary" onClick={cancel}>Cancel</Button>
                : <Button variant="primary" onClick={closeRun}>Done</Button>}
            </StackItem>
            {run.log.length > 0 && (
              <ExpandableSection toggleText="rkdeveloptool output" className="log">
                <CodeBlock><CodeBlockCode>{run.log.slice(-400).join('\n')}</CodeBlockCode></CodeBlock>
              </ExpandableSection>
            )}
          </Stack>
        </PageSection>
      ) : (
        <PageSection type="wizard" isFilled hasBodyWrapper={false} aria-label="Write a board">
          <Wizard navAriaLabel="Steps" isVisitRequired>
            <WizardStep name="Board" id="board" footer={{ isNextDisabled: !board, isCancelHidden: true }}>{boardStep}</WizardStep>
            <WizardStep name="What to write" id="task" isDisabled={!board} footer={{ isNextDisabled: !task, isCancelHidden: true }}>{taskStep}</WizardStep>
            <WizardStep name="Windows image" id="windows" isHidden={!windowsNeeded} footer={{ isNextDisabled: !edition, isCancelHidden: true }}>{windowsStep}</WizardStep>
            <WizardStep name="Review" id="review" isDisabled={!task || (windowsNeeded && !edition)}
              footer={<ReviewFooter label={goLabel} disabled={!!why} why={why} onGo={() => setAsk(true)} />}>
              {reviewStep}
            </WizardStep>
          </Wizard>
        </PageSection>
      )}
      <Modal isOpen={ask} onClose={() => setAsk(false)} variant="small" aria-labelledby="ask-title">
        <ModalHeader title={task === 'stick' ? 'Erase the USB drive?' : onBoard ? `Erase this board's ${task === 'windows' || board?.firmwareStorage === 'emmc' ? 'eMMC' : 'SPI NOR flash'}?` : 'Connect to the board'} labelId="ask-title" />
        <ModalBody>
          {task === 'stick' ? 'Everything on the drive is replaced by the WinPE image.'
            : onBoard ? `${here?.emmc && (task === 'windows' || board?.firmwareStorage === 'emmc') ? `${here.emmc.model}, ${here.emmc.device}, ${GB(here.emmc.bytes)}. ` : ''}${task === 'windows' ? 'Every partition except the firmware partition is removed. ' : ''}Your administrator password is asked for next.`
              : 'The board is connected and read first. Nothing is erased until you confirm what the board reports.'}
        </ModalBody>
        <ModalFooter>
          <Button variant={onBoard || task === 'stick' ? 'danger' : 'primary'} onClick={start}>{onBoard || task === 'stick' ? 'Erase and write' : 'Connect'}</Button>
          <Button variant="link" onClick={() => setAsk(false)}>Cancel</Button>
        </ModalFooter>
      </Modal>
      <SettingsModal open={settings} onClose={() => setSettings(false)} theme={theme} setTheme={setTheme}
        onOffer={(o) => setOffer(o)} onUpdate={() => { setSettings(false); setUpdating(true); }} writing={!!run && !run.result} />
      {updating && <UpdateModal offer={offer} onClose={() => setUpdating(false)} />}
    </Shell>
  );
}
