// Pieces of the page that came from Roxora Imager's App.tsx unchanged but
// for the names: the shell, step layout, copy blocks, the driver note, and
// the update and settings dialogs. Offer changes here back to Roxora Imager.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Alert, Button, Checkbox, CodeBlock, CodeBlockAction, CodeBlockCode, Content, DescriptionList,
  DescriptionListDescription, DescriptionListGroup, DescriptionListTerm, ExpandableSection, Flex, FlexItem, Form,
  FormGroup, FormHelperText, FormSection, HelperText, HelperTextItem, List, ListItem, OrderType, Masthead, Menu, MenuContent, MenuItem, MenuList, MastheadBrand, MastheadContent, MastheadLogo, MastheadMain, Modal, ModalBody, ModalFooter,
  MenuToggle, ModalHeader, Page, Progress, Select, SelectList, SelectOption, ProgressMeasureLocation, Spinner, Stack, StackItem, Switch, Title, ToggleGroup,
  ToggleGroupItem, Toolbar, ToolbarContent, ToolbarGroup, ToolbarItem,
} from '@patternfly/react-core';
import { CogIcon } from '@patternfly/react-icons/dist/esm/icons/cog-icon';
import { GlobeIcon } from '@patternfly/react-icons/dist/esm/icons/globe-icon';
import { SlidersHIcon } from '@patternfly/react-icons/dist/esm/icons/sliders-h-icon';
import { TimesIcon } from '@patternfly/react-icons/dist/esm/icons/times-icon';
import { formatBytes } from '../shared/format';
import type { ImagerApi } from '../shared/ipc';
import type { CacheInfo } from '../main/cache';
import { CHANNELS, type Channel } from '../shared/channel';
import { APT_COMMAND, type UpdateCheck, type UpdateOffer, type UpdateResult } from '../shared/update';
import type { Theme } from './theme';
import { useI18n } from './i18n';
import { LANG_NAMES, LANGS, type T } from '../shared/i18n';
import { WOA_BOARDS } from '../woa/boards';

declare global {
  interface Window { imager: ImagerApi }
}
export const api = window.imager;

/*
 * The page shell, laid out as Fedora's installer (anaconda-webui) does it:
 * a masthead, then one wizard that fills the rest of the window, its step
 * nav running the full height and its footer pinned to the bottom.
 */
export function Shell({ children, onSettings, mode, onMode }: {
  children: React.ReactNode; onSettings: () => void;
  /** Simple or Advanced, shown at md and wider; narrower, Settings has it. */
  mode?: UiMode | null; onMode?: (m: UiMode) => void;
}) {
  const { t, lang } = useI18n();
  const [langOpen, setLangOpen] = useState(false);
  const masthead = (
    <Masthead display={{ default: 'inline' }}>
      <MastheadMain>
        <MastheadBrand>
          <MastheadLogo component="span" className="brand">
            <img src="resources/woa-mark.svg" alt="" className="brand-mark" />
            <span className="brand-name">Maskrom Studio</span>
          </MastheadLogo>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <Toolbar isFullHeight isStatic>
          <ToolbarContent>
            <ToolbarGroup align={{ default: 'alignEnd' }}>
              {mode && onMode && (
                <ToolbarItem visibility={{ default: 'hidden', md: 'visible' }}>
                  <ModeMenu mode={mode} onMode={onMode} />
                </ToolbarItem>
              )}
              <ToolbarItem>
                <Button variant="plain" icon={<GlobeIcon />} aria-label={t('lang.dialog')} title={t('lang.dialog')}
                  onClick={() => setLangOpen(true)}>
                  <span lang={lang}>{LANG_NAMES[lang]}</span>
                </Button>
              </ToolbarItem>
              <ToolbarItem>
                <Button variant="plain" icon={<CogIcon />} onClick={onSettings}>{t('settings')}</Button>
              </ToolbarItem>
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>
      </MastheadContent>
    </Masthead>
  );
  return (
    <Page masthead={masthead} isContentFilled>
      {children}
      {langOpen && <LangModal onClose={() => setLangOpen(false)} />}
    </Page>
  );
}

/*
 * The language dialog, as Cockpit's "Display language" (shell-modals.jsx):
 * a small modal with a plain menu of the languages, each in its own
 * language, the current one selected, and Select / Cancel.
 */
