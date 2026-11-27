// The Maskrom Studio page: one wizard (board, what to write, the Windows
// image, how Windows comes out, review), then the write itself in place of
// the wizard. Every text goes through useI18n() (messages.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionList, ActionListGroup, ActionListItem, Alert, AlertActionCloseButton, AlertActionLink, Button, Card, CardBody,
  CardHeader, CardTitle, Checkbox, Gallery, Popover, CodeBlock, CodeBlockCode, Content, DescriptionList, DescriptionListDescription, DescriptionListGroup,
  DescriptionListTerm, ExpandableSection, Flex, FlexItem, Form, FormGroup, FormSection, FormHelperText, HelperText, HelperTextItem,
  List, ListItem, Modal, ModalBody, ModalFooter, ModalHeader, OrderType, PageSection, Progress, ProgressMeasureLocation,
  Radio, Slider, Stack, StackItem, Switch, TextArea, TextInput, Title, Wizard, WizardFooterWrapper, WizardStep, useWizardContext,
} from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { OutlinedQuestionCircleIcon } from '@patternfly/react-icons/dist/esm/icons/outlined-question-circle-icon';
import { formatBytes } from '../shared/format';
import type { ArmbianChoice, FactoryChoice, ReleaseTier, UpgradeImage, BoardHereInfo, DriverFolder, EditionInfo, ExtrasWanted, JobProgress, JobResult, Releases, Served, WindowsChoice } from '../shared/ipc';
import type { Target } from '../shared/targets';
import type { UpdateOffer } from '../shared/update';
import { firmwareTargets, hybridOnSd, WOA_BOARDS, woaBoard, type BoardId, type WindowsTarget, type WoaBoard } from '../woa/boards';
import type { WebflashTarget } from '../web/webflash/boards';
import type { WoaJob, WoaWorkerEvent, WoaWorkerRequest } from '../woa/woa-worker';
import type { RegionResult, RegionStage } from '../woa/maskrom-regions';
import { accountProblem, DEFAULT_SETUP, OPENSSH, sshKeyProblem, type Account, type SetupOptions } from '../woa/setup-files';
import { anyTrim, NO_TRIM, RECOMMENDED_TRIM, TRIM_KEYS, type TrimOptions } from '../woa/trim';
import { AboutModal, api, DriversNote, SettingsModal, Shell, StepPage, UpdateModal, type UiMode } from './common';
import { useI18n } from './i18n';
import { WINDOWS_SOURCES } from '../shared/windows-sources';
import { defaultLanguage, imageHasLanguage, keyboardChoices, languageChoices, timeZoneChoices, windowsZoneFor } from '../shared/windows-intl';
import { Picker } from './picker';
import { ARMBIAN_RESTORE, DESKTOPS, distroWords, simpleOffers, variantWords, type ArmbianOffer } from '../woa/armbian-restore';
import { ESP_MIB, freeBytesOf, GiB, MIN_WINDOWS_CHOSEN, MiB, MSR_MIB, planLayout, type LayoutChoice, type RestUse } from '../woa/windows-layout';
import { applyTheme, readTheme, type Theme } from './theme';
import { MaskromLive } from './maskrom-live';
import { MIN_ARMBIAN_BYTES, minArmbianBytes } from '../woa/armbian-hybrid';
import { BOARD_EXTRA_KINDS } from '../woa/driver-package';
import { FEATURE_KEYS, hasFeature, type FeatureKey } from '../woa/firmware-features';

type Task = 'windows' | 'uefi' | 'uefi-keep' | 'upgrade' | 'uefi-sd' | 'stick' | 'armbian' | 'factory';
type Via = 'maskrom' | 'here';
type Dest = 'emmc' | 'sd' | 'nvme';
type Method = 'stage' | 'host';
const WIN_HOST = api.platform === 'win32';

const GB = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
/** The smallest drive Windows is staged on (stage-layout.ts MIN_DISK_BYTES), and the smallest card listed for Armbian. */
const DISK_MIN = 30e9;
const SD_MIN = 4e9;
const LOADER = 'rk3576_spl_loader.bin';

interface Stage { id: string; label: string; percent: number | null; note?: string }
interface Run {
  title: string;
  stages: Stage[];
  log: string[];
  confirm: StageSummary | FirmwareSummary | WholeSummary | FactorySummary | UpgradeSummary | null;
  result: { ok: boolean; title: string; text?: string; detail?: string; next?: string[]; help?: 'noBoard' | 'gone'; reason?: string } | null;
  /** Where the partition table and UEFI settings were kept before the write (pre-write-backup.ts). */
  backup?: string;
}
interface StageSummary { kind: 'stage'; capacity: number; windowsBytes: number; totalBytes: number; removed: Array<{ name: string; bytes: number }>;
  layout?: { windowsBytes: number; data: { fs: string; label: string; bytes: number } | null; unallocatedBytes: number }; chosen?: boolean;
  armbian?: { bytes: number; label: string } | null }
interface WholeSummary { kind: 'whole'; label: string; capacity: number | null; bytes: number; clearsBackupGpt: boolean }
interface FactorySummary { kind: 'factory'; capacity: number | null; chip: string; model: string; version: string; partitions: Array<{ name: string; lba: number; bytes: number }>; skipped: string[]; bytes: number }
interface UpgradeSummary { kind: 'upgrade'; manufacturer: string | null; capacity: number | null; installed: string | null; next: string | null; settings: 'kept' | 'reset' | 'none'; backup: string | null; nvdataLba: number; nvdataSectors: number; lba: number; bytes: number }
interface FirmwareSummary { kind: 'firmware'; board: string; target: string; lba: number; bytes: number; capacity: number | null; dropped: Array<{ name: string; bytes: number }>; erases: string;
  spi?: { next: string | null; installed: string | null; settings: 'kept' | 'none' | 'reset' } }