function LangModal({ onClose }: { onClose: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [picked, setPicked] = useState(lang);
  const apply = () => { if (picked !== lang) setLang(picked); onClose(); };
  return (
    <Modal isOpen variant="small" onClose={onClose} aria-labelledby="lang-dialog-title" id="lang-dialog">
      <ModalHeader title={t('lang.dialog')} labelId="lang-dialog-title" />
      <ModalBody>
        <Menu isPlain isScrollable activeItemId={picked} selected={picked}
          onSelect={(_e, id) => setPicked(id as typeof lang)}>
          <MenuContent>
            <MenuList>
              {LANGS.map((l) => (
                <MenuItem key={l} itemId={l} isSelected={picked === l} lang={l}>{LANG_NAMES[l]}</MenuItem>
              ))}
            </MenuList>
          </MenuContent>
        </Menu>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={apply}>{t('lang.select')}</Button>
        <Button variant="link" onClick={onClose}>{t('cancel')}</Button>
      </ModalFooter>
    </Modal>
  );
}

/** One wizard step's content: title, optional lead, notices, then the step itself. */
export function StepPage({ title, lead, notices, children }: {
  title: string; lead?: React.ReactNode; notices?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <Stack hasGutter className="step">
      <StackItem>
        <Title headingLevel="h2">{title}</Title>
        {lead && <Content component="p" className="step-lead">{lead}</Content>}
      </StackItem>
      {notices}
      {children}
    </Stack>
  );
}

export function DriversNote() {
  const { t } = useI18n();
  if (api.platform === 'win32') {
    return (
      <>
        <Content component="p">{t('drivers.windows')}</Content>
        <List component="ol" type={OrderType.number}>
          <ListItem>{t('drivers.windows.1')}</ListItem>
          <ListItem>{t('drivers.windows.2')}{' '}
            <Button variant="link" isInline component="a" href="https://zadig.akeo.ie/" target="_blank">zadig.akeo.ie</Button></ListItem>
          <ListItem>{t('drivers.windows.3')}</ListItem>
          <ListItem>{t('drivers.windows.4')}</ListItem>
        </List>
      </>
    );
  }
  if (api.platform === 'linux') {
    return (
      <>
        <Content component="p">{t('drivers.linux')}</Content>
        <CopyBlock text={'echo \'SUBSYSTEM=="usb", ATTR{idVendor}=="2207", TAG+="uaccess"\' | sudo tee /etc/udev/rules.d/70-maskrom-studio.rules\nsudo udevadm control --reload-rules && sudo udevadm trigger'} />
      </>
    );
  }
  return <Content component="p">{t('drivers.mac')}</Content>;
}

/** Copy text: through the main process in the desktop app (the page has no clipboard permission), else the browser's clipboard. */
export function copyText(text: string): void {
  if (api.copyText) api.copyText(text).catch(() => {});
  else navigator.clipboard?.writeText(text).catch(() => {});
}

/**
 * Commands in a code block with a Copy button. The button itself says
 * "Copied" for a moment: feedback that does not depend on a tooltip.
 */
export function CopyBlock({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  const actions = (
    <CodeBlockAction>
      <Button variant="link" className="copy-button" aria-live="polite" onClick={() => { copyText(text); setCopied(true); }}>
        {copied ? t('copied') : t('copy')}
      </Button>
    </CodeBlockAction>
  );
  return <CodeBlock actions={actions}><CodeBlockCode>{text}</CodeBlockCode></CodeBlock>;
}

/** What pressing Update will do, by how this copy was installed. Shown before anything is downloaded. */
function updatePlan(o: UpdateOffer, t: T): string {
  const file = o.asset ? `${o.asset.name} (${formatBytes(o.asset.size)})` : '';
  switch (o.kind) {
    case 'brew': return t('update.plan.brew');
    case 'dmg': return t('update.plan.dmg', { file });
    case 'windows': return t('update.plan.windows', { file });
    case 'appimage': return t('update.plan.appimage', { file });
    case 'deb': case 'rpm': return t('update.plan.pkg', { file });
    default: return '';
  }
}

/* The update itself: nothing is downloaded before the button in here is pressed. */
export function UpdateModal({ offer, onClose }: { offer: UpdateOffer | null; onClose: () => void }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ bytes: number; total: number } | null>(null);
  const [stage, setStage] = useState('download');
  const [log, setLog] = useState('');
  const [result, setResult] = useState<UpdateResult | null>(null);
  useEffect(() => { setResult(null); setProgress(null); setLog(''); }, [offer?.version]);
  if (!offer) return null;
  const brew = offer.kind === 'brew';
  const apt = offer.kind === 'apt';
  const canInstall = !!api.installUpdate && !apt && (brew || (!!offer.asset && offer.kind !== 'none'));
  const start = async () => {
    setBusy(true);
    setResult(null);
    setLog('');
    setStage(brew ? 'brew-update' : 'download');
    setProgress({ bytes: 0, total: offer.asset?.size ?? 0 });
    const offs = [
      api.onUpdateProgress?.(setProgress), api.onUpdateStage?.(setStage),
      api.onUpdateLog?.((t) => setLog((cur) => (cur + t).slice(-20000))),
    ];
    const r = await api.installUpdate!();
    offs.forEach((off) => off?.());
    setBusy(false);
    setResult(r);
  };
  const close = () => { if (!busy) onClose(); };
  const notes = <Button variant="link" isInline component="a" href={offer.url} target="_blank">{t('update.notes')}</Button>;
  // Once the app itself is being replaced there is no stopping half way.
  const canCancel = stage === 'download' || stage === 'brew-update';
  return (
    <Modal isOpen onClose={close} variant="small" aria-labelledby="update-title">
      <ModalHeader title={t('update.title', { version: `${offer.version}${offer.beta ? ' (beta)' : ''}` })} labelId="update-title" />
      <ModalBody>
        <Stack hasGutter>
          {brew && !canInstall && (
            <>
              <Content component="p">{t('update.brewManual')}</Content>
              <CopyBlock text="brew upgrade --cask maskrom-studio" />
            </>
          )}
          {apt && (
            <>
              <Content component="p">{t('update.apt', { version: offer.version })}</Content>
              <CopyBlock text={APT_COMMAND} />
            </>
          )}
          {!brew && !apt && !canInstall && (
            <Content component="p">{t('update.cannot')}</Content>
          )}
          {canInstall && !busy && !result && <Content component="p">{updatePlan(offer, t)}</Content>}
          {busy && stage === 'download' && progress && (
            <Progress title={t('update.downloading', { name: offer.asset?.name ?? '' })} measureLocation={ProgressMeasureLocation.top}
              value={progress.total ? Math.min(100, Math.floor(progress.bytes * 100 / progress.total)) : 0}
              label={t('run.of', { done: formatBytes(progress.bytes), total: formatBytes(progress.total) })} />
          )}
          {busy && stage !== 'download' && (
            <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }} flexWrap={{ default: 'nowrap' }}>
              <FlexItem flex={{ default: 'flexNone' }}><Spinner size="md" aria-label={t('working')} /></FlexItem>
              <FlexItem>{t('update.working')}</FlexItem>
            </Flex>
          )}
          {result && (
            <Alert isInline variant={result.ok ? 'success' : 'danger'} title={result.ok ? result.message : result.reason} />
          )}
          {result && !result.ok && result.command && <CopyBlock text={result.command} />}
          {log && (
            <ExpandableSection toggleText={t('update.output')} className="log">
              <CodeBlock><CodeBlockCode>{log}</CodeBlockCode></CodeBlock>
            </ExpandableSection>
          )}
          <StackItem>{notes}</StackItem>
        </Stack>
      </ModalBody>
      <ModalFooter>
        {canInstall && !busy && !result && <Button variant="primary" onClick={start}>{t('update.install')}</Button>}
        {busy && canCancel && <Button variant="secondary" onClick={() => api.cancelUpdate?.()}>{t('cancel')}</Button>}
        {result?.ok && result.restart && <Button variant="primary" onClick={() => api.restartApp?.()}>{t('update.restart')}</Button>}
        {result && !result.ok && canInstall && <Button variant="secondary" onClick={start}>{t('update.retry')}</Button>}
        {!busy && <Button variant="link" onClick={close}>{result?.ok && result.restart ? t('update.later') : result || !canInstall ? t('close') : t('cancel')}</Button>}
      </ModalFooter>
    </Modal>
  );
}

/** The answer to "Check now", in a sentence. */
function checkWords(c: UpdateCheck, t: T): string {
  if (c.state === 'error') return c.message;
  if (c.state === 'newer') return t('update.newer', { version: `${c.offer.version}${c.offer.beta ? ' (beta)' : ''}` });
  return c.beta ? t('update.betaCurrent', { version: c.version }) : t('update.current', { version: c.version });
}

type AppSettings = { updateCheck: boolean; appChannel: Channel; firmwareChannel: Channel; resetAfterMaskrom: boolean };

export function SettingsModal({ open, onClose, theme, setTheme, onOffer, onUpdate, writing, onAbout, onFirmwareChannel, mode, onMode }: {
  mode?: UiMode | null; onMode?: (m: UiMode) => void;
  /** The firmware tier changed: the releases are read again. */
  onFirmwareChannel?: () => void;
  open: boolean; onClose: () => void; theme: Theme; setTheme: (t: Theme) => void;
  /** Open About Maskrom Studio. */
  onAbout?: () => void;
  /** A check found a newer version. */
  onOffer: (o: UpdateOffer) => void;
  /** The user wants it. */
  onUpdate: () => void;
  writing: boolean;
}) {
  const { t, lang, setLang, msg } = useI18n();
  const [s, setS] = useState<AppSettings | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [cache, setCache] = useState<CacheInfo | null>(null);
  const [clearAsk, setClearAsk] = useState(false);
  const [alsoNv, setAlsoNv] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  useEffect(() => { if (open) { api.getSettings().then(setS); setCheck(null); setCleared(null); api.cacheInfo().then(setCache); } }, [open]);
  const cacheBytes = cache ? cache.images.bytes + cache.loaders.bytes : 0;
  const doClear = async () => {
    const r = await api.clearCache({ nvdata: alsoNv });
    setClearAsk(false);
    setAlsoNv(false);
    setCleared(r.ok ? t('cache.freed', { size: formatBytes(r.freed) }) : msg(r.reason));
    api.cacheInfo().then(setCache);
  };
  const set = (patch: Partial<AppSettings>) => {
    setS((cur) => (cur ? { ...cur, ...patch } : cur));
    return api.setSettings(patch);
  };
  const checkNow = async () => {
    setChecking(true);
    const r = await api.checkUpdate(true);
    setChecking(false);
    setCheck(r);
    if (r?.state === 'newer') onOffer(r.offer);
  };
  return (
    <>
    <Modal isOpen={open} onClose={onClose} variant="small" aria-labelledby="settings-title">
      <ModalHeader title={t('settings')} labelId="settings-title" />
      <ModalBody>
        {s && (
          <Form onSubmit={(e) => e.preventDefault()}>
            {mode && onMode && (
              <FormSection title={t('mode.label')} titleElement="h3">
                <FormGroup fieldId="ui-mode" role="group" aria-label={t('mode.label')}>
                  <ModeToggle mode={mode} onMode={onMode} idPrefix="set-mode" />
                  <FormHelperText><HelperText><HelperTextItem>{t(`mode.${mode}.help`)}</HelperTextItem></HelperText></FormHelperText>
                </FormGroup>
              </FormSection>
            )}
            <FormSection title={t('settings.updates')} titleElement="h3">
              <FormGroup fieldId="set-update" label={t('settings.updateCheck.label')} hasNoPaddingTop>
                <Switch id="set-update" label={t('settings.updateCheck')} isChecked={s.updateCheck}
                  onChange={(_e, v) => { set({ updateCheck: v }); }} />
              </FormGroup>
              <FormGroup fieldId="app-channel" label={t('settings.tier')} role="group">
                <ChannelPicker id="app-channel" label={t('settings.tier')} value={s.appChannel}
                  onChange={(c) => { set({ appChannel: c }).then(checkNow); }} />
              </FormGroup>
              <FormGroup fieldId="check-now">
                <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
                  <FlexItem flex={{ default: 'flexNone' }}>
                    <Button id="check-now" variant="secondary" onClick={checkNow} isLoading={checking} isDisabled={checking}>{t('settings.checkNow')}</Button>
                  </FlexItem>
                  {check && <FlexItem className="update-result" aria-live="polite">{checkWords(check, t)}</FlexItem>}
                  {check?.state === 'newer' && (
                    <FlexItem><Button variant="link" isInline isDisabled={writing} onClick={onUpdate}>{t('settings.update')}</Button></FlexItem>
                  )}
                </Flex>
              </FormGroup>
            </FormSection>
            <FormSection title={t('settings.fwChannel')} titleElement="h3">
              <FormGroup fieldId="fw-channel" label={t('settings.tier')} role="group">
                <ChannelPicker id="fw-channel" label={t('settings.tier')} value={s.firmwareChannel} help={t('settings.fwChannel.help')}
                  onChange={(c) => { set({ firmwareChannel: c }).then(() => onFirmwareChannel?.()); }} />
              </FormGroup>
            </FormSection>
            <FormSection title={t('settings.maskrom')} titleElement="h3">
              <FormGroup fieldId="set-reset" label={t('settings.reset.label')} hasNoPaddingTop>
                <Switch id="set-reset" label={t('settings.reset')} isChecked={s.resetAfterMaskrom}
                  onChange={(_e, v) => { set({ resetAfterMaskrom: v }); }} />
              </FormGroup>
            </FormSection>
            <FormSection title={t('cache.label')} titleElement="h3">
              <FormGroup fieldId="clear-cache">
                <Content component="p">{cache ? t('cache.size', { size: formatBytes(cacheBytes), files: cache.images.files + cache.loaders.files }) : t('cache.looking')}</Content>
                <Flex><FlexItem>
                  <Button id="clear-cache" variant="secondary" isDisabled={writing || !cache || (cacheBytes === 0 && cache.nvdata.files === 0)} onClick={() => setClearAsk(true)}>{t('cache.clear')}</Button>
                </FlexItem></Flex>
                {(writing || cleared) && (
                  <FormHelperText><HelperText><HelperTextItem className="selectable">{writing ? t('cache.writing') : cleared}</HelperTextItem></HelperText></FormHelperText>
                )}
              </FormGroup>
            </FormSection>
            <FormSection title={t('settings.appearance')} titleElement="h3">
              <FormGroup fieldId="appearance" label={t('settings.theme')} role="group">
                <ToggleGroup aria-label={t('settings.appearance')} id="appearance">
                  {(['system', 'light', 'dark'] as Theme[]).map((th) => (
                    <ToggleGroupItem key={th} text={t(`settings.theme.${th}`)} isSelected={theme === th} onChange={() => setTheme(th)} />
                  ))}
                </ToggleGroup>
              </FormGroup>
              <FormGroup fieldId="language" label={t('settings.language')} role="group">
                <ToggleGroup aria-label={t('settings.language')} id="language">
                  {LANGS.map((l) => (
                    <ToggleGroupItem key={l} text={LANG_NAMES[l]} isSelected={lang === l} onChange={() => setLang(l)} />
                  ))}
                </ToggleGroup>
              </FormGroup>
            </FormSection>
            <FormSection title={t('settings.version')} titleElement="h3">
              <FormGroup fieldId="about-open">
                <Content component="p">{api.version}</Content>
                {onAbout && <Button id="about-open" variant="link" isInline onClick={onAbout}>{t('about.open')}</Button>}
              </FormGroup>
            </FormSection>
          </Form>
        )}
      </ModalBody>
      <ModalFooter><Button variant="primary" onClick={onClose}>{t('close')}</Button></ModalFooter>
    </Modal>
    {clearAsk && cache && (
      <Modal isOpen onClose={() => setClearAsk(false)} variant="small" aria-labelledby="clear-title">
        <ModalHeader title={t('cache.ask.title')} labelId="clear-title" />
        <ModalBody>
          <Stack hasGutter>
            {cacheBytes > 0 && <Content component="p">{t('cache.ask.text')}</Content>}
            {/* Only what is there: an empty kind is not listed. */}
            {cacheBytes > 0 && (
              <List>
                {cache.images.files > 0 && <ListItem>{t('cache.ask.images', { size: formatBytes(cache.images.bytes), files: cache.images.files, names: cache.images.names.join(', ') })}</ListItem>}
                {cache.loaders.files > 0 && <ListItem>{t('cache.ask.loaders', { size: formatBytes(cache.loaders.bytes), files: cache.loaders.files })}</ListItem>}
              </List>
            )}
            <Checkbox id="clear-nvdata" isChecked={alsoNv} onChange={(_e, v) => setAlsoNv(v)} isDisabled={cache.nvdata.files === 0}
              label={t('cache.ask.nvdata', { n: cache.nvdata.files })} description={t('cache.ask.nvdata.desc', { path: cache.nvdata.dir })} />
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={doClear} isDisabled={cacheBytes + (alsoNv ? cache.nvdata.bytes : 0) === 0}>{t('cache.ask.go', { size: formatBytes(cacheBytes + (alsoNv ? cache.nvdata.bytes : 0)) })}</Button>
          <Button variant="link" onClick={() => setClearAsk(false)}>{t('cancel')}</Button>
        </ModalFooter>
      </Modal>
    )}
    </>
  );
}