// The time zone starts as the PC's; the language is preselected once the image is known (defaultLanguage).
const EMPTY_ACCOUNT: Account = { user: '', password: '', computerName: '', locale: '', keyboard: '', timeZone: windowsZoneFor(api.timeZone) ?? '', autoLogonAlways: false };
const TIME_ZONES = timeZoneChoices();

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
  // A local account and no OOBE by default (decided 2026-11-25); Simple mode has no account fields, so there it is OOBE.
  const [skip, setSkip] = useState(true);
  const [account, setAccount] = useState<Account>(EMPTY_ACCOUNT);
  // Once the language is picked by hand, a new image no longer changes it.
  const localePicked = useRef(false);
  const [password2, setPassword2] = useState('');
  const [ssh, setSsh] = useState(DEFAULT_SETUP.ssh);
  const [sshKey, setSshKey] = useState('');
  const [drivers, setDrivers] = useState<DriverFolder | null>(null);
  // Trimming Windows (trim.ts): Simple mode's one switch, Advanced mode's list; both start at the recommended set.
  const [trimSimple, setTrimSimple] = useState(true);
  const [trimPick, setTrimPick] = useState<TrimOptions>(RECOMMENDED_TRIM);
  const [rkToolsOn, setRkToolsOn] = useState(true);
  // Charsiu Desktop, on by default (decided 2026-11-25; charsiu-desktop.ts): the app only, no model.
  const [charsiuOn, setCharsiuOn] = useState(DEFAULT_SETUP.charsiuDesktop === true);
  const [driversError, setDriversError] = useState<string | null>(null);
  const [drives, setDrives] = useState<Target[] | null>(null);
  const [stick, setStick] = useState<string | null>(null);
  const [dest, setDest] = useState<Dest>('emmc');
  const [method, setMethod] = useState<Method>('stage');
  const [disk, setDisk] = useState<string | null>(null);
  const [layoutMode, setLayoutMode] = useState<'whole' | 'custom'>('whole');
  const [winGb, setWinGb] = useState('');
  const [rest, setRest] = useState<RestUse>('unallocated');
  const [dataLabel, setDataLabel] = useState('Data');
  const [linuxGb, setLinuxGb] = useState('0');
  const [understood, setUnderstood] = useState(false);
  const [armbianOffers, setArmbianOffers] = useState<ArmbianOffer[] | { error: string } | 'looking' | null>(null);
  const [armbianId, setArmbianId] = useState<string | null>(null);
  const [restoreTo, setRestoreTo] = useState<'emmc' | 'drive'>('emmc');
  const [armbian, setArmbian] = useState<ArmbianChoice | { error: string } | 'looking' | null>(null);
  // Armbian next to Windows (boards.ts hybrid): off until asked for, no image preselected.
  const [withArmbian, setWithArmbian] = useState(false);
  // ROCK 4D: the SD card Armbian goes onto, beside the NVMe drive Windows goes onto.
  const [sdDrive, setSdDrive] = useState<string | null>(null);
  const [hybridId, setHybridId] = useState<string | null>(null);
  const [hybridFound, setHybridFound] = useState<ArmbianChoice | { error: string } | 'looking' | null>(null);
  const [armbianGb, setArmbianGb] = useState('24');
  const [factory, setFactory] = useState<FactoryChoice | null>(null);
  const [factoryError, setFactoryError] = useState<string | null>(null);
  const [upgrade, setUpgrade] = useState<UpgradeImage | 'loading' | null>(null);
  const [upgradeError, setUpgradeError] = useState<string | null>(null);
  const [keepSettings, setKeepSettings] = useState(true);
  const [run, setRun] = useState<Run | null>(null);
  const [settings, setSettings] = useState(false);
  const [about, setAbout] = useState(false);
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [updating, setUpdating] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(() => { try { return localStorage.getItem('updateDismissed'); } catch { return null; } });
  const worker = useRef<Worker | null>(null);
  const servedTokens = useRef<string[]>([]);

  // Simple or Advanced (Settings, masthead); null until the settings are read.
  const [mode, setModeState] = useState<UiMode | null>(null);
  const [modeAsk, setModeAsk] = useState<string[] | null>(null);
  useEffect(() => {
    api.getSettings().then(async (st) => {
      // Simple mode always uses the Stable firmware and WinPE.
      if (st.uiMode === 'simple' && st.firmwareChannel !== 'stable') await api.setSettings({ firmwareChannel: 'stable' });
      setModeState(st.uiMode);
      api.releases(st.uiMode === 'simple' && st.firmwareChannel !== 'stable').then(setReleases);
    });
  }, []);
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
  const restoreTask = task === 'armbian' || task === 'factory';
  // What Armbian publishes for the board (its image index), then the chosen image's .sha, .asc and sizes.
  useEffect(() => {
    if ((task !== 'armbian' && !(task === 'windows' && withArmbian)) || !boardId || !ARMBIAN_RESTORE[boardId]) return;
    let live = true;
    setArmbianOffers('looking');
    setArmbian(null);
    api.listArmbian(boardId).then((r) => {
      if (!live) return;
      if ('error' in r) { setArmbianOffers(r); return; }
      setArmbianOffers(r.offers);
      setArmbianId((id) => (id && r.offers.some((o) => o.id === id) ? id : simpleOffers(r.offers).recommended));
    });
    return () => { live = false; };
  }, [task, boardId, withArmbian]);
  useEffect(() => {
    if (task !== 'armbian' || !boardId || !armbianId || !Array.isArray(armbianOffers)) return;
    let live = true;
    setArmbian('looking');
    api.findArmbian(boardId, armbianId).then((r) => { if (live) setArmbian(r); });
    return () => { live = false; };
  }, [task, boardId, armbianId, armbianOffers]);
  const offerList = Array.isArray(armbianOffers) ? armbianOffers : [];
  const simpleArmbian = simpleOffers(offerList);
  const simpleArmbianIds = [...simpleArmbian.desktops.map((o) => o.id), ...(simpleArmbian.cli ? [simpleArmbian.cli.id] : [])];
  const onBoard = via === 'here' && !!here?.boardId && here.boardId === boardId;
  const edition = windows?.editions.find((e) => e.index === index) ?? null;
  const fwRelease = releases?.firmware && boardId ? releases.firmware.boards[boardId] : undefined;
  // What the chosen release's image for the board supports (firmware-features.ts): true, false, or null when
  // neither the release (FEATURES.json) nor the built-in table knows.
  const fwHas = (k: FeatureKey): boolean | null => (board ? hasFeature(releases?.firmware?.features, board.id, k) : null);
  const fwNoWindows = fwHas('windows') === false;
  const fwTag = releases?.firmware?.tier.label ?? '';
  // "Windows, HDMI output, ...; off until turned on in the firmware setup: ...; not in it: ...", or null.
  const fwFeatureText = (): string | null => {
    const fs = board ? releases?.firmware?.features.boards[board.id]?.features : undefined;
    if (!fs) return null;
    const sep = t('fwFeatures.sep');
    const on: string[] = []; const off: string[] = []; const no: string[] = [];
    for (const k of FEATURE_KEYS) {
      const v = fs[k];
      if (!v) continue;
      (v.built ? (v.default === 'off' ? off : on) : no).push(t(`feature.${k}`));
    }
    const parts = [on.length ? on.join(sep) : t('fwFeatures.nothing')];
    if (off.length) parts.push(t('fwFeatures.off', { list: off.join(sep) }));
    if (no.length) parts.push(t('fwFeatures.no', { list: no.join(sep) }));
    return parts.join(t('fwFeatures.partSep')) + (releases?.firmware?.features.from === 'builtin' ? t('fwFeatures.builtin') : '');
  };
  const fwFeatureRow = (): Array<[string, string]> => { const x = fwFeatureText(); return x ? [[t('review.fwFeatures'), x]] : []; };

  // Text from edk2-webflash's board list: its English, or this page's Chinese for the same thing.
  const fwText = (b: WoaBoard, tg: WebflashTarget, field: 'label' | 'note' | 'erases' | 'done'): string => {
    if (field === 'label') { const k = `fw.${b.id}.${tg.id}.label`; const own = t(k); return own && own !== k ? own : t(`fw.${tg.id}.label`); }
    const original = (tg[field] as string | undefined) ?? '';
    return lang === 'en' ? original : (t(`fw.${b.id}.${tg.id}.${field}`) || original);
  };
  const maskromSteps = (b: WoaBoard): string[] => b.webflash.maskrom.map((s, i) => (lang === 'en' ? s : t(`maskrom.${b.id}.${i + 1}`) || s));
  // Chinese text with a space between Han characters and Latin letters or digits, as the page writes it.
  const spaced = (z: string): string => (lang === 'en' ? z
    : z.replace(/([\u4e00-\u9fff])([A-Za-z0-9])/g, '$1 $2').replace(/([A-Za-z0-9])([\u4e00-\u9fff])/g, '$1 $2'));
  // "the eMMC, an SD card or an NVMe drive", from the board's list (boards.ts).
  const whereText = (targets: WindowsTarget[]): string => {
    const w = targets.map((x) => t(`where.${x}`));
    if (lang === 'en') return w.length < 2 ? w.join('') : `${w.slice(0, -1).join(', ')} or ${w[w.length - 1]}`;
    return spaced(w.length < 2 ? w.join('') : `${w.slice(0, -1).join('、')}或${w[w.length - 1]}`);
  };
  const boardDesc = (b: WoaBoard): string => t(b.windowsBooted ? 'board.desc' : 'board.desc.untried', {
    firmware: t(`board.fw.${b.firmwareStorage}`), where: whereText(b.windowsTargets), maskrom: t(`board.maskrom.${b.maskromEntry}`),
  });
  const checkText = (e: EditionInfo): string | null => (e.check.level === 'ok' ? null : t(`win.check.${e.check.code}`, e.check.vars));
  // The tier a release came from (Settings): nothing for Stable, a word for the others.
  const tierWord = (tr: ReleaseTier) => (tr.used === 'stable' ? '' : ` (${t(`tier.${tr.used}`)})`);
  const tierNotice = (() => {
    const list = [releases?.firmware && { repo: 'edk2-rk3576', tier: releases.firmware.tier }, releases?.winpe && { repo: 'woa-rk3576', tier: releases.winpe.tier }]
      .filter((x): x is { repo: string; tier: ReleaseTier } => !!x && (x.tier.used !== 'stable' || x.tier.asked !== 'stable'));
    if (list.length === 0) return null;
    const ci = list.some((x) => x.tier.used === 'ci');
    return (
      <Alert isInline variant={ci ? 'custom' : 'warning'} title={t(ci ? 'tier.ci.title' : 'tier.prerelease.title')}>
        <List>{list.map((x) => (
          <ListItem key={x.repo}>{t(x.tier.asked !== x.tier.used ? 'tier.fallback' : `tier.${x.tier.used}.item`, { repo: x.repo, label: x.tier.label, commit: x.tier.commit ?? '' })}</ListItem>
        ))}</List>
      </Alert>
    );
  })();
  // A failed download says what to do, with the system's own words kept for a search.
  const NETWORK = /^net::ERR_[A-Z_]+|fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|socket hang up/i;
  const errorText = (e: string) => (/^[a-z]+\.[a-z.]+$/.test(e) ? t(e)
    : NETWORK.test(e) ? t('error.network', { code: NETWORK.exec(e)![0] }) : msg(e));

  // The disk after the install (windows-layout.ts). Sizes are typed in GB (GiB); the preview uses the
  // board's usual eMMC size, or the chosen drive's; the plan on the real size is checked again when writing.
  const staged = method === 'stage';
  const gbToBytes = (v: string) => (/^\d+(\.\d+)?$/.test(v.trim()) ? Math.round(Number(v) * 1024) * MiB : NaN);
  // Armbian next to Windows, started by the firmware's "Armbian (U-Boot)" (boards.ts hybrid): on the TaishanPi 3M
  // both on the eMMC, staged over MaskROM; on the ROCK 4D Windows on the NVMe drive and Armbian on an SD card;
  // on the CM5-IO Windows on the eMMC (staged over MaskROM) or the NVMe drive, and Armbian on an SD card.
  const hybridKind = board?.hybrid ?? null;
  const sdKind = hybridOnSd(hybridKind);
  // Offered only when the chosen firmware release can start it (FEATURES.json armbianOnce); with Armbian on an
  // SD card the SPL on the board is still read over MaskROM before anything is written (armbian-once.ts).
  const hybridFirmware = fwHas('armbianOnce') !== false;
  // Experimental (never run end to end on a board): Advanced mode only.
  const hybridPossible = mode === 'advanced' && !!board && !!hybridKind && !!ARMBIAN_RESTORE[board.id] && task === 'windows' && !onBoard && hybridFirmware
    && (hybridKind === 'one-emmc' ? staged && dest === 'emmc'
      : hybridKind === 'windows-and-sd' ? (staged && dest === 'emmc') || dest === 'nvme' : dest === 'nvme');
  const hybridNoFirmware = mode === 'advanced' && !!board && !!hybridKind && !!ARMBIAN_RESTORE[board.id] && task === 'windows' && !onBoard && !hybridFirmware;
  const hybridOn = hybridPossible && withArmbian;
  const hybridEmmc = hybridOn && hybridKind === 'one-emmc';
  const hybridSd = hybridOn && sdKind;
  // CM5-IO: Windows staged on the eMMC over MaskROM, Armbian on the SD card, in one job.
  const hybridSdEmmc = hybridSd && dest === 'emmc';
  const layoutChoice: LayoutChoice | undefined = !staged || layoutMode === 'whole' || hybridEmmc ? undefined : {
    windowsBytes: gbToBytes(winGb), rest, dataLabel, linuxReserveBytes: linuxGb.trim() === '' ? 0 : gbToBytes(linuxGb),
  };
  const layoutDisk = dest === 'emmc' ? (board?.emmc?.bytes ?? null) : (drives?.find((x) => x.device === disk)?.size ?? null);
  const layoutFree = layoutDisk ? freeBytesOf(layoutDisk, dest === 'emmc') : null;
  const layoutMaxWin = layoutFree ? Math.floor((layoutFree - (ESP_MIB + MSR_MIB + 2) * MiB) / MiB) * MiB : null;
  const customPossible = layoutMaxWin === null || layoutMaxWin >= MIN_WINDOWS_CHOSEN;
  const layoutPlan = layoutChoice && layoutFree ? planLayout(layoutFree, layoutChoice)
    : layoutChoice && (Number.isNaN(layoutChoice.windowsBytes) || Number.isNaN(layoutChoice.linuxReserveBytes)) ? { problem: 'layout.number' } : null;
  const layoutErr = layoutChoice && (Number.isNaN(layoutChoice.windowsBytes!) || Number.isNaN(layoutChoice.linuxReserveBytes)) ? t('layout.number')
    : layoutPlan && 'problem' in layoutPlan ? (layoutPlan.problem === 'layout.number' ? t('layout.number') : msg(layoutPlan.problem)) : null;
  const trim = mode === 'simple' ? (trimSimple ? RECOMMENDED_TRIM : NO_TRIM) : trimPick;
  const toolsThere = !!releases?.winpe?.tools;
  // The release's RK3576 driver package: installed for the board without asking (driver-package.ts).
  const packageThere = !!releases?.winpe?.drivers;
  const kindWords = board ? BOARD_EXTRA_KINDS[board.id].map((k) => t(k)) : [];
  const boardKinds = kindWords.length > 1 ? `${kindWords.slice(0, -1).join(t('drivers.sep'))}${t('drivers.and')}${kindWords[kindWords.length - 1]}` : kindWords.join('');
  const rkTools = rkToolsOn && toolsThere;
  const charsiuThere = !!releases?.charsiu;
  const charsiuDesktop = charsiuOn && charsiuThere;
  const skipOn = skip && mode !== 'simple';
  const setup: SetupOptions = { skipSetup: skipOn ? account : null, ssh, sshKey: ssh ? sshKey : '', ...(layoutChoice ? { layout: layoutChoice } : {}),
    ...(anyTrim(trim) ? { trim } : {}), ...(rkTools ? { rkTools: true } : {}), ...(charsiuDesktop ? { charsiuDesktop: true } : {}), ...(hybridSd ? { armbianOnSd: true } : {}) };
  const accountErr = skipOn ? accountProblem(account) : null;
  const passwordMismatch = skipOn && account.password !== password2;
  const keyErr = ssh ? sshKeyProblem(sshKey) : null;
  const hybridChoice = hybridFound && typeof hybridFound === 'object' && 'file' in hybridFound && hybridFound.id === hybridId ? hybridFound : null;
  const armbianBytes = gbToBytes(armbianGb);
  const armbianMin = hybridChoice ? minArmbianBytes(hybridChoice.imageBytes ?? 0, hybridChoice.desktop) : MIN_ARMBIAN_BYTES;
  const armbianMax = layoutFree ? Math.floor((layoutFree - (ESP_MIB + MSR_MIB + 2) * MiB - MIN_WINDOWS_CHOSEN) / GiB) * GiB : null;
  const hybridErr = !hybridEmmc ? null : Number.isNaN(armbianBytes) ? t('layout.number')
    : armbianBytes < armbianMin ? t('hybrid.size.small', { min: `${(armbianMin / GiB).toFixed(0)} GB` })
      : armbianMax !== null && armbianBytes > armbianMax ? t('hybrid.size.large', { max: `${(armbianMax / GiB).toFixed(0)} GB` }) : null;
  const hybridReady = !hybridOn || (!!hybridChoice && !hybridErr);
  const setupOk = !accountErr && !passwordMismatch && !keyErr && !layoutErr && hybridReady;
  useEffect(() => {
    if (!hybridOn || !boardId || !hybridId) { setHybridFound(null); return; }
    let live = true;
    setHybridFound('looking');
    api.findArmbian(boardId, hybridId).then((r) => { if (live) setHybridFound(r); });
    return () => { live = false; };
  }, [hybridOn, boardId, hybridId]);

  const refreshDisks = () => refreshDrives(hybridOnSd(board?.hybrid ?? null) && withArmbian ? SD_MIN : DISK_MIN);
  const refreshDrives = (min = 600e6) => { setDrives(null); api.listDrives(min).then((dl) => setDrives(dl.targets.filter((x) => !x.disabled))); };
  const onPc = task === 'windows' && dest !== 'emmc';
  const diskChoices = (drives ?? []).filter((x) => x.size >= DISK_MIN);
  // Written to an SD card or USB drive of this computer, not to the board: Armbian on a card, the SD card firmware.
  const driveTask = (task === 'armbian' && restoreTo === 'drive') || task === 'uefi-sd';
  const sdRelease = releases?.firmware && boardId ? releases.firmware.sdcard?.[boardId] : undefined;

  const chooseWindows = async (pick: () => Promise<WindowsChoice | { error: string } | null>) => {
    setWindowsError(null);
    const r = await pick();
    if (!r) return;
    if ('error' in r) { setWindowsError(errorText(r.error)); setWindows(null); setIndex(null); return; }
    setWindows(r);
    if (!localePicked.current) {
      const locale = defaultLanguage(api.systemLocale, [...new Set(r.editions.flatMap((e) => e.languages))]);
      setAccount((a) => ({ ...a, locale }));
    }
    // 22H2 and 23H2 first; an untested or preview edition only when there is nothing else.
    const clean = r.editions.filter((e) => !e.refuse && !e.warn);
    const ok = clean.length ? clean : r.editions.filter((e) => !e.refuse);
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
  const addLog = (line: string) => update((r) => ({ ...r, log: [...r.log.slice(-5000), line] }));
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
        const head = c.headBytes ? `${t('result.samples.head', { size: formatBytes(c.headBytes) })} ` : '';
        text = head + (c.samples === 0 ? '' : c.matched === c.samples
          ? t('result.samples.all', { n: c.samples })
          : t('result.samples.some', { m: c.matched, n: c.samples, k: c.filler + c.unsure, filler: c.filler ? t('result.samples.filler', { n: c.filler }) : '' }));
      }
      return { ok: true, title: okTitle, ...(text ? { text } : {}), ...(next ? { next } : {}) };
    }
    return { ok: false, title: errorText(r.reason), reason: r.reason, ...('detail' in r && r.detail ? { detail: r.detail } : {}),
      ...(/^No board in MaskROM mode was found/.test(r.reason) ? { help: 'noBoard' as const }
        : /^The board was disconnected/.test(r.reason) || /LIBUSB_ERROR_NO_DEVICE/.test('detail' in r && r.detail ? r.detail : '') ? { help: 'gone' as const } : {}) };
  };

  const STAGE_NEXT = ['next.stage.1', 'next.stage.2', 'next.stage.3', 'next.stage.4'].map((k) => t(k));

  const startMaskrom = async (jobFor: (served: Record<string, Served>, extras: Array<{ path: string; data: Uint8Array }>) => WoaJob,
    prep: Array<{ id: string; get: () => Promise<Served | { error: string }> }>, extras: ExtrasWanted | null, onWritten?: () => Promise<void>) => {
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
    if (extras && (extras.ssh || extras.drivers || extras.chrome || extras.rkTools || extras.charsiu || extras.boardId)) {
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
    if (job.kind === 'firmware' || job.kind === 'whole' || job.kind === 'factory' || job.kind === 'upgrade') job.resetAfter = settingsNow.resetAfterMaskrom;
    const w = new Worker(api.testWorker ?? 'woa-worker.js', { type: 'module' });
    worker.current = w;
    const at = (p: string) => new URL(p, document.baseURI).href;
    w.onmessage = (e: MessageEvent<WoaWorkerEvent>) => {
      const m = e.data;
      if (m.type === 'log') addLog(m.line);
      else if (m.type === 'stage') {
        if (m.stage === 'write' || m.stage === 'check' || m.stage === 'reset') setStage('board', { percent: 100, note: t('run.connected') });
        if (m.stage === 'check') setStage('write', { percent: 100, note: t('run.written') });
        const target = m.stage === 'write' ? 'write' : m.stage === 'check' || m.stage === 'reset' ? 'check' : 'board';
        setStage(target, { note: t(m.stage === 'probe' && board && !board.emmc ? 'stage.probe.spinor' : `stage.${m.stage as RegionStage}`) });
      } else if (m.type === 'progress') {
        setStage('write', { percent: Math.min(100, Math.floor((m.done * 100) / Math.max(1, m.total))), note: t('run.of', { done: formatBytes(m.done), total: formatBytes(m.total) }) });
      } else if (m.type === 'backup') {
        api.saveNvdata(m.boardId as BoardId, m.data).then((r) => {
          if ('path' in r) addLog(t('upgrade.backupSaved', { path: r.path }));
          w.postMessage({ type: 'woa-backup-saved', path: 'path' in r ? r.path : null, ...('error' in r ? { error: r.error } : {}) } satisfies WoaWorkerRequest);
        });
      } else if (m.type === 'pre-backup') {
        api.saveBeforeWrite(m.boardId as BoardId, m.files, m.notes).then((r) => {
          if ('path' in r) { const path = r.path; update((x) => ({ ...x, backup: path })); addLog(t(board?.spi ? 'backup.where.spinor' : 'backup.where', { path })); }
          w.postMessage({ type: 'woa-backup-saved', path: 'path' in r ? r.path : null, ...('error' in r ? { error: r.error } : {}) } satisfies WoaWorkerRequest);
        });
      } else if (m.type === 'planned') {
        update((r) => ({ ...r, confirm: m.summary as Run['confirm'] }));
      } else if (m.type === 'result') {
        w.terminate();
        worker.current = null;
        if (m.result.ok && onWritten) {
          // The run goes on (the Armbian card): the MaskROM part is done.
          update((r) => ({ ...r, stages: r.stages.map((s) => (['board', 'write', 'check'].includes(s.id) ? { ...s, percent: 100 } : s)) }));
          onWritten().catch((e: unknown) => finish({ ok: false, title: errorText(String((e as Error)?.message ?? e)) }));
          return;
        }
        const done = resultOf(m.result, job.kind === 'stage' ? t('result.staged') : job.kind === 'vhd' ? t('result.hostEmmc')
          : job.kind === 'upgrade' ? t('result.upgrade')
          : job.kind === 'whole' ? t('result.restore.armbian') : job.kind === 'factory' ? t('result.restore.factory') : t('result.firmware'),
          job.kind === 'stage' ? STAGE_NEXT : job.kind === 'vhd' ? [t('next.hostEmmc')] : undefined);
        finish(done);
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

  // The staged install over MaskROM: its stages, then the job (WinPE, the image, extras, Armbian on the eMMC).
  const windowsStages = (): Stage[] => [
    { id: 'winpe', label: t('run.winpe', { tag: releases?.winpe?.tier.label ?? '' }), percent: null },
    { id: 'image', label: t('run.image', { file: windows!.fileName }), percent: null },
    ...(ssh || drivers || trim.chrome || rkTools || charsiuDesktop || packageThere ? [{ id: 'extras', label: t('run.extras'), percent: null }] : []),
    ...(hybridEmmc ? [{ id: 'armbian', label: t('run.restore.armbian'), percent: null }] : []),
    { id: 'board', label: t('run.board'), percent: null },
    { id: 'write', label: t('run.write'), percent: 0 },
    { id: 'check', label: t('run.check'), percent: null },
  ];
  /** Stage Windows on the eMMC over MaskROM; `onWritten` runs after a good write instead of ending the run. */
  const stageWindows = async (b: WoaBoard, onWritten?: () => Promise<void>) => {
    const ed = edition!;
    const hash = await withProgress('image', () => api.hashWindows(windows!.token));
    if ('error' in hash) { finish({ ok: false, title: errorText(hash.error) }); return; }
    await startMaskrom((s, extras) => ({
      kind: 'stage', boardId: b.id, appVersion: api.version, spotCheck: true, resetAfter: true, setup, extras,
      winpe: { url: s.winpe.url, size: s.winpe.size },
      image: { url: s.image.url, size: s.image.size, extents: windows!.extents, name: windows!.imageName, imageSize: windows!.imageSize,
        sha256: hash.sha256, index: ed.index, edition: ed.name, build: ed.build ?? 0 },
      ...(hybridEmmc && s.armbian ? { armbian: { url: s.armbian.url, size: s.armbian.size, partitionBytes: armbianBytes, label: hybridChoice?.file ?? s.armbian.name } } : {}),
    }), [
      { id: 'winpe', get: () => api.prepareWinpe() },
      { id: 'image', get: () => api.serveWindows(windows!.token) },
      ...(hybridEmmc ? [{ id: 'armbian', get: () => api.prepareArmbian(b.id, hybridId!) }] : []),
    ], { ssh, drivers: drivers?.token ?? null, chrome: trim.chrome, rkTools, charsiu: charsiuDesktop, ...(packageThere ? { boardId: b.id } : {}) }, onWritten);
  };

  // Every failure ends on the run page with Try again, never in a run that waits for nothing.
  const start = () => startJob().catch((e: unknown) => {
    const reason = String((e as Error)?.message ?? e);
    setRun((r) => ({ ...(r ?? { title: t('run.stopped'), stages: [], log: [], confirm: null }), confirm: null,
      result: { ok: false, title: errorText(reason), reason } }));
  });
  const startJob = async () => {
    if (!board || !task) return;
    if (driveTask) {
      const isArmbian = task === 'armbian';
      setRun({ title: isArmbian ? t('run.drive.armbian') : t('run.drive.uefi'), log: [], confirm: null, result: null,
        stages: [{ id: 'write', label: isArmbian ? t('run.drive.armbian.stage') : t('run.drive.uefi.stage'), percent: 0 }] });
      const r = await withProgress('write', () => api.writeDrive(isArmbian
        ? { kind: 'armbian', board: board.id, id: armbianId!, device: stick! } : { kind: 'uefi-sd', board: board.id, device: stick! }));
      finish(resultOf(r, isArmbian ? t('result.drive.armbian') : t('result.drive.uefi'), [t(`next.drive.${board.sdBoot}`, { board: board.name })]));
      return;
    }
    if (task === 'stick') {
      setRun({ title: t('run.stick'), log: [], confirm: null, result: null, stages: [{ id: 'write', label: t('run.stick.stage'), percent: 0 }] });
      const r = await withProgress('write', () => api.writeWinpeStick(stick!));
      finish(resultOf(r, t('result.stick'), [t('next.stick.1'), t('next.stick.2')]));
      return;
    }
    if (task === 'windows' && hybridSd) { await startHybridSd(board); return; }
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
    if (task === 'upgrade') {
      const up = upgrade as UpgradeImage;
      setRun({ title: t('run.upgrade'), log: [], confirm: null, result: null, stages: [
        { id: 'fw', label: t('run.upgrade.image', { origin: up.origin }), percent: 100, note: `${up.served.name}, ${formatBytes(up.served.size)}` },
        { id: 'board', label: t('run.upgrade.board'), percent: null },
        { id: 'write', label: t('run.writeTo', { storage: t('storage.emmc') }), percent: 0 },
        { id: 'check', label: t('run.check.full'), percent: null },
      ] });
      await startMaskrom(() => ({ kind: 'upgrade', boardId: board.id, image: { url: up.served.url, size: up.served.size }, keepSettings, resetAfter: true }), [], null);
      return;
    }
    if (restoreTask) {
      const isArmbian = task === 'armbian';
      const what = isArmbian && armbian && typeof armbian === 'object' && 'file' in armbian ? armbian.file : factory?.fileName ?? '';
      setRun({ title: t('run.restore', { what }), log: [], confirm: null, result: null, stages: [
        { id: 'img', label: isArmbian ? t('run.restore.armbian') : t('run.restore.factory'), percent: null },
        { id: 'board', label: t('run.board'), percent: null },
        { id: 'write', label: t('run.writeTo', { storage: t('storage.emmc') }), percent: 0 },
        { id: 'check', label: t('run.check'), percent: null },
      ] });
      await startMaskrom((sv) => (isArmbian
        ? { kind: 'whole', boardId: board.id, image: { url: sv.img.url, size: sv.img.size }, label: 'The Armbian image', resetAfter: true }
        : { kind: 'factory', boardId: board.id, image: { url: sv.img.url, size: sv.img.size }, resetAfter: true }),
      [{ id: 'img', get: () => (isArmbian ? api.prepareArmbian(board.id, armbianId!) : api.prepareFactory(factory!.token)) }], null);
      return;
    }
    if (onBoard) {
      setRun({ title: task === 'windows' ? t('run.stagingHere') : t('run.firmware'), log: [], confirm: null, result: null,
        stages: [{ id: 'write', label: task === 'windows' ? t('run.here.windows') : t('run.here.firmware', { storage: storageWord(board, task) }), percent: 0 }] });
      const device = board.firmwareStorage === 'spinor' && task !== 'windows' ? here!.mtd[0]?.device : here!.emmc?.device;
      const r = await withProgress('write', () => api.writeBoard(
        task === 'windows' ? { kind: 'stage', boardId: board.id, device: device!, windowsToken: windows!.token, index: index!, setup, drivers: drivers?.token ?? null }
          : board.firmwareStorage === 'spinor' ? { kind: 'spinor', boardId: board.id, device: device!, targetId: task }
            : { kind: 'firmware', boardId: board.id, device: device!, targetId: task },
      ));
      finish(resultOf(r, task === 'windows' ? t('result.stagedHere') : t('result.firmwareHere'),
        task === 'windows' ? [t('next.here.1'), ...STAGE_NEXT.slice(1)] : [t('next.fw.restart')]));
      return;
    }
    if (task === 'windows') {
      setRun({ title: t('run.staging'), log: [], confirm: null, result: null, stages: windowsStages() });
      await stageWindows(board);
      return;
    }
    setRun({ title: t('run.firmware'), log: [], confirm: null, result: null, stages: [
      { id: 'fw', label: t('run.fw', { tag: releases?.firmware?.tier.label ?? '' }), percent: null },
      { id: 'board', label: t('run.board'), percent: null },
      { id: 'write', label: t('run.writeTo', { storage: storageWord(board, task) }), percent: 0 },
      { id: 'check', label: t('run.check'), percent: null },
    ] });
    await startMaskrom((s) => ({ kind: 'firmware', boardId: board.id, targetId: task, image: { url: s.fw.url, size: s.fw.size }, spotCheck: true, resetAfter: true }),
      [{ id: 'fw', get: () => api.prepareFirmware(board.id) }], null);
  };

  /**
   * Read-only over MaskROM: does the board's SPL start Armbian once from the SD card (armbian-once.ts)?
   * The run's stage `stageId` shows it; the promise ends with the worker's result. With `resetAfter` false
   * the loader keeps running, so the staged install that follows needs no new MaskROM entry.
   */
  const checkArmbianOnce = async (b: WoaBoard, stageId = 'board', resetAfter = true): Promise<RegionResult> => {
    const loader = await api.getLoader(LOADER);
    if ('error' in loader) return { ok: false, written: 0, reason: t('result.loader'), detail: loader.error };
    const w = new Worker(api.testWorker ?? 'woa-worker.js', { type: 'module' });
    worker.current = w;
    const at = (p: string) => new URL(p, document.baseURI).href;
    return new Promise<RegionResult>((resolve) => {
      const done = (r: RegionResult) => { w.terminate(); worker.current = null; resolve(r); };
      w.onmessage = (e: MessageEvent<WoaWorkerEvent>) => {
        const m = e.data;
        if (m.type === 'log') addLog(m.line);
        else if (m.type === 'stage' && m.stage !== 'write' && m.stage !== 'confirm') setStage(stageId, { note: t(m.stage === 'probe' && b.spi ? 'stage.probe.spinor' : `stage.${m.stage as RegionStage}`) });
        else if (m.type === 'result') done(m.result);
      };
      w.onerror = (e) => done({ ok: false, written: 0, reason: t('result.workerStopped'), detail: e.message });
      w.postMessage({ type: 'woa-start', job: { kind: 'armbian-once-check', boardId: b.id, resetAfter },
        moduleUrl: at('wasm/rkdeveloptool.js'), wasmUrl: at('wasm/rkdeveloptool.wasm'), loaderUrl: loader.url } satisfies WoaWorkerRequest);
    });
  };

  /** Armbian's own image onto the SD card (downloaded and checked as for "Armbian onto an SD card"). */
  const writeArmbianSd = (b: WoaBoard) => withProgress('sd', () => api.writeDrive({ kind: 'armbian', board: b.id, id: hybridId!, device: sdDrive! }));
  const keepNext = (b: WoaBoard) => t(b.spi ? 'next.hybridSd.keep' : 'next.hybridSd.keep.emmc');

  /**
   * CM5-IO, Windows on the eMMC: check the board's firmware over MaskROM (nothing is written when it cannot
   * start Armbian; the loader keeps running), then Windows staged on the eMMC as without Armbian, then
   * Armbian's own image onto the SD card. The firmware on the eMMC is kept and writes the request itself.
   */
  const startHybridSdEmmc = async (b: WoaBoard) => {
    setRun({ title: t('run.hybridSd.emmc'), log: [], confirm: null, result: null, stages: [
      { id: 'fwcheck', label: t('run.hybridSd.check', { board: b.name }), percent: null },
      ...windowsStages(),
      { id: 'sd', label: t('run.hybridSd.sd'), percent: 0 },
    ] });
    const c = await checkArmbianOnce(b, 'fwcheck', false);
    if (!c.ok) { finish(resultOf(c, '')); return; }
    setStage('fwcheck', { percent: 100, note: t('run.hybridSd.checked') });
    await stageWindows(b, async () => {
      const a = await writeArmbianSd(b);
      finish(resultOf(a, t('result.hybridSd.emmc'), [t('next.stage.1'), t('next.stage.2'), t('next.stage.3'), t('next.hybridSd.card'), t('next.hybridSd.armbian'), keepNext(b), t('next.stage.4')]));
    });
  };

  /**
   * Armbian next to Windows on an SD card: check the board's firmware over MaskROM (nothing is written when it
   * cannot start Armbian), then Windows onto the NVMe drive as without Armbian, then Armbian's own image
   * onto the SD card. On the CM5-IO with Windows on the eMMC, startHybridSdEmmc.
   */
  const startHybridSd = async (b: WoaBoard) => {
    if (dest === 'emmc') { await startHybridSdEmmc(b); return; }
    const req = { target: dest, boardId: b.id, windowsToken: windows!.token, index: index!, setup, drivers: drivers?.token ?? null };
    setRun({ title: t('run.hybridSd'), log: [], confirm: null, result: null, stages: [
      { id: 'board', label: t('run.hybridSd.check', { board: b.name }), percent: null },
      { id: 'write', label: method === 'host' ? t('run.host.disk') : t('run.stagingDisk.stage'), percent: method === 'host' ? null : 0 },
      { id: 'sd', label: t('run.hybridSd.sd'), percent: 0 },
    ] });
    const c = await checkArmbianOnce(b);
    if (!c.ok) { finish(resultOf(c, '')); return; }
    setStage('board', { percent: 100, note: t('run.hybridSd.checked') });
    if (method === 'host') {
      const off = api.onProgress((p) => { if (p.note) addLog(p.note); setStage('write', { note: p.note ?? t(`progress.${p.stage}`, { done: formatBytes(p.bytes), total: formatBytes(p.total) }) }); });
      const r = await api.hostBuild({ ...req, device: disk! }).finally(off);
      if (!r.ok) { finish({ ok: false, title: errorText(r.reason), ...(r.detail ? { detail: r.detail } : {}) }); return; }
    } else {
      const r = await withProgress('write', () => api.writeBoard({ kind: 'stage-disk', ...req, target: dest as 'sd' | 'nvme', device: disk! }));
      if (!r.ok) { finish(resultOf(r, '')); return; }
    }
    setStage('write', { percent: 100, note: t('run.written') });
    const a = await writeArmbianSd(b);
    finish(resultOf(a, t('result.hybridSd'), [t('next.disk.nvme'), t('next.hybridSd.windows'), t('next.hybridSd.card'), t('next.hybridSd.armbian'), keepNext(b), t('next.stage.4')]));
  };

  // While a write runs, closing the window asks first (main.ts), in the page's language.
  const running = !!run && !run.result;
  useEffect(() => {
    api.setBusy?.(running ? { title: t('stop.title'), text: t('stop.close'), stay: t('stop.stay'), leave: t('stop.leave') } : null);
  }, [running, t]);
  const [stopAsk, setStopAsk] = useState(false);
  const cancel = () => {
    setStopAsk(false);
    if (worker.current) {
      worker.current.terminate();
      worker.current = null;
      finish({ ok: false, title: t('result.cancelled') });
    } else api.cancel();
  };
  // After a failure the wizard opens where the run was started (Confirm or Review), with every choice kept.
  const [wizardStart, setWizardStart] = useState(1);
  // What a problem report says (shared/report.ts scrubs it in the main process).
  const reportFacts = () => {
    const failed = run?.stages.find((x) => x.percent !== 100);
    return {
      board: board?.name ?? null, mode: mode ?? '?', task: run?.title ?? null, step: failed?.label ?? null,
      error: run?.result?.reason ?? run?.result?.title ?? null, detail: run?.result?.detail ?? null, log: run?.log ?? [],
    };
  };
  const closeRun = (again = false) => {
    for (const tok of servedTokens.current) api.releaseServed(tok);
    servedTokens.current = [];
    setWizardStart(run?.result && !run.result.ok ? lastStep : 1);
    setRun(null);
    // Try again: as pressing Start or the Review button once more; what is erased was confirmed on that page.
    if (again) start();
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
              description={boardDesc(b)}
              onChange={() => {
                setBoardId(b.id);
                if (b.id !== here?.boardId) setVia('maskrom');
                if (!b.windowsTargets.includes(dest)) setDest(b.windowsTargets[0]);
                if ((task === 'uefi' || task === 'uefi-keep') && !firmwareTargets(b).some((x) => x.id === task)) setTask(null);
                if (task === 'uefi-sd' && !releases?.firmware?.sdcard?.[b.id]) setTask(null);
                if ((task === 'armbian' || task === 'factory') && (!ARMBIAN_RESTORE[b.id] || !b.emmc)) setTask(null);
                setFactory(null);
                setUpgrade(null);
                if (task === 'upgrade' && b.firmwareStorage !== 'emmc') setTask(null);
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
          <List>{releases.problems.map((p) => <ListItem key={p}>{errorText(p)}</ListItem>)}</List>
        </Alert>
      )}
      {tierNotice}
      <Form onSubmit={(e) => e.preventDefault()}>
        <FormGroup role="radiogroup" fieldId="task-win" label={t('task.group.windows')} isStack>
          <Radio id="task-windows" name="task" label={t('task.windows.any')} isChecked={task === 'windows'} isDisabled={onBoard && !board.emmc}
            onChange={() => { setTask('windows'); if (!board.windowsTargets.includes(dest)) setDest(board.windowsTargets[0]); }}
            description={t('task.windows.short', { where: whereText(board.windowsTargets) })} />
          {board.emmc && (
            <Radio id="task-stick" name="task" label={t('task.stick')} isChecked={task === 'stick'} isDisabled={onBoard}
              onChange={() => { setTask('stick'); refreshDrives(); }} description={t('task.stick.short')} />
          )}
        </FormGroup>
        <FormGroup role="radiogroup" fieldId="task-fw" label={t('task.group.firmware')} isStack>
          {firmwareTargets(board).map((tg) => (
            <Radio key={tg.id} id={`task-${tg.id}`} name="task" label={fwText(board, tg, 'label')} isChecked={task === tg.id}
              onChange={() => setTask(tg.id as Task)} description={fwText(board, tg, 'note')} />
          ))}
          {board.firmwareStorage === 'emmc' && (
            <Radio id="task-upgrade" name="task" label={t('task.upgrade')} isChecked={task === 'upgrade'} isDisabled={onBoard}
              onChange={() => setTask('upgrade')} description={onBoard ? t('task.upgrade.here') : t('task.upgrade.short')} />
          )}
          {sdRelease && (
            <Radio id="task-uefi-sd" name="task" label={t('task.uefiSd')} isChecked={task === 'uefi-sd'} isDisabled={onBoard}
              onChange={() => { setTask('uefi-sd'); setStick(null); refreshDrives(); }}
              description={t(`sd.boot.${board.sdBoot}.uefi`, { board: board.name })} />
          )}
          {/* What the release's image for this board supports (FEATURES.json, or the built-in table for older releases). */}
          {fwRelease && fwFeatureText() && (
            <FormHelperText><HelperText><HelperTextItem id="fw-features" variant={fwNoWindows ? 'warning' : 'default'}>
              {t('fwFeatures.lead', { tag: fwTag, list: fwFeatureText()! })}{fwNoWindows ? ` ${t('fwFeatures.noWindows')}` : ''}
            </HelperTextItem></HelperText></FormHelperText>
          )}
        </FormGroup>
        {/* Armbian alone and the factory restore write the eMMC; a board without one gets Armbian only next to Windows. */}
        {ARMBIAN_RESTORE[board.id] && board.emmc && (
          <FormGroup role="radiogroup" fieldId="task-other" label={t('task.group.other')} isStack>
            <Radio id="task-armbian" name="task" label={t('task.armbian')} isChecked={task === 'armbian'} isDisabled={onBoard}
              onChange={() => setTask('armbian')} description={onBoard ? t('task.restore.here') : t('task.armbian.short')} />
            <Radio id="task-factory" name="task" label={t('task.factory')} isChecked={task === 'factory'} isDisabled={onBoard}
              onChange={() => setTask('factory')} description={onBoard ? t('task.restore.here') : `${t('task.factory.short')} ${t('task.factory.untested')}`} />
          </FormGroup>
        )}
      </Form>
      {task === 'windows' && (
        <Form onSubmit={(e) => e.preventDefault()}>
          <FormGroup role="radiogroup" fieldId="dest" label={t('dest.label')} isStack>
            {/* Only the places this board can take Windows (boards.ts windowsTargets). */}
            {board.windowsTargets.map((x) => (x === 'emmc'
              ? <Radio key={x} id="dest-emmc" name="dest" label={t('dest.emmc')} isChecked={dest === 'emmc'} onChange={() => setDest('emmc')} description={t('dest.emmc.desc')} />
              : <Radio key={x} id={`dest-${x}`} name="dest" label={t(`dest.${x}`)} isChecked={dest === x} isDisabled={onBoard}
                onChange={() => { setDest(x); setDisk(null); refreshDisks(); }}
                description={x === 'sd' ? t(`dest.sd.desc.${board.sdBoot}`, { board: board.name }) : t('dest.nvme.desc', { board: board.name })} />))}
          </FormGroup>
          {/* Built on this PC needs a Windows PC (DISM); elsewhere the board installs, and that is said once, not offered greyed out. */}
          {WIN_HOST && !onBoard ? (
            <FormGroup role="radiogroup" fieldId="method" label={t('method.label')} isStack>
              <Radio id="method-stage" name="method" label={t('method.stage')} isChecked={method === 'stage'} onChange={() => setMethod('stage')}
                description={t('method.stage.desc')} />
              <Radio id="method-host" name="method" label={t('method.host')} isChecked={method === 'host'} onChange={() => setMethod('host')}
                description={t('method.host.desc')} />
            </FormGroup>
          ) : (
            <FormGroup fieldId="method" label={t('method.label')}>
              <Content component="p" id="method-stage-only">{t('method.stage.only')}</Content>
              {!onBoard && (
                <FormHelperText><HelperText><HelperTextItem>{t('method.host.notHere')}</HelperTextItem></HelperText></FormHelperText>
              )}
            </FormGroup>
          )}
          {fwNoWindows ? (
            <Alert isInline variant="danger" id="fw-no-windows" title={t('noWindows.title', { board: board.name, tag: fwTag })}>
              <Content component="p">{t('noWindows.text', { board: board.name, tag: fwTag })}</Content>
              <Content component="p">{t(releases?.firmware?.tier.used === 'ci' ? 'noWindows.ci' : 'noWindows.useCi')}</Content>
            </Alert>
          ) : !board.windowsBooted && <Alert isInline variant="warning" title={t('untried.title', { board: board.name })}>{t('untried.text')}</Alert>}
          {hybridNoFirmware && <Content component="p" className="muted" id="hybrid-no-firmware">{t('hybrid.noFirmware', { board: board.name, tag: fwTag })}</Content>}
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

  const loadUpgrade = async (from: 'release' | 'file') => {
    if (!board) return;
    setUpgradeError(null);
    setUpgrade('loading');
    const r = await api.prepareUpgrade(board.id, from);
    if (!r) { setUpgrade(null); return; }
    if ('error' in r) { setUpgrade(null); setUpgradeError(errorText(r.error)); return; }
    setUpgrade(r);
  };
  useEffect(() => {
    if (task === 'upgrade' && board && upgrade === null && !upgradeError && fwRelease) loadUpgrade('release');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, boardId, fwRelease]);
  const upgradeReady = typeof upgrade === 'object' && upgrade !== null;
  const upgradeStep = board && (
    <StepPage title={t('step.upgrade')} lead={t('upgrade.lead')}>
      <Alert isInline variant="info" title={t('upgrade.kept.title')}>{t('upgrade.kept.text')}</Alert>
      <Card isPlain>
        <CardTitle>{t('upgrade.card')}</CardTitle>
        <CardBody>
          <Stack hasGutter>
            {upgrade === 'loading' && <Content component="p">{t('upgrade.loading')}</Content>}
            {upgradeError && <Alert isInline variant="danger" title={upgradeError} />}
            {upgradeReady && (
              <DescriptionList isCompact isHorizontal aria-label={t('upgrade.card')}>
                {([
                  [t('upgrade.installed'), t('upgrade.installed.value')],
                  [t('upgrade.new'), `${upgrade.version ?? t('upgrade.noVersion')} (${upgrade.origin})`],
                  [t('upgrade.for'), upgrade.dt],
                  [t('upgrade.settingsAt'), t('upgrade.settingsAt.value', { lba: upgrade.nvdataLba, n: upgrade.nvdataSectors })],
                ] as Array<[string, string]>).map(([k, v]) => (
                  <DescriptionListGroup key={k}><DescriptionListTerm>{k}</DescriptionListTerm><DescriptionListDescription>{v}</DescriptionListDescription></DescriptionListGroup>
                ))}
              </DescriptionList>
            )}
            <Flex spaceItems={{ default: 'spaceItemsMd' }}>
              <FlexItem><Button variant="secondary" isDisabled={upgrade === 'loading' || !fwRelease} onClick={() => loadUpgrade('release')}>{t('upgrade.useRelease', { tag: releases?.firmware?.tier.label ?? '' })}</Button></FlexItem>
              <FlexItem><Button variant="secondary" isDisabled={upgrade === 'loading'} onClick={() => loadUpgrade('file')}>{t('upgrade.useFile')}</Button></FlexItem>
            </Flex>
            <Switch id="keep-settings" label={t('upgrade.keep')} isChecked={keepSettings} onChange={(_e, v) => setKeepSettings(v)} />
            <Content component="p" className="muted">{keepSettings ? t('upgrade.keep.desc') : t('upgrade.reset.desc')}</Content>
          </Stack>
        </CardBody>
      </Card>
    </StepPage>
  );

  const armbianFound = armbian && typeof armbian === 'object' && 'file' in armbian && armbian.id === armbianId ? armbian : null;
  // The board's eMMC is smaller than the image and its room to grow (never so far: 32 and 64 GB).
  const armbianTooBig = !!armbianFound?.minBytes && restoreTo === 'emmc' && !!board?.emmc && board.emmc.bytes < armbianFound.minBytes;
  const offerWords = (o: { desktop: boolean; variant: string }) => (o.desktop ? t('restore.desktop', { name: variantWords(o.variant) })
    : t(o.variant === 'server' ? 'restore.server' : 'restore.minimal'));
  const factoryLink = board?.factoryPage ? (lang === 'en' ? board.factoryPage.en : board.factoryPage.zh) : undefined;
  const chooseFactory = async () => {
    setFactoryError(null);
    const r = await api.pickFactory();
    if (!r) return;
    if ('error' in r) { setFactory(null); setFactoryError(errorText(r.error)); return; }
    setFactory(r);
  };
  const restoreStep = board && (
    <StepPage title={t('step.restore')} lead={t('restore.lead')}>
      {task === 'armbian' && (
        <>
          {armbianOffers === 'looking' && <Content component="p">{t('restore.list.looking')}</Content>}
          {armbianOffers && typeof armbianOffers === 'object' && 'error' in armbianOffers && <Alert isInline variant="danger" title={errorText(armbianOffers.error)} />}
          {offerList.length > 0 && (
            <Table aria-label={t('restore.list')} variant="compact" id="armbian-offers">
              <Thead><Tr>
                <Th screenReaderText={t('restore.list.pick')} />
                <Th>{t('restore.col.desktop')}</Th><Th>{t('restore.col.system')}</Th><Th>{t('restore.col.kernel')}</Th>
                <Th modifier="nowrap">{t('restore.col.download')}</Th><Th modifier="nowrap">{t('restore.col.date')}</Th>
              </Tr></Thead>
              <Tbody>
                {offerList.map((o, i) => (
                  <Tr key={o.id} id={`offer-${o.id}`} isClickable isRowSelected={armbianId === o.id} onRowClick={() => setArmbianId(o.id)}>
                    <Td select={{ rowIndex: i, onSelect: () => setArmbianId(o.id), isSelected: armbianId === o.id, variant: 'radio' }} />
                    <Td dataLabel={t('restore.col.desktop')}>{o.promoted ? t('restore.withNote', { what: offerWords(o), note: t('restore.promoted') }) : offerWords(o)}</Td>
                    <Td dataLabel={t('restore.col.system')}>{distroWords(o.distro)}</Td>
                    <Td dataLabel={t('restore.col.kernel')}>{t('restore.withNote', { what: o.kernel, note: t(`restore.branch.${o.branch}`) === `restore.branch.${o.branch}` ? o.branch : t(`restore.branch.${o.branch}`) })}</Td>
                    <Td dataLabel={t('restore.col.download')} modifier="nowrap">{formatBytes(o.size)}</Td>
                    <Td dataLabel={t('restore.col.date')} modifier="nowrap">{o.date}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
          <Content component="p" className="muted">{t('restore.branches')}</Content>
          <Form onSubmit={(e) => e.preventDefault()}>
            <FormGroup role="radiogroup" fieldId="restore-to" label={t('restore.to')} isStack>
              <Radio id="restore-to-emmc" name="restore-to" label={t('restore.to.emmc')} isChecked={restoreTo === 'emmc'} onChange={() => setRestoreTo('emmc')} description={t('restore.to.emmc.desc')} />
              <Radio id="restore-to-drive" name="restore-to" label={t('restore.to.drive')} isChecked={restoreTo === 'drive'}
                onChange={() => { setRestoreTo('drive'); setStick(null); refreshDrives(); }} description={t('restore.to.drive.desc')} />
            </FormGroup>
          </Form>
          {restoreTo === 'drive' && (
            <Alert isInline variant="info" title={t(`sd.boot.${board.sdBoot}.title`, { board: board.name })}>{t(`sd.boot.${board.sdBoot}.armbian`, { board: board.name })}</Alert>
          )}
          {armbian === 'looking' && <Content component="p">{t('restore.looking')}</Content>}
          {armbian && typeof armbian === 'object' && 'error' in armbian && <Alert isInline variant="danger" title={errorText(armbian.error)} />}
          {armbianFound && (
            <DescriptionList isCompact isHorizontal aria-label={t('restore.found')}>
              {([
                [t('restore.file'), armbianFound.file],
                [t('restore.version'), armbianFound.version],
                [t('restore.kernel'), t('restore.withNote', { what: armbianFound.kernel, note: armbianFound.branch })],
                [t('restore.distro'), `${distroWords(armbianFound.distro)}, ${variantWords(armbianFound.variant)}`],
                [t('restore.signed'), armbianFound.signed ?? '?'],
                [t('restore.download'), formatBytes(armbianFound.size)],
                [t('restore.image'), armbianFound.imageBytes === null ? t('restore.image.later') : formatBytes(armbianFound.imageBytes)],
                [t('restore.needs'), armbianFound.minBytes === null ? t('restore.image.later') : t('restore.needs.value', { size: formatBytes(armbianFound.minBytes) })],
              ] as Array<[string, string]>).map(([k, v]) => (
                <DescriptionListGroup key={k}><DescriptionListTerm>{k}</DescriptionListTerm><DescriptionListDescription>{v}</DescriptionListDescription></DescriptionListGroup>
              ))}
            </DescriptionList>
          )}
          {armbianTooBig && <Alert isInline variant="danger" title={t('restore.tooBig', { need: formatBytes(armbianFound!.minBytes!), have: formatBytes(board.emmc!.bytes) })} />}
          <Content component="p">{t('restore.checks')}</Content>
          <Content component="p"><Button variant="link" isInline component="a" href={ARMBIAN_RESTORE[board.id]!.page} target="_blank">{t('restore.armbianPage')}</Button></Content>
        </>
      )}
      {task === 'factory' && (
        <>
          <Content component="p" className="muted">{t('restore.factory.emmcOnly')}</Content>
          <Content component="p">{t(`restore.factory.${board.id}`)}{' '}
            <Button variant="link" isInline component="a" href={factoryLink} target="_blank">{t('restore.factory.where')}</Button></Content>
          <Alert isInline variant="custom" title={t('restore.factory.untested')}>{t('restore.factory.untestedText')}</Alert>
          <Flex><FlexItem><Button variant="secondary" onClick={chooseFactory}>{t('restore.factory.choose')}</Button></FlexItem></Flex>
          {factoryError && <Alert isInline variant="danger" title={factoryError} />}
          {factory && (
            <DescriptionList isCompact isHorizontal aria-label={t('restore.factory.choose')}>
              {([
                [t('restore.file'), `${factory.fileName}, ${formatBytes(factory.size)}`],
                [t('restore.factory.chip'), factory.loaderChip && factory.loaderChip !== factory.chip ? `${factory.chip} (loader ${factory.loaderChip})` : factory.chip],
                [t('restore.factory.model'), [factory.manufacturer, factory.model].filter(Boolean).join(' ') || '?'],
                [t('restore.factory.version'), `${factory.version}, ${factory.released}`],
                [t('restore.factory.parts'), factory.partitions.map((p) => `${p.name} (${formatBytes(p.bytes)})`).join(', ')],
                [t('restore.factory.md5'), factory.hasMd5 ? t('restore.factory.md5.yes') : t('restore.factory.md5.no')],
              ] as Array<[string, string]>).map(([k, v]) => (
                <DescriptionListGroup key={k}><DescriptionListTerm>{k}</DescriptionListTerm><DescriptionListDescription>{v}</DescriptionListDescription></DescriptionListGroup>
              ))}
            </DescriptionList>
          )}
          {factory?.refuse && <Alert isInline variant="danger" title={t('restore.factory.refused')}>{msg(factory.refuse)}</Alert>}
        </>
      )}
    </StepPage>
  );
  const restoreReady = task === 'armbian' ? !!armbianFound && !armbianTooBig : task === 'factory' ? !!factory && !factory.refuse : true;

  // What was read from the chosen image, before anything is written.
  const windowsFound = (w: WindowsChoice) => {
    const uniq = (xs: string[]) => [...new Set(xs)];
    const builds = uniq(w.editions.map((e) => {
      const b = `${e.build ?? '?'}${e.spBuild ? `.${e.spBuild}` : ''}`;
      return `${b} (${e.release ?? t('win.preview')})`;
    }));
    const boot = w.container !== 'iso' ? null
      : !w.boot ? t('win.found.boot.none')
      : (['arm64', 'x64', 'x86'] as const).filter((k) => w.boot![k]).map((k) => t(`win.found.boot.${k}`)).join(', ') || t('win.found.boot.none');
    const rows: Array<[string, string]> = [
      [t('win.found.file'), `${w.fileName}, ${formatBytes(w.fileSize)}`],
      [t('win.found.image'), `${w.container === 'iso' ? t('win.inIso', { name: w.imageName }) : w.imageName}, ${formatBytes(w.imageSize)}`],
      [t('win.found.arch'), uniq(w.editions.map((e) => e.archName)).join(', ')],
      [t('win.found.build'), builds.join(', ')],
      ...(boot ? [[t('win.found.boot'), boot] as [string, string]] : []),
      [t('win.found.languages'), uniq(w.editions.flatMap((e) => e.languages)).join(', ') || '?'],
      [t('win.found.editions'), t('win.found.editions.value', { all: String(w.editions.length), ok: String(w.editions.filter((e) => !e.refuse).length) })],
    ];
    return (
      <DescriptionList isCompact isHorizontal aria-label={t('win.found')}>
        {rows.map(([k, v]) => (
          <DescriptionListGroup key={k}><DescriptionListTerm>{k}</DescriptionListTerm><DescriptionListDescription>{v}</DescriptionListDescription></DescriptionListGroup>
        ))}
      </DescriptionList>
    );
  };

  const windowsStep = (
    <StepPage title={t('step.windows')} lead={t('win.lead')}>
      <Alert isInline variant="info" title={t('win.24h2.title')}>{t('win.24h2.text')}</Alert>
      <ExpandableSection toggleText={t('win.get')} isIndented className="sources">
        <Content component="p">{t('win.get.text')}</Content>
        <DescriptionList isCompact>
          {WINDOWS_SOURCES.map((src) => (
            <DescriptionListGroup key={src.id}>
              <DescriptionListTerm>
                <Button variant="link" isInline component="a" href={src.url} target="_blank">{src.title[lang]}</Button>
                {src.recommended && <span className="muted"> ({src.recommended[lang]})</span>}
                {!src.fits && <span className="muted"> ({t('win.get.unsuitable')})</span>}
              </DescriptionListTerm>
              <DescriptionListDescription>{src.text[lang]}</DescriptionListDescription>
            </DescriptionListGroup>
          ))}
        </DescriptionList>
      </ExpandableSection>
      <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
        <FlexItem><Button variant="secondary" onClick={() => chooseWindows(() => api.pickWindows())}>{t('win.choose')}</Button></FlexItem>
      </Flex>
      <div className="drop" onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) chooseWindows(() => api.dropWindows(f)); }}>
        {t('win.drop')}
      </div>
      {windowsError && <Alert isInline variant="danger" title={windowsError} />}
      {windows && windowsFound(windows)}
      {windows && (windows.refuse || windows.editions.every((e) => e.refuse)) && (
        <Alert isInline variant="danger" title={t('win.refused')}>
          {windows.refuse ? msg(windows.refuse) : checkText(windows.editions[0])}
        </Alert>
      )}
      {edition?.check.level === 'notice' && <Alert isInline variant="custom" title={t('win.untested')}>{checkText(edition)}</Alert>}
      {edition?.check.level === 'warn' && <Alert isInline variant="warning" title={t('win.warned')}>{checkText(edition)}</Alert>}
      {windows && (
        <Table aria-label={t('win.col.edition')} variant="compact">
          <Thead><Tr><Th screenReaderText={t('restore.list.pick')} /><Th>{t('win.col.edition')}</Th><Th>{t('win.col.build')}</Th><Th>{t('win.col.installed')}</Th></Tr></Thead>
          <Tbody>
            {windows.editions.map((e) => (
              <Tr key={e.index}>
                <Td select={{ rowIndex: e.index, isSelected: index === e.index, onSelect: () => setIndex(e.index), isDisabled: !!e.refuse, variant: 'radio' }} />
                <Td dataLabel={t('win.col.edition')}>{e.name}{!windows.refuse && checkText(e) && <div className="muted">{checkText(e)}</div>}</Td>
                <Td dataLabel={t('win.col.build')}>{e.build ?? '?'}{e.spBuild ? `.${e.spBuild}` : ''}</Td>
                <Td dataLabel={t('win.col.installed')}>{e.totalBytes > 1e6 ? formatBytes(e.totalBytes) : ''}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      )}
    </StepPage>
  );

  const languages = useMemo(() => languageChoices(lang), [lang]);
  const keyboards = useMemo(() => keyboardChoices(lang), [lang]);
  const imageLanguages = windows ? [...new Set(windows.editions.flatMap((e) => e.languages))] : [];
  // Regional formats are fine in any image; Windows' menus only come in a language the image has.
  const localeElsewhere = !!windows && imageLanguages.length > 0 && !imageHasLanguage(account.locale, imageLanguages);
  const field = (id: keyof Account, label: string, type: 'text' | 'password' = 'text') => (
    <FormGroup label={label} fieldId={`acc-${id}`} isRequired={id === 'user' || id === 'password'}>
      <TextInput id={`acc-${id}`} type={type} value={account[id] as string} autoComplete="off" spellCheck={false}
        onChange={(_e, v) => setAccount((a) => ({ ...a, [id]: v }))} />
    </FormGroup>
  );

  const GBs = (n: number) => `${(n / GiB).toFixed(1)} GB`;
  // The disk after the install, as [partition, size] rows.
  const layoutRows = (): Array<[string, string]> => {
    const rows: Array<[string, string]> = [];
    if (dest === 'emmc') rows.push([t('layout.part.firmware'), t('layout.size.kept', { size: '64 MiB' })]);
    rows.push([t('layout.part.esp'), '260 MiB'], [t('layout.part.msr'), '16 MiB']);
    if (hybridEmmc) {
      const win = layoutFree && !Number.isNaN(armbianBytes) ? layoutFree - (ESP_MIB + MSR_MIB) * MiB - armbianBytes : null;
      rows.push([t('layout.part.windows'), win !== null && win > 0 ? GBs(win) : t('layout.size.rest')]);
      rows.push([t('layout.part.armbian'), Number.isNaN(armbianBytes) ? '?' : GBs(armbianBytes)]);
      return rows;
    }
    if (!layoutChoice) { rows.push([t('layout.part.windows'), t('layout.size.rest')]); return rows; }
    if (layoutPlan && !('problem' in layoutPlan)) {
      rows.push([t('layout.part.windows'), GBs(layoutPlan.windowsBytes)]);
      if (layoutPlan.data) rows.push([t('layout.part.data', { fs: layoutPlan.data.fs === 'ntfs' ? 'NTFS' : 'exFAT', label: layoutPlan.data.label }), GBs(layoutPlan.data.bytes)]);
      if (layoutPlan.linuxReserveBytes > 0) rows.push([t('layout.part.linux'), GBs(layoutPlan.linuxReserveBytes)]);
      const other = layoutPlan.unallocatedBytes - layoutPlan.linuxReserveBytes;
      if (other >= 512 * MiB) rows.push([t('layout.part.free'), GBs(other)]);
    }
    return rows;
  };
  const layoutList = (
    <DescriptionList isCompact isHorizontal horizontalTermWidthModifier={{ default: '14rem' }} aria-label={t('layout.label')}>
      {layoutRows().map(([k, v]) => (
        <DescriptionListGroup key={k}><DescriptionListTerm>{k}</DescriptionListTerm><DescriptionListDescription>{v}</DescriptionListDescription></DescriptionListGroup>
      ))}
    </DescriptionList>
  );
  const hybridOffers = offerList;
  const hybridGroup = hybridPossible && (
    <FormSection title={t('hybrid.title')} titleElement="h3">
      <Checkbox id="hybrid-on" label={t(sdKind ? 'hybrid.on.sd' : 'hybrid.on')}
        description={hybridKind === 'windows-and-sd' ? spaced(t('hybrid.wsd.on.desc', { where: t(`where.${dest}`) })) : t(sdKind ? 'hybrid.on.sd.desc' : 'hybrid.on.desc')} isChecked={withArmbian}
        onChange={(_e, v) => { setWithArmbian(v); if (v) { setHybridId(null); setSdDrive(null); if (sdKind) refreshDrives(SD_MIN); } }} />
      <Content component="p" id="hybrid-experimental">{t('hybrid.experimental')}</Content>
      {/* The ROCK 4D: what the firmware must have, said before anything is chosen; the app checks it over MaskROM. */}
      {hybridKind === 'nvme-and-sd' && (
        <Alert isInline variant="warning" id="hybrid-firmware" title={t('hybrid.sd.fw.title')}>
          <Content component="p">{t('hybrid.sd.fw.text', { board: board?.name ?? '' })}</Content>
          <Content component="p">{t('hybrid.sd.flow', { board: board?.name ?? '' })}</Content>
        </Alert>
      )}
      {hybridKind === 'windows-and-sd' && (
        <Alert isInline variant="warning" id="hybrid-firmware" title={t('hybrid.sd.fw.title')}>
          <Content component="p">{t('hybrid.wsd.fw.text', { board: board?.name ?? '' })}</Content>
          <Content component="p">{spaced(t('hybrid.wsd.flow', { board: board?.name ?? '', where: t(`where.${dest}`) }))}</Content>
        </Alert>
      )}
      {hybridOn && (
        <>
          <FormGroup role="radiogroup" fieldId="hybrid-image" label={t('hybrid.image')} isRequired isStack>
            {armbianOffers === 'looking' && <Content component="p">{t('restore.list.looking')}</Content>}
            {armbianOffers && typeof armbianOffers === 'object' && 'error' in armbianOffers && <Alert isInline variant="danger" title={errorText(armbianOffers.error)} />}
            {hybridOffers.map((o) => (
              <Radio key={o.id} id={`hybrid-${o.id}`} name="hybrid-image" isChecked={hybridId === o.id} onChange={() => setHybridId(o.id)}
                label={`${offerWords(o)}, ${distroWords(o.distro)}`}
                description={t('hybrid.image.desc', { kernel: o.kernel, branch: o.branch, size: formatBytes(o.size) }) + (o.nightly ? ` ${t('hybrid.image.nightly')}` : '')} />
            ))}
            <FormHelperText><HelperText><HelperTextItem variant={hybridId ? 'default' : 'warning'}>{hybridId ? t('hybrid.image.help') : t('why.hybrid.pick')}</HelperTextItem></HelperText></FormHelperText>
          </FormGroup>
          {hybridFound === 'looking' && <Content component="p">{t('restore.looking')}</Content>}
          {hybridFound && typeof hybridFound === 'object' && 'error' in hybridFound && <Alert isInline variant="danger" title={errorText(hybridFound.error)} />}
          {hybridChoice && <Content component="p" className="muted">{t('hybrid.found', { file: hybridChoice.file, image: hybridChoice.imageBytes === null ? '?' : formatBytes(hybridChoice.imageBytes) })}</Content>}
          {hybridEmmc && <FormGroup label={t('hybrid.size')} fieldId="hybrid-size" isRequired>
            {armbianMax !== null && armbianMax > armbianMin && (
              <Slider id="hybrid-slider" value={Number.isNaN(armbianBytes) ? armbianMin / GiB : armbianBytes / GiB} min={Math.floor(armbianMin / GiB)} max={armbianMax / GiB} step={1}
                showBoundaries onChange={(_e, v) => setArmbianGb(String(Math.round(v)))} aria-label={t('hybrid.size')} />
            )}
            <TextInput id="hybrid-size" value={armbianGb} onChange={(_e, v) => setArmbianGb(v)} type="text" inputMode="decimal" validated={hybridErr ? 'error' : 'default'} />
            <FormHelperText><HelperText><HelperTextItem variant={hybridErr ? 'error' : 'default'}>{hybridErr
              ?? t('hybrid.size.help', { min: `${(armbianMin / GiB).toFixed(0)} GB`, max: armbianMax === null ? '?' : `${(armbianMax / GiB).toFixed(0)} GB` })}</HelperTextItem></HelperText></FormHelperText>
          </FormGroup>}
          {hybridSd && <Content component="p" id="hybrid-sd-size">{t('hybrid.sd.size', { need: hybridChoice?.minBytes ? formatBytes(hybridChoice.minBytes) : '?' })}</Content>}
          <FormGroup role="radiogroup" fieldId="hybrid-default" label={t('hybrid.default')} isStack>
            <Radio id="hybrid-default-windows" name="hybrid-default" label="Windows" isChecked onChange={() => undefined} description={t(hybridSd ? 'hybrid.default.windows.sd' : 'hybrid.default.windows')} />
            <Radio id="hybrid-default-armbian" name="hybrid-default" label="Armbian" isChecked={false} isDisabled onChange={() => undefined} description={t('hybrid.default.armbian')} />
          </FormGroup>
          <Alert isInline variant="info" title={t('hybrid.first.title')}>{t('hybrid.first.text')}</Alert>
        </>
      )}
    </FormSection>
  );
  const layoutGroup = staged && (
    <FormSection title={t('layout.label')} titleElement="h3">
      {!hybridEmmc && <FormGroup role="radiogroup" fieldId="layout" label={t('layout.size')} isStack>
        <Radio id="layout-whole" name="layout" label={t('layout.whole')} isChecked={layoutMode === 'whole'} onChange={() => setLayoutMode('whole')} description={t('layout.whole.desc')} />
        <Radio id="layout-custom" name="layout" label={t('layout.custom')} isChecked={layoutMode === 'custom'} isDisabled={!customPossible}
          onChange={() => { setLayoutMode('custom'); if (!winGb && layoutMaxWin) setWinGb(String(Math.max(32, Math.floor(layoutMaxWin / GiB / 2)))); }}
          description={customPossible ? t('layout.custom.desc', { min: GBs(MIN_WINDOWS_CHOSEN) }) : t('layout.custom.tooSmall', { min: GBs(MIN_WINDOWS_CHOSEN) })} />
      </FormGroup>}
      {layoutMode === 'custom' && !hybridEmmc && (
        <>
          <FormGroup label={t('layout.windowsSize')} fieldId="layout-win" isRequired>
            <TextInput id="layout-win" value={winGb} onChange={(_e, v) => setWinGb(v)} type="text" inputMode="decimal" validated={layoutErr ? 'error' : 'default'} />
            <FormHelperText><HelperText><HelperTextItem variant={layoutErr ? 'error' : 'default'}>{layoutErr
              ?? (layoutMaxWin ? t('layout.windowsSize.help', { min: GBs(MIN_WINDOWS_CHOSEN), max: GBs(layoutMaxWin) }) : t('layout.windowsSize.helpNoDisk', { min: GBs(MIN_WINDOWS_CHOSEN) }))}</HelperTextItem></HelperText></FormHelperText>
          </FormGroup>
          <FormGroup role="radiogroup" fieldId="layout-rest" label={t('layout.rest')} isStack>
            <Radio id="rest-free" name="rest" label={t('layout.rest.free')} isChecked={rest === 'unallocated'} onChange={() => setRest('unallocated')} />
            <Radio id="rest-ntfs" name="rest" label={t('layout.rest.ntfs')} isChecked={rest === 'ntfs'} onChange={() => setRest('ntfs')} />
            <Radio id="rest-exfat" name="rest" label={t('layout.rest.exfat')} isChecked={rest === 'exfat'} onChange={() => setRest('exfat')} description={t('layout.rest.exfat.desc')} />
          </FormGroup>
          {rest !== 'unallocated' && (
            <FormGroup label={t('layout.dataLabel')} fieldId="layout-label">
              <TextInput id="layout-label" value={dataLabel} onChange={(_e, v) => setDataLabel(v)} />
            </FormGroup>
          )}
          <FormGroup label={t('layout.linux')} fieldId="layout-linux">
            <TextInput id="layout-linux" value={linuxGb} onChange={(_e, v) => setLinuxGb(v)} type="text" inputMode="decimal" />
            <FormHelperText><HelperText><HelperTextItem>{t('layout.linux.help')}</HelperTextItem></HelperText></FormHelperText>
          </FormGroup>
        </>
      )}
      <FormGroup fieldId="layout-preview" label={layoutDisk ? t(dest === 'emmc' ? 'layout.preview.emmc' : 'layout.preview.drive', { size: GBs(layoutDisk) }) : t('layout.preview.later')}>
        {layoutDisk && layoutList}
      </FormGroup>
    </FormSection>
  );

  const toolsGroup = (
    <FormGroup label={t('tools.label')} fieldId="rk-tools" role="group">
      <Checkbox id="rk-tools" label={t('tools.on')} isChecked={rkTools} isDisabled={!toolsThere} onChange={(_e, v) => setRkToolsOn(v)}
        description={toolsThere ? t('tools.desc') : t('tools.missing')} />
      <Checkbox id="charsiu-desktop" label={t('charsiu.on')} isChecked={charsiuDesktop} isDisabled={!charsiuThere} onChange={(_e, v) => setCharsiuOn(v)}
        description={releases?.charsiu ? t('charsiu.desc', { tag: releases.charsiu.tag, size: formatBytes(releases.charsiu.size) }) : t('charsiu.missing')} />
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
            <FormGroup label={t('setup.locale')} fieldId="acc-locale">
              <Picker id="acc-locale" value={account.locale} choices={languages} none={t('setup.locale.none')} clearLabel={t('picker.clear')} noMatch={t('picker.none')}
                onChange={(v) => { localePicked.current = true; setAccount((a) => ({ ...a, locale: v })); }} />
              <FormHelperText><HelperText><HelperTextItem variant={localeElsewhere ? 'warning' : 'default'}>
                {localeElsewhere ? t('setup.locale.notInImage', { tag: account.locale, has: imageLanguages.join(', ') }) : t('setup.locale.help')}
              </HelperTextItem></HelperText></FormHelperText>
            </FormGroup>
            <FormGroup label={t('setup.keyboard')} fieldId="acc-keyboard">
              <Picker id="acc-keyboard" value={account.keyboard} choices={keyboards} none={t('setup.keyboard.none')} clearLabel={t('picker.clear')} noMatch={t('picker.none')}
                onChange={(v) => setAccount((a) => ({ ...a, keyboard: v }))} />
            </FormGroup>
            <FormGroup label={t('setup.timezone')} fieldId="acc-timeZone">
              <Picker id="acc-timeZone" value={account.timeZone} choices={TIME_ZONES} none={t('setup.timezone.none')} clearLabel={t('picker.clear')} noMatch={t('picker.none')}
                showDetail={false} onChange={(v) => setAccount((a) => ({ ...a, timeZone: v }))} />
            </FormGroup>
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
        {hybridGroup}
        {layoutGroup}
        <FormGroup label={t('setup.drivers')} fieldId="drivers" role="group">
          <Content component="p" id="drivers-auto">{packageThere
            ? t('setup.drivers.auto', { all: t('drivers.kind.all'), board: board?.name ?? '', extra: boardKinds })
            : t('setup.drivers.winpe')}</Content>
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
        {toolsGroup}
        <FormGroup label={t('trim.label')} fieldId="trim" role="group" isStack>
          <Content component="p" className="muted">{t('trim.desc')}</Content>
          {TRIM_KEYS.map((k) => (
            <Checkbox key={k} id={`trim-${k}`} label={t(`trim.${k}`)} description={t(`trim.${k}.desc`)} isChecked={trimPick[k]}
              onChange={(_e, v) => setTrimPick((x) => ({ ...x, [k]: v }))} />
          ))}
          {(trimPick.removeEdge || trimPick.removeStore) && <Alert isInline variant="warning" title={t('trim.warn.title')}>
            {[trimPick.removeEdge ? t('trim.warn.edge') : '', trimPick.removeStore ? t('trim.warn.store') : ''].filter(Boolean).join(' ')}</Alert>}
          <Flex><FlexItem><Button variant="link" isInline onClick={() => setTrimPick(RECOMMENDED_TRIM)}>{t('trim.recommended')}</Button></FlexItem>
            <FlexItem><Button variant="link" isInline onClick={() => setTrimPick(NO_TRIM)}>{t('trim.none')}</Button></FlexItem></Flex>
        </FormGroup>
      </Form>
    </StepPage>
  );

  // Armbian next to Windows on an SD card reads the board's firmware over MaskROM first, though Windows may go to a drive.
  const maskromCard = board && !onBoard && task !== 'stick' && !driveTask && (!onPc || hybridSd) && (
    <Card>
      <CardTitle>{t('maskrom.title')}</CardTitle>
      <CardBody>
        <Stack hasGutter>
          <List component="ol" type={OrderType.number}>{maskromSteps(board).map((s) => <ListItem key={s}>{s}</ListItem>)}</List>
          {board.webflash.maskromNote && <Content component="p">{lang === 'en' ? board.webflash.maskromNote : t(`maskrom.${board.id}.note`)}</Content>}
          <MaskromLive board={board.name} />
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
      reviewRows = reviewRows.concat(([
        [t('review.windows'), edition ? t('review.windows.value', { edition: edition.name, build: `${edition.build}${edition.spBuild ? `.${edition.spBuild}` : ''}`, file: windows!.fileName }) : t('review.notChosen')],
        [t('review.winpe'), releases?.winpe ? `woa-rk3576 ${releases.winpe.tier.label} (${releases.winpe.file})${tierWord(releases.winpe.tier)}` : t('review.unavailable')],
        [t('review.setup'), skipOn ? t('review.setup.skip', { user: account.user, auto: account.autoLogonAlways ? t('review.setup.auto') : '' }) : t('review.setup.oobe')],
        // The codes the answer file gets, as picked on the setup step.
        ...(skipOn ? [[t('review.intl'), t('review.intl.value', {
          locale: account.locale || t('setup.locale.none'),
          keyboard: account.keyboard || (account.locale ? account.locale : t('setup.locale.none')),
          zone: account.timeZone || t('setup.timezone.none'),
        })] as [string, string]] : []),
        [t('review.ssh'), ssh ? t('review.ssh.on', { key: sshKey.trim() ? t('review.ssh.key') : '' }) : t('review.ssh.off')],
        [t('review.drivers'), t(packageThere ? 'review.drivers.package' : 'review.drivers.value', { file: releases?.winpe?.drivers?.file ?? '', extra: drivers ? t('review.drivers.extra', { name: drivers.name }) : '' })],
        [t('review.trim'), anyTrim(trim) ? TRIM_KEYS.filter((k) => trim[k]).map((k) => t(`trim.${k}`)).join('; ') : t('review.trim.none')],
        [t('review.tools'), rkTools ? t('tools.on') : t('review.trim.none')],
        [t('review.charsiu'), charsiuDesktop ? t('review.charsiu.on', { tag: releases?.charsiu?.tag ?? '' }) : t('review.trim.none')],
        [t('review.target'), t(`review.target.${dest}.${method}`)],
        ...(hybridOn ? [[t('review.armbian'), hybridChoice ? t('review.armbian.value', { what: `${offerWords(hybridChoice)}, ${distroWords(hybridChoice.distro)}`, version: hybridChoice.version, kernel: hybridChoice.kernel }) : t('review.notChosen')] as [string, string]] : []),
        ...(staged ? [[t('layout.label'), layoutDisk ? layoutRows().map(([k, v]) => `${k}: ${v}`).join('; ') : t('layout.preview.later')] as [string, string]] : []),
        [t('review.erased'), dest === 'emmc' ? t('review.erased.windows') : disk ? t('review.erased.disk', { drive: drives?.find((x) => x.device === disk)?.description ?? disk }) : t('review.disk.choose')],
        ...(hybridSd ? [
          [t('review.erased.sd.label'), sdDrive ? t('review.erased.disk', { drive: drives?.find((x) => x.device === sdDrive)?.description ?? sdDrive }) : t('review.sd.choose')],
          [t('review.hybrid.check'), t('review.hybrid.check.value', { board: board.name })],
        ] as Array<[string, string]> : []),
        ...(method === 'stage' ? [
          [t('review.written'), t(dest === 'emmc' ? 'review.written.windows' : `review.written.windows.${dest}`, { size: windows ? formatBytes(windows.imageSize + 560e6) : '' }) + (onBoard || dest !== 'emmc' ? '' : t('review.written.maskrom'))],
          [t('review.checked'), dest !== 'emmc' ? t('review.checked.disk') : onBoard ? t('review.checked.here') : t('review.checked.maskrom')],
          [t('review.then'), t(dest === 'emmc' ? 'review.then.windows' : 'review.then.windows.disk') + (hybridSd ? ` ${t('review.then.armbian.sd')}` : hybridOn ? ` ${t('review.then.armbian')}` : '')],
        ] as Array<[string, string]> : [
          [t('review.checked'), dest === 'emmc' ? t('review.checked.host.emmc') : t('review.checked.host.disk')],
          ...(hybridSd ? [[t('review.then'), t('review.then.armbian.sd')] as [string, string]] : []),
        ] as Array<[string, string]>),
      ] as Array<[string, string]>));
      if (!edition) why = t('why.windows');
      else if (hybridOn && !hybridId) why = t('why.hybrid.pick');
      else if (!setupOk) why = t('why.setup');
      if (!releases?.winpe) why = t('why.winpe');
      if (fwNoWindows) why = t('why.noWindows', { board: board.name, tag: fwTag });
      if (onBoard && here?.emmcRefusal) why = msg(here.emmcRefusal);
      if (dest !== 'emmc' && !disk) why = t('review.disk.choose');
      else if (hybridSd && (!sdDrive || sdDrive === disk)) why = t('review.sd.choose');
      goLabel = hybridSd ? t('go.connect') : onBoard || dest !== 'emmc' || method === 'host' ? t('go.erase') : t('go.connect');
    } else if (task === 'upgrade') {
      reviewRows = reviewRows.concat([
        [t('review.firmware'), upgradeReady ? `${upgrade.version ?? t('upgrade.noVersion')} (${upgrade.origin})` : t('review.notChosen')],
        [t('review.written'), t('review.upgrade.written')],
        [t('review.upgrade.kept'), keepSettings ? t('review.upgrade.kept.keep') : t('review.upgrade.kept.reset')],
        [t('review.checked'), t('review.upgrade.checked')],
        [t('review.then'), t('review.upgrade.then')],
      ]);
      if (!upgradeReady) why = t('why.upgrade');
      goLabel = t('go.connect');
    } else if (driveTask) {
      const drive = stick ? drives?.find((x) => x.device === stick)?.description ?? stick : null;
      reviewRows = reviewRows.concat([
        [t('review.written'), task === 'armbian'
          ? (armbianFound ? `${t('review.restore.armbian', { what: `${offerWords(armbianFound)}, ${distroWords(armbianFound.distro)}`, version: armbianFound.version, kernel: armbianFound.kernel, branch: armbianFound.branch, file: armbianFound.file })}. ${t('review.drive.written.armbian')}` : t('review.unavailable'))
          : (sdRelease ? t('review.drive.written.uefi', { tag: releases!.firmware!.tier.label, file: sdRelease.file }) : t('review.unavailable'))],
        [t('review.erased'), drive ? t('review.stick.erased', { drive }) : t('review.drive.choose')],
        [t('review.checked'), t('review.stick.checked')],
        [t('review.then'), t(`sd.boot.${board.sdBoot}.${task === 'armbian' ? 'armbian' : 'uefi'}`, { board: board.name })],
      ]);
      if (task === 'uefi-sd') reviewRows.splice(2, 0, ...fwFeatureRow());
      if (task === 'armbian' && !restoreReady) why = t('why.restore.armbian');
      else if (!stick) why = t('review.drive.choose');
      goLabel = t('go.erase');
    } else if (restoreTask) {
      reviewRows = reviewRows.concat([
        [t('review.written'), task === 'armbian'
          ? (armbianFound ? `${t('review.restore.armbian', { what: `${offerWords(armbianFound)}, ${distroWords(armbianFound.distro)}`, version: armbianFound.version, kernel: armbianFound.kernel, branch: armbianFound.branch, file: armbianFound.file })}. ${t('review.restore.written.armbian')}` : t('review.unavailable'))
          : (factory ? `${t('review.restore.factory', { file: factory.fileName, chip: factory.chip, model: factory.model, version: factory.version })}. ${t('review.restore.written.factory', { n: factory.partitions.filter((p) => p.lba !== null).length })}` : t('review.notChosen'))],
        [t('review.erased'), t('review.restore.erased')],
        [t('review.checked'), t('review.restore.checked')],
        [t('review.then'), task === 'armbian' ? t('review.restore.then.armbian') : t('review.restore.then.factory')],
      ]);
      if (!restoreReady) why = task === 'armbian' ? t('why.restore.armbian') : t('why.restore.factory');
      goLabel = t('go.connect');
    } else if (task === 'stick') {
      reviewRows = reviewRows.concat([
        [t('review.written'), releases?.winpe ? t('review.stick.written', { tag: releases.winpe.tier.label, file: releases.winpe.file }) : t('review.unavailable')],
        [t('review.erased'), stick ? t('review.stick.erased', { drive: drives?.find((x) => x.device === stick)?.description ?? stick }) : t('review.stick.choose')],
        [t('review.checked'), t('review.stick.checked')],
      ]);
      if (!stick) why = t('why.stick');
      goLabel = t('go.erase');
    } else {
      const tg = firmwareTargets(board).find((x) => x.id === task)!;
      reviewRows = reviewRows.concat([
        [t('review.firmware'), fwRelease ? `edk2-rk3576 ${releases!.firmware!.tier.label}, ${fwRelease.file}${tierWord(releases!.firmware!.tier)}` : t('review.unavailable')],
        [t('review.written'), tg.slice ? t('review.fw.slice', { a: tg.slice[0], b: tg.slice[1], lba: tg.lba }) : t('review.fw.whole', { lba: tg.lba })],
        [t('review.erased'), fwText(board, tg, 'erases')],
        [t('review.checked'), onBoard ? t('review.checked.fw.here') : board.spi ? t('review.checked.fw.spi') : t('review.checked.fw.maskrom')],
        [t('review.then'), fwText(board, tg, 'done')],
      ]);
      if (fwRelease) reviewRows.splice(2, 0, ...fwFeatureRow());
      if (!fwRelease) why = t('why.firmware');
      if (onBoard && board.firmwareStorage === 'emmc' && here?.emmcRefusal) why = msg(here.emmcRefusal);
      if (onBoard && board.firmwareStorage === 'spinor' && !here?.mtd.length) why = t('why.mtd');
      goLabel = onBoard ? t('go.erase') : t('go.connect');
    }
  }

  const erases = task !== 'upgrade';
  const askTitle = !board || !task ? '' : driveTask ? t('ask.drive.title') : restoreTask ? t('ask.restore.title') : task === 'stick' ? t('ask.stick.title')
    : hybridSdEmmc ? t('ask.hybridSd.emmc.title') : hybridSd ? t('ask.hybridSd.title') : onPc ? t('ask.disk.title') : task === 'windows' && method === 'host' ? t('ask.host.title')
    : onBoard ? t('ask.here.title', { storage: storageWord(board, task) }) : t('ask.connect.title');
  const askText = !board || !task ? '' : driveTask ? t('ask.drive.text', { drive: drives?.find((x) => x.device === stick)?.description ?? stick ?? '' })
    : restoreTask ? t('ask.restore.text')
    : task === 'stick' ? t('ask.stick.text')
    : hybridSdEmmc ? t('ask.hybridSd.emmc.text', { board: board.name, card: drives?.find((x) => x.device === sdDrive)?.description ?? sdDrive ?? '' })
    : hybridSd ? t('ask.hybridSd.text', { board: board.name, drive: drives?.find((x) => x.device === disk)?.description ?? disk ?? '', card: drives?.find((x) => x.device === sdDrive)?.description ?? sdDrive ?? '' })
    : onPc ? t('ask.disk.text', { drive: drives?.find((x) => x.device === disk)?.description ?? disk ?? '' })
      : task === 'windows' && method === 'host' ? t('ask.host.text')
    : onBoard ? `${here?.emmc && (task === 'windows' || board.firmwareStorage === 'emmc') ? `${here.emmc.model}, ${here.emmc.device}, ${GB(here.emmc.bytes)}. ` : ''}${task === 'windows' ? t('ask.here.windows') : ''}${t('ask.here.password')}`
      : t('ask.connect.text');

  const reviewStep = (
    <StepPage title={t('step.review')}>
      <Review rows={reviewRows} />
      {onPc && (
        <FormGroup role="radiogroup" fieldId="disk" label={t(`review.drive.${dest}`)} isStack>
          {drives === null ? <Content component="p">{t('review.usb.looking')}</Content>
            : diskChoices.length === 0 ? <Content component="p">{t('review.drive.none')}</Content>
              : diskChoices.map((x) => (
                <Radio key={x.device} id={`disk-${x.device}`} name="disk" isChecked={disk === x.device} isDisabled={hybridSd && sdDrive === x.device}
                  onChange={() => setDisk(x.device)} label={`${x.description} (${formatBytes(x.size)})`} description={x.device} />
              ))}
          <Button variant="link" isInline onClick={refreshDisks}>{t('refresh')}</Button>
        </FormGroup>
      )}
      {/* ROCK 4D and CM5-IO: the SD card Armbian goes onto (beside the NVMe drive, or alone with Windows on the eMMC). */}
      {hybridSd && (
        <FormGroup role="radiogroup" fieldId="sd-drive" label={t('review.drive.armbianSd')} isStack>
          {drives === null ? <Content component="p">{t('review.usb.looking')}</Content>
            : drives.length === 0 ? <Content component="p">{t('review.usb.none')}</Content>
              : drives.map((x) => {
                const small = !!hybridChoice?.minBytes && x.size < hybridChoice.minBytes;
                const taken = x.device === disk;
                return (
                  <Radio key={x.device} id={`sd-${x.device}`} name="sd-drive" isChecked={sdDrive === x.device && !small && !taken} isDisabled={small || taken}
                    onChange={() => setSdDrive(x.device)} label={`${x.description} (${formatBytes(x.size)})`}
                    description={taken ? t('drive.forWindows', { device: x.device }) : small ? t('drive.tooSmall', { device: x.device, need: formatBytes(hybridChoice!.minBytes!) }) : x.device} />
                );
              })}
          <Button variant="link" isInline onClick={refreshDisks}>{t('refresh')}</Button>
        </FormGroup>
      )}
      {(task === 'stick' || driveTask) && (
        <FormGroup role="radiogroup" fieldId="stick" label={t(driveTask ? 'review.drive' : 'review.usb')} isStack>
          {drives === null ? <Content component="p">{t('review.usb.looking')}</Content>
            : drives.length === 0 ? <Content component="p">{t('review.usb.none')}</Content>
              : drives.map((x) => {
                const small = task === 'armbian' && !!armbianFound?.minBytes && x.size < armbianFound.minBytes;
                return (
                  <Radio key={x.device} id={`stick-${x.device}`} name="stick" isChecked={stick === x.device && !small} isDisabled={small} onChange={() => setStick(x.device)}
                    label={`${x.description} (${formatBytes(x.size)})`}
                    description={small ? t('drive.tooSmall', { device: x.device, need: formatBytes(armbianFound!.minBytes!) }) : x.device} />
                );
              })}
          <Button variant="link" isInline onClick={() => refreshDrives()}>{t('refresh')}</Button>
        </FormGroup>
      )}
      {maskromCard}
      {/* The one confirmation before starting (UX audit D5): what is erased, a box to tick, then the button below.
          A write over MaskROM still shows what the board itself reports before anything is written. */}
      {board && task && (
        <Alert isInline variant={erases ? 'warning' : 'info'} title={askTitle} id="review-erase">
          <Stack hasGutter>
            <Content component="p">{askText}</Content>
            {erases && <Checkbox id="review-understood" label={t('review.understand')} isChecked={understood} onChange={(_e, v) => setUnderstood(v)} />}
          </Stack>
        </Alert>
      )}
    </StepPage>
  );

  // --- Simple mode -------------------------------------------------------------
  const SIMPLE_TASKS: Task[] = ['windows', 'armbian', 'upgrade'];
  // Simple mode installs to the built-in storage: the boards with an eMMC.
  const SIMPLE_BOARDS: BoardId[] = WOA_BOARDS.filter((b) => b.emmc).map((b) => b.id);
  const advancedOnly = WOA_BOARDS.filter((b) => !b.emmc).map((b) => b.name).join(', ');
  /** What Advanced mode has set that Simple mode would put back to the recommended choice. */
  const nonDefaults = async (): Promise<string[]> => {
    const st = await api.getSettings();
    const out: string[] = [];
    if (boardId && !SIMPLE_BOARDS.includes(boardId)) out.push(t('mode.reset.board', { boards: advancedOnly }));
    if (task && !SIMPLE_TASKS.includes(task)) out.push(t('mode.reset.task'));
    if (layoutMode !== 'whole') out.push(t('mode.reset.layout'));
    if (st.firmwareChannel !== 'stable') out.push(t('mode.reset.tier'));
    if (restoreTo !== 'emmc' || dest !== 'emmc' || method !== 'stage') out.push(t('mode.reset.target'));
    if (armbianId && offerList.length && !simpleArmbianIds.includes(armbianId)) out.push(t('mode.reset.branch'));
    if (!keepSettings) out.push(t('mode.reset.keep'));
    if (via === 'here') out.push(t('mode.reset.here'));
    if (withArmbian) out.push(t('mode.reset.hybrid'));
    return out;
  };
  const toSimple = async () => {
    if (boardId && !SIMPLE_BOARDS.includes(boardId)) setBoardId(null);
    if (task && !SIMPLE_TASKS.includes(task)) setTask(null);
    setLayoutMode('whole'); setRestoreTo('emmc'); setDest('emmc'); setMethod('stage'); setWithArmbian(false);
    if (armbianId && offerList.length && !simpleArmbianIds.includes(armbianId)) setArmbianId(simpleArmbian.recommended); setKeepSettings(true); setVia('maskrom');
    const st = await api.getSettings();
    if (st.firmwareChannel !== 'stable') { await api.setSettings({ firmwareChannel: 'stable' }); api.releases(true).then(setReleases); }
    await api.setSettings({ uiMode: 'simple' });
    setModeState('simple');
  };
  const requestMode = async (m: UiMode) => {
    if (m === 'advanced') { await api.setSettings({ uiMode: 'advanced' }); setModeState('advanced'); return; }
    const list = await nonDefaults();
    if (list.length) setModeAsk(list); else await toSimple();
  };
  const simpleReady = task === 'windows' ? !!edition
    : task === 'armbian' ? !!armbianFound && !armbianTooBig
    : task === 'factory' ? !!factory && !factory.refuse
    : task === 'upgrade' ? upgradeReady : false;
  const [understood2, setUnderstood2] = useState(false);
  useEffect(() => { setUnderstood2(false); setUnderstood(false); }, [task, boardId, dest, disk, stick, method, restoreTo, sdDrive, withArmbian]);
  const term = (word: string, help: string) => (
    <>
      {word}{' '}
      <Popover bodyContent={help} aria-label={word}>
        <Button variant="plain" isInline aria-label={`${word}: ${t('s.help')}`} icon={<OutlinedQuestionCircleIcon />} className="term-help" />
      </Popover>
    </>
  );
  const simpleChoice = (id: Task, title: string, desc: string, disabled = false) => (
    <Radio key={id} id={`s-task-${id}`} name="s-task" label={title} description={desc} isChecked={task === id} isDisabled={disabled}
      onChange={() => { setTask(id); if (id === 'armbian') { setRestoreTo('emmc'); if (armbianId && offerList.length && !simpleArmbianIds.includes(armbianId)) setArmbianId(simpleArmbian.recommended); } }} />
  );
  const simpleBoardStep = (
    <StepPage title={t('s.step.board')} lead={t('s.board.lead')}>
      <Gallery hasGutter minWidths={{ default: '14rem' }}>
        {SIMPLE_BOARDS.map((id) => {
          const b = woaBoard(id)!;
          return (
            <Card key={id} id={`s-board-${id}`} isSelectable isSelected={boardId === id} isCompact>
              <CardHeader selectableActions={{ selectableActionId: `s-board-input-${id}`, selectableActionAriaLabelledby: `s-board-${id}`, name: 's-board',
                variant: 'single', onChange: () => { setBoardId(id); setVia('maskrom'); }, isChecked: boardId === id }}>
                <CardTitle>{b.name}</CardTitle>
              </CardHeader>
              {/* The card is labelled by its whole text; the title already names the board, so the photo adds no words. */}
              <CardBody><img src={`resources/boards/${id}.png`} alt="" className="board-photo" /></CardBody>
            </Card>
          );
        })}
      </Gallery>
      <Content component="p" className="muted">{t('s.board.advanced', { boards: advancedOnly })}</Content>
    </StepPage>
  );
  const simpleWhatStep = board && (
    <StepPage title={t('s.step.what')} lead={t('s.what.lead', { board: board.name })}>
      <Form onSubmit={(e) => e.preventDefault()}>
        <FormGroup role="radiogroup" fieldId="s-task" aria-label={t('s.step.what')} isStack>
          {simpleChoice('windows', t('s.what.windows'), t('s.what.windows.desc'), !board.emmc)}
          {simpleChoice('armbian', t('s.what.armbian'), t('s.what.armbian.desc'), !ARMBIAN_RESTORE[board.id])}
          {/* The factory restore is in Advanced mode only until it has run on a board (UX audit D1). */}
          {simpleChoice('upgrade', t('s.what.upgrade'), t('s.what.upgrade.desc'), board.firmwareStorage !== 'emmc')}
        </FormGroup>
        {task === 'windows' && (
          <FormGroup fieldId="s-win" label={t('s.windows.label')}>
            <Flex><FlexItem><Button id="s-win" variant="secondary" onClick={() => chooseWindows(() => api.pickWindows())}>{t('s.windows.choose')}</Button></FlexItem></Flex>
            <FormHelperText><HelperText>
              {windowsError ? <HelperTextItem variant="error">{t('s.windows.bad')} {windowsError}</HelperTextItem>
                : windows && !edition ? <HelperTextItem variant="error">{t('s.windows.bad')} {windows.refuse ? msg(windows.refuse) : checkText(windows.editions[0])}</HelperTextItem>
                : edition ? <HelperTextItem variant="success">{t('s.windows.ok', { edition: edition.name, release: (edition.release ?? String(edition.build)).replace(/^Windows 1[01] /, '') })}</HelperTextItem>
                : <HelperTextItem>{t('win.24h2.text')}</HelperTextItem>}
              {edition?.warn && <HelperTextItem variant="warning">{checkText(edition)}</HelperTextItem>}
            </HelperText></FormHelperText>
            <ExpandableSection toggleText={t('win.get')} className="sources">
              <Content component="p">{t('win.get.text')}</Content>
              <DescriptionList isCompact>
                {WINDOWS_SOURCES.filter((src) => src.fits).map((src) => (
                  <DescriptionListGroup key={src.id}>
                    <DescriptionListTerm><Button variant="link" isInline component="a" href={src.url} target="_blank">{src.title[lang]}</Button>
                      {src.recommended && <span className="muted"> ({src.recommended[lang]})</span>}</DescriptionListTerm>
                    <DescriptionListDescription>{src.text[lang]}</DescriptionListDescription>
                  </DescriptionListGroup>
                ))}
              </DescriptionList>
            </ExpandableSection>
          </FormGroup>
        )}
        {task === 'windows' && (
          <FormGroup fieldId="s-trim" label={t('trim.label')} isStack>
            <Switch id="s-trim" label={t('trim.simple')} isChecked={trimSimple} onChange={(_e, v) => setTrimSimple(v)} />
            <FormHelperText><HelperText><HelperTextItem>{t('trim.simple.desc')}</HelperTextItem></HelperText></FormHelperText>
            {toolsGroup}
            <Content component="p" id="s-drivers">{packageThere ? t('s.drivers', { board: board?.name ?? '' }) : t('setup.drivers.winpe')}</Content>
          </FormGroup>
        )}
        {task === 'armbian' && (
          <FormGroup fieldId="s-armbian" role="radiogroup" label={t('s.armbian.label')}>
            {armbianOffers === 'looking' && <Content component="p">{t('s.armbian.looking')}</Content>}
            {armbianOffers && typeof armbianOffers === 'object' && 'error' in armbianOffers && <Content component="p">{errorText(armbianOffers.error)}</Content>}
            {offerList.length > 0 && (
              <Gallery hasGutter minWidths={{ default: '12rem' }}>
                {[...simpleArmbian.desktops, ...(simpleArmbian.cli ? [simpleArmbian.cli] : [])].map((o) => {
                  const pic = o.desktop ? DESKTOPS[o.variant]?.picture : undefined;
                  const title = o.desktop
                    ? t(o.id === simpleArmbian.recommended ? 's.armbian.desktop.recommended' : 's.armbian.desktop', { name: variantWords(o.variant) })
                    : t('s.armbian.cli');
                  const line = o.desktop ? (t(`s.desk.${o.variant}`) === `s.desk.${o.variant}` ? t('s.desk.other') : t(`s.desk.${o.variant}`)) : t('s.armbian.cli.desc');
                  return (
                    <Card key={o.id} id={`s-armbian-${o.id}`} isSelectable isSelected={armbianId === o.id} isCompact>
                      <CardHeader selectableActions={{ selectableActionId: `s-armbian-input-${o.id}`, selectableActionAriaLabelledby: `s-armbian-${o.id}`, name: 's-armbian',
                        variant: 'single', onChange: () => setArmbianId(o.id), isChecked: armbianId === o.id }}>
                        <CardTitle>{title}</CardTitle>
                      </CardHeader>
                      <CardBody>
                        <Stack hasGutter>
                          {pic ? <img src={`resources/desktops/${pic}`} alt={t('s.armbian.picture', { name: variantWords(o.variant) })} className="desktop-picture" />
                            : <div className={`desktop-picture desktop-plain${o.desktop ? '' : ' desktop-cli'}`} aria-hidden="true">{o.desktop ? variantWords(o.variant) : '$ _'}</div>}
                          <Content component="small">{line}</Content>
                          <Content component="small" className="muted">{t('s.armbian.size', { size: formatBytes(o.size) })}</Content>
                        </Stack>
                      </CardBody>
                    </Card>
                  );
                })}
              </Gallery>
            )}
            <FormHelperText><HelperText><HelperTextItem>
              {armbianFound ? t('s.armbian.info', { version: armbianFound.version, kernel: armbianFound.kernel, distro: distroWords(armbianFound.distro),
                need: armbianFound.minBytes ? formatBytes(armbianFound.minBytes) : '?' })
                : armbian && typeof armbian === 'object' && 'error' in armbian ? errorText(armbian.error) : armbian === 'looking' ? t('s.armbian.checking') : ''}
            </HelperTextItem></HelperText></FormHelperText>
          </FormGroup>
        )}
        {task === 'upgrade' && (
          <FormGroup fieldId="s-upgrade" label={t('s.what.upgrade')}>
            <Content component="p">{upgradeReady ? t('s.upgrade.info', { version: upgrade.version ?? upgrade.origin }) : upgradeError ?? t('s.upgrade.loading')}</Content>
          </FormGroup>
        )}
      </Form>
      <Content component="p" className="muted">{t('s.more')}</Content>
    </StepPage>
  );
  const eraseText = task === 'windows' ? t('s.erase.windows') : task === 'upgrade' ? t('s.erase.upgrade') : t('s.erase.all');
  // s.ready.<board>.1, .2, ... as many as messages.ts has.
  const readySteps = (id: BoardId): string[] => {
    const out: string[] = [];
    for (let n = 1; ; n++) { const k = `s.ready.${id}.${n}`; const v = t(k); if (v === k) return out; out.push(v); }
  };
  const simpleReadyStep = board && (
    <StepPage title={t('s.step.ready')} lead={t('s.ready.lead')}>
      <MaskromLive board={board.name} />
      <Card isPlain>
        <CardTitle>{term(t('s.ready.title'), t('s.ready.term.help'))}</CardTitle>
        <CardBody>
          <Stack hasGutter>
            <List component="ol" type={OrderType.number}>
              {readySteps(board.id).map((text) => <ListItem key={text}>{text}</ListItem>)}
            </List>
            <Content component="p">{t('s.ready.cable')}</Content>
            {board.maskromEntry === 'pads' && <img src={`resources/boards/${board.id}-maskrom.jpg`} alt={t('s.ready.photo')} className="maskrom-photo" />}
            <DriversNote />
          </Stack>
        </CardBody>
      </Card>
      <Alert isInline variant={erases ? 'warning' : 'info'} title={t(erases ? 's.erase.title' : 's.erase.none.title')}>{eraseText}</Alert>
    </StepPage>
  );
  const simpleFrom = task === 'windows' ? windows?.fileName : task === 'factory' ? factory?.fileName
    : task === 'armbian' ? armbianFound?.file : task === 'upgrade' && upgradeReady ? `edk2-rk3576 ${upgrade.version ?? upgrade.origin}` : '';
  const simpleConfirmStep = board && task && (
    <StepPage title={t('s.step.confirm')} lead={t('s.confirm.lead')}>
      <Review rows={[
        [t('s.confirm.board'), board.name],
        [t('s.confirm.what'), t(`s.what.${task}`)],
        [t('s.confirm.file'), simpleFrom ?? ''],
        [t('s.confirm.erased'), eraseText],
        [t('s.confirm.checked'), t('s.confirm.checked.value')],
        ...(task === 'windows' ? [[t('s.confirm.time'), t('s.time.windows')] as [string, string]]
          : task === 'armbian' && armbianFound ? [[t('s.confirm.time'), t('s.time.armbian', { size: formatBytes(armbianFound.size) })] as [string, string]] : []),
        [t('s.confirm.after'), t(`s.after.${task}`)],
      ]} />
      {erases && <Checkbox id="s-understand" label={t('s.understand')} isChecked={understood2} onChange={(_e, v) => setUnderstood2(v)} />}
    </StepPage>
  );
  const simpleWizard = (
    <Wizard navAriaLabel={t('steps')} isVisitRequired startIndex={wizardStart}>
      <WizardStep name={t('s.step.board')} id="s-board" footer={{ isNextDisabled: !board || !SIMPLE_BOARDS.includes(board.id), isCancelHidden: true, isBackHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{simpleBoardStep}</WizardStep>
      <WizardStep name={t('s.step.what')} id="s-what" isDisabled={!board} footer={{ isNextDisabled: !task || !SIMPLE_TASKS.includes(task) || !simpleReady, isCancelHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{simpleWhatStep}</WizardStep>
      <WizardStep name={t('s.step.ready')} id="s-ready" isDisabled={!simpleReady} footer={{ isCancelHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{simpleReadyStep}</WizardStep>
      <WizardStep name={t('s.step.confirm')} id="s-confirm" isDisabled={!simpleReady}
        footer={<ReviewFooter label={t('s.start')} disabled={!simpleReady || (erases && !understood2)} why={null} onGo={() => { setUnderstood2(false); start(); }} />}>
        {simpleConfirmStep}
      </WizardStep>
    </Wizard>
  );

  const windowsNeeded = task === 'windows';
  const lastStep = mode === 'simple' ? 4 : 3 + (windowsNeeded ? 2 : 0) + (task === 'upgrade' ? 1 : 0) + (restoreTask ? 1 : 0);
  // Opened at the last step once; afterwards the wizard starts at the first step as before.
  useEffect(() => {
    if (run || wizardStart === 1) return undefined;
    const id = setTimeout(() => setWizardStart(1), 0);
    return () => clearTimeout(id);
  }, [run, wizardStart]);
  const c = run?.confirm;
  const confirmText = c && (c.kind === 'upgrade' ? (
    <Review rows={[
      [t('confirm.upgrade.emmc'), `${c.manufacturer ?? '?'}, ${c.capacity ? `${GB(c.capacity)} (${c.capacity / 512} ${t('confirm.sectors')})` : t('confirm.storage.unknown')}`],
      [t('confirm.upgrade.versions'), t('confirm.upgrade.versions.value', { installed: c.installed ?? t('upgrade.noVersion'), next: c.next ?? t('upgrade.noVersion') })],
      [t('confirm.write'), t('confirm.upgrade.write', { lba: c.lba, size: formatBytes(c.bytes) })],
      [t('review.upgrade.kept'), c.settings === 'kept' ? t('confirm.upgrade.kept', { path: c.backup ?? '' }) : c.settings === 'none' ? t('confirm.upgrade.none') : t('review.upgrade.kept.reset')],
    ]} />
  ) : c.kind === 'whole' ? (
    <Review rows={[
      [t('confirm.write'), t('confirm.restore.whole', { label: armbianFound?.file ?? c.label, size: formatBytes(c.bytes) })],
      [t('confirm.storage'), c.capacity ? GB(c.capacity) : t('confirm.storage.unknown')],
      [t('review.erased'), t('review.restore.erased')],
    ]} />
  ) : c.kind === 'factory' ? (
    <Review rows={[
      [t('confirm.write'), t('confirm.restore.factory', { n: c.partitions.length, model: c.model, version: c.version, size: formatBytes(c.bytes) })],
      [t('restore.factory.parts'), c.partitions.map((p) => `${p.name} @ ${p.lba}`).join(', ')],
      [t('confirm.storage'), c.capacity ? GB(c.capacity) : t('confirm.storage.unknown')],
      [t('review.erased'), t('review.restore.erased')],
    ]} />
  ) : c.kind === 'stage' ? (
    <Stack hasGutter>
      <Content component="p">{t('confirm.answered', { size: GB(c.capacity) })}</Content>
      <Review rows={[
        [t('confirm.kept'), t('confirm.kept.value')],
        [t('confirm.removed'), c.removed.length ? c.removed.map((p) => `${p.name} (${GB(p.bytes)})`).join(', ') : t('confirm.removed.none')],
        [t('confirm.windowsGets'), c.chosen && c.layout ? t('confirm.windowsGets.chosen', {
          size: GB(c.windowsBytes), win: GB(c.layout.windowsBytes),
          data: c.layout.data ? t('confirm.layout.data', { size: GB(c.layout.data.bytes), fs: c.layout.data.fs === 'ntfs' ? 'NTFS' : 'exFAT', label: c.layout.data.label }) : '',
          free: c.layout.unallocatedBytes >= 512 * MiB ? t('confirm.layout.free', { size: GB(c.layout.unallocatedBytes) }) : '',
        }) : t('confirm.windowsGets.value', { size: GB(c.windowsBytes) })],
        ...(c.armbian ? [[t('confirm.armbian'), t('confirm.armbian.value', { size: GB(c.armbian.bytes), file: c.armbian.label })] as [string, string]] : []),
        [t('confirm.sent'), formatBytes(c.totalBytes)],
      ]} />
    </Stack>
  ) : (
    <Review rows={[
      [t('confirm.write'), t('confirm.write.value', { target: c.target, size: formatBytes(c.bytes), lba: c.lba })],
      [t('confirm.storage'), c.capacity ? (c.spi ? `${t('storage.spinor')}, ${formatBytes(c.capacity)}` : GB(c.capacity)) : t('confirm.storage.unknown')],
      ...(c.spi ? [
        [t('confirm.spi.next'), c.spi.next ?? t('confirm.spi.unknown')] as [string, string],
        [t('confirm.spi.settings'), t(`confirm.spi.settings.${c.spi.settings}`)] as [string, string],
      ] : []),
      ...(c.dropped.length ? [[t('confirm.dropped'), c.dropped.map((p) => `${p.name} (${GB(p.bytes)})`).join(', ')] as [string, string]] : []),
    ]} />
  ));

  return (
    <Shell onSettings={() => setSettings(true)} mode={run ? null : mode} onMode={requestMode}>
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
            {!run.result && !run.confirm && <Content component="p" className="step-lead">{t('run.keep')}</Content>}
            {/* The one thing the run waits for comes first, above the progress. */}
            {run.confirm && (
              <Card>
                <CardTitle>{t(c?.kind === 'upgrade' ? 'confirm.title.upgrade' : 'confirm.title')}</CardTitle>
                <CardBody>
                  <Stack hasGutter>
                    {confirmText}
                    {run.backup && <Content component="p" className="muted">{t(board?.spi ? 'backup.where.spinor' : 'backup.where', { path: run.backup })}</Content>}
                    <ActionList>
                      <ActionListGroup>
                        <ActionListItem><Button variant={c?.kind === 'upgrade' ? 'primary' : 'danger'} onClick={() => answer(true)}>{t(c?.kind === 'upgrade' ? 'go.upgrade' : 'go.erase')}</Button></ActionListItem>
                        <ActionListItem><Button variant="secondary" onClick={() => answer(false)}>{t('confirm.stop')}</Button></ActionListItem>
                      </ActionListGroup>
                    </ActionList>
                  </Stack>
                </CardBody>
              </Card>
            )}
            <ProgressList stages={run.stages} waiting={t('run.waiting')} />
            {run.result && (
              <Alert isInline variant={run.result.ok ? 'success' : 'danger'} title={run.result.title}>
                {run.result.text && <p>{run.result.text}</p>}
                {run.result.detail && <p className="detail">{run.result.detail}</p>}
                {run.backup && <p>{t(board?.spi ? 'backup.where.spinor' : 'backup.where', { path: run.backup })}</p>}
              </Alert>
            )}
            {run.result?.ok && run.result.next && (
              <Card>
                <CardTitle>{t('next.title')}</CardTitle>
                <CardBody><List component="ol" type={OrderType.number}>{run.result.next.map((n) => <ListItem key={n}>{n}</ListItem>)}</List></CardBody>
              </Card>
            )}
            {run.result?.help === 'gone' && board && (
              <Card>
                <CardTitle>{t('gone.title')}</CardTitle>
                <CardBody>
                  <Stack hasGutter>
                    <Content component="p">{t('gone.text')}</Content>
                    <List component="ol" type={OrderType.number}>{maskromSteps(board).map((x) => <ListItem key={x}>{x}</ListItem>)}</List>
                    <MaskromLive board={board.name} />
                    <Content component="p">{t('gone.retry')}</Content>
                  </Stack>
                </CardBody>
              </Card>
            )}
            {run.result?.help === 'noBoard' && (
              <Card>
                <CardTitle>{t('noboard.title')}</CardTitle>
                <CardBody>
                  <List>
                    <ListItem>{t('noboard.mode')}</ListItem>
                    <ListItem>{t('noboard.cable')}</ListItem>
                    {api.platform === 'win32' && <ListItem>{t('noboard.windows')}</ListItem>}
                    {api.platform === 'linux' && <ListItem>{t('noboard.linux')}</ListItem>}
                    <ListItem>{t('noboard.one')}</ListItem>
                  </List>
                </CardBody>
              </Card>
            )}
            <StackItem>
              {!run.result ? <Button variant="secondary" onClick={() => setStopAsk(true)}>{t('cancel')}</Button>
                : run.result.ok ? <Button variant="primary" onClick={() => closeRun()}>{t('done')}</Button>
                : (
                  <ActionList>
                    <ActionListGroup>
                      <ActionListItem><Button variant="primary" onClick={() => closeRun(true)}>{t('run.again')}</Button></ActionListItem>
                      <ActionListItem><Button variant="secondary" onClick={() => closeRun()}>{t('run.backToSteps')}</Button></ActionListItem>
                    </ActionListGroup>
                    <ActionListGroup>
                      <ActionListItem><Button variant="link" id="report-problem" onClick={() => { api.reportProblem(reportFacts()).catch(() => {}); }}>{t('report.open')}</Button></ActionListItem>
                      <ActionListItem><Button variant="link" id="save-log" onClick={() => { api.saveLog(reportFacts()).then((r) => { if (r && 'path' in r) addLog(t('report.saved', { path: r.path })); }).catch(() => {}); }}>{t('report.save')}</Button></ActionListItem>
                    </ActionListGroup>
                  </ActionList>
                )}
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
          {mode === 'simple' ? simpleWizard : mode === 'advanced' && <Wizard navAriaLabel={t('steps')} isVisitRequired startIndex={wizardStart}>
            <WizardStep name={t('step.board')} id="board" footer={{ isNextDisabled: !board, isCancelHidden: true, isBackHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{boardStep}</WizardStep>
            <WizardStep name={t('step.task')} id="task" isDisabled={!board} footer={{ isNextDisabled: !task, isCancelHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{taskStep}</WizardStep>
            {windowsNeeded && (<WizardStep name={t('step.windows')} id="windows" footer={{ isNextDisabled: !edition, isCancelHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{windowsStep}</WizardStep>)}
            {windowsNeeded && (<WizardStep name={t('step.setup')} id="setup" isDisabled={!edition} footer={{ isNextDisabled: !setupOk, isCancelHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{setupStep}</WizardStep>)}
            {task === 'upgrade' && (<WizardStep name={t('step.upgrade')} id="upgrade" footer={{ isNextDisabled: !upgradeReady, isCancelHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{upgradeStep}</WizardStep>)}
            {restoreTask && (<WizardStep name={t('step.restore')} id="restore" footer={{ isNextDisabled: !restoreReady, isCancelHidden: true, nextButtonText: t('next'), backButtonText: t('back') }}>{restoreStep}</WizardStep>)}
            <WizardStep name={t('step.review')} id="review" isDisabled={!task || (windowsNeeded && (!edition || !setupOk)) || (restoreTask && !restoreReady) || (task === 'upgrade' && !upgradeReady)}
              footer={<ReviewFooter label={goLabel} disabled={!!why || (erases && !understood)} why={why ?? (erases && !understood ? t('review.tick') : null)} onGo={() => { setUnderstood(false); start(); }} />}>
              {reviewStep}
            </WizardStep>
          </Wizard>}
        </PageSection>
      )}
      <SettingsModal open={settings} onClose={() => setSettings(false)} theme={theme} setTheme={setTheme}
        onOffer={(o) => setOffer(o)} onUpdate={() => { setSettings(false); setUpdating(true); }} writing={!!run && !run.result}
        onAbout={() => { setSettings(false); setAbout(true); }} onFirmwareChannel={() => api.releases(true).then(setReleases)}
        mode={mode} onMode={(m) => { setSettings(false); requestMode(m); }} />
      <Modal isOpen={!!modeAsk} onClose={() => setModeAsk(null)} variant="small" aria-labelledby="mode-title">
        <ModalHeader title={t('mode.reset.title')} labelId="mode-title" />
        <ModalBody><Stack hasGutter><Content component="p">{t('mode.reset.text')}</Content><List>{(modeAsk ?? []).map((x) => <ListItem key={x}>{x}</ListItem>)}</List></Stack></ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={() => { setModeAsk(null); toSimple(); }}>{t('mode.reset.go')}</Button>
          <Button variant="link" onClick={() => setModeAsk(null)}>{t('cancel')}</Button>
        </ModalFooter>
      </Modal>
      <Modal isOpen={stopAsk && running} onClose={() => setStopAsk(false)} variant="small" aria-labelledby="stop-title">
        <ModalHeader title={t('stop.title')} labelId="stop-title" />
        <ModalBody>{t('stop.text')}</ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={cancel}>{t('stop.go')}</Button>
          <Button variant="link" onClick={() => setStopAsk(false)}>{t('stop.stay')}</Button>
        </ModalFooter>
      </Modal>
      <AboutModal open={about} onClose={() => setAbout(false)} />
      {updating && <UpdateModal offer={offer} onClose={() => setUpdating(false)} />}
    </Shell>
  );
}