declare const __BUILD_COMMIT__: string;
declare const __BUILD_DATE__: string;
declare const __PATTERNFLY_VERSION__: string;
const BUILD = {
  commit: typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : 'unknown',
  date: typeof __BUILD_DATE__ === 'string' ? __BUILD_DATE__ : '',
  patternfly: typeof __PATTERNFLY_VERSION__ === 'string' ? __PATTERNFLY_VERSION__ : '',
};

/** The "Engineered by gahingwoo" badge, as gahingwoo.com's About this site has it. */
function CreditBadge() {
  return (
    <svg className="credit-badge" viewBox="14 0 346 110" role="img" aria-label="Engineered by gahingwoo">
      <g className="credit-badge__mark" transform="translate(14,19) scale(0.257143)">
        <rect x="0" y="0" width="350" height="70" />
        <rect x="70" y="70" width="70" height="70" />
        <rect x="210" y="70" width="70" height="70" />
        <rect x="0" y="210" width="350" height="70" />
      </g>
      <text className="credit-badge__label" x="124" y="48">Engineered by</text>
      <text className="credit-badge__name" x="123" y="88">gahingwoo</text>
    </svg>
  );
}

/**
 * About Maskrom Studio: PatternFly's about modal box with the facts of this
 * build, laid out as gahingwoo.com's "About this site". Every row has to be
 * true for the build that shows it.
 */
export function AboutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, lang } = useI18n();
  const close = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    close.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onClose]);
  if (!open) return null;
  const link = (href: string, text: string) => <a href={href} target="_blank" rel="noreferrer">{text}</a>;
  const rows: Array<[string, React.ReactNode]> = [
    [t('about.version'), t('about.version.value', { version: api.version, commit: BUILD.commit, date: BUILD.date })],
    [t('about.design'), `PatternFly ${BUILD.patternfly}`],
    [t('about.network'), <>{t('about.network.value')} {link(`https://github.com/gahingwoo/maskrom-studio/blob/${BUILD.commit}/docs/network.md`, t('about.details'))}</>],
    [t('about.kept'), <span className="selectable">{t('about.kept.value', { path: api.dataDir })}</span>],
    [t('about.images'), t('about.images.value')],
    [t('about.boards'), WOA_BOARDS.map((b) => b.name).join(lang === 'en' ? ', ' : '、')],
    [t('about.licence'), t('about.licence.value')],
    [t('about.pictures'), <>{t('about.pictures.value')} {link(`https://github.com/gahingwoo/maskrom-studio/blob/${BUILD.commit}/resources/desktops/README.md`, t('about.details'))}</>],
    [t('about.madeBy'), link('https://gahingwoo.com', 'Ga Hing Woo (Jiaxing Hu)')],
    [t('about.source'), link('https://github.com/gahingwoo/maskrom-studio', 'github.com/gahingwoo/maskrom-studio')],
    [t('report.open'), <Button variant="link" isInline id="about-report" onClick={() => { api.reportProblem({ mode: 'about' }).catch(() => {}); }}>{t('report.about')}</Button>],
    [t('about.basedOn'), <>{t('about.basedOn.value')} {link('https://github.com/roxora-os/imager', 'github.com/roxora-os/imager')}</>],
  ];
  // On the document body, as PatternFly's Modal does, so the backdrop covers the masthead too.
  return createPortal(
    <div className="pf-v6-c-backdrop about-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pf-v6-l-bullseye">
        <div className="pf-v6-c-about-modal-box" role="dialog" aria-modal="true" aria-labelledby="about-title">
          <div className="pf-v6-c-about-modal-box__brand"><CreditBadge /></div>
          <div className="pf-v6-c-about-modal-box__close">
            <Button ref={close} variant="plain" aria-label={t('about.close')} icon={<TimesIcon />} onClick={onClose} />
          </div>
          <div className="pf-v6-c-about-modal-box__header">
            <h1 className="pf-v6-c-title pf-m-2xl" id="about-title">{t('about.title')}</h1>
          </div>
          <div className="pf-v6-c-about-modal-box__content">
            <dl className="pf-v6-c-description-list pf-m-horizontal">
              {rows.map(([k, v]) => (
                <div className="pf-v6-c-description-list__group" key={k}>
                  <dt className="pf-v6-c-description-list__term"><span className="pf-v6-c-description-list__text">{k}</span></dt>
                  <dd className="pf-v6-c-description-list__description"><div className="pf-v6-c-description-list__text">{v}</div></dd>
                </div>
              ))}
            </dl>
            <p className="pf-v6-c-about-modal-box__strapline">{t('about.strapline')}</p>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Stable / Prerelease / CI, with what the chosen one means as the group's helper text. */
function ChannelPicker({ id, label, value, help, onChange }: { id: string; label: string; value: Channel; help?: string; onChange: (c: Channel) => void }) {
  const { t } = useI18n();
  const note = value === 'prerelease' ? t('tier.prerelease.desc') : value === 'ci' ? t('tier.ci.desc') : help;
  return (
    <>
      <ToggleGroup aria-label={label} id={id}>
        {CHANNELS.map((c) => <ToggleGroupItem key={c} text={t(`tier.${c}`)} isSelected={value === c} onChange={() => onChange(c)} />)}
      </ToggleGroup>
      {note && (
        <FormHelperText><HelperText><HelperTextItem variant={value === 'stable' ? 'default' : 'warning'}>{note}</HelperTextItem></HelperText></FormHelperText>
      )}
    </>
  );
}

export type UiMode = 'simple' | 'advanced';

/**
 * The masthead's mode choice: a plain toggle like the language and Settings buttons next to it, naming
 * the current mode, that opens a select with both modes and what each one shows.
 */
export function ModeMenu({ mode, onMode }: { mode: UiMode; onMode: (m: UiMode) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Select id="mode-menu" isOpen={open} selected={mode} onOpenChange={setOpen} popperProps={{ position: 'end' }}
      onSelect={(_e, v) => { setOpen(false); if (v !== mode) onMode(v as UiMode); }}
      toggle={(ref) => (
        <MenuToggle ref={ref} id="mode-toggle" variant="plainText" icon={<SlidersHIcon />} isExpanded={open} onClick={() => setOpen(!open)}
          aria-label={`${t('mode.label')}: ${t(`mode.${mode}.name`)}`}>
          {t(`mode.${mode}.name`)}
        </MenuToggle>
      )}>
      <SelectList aria-label={t('mode.label')}>
        {(['simple', 'advanced'] as UiMode[]).map((m) => (
          <SelectOption key={m} id={`mode-${m}`} value={m} isSelected={mode === m} description={t(`mode.${m}.help`)}>{t(`mode.${m}.name`)}</SelectOption>
        ))}
      </SelectList>
    </Select>
  );
}

/** Simple | Advanced in Settings: a choice between two modes, so a toggle group, as the theme choice there. */
export function ModeToggle({ mode, onMode, idPrefix = 'mode' }: { mode: UiMode; onMode: (m: UiMode) => void; idPrefix?: string }) {
  const { t } = useI18n();
  return (
    <ToggleGroup isCompact aria-label={t('mode.label')}>
      {(['simple', 'advanced'] as UiMode[]).map((m) => (
        <ToggleGroupItem key={m} text={t(`mode.${m}`)} buttonId={`${idPrefix}-${m}`} isSelected={mode === m} onChange={() => { if (mode !== m) onMode(m); }} />
      ))}
    </ToggleGroup>
  );
}
