// Pieces of the page that came from Roxora Imager's App.tsx unchanged but
// for the names: the shell, step layout, copy blocks, the driver note, and
// the update and settings dialogs. Offer changes here back to Roxora Imager.
import { useEffect, useState } from 'react';
import {
  Alert, Button, CodeBlock, CodeBlockAction, CodeBlockCode, Content, DescriptionList,
  DescriptionListDescription, DescriptionListGroup, DescriptionListTerm, ExpandableSection, Flex, FlexItem, Form,
  FormGroup, Masthead, Menu, MenuContent, MenuItem, MenuList, MastheadBrand, MastheadContent, MastheadLogo, MastheadMain, Modal, ModalBody, ModalFooter,
  ModalHeader, Page, Progress, ProgressMeasureLocation, Spinner, Stack, StackItem, Switch, Title, ToggleGroup,
  ToggleGroupItem, Toolbar, ToolbarContent, ToolbarGroup, ToolbarItem,
} from '@patternfly/react-core';
import { CogIcon } from '@patternfly/react-icons/dist/esm/icons/cog-icon';
import { GlobeIcon } from '@patternfly/react-icons/dist/esm/icons/globe-icon';
import { formatBytes } from '../shared/format';
import type { ImagerApi } from '../shared/ipc';
import { APT_COMMAND, type UpdateCheck, type UpdateOffer, type UpdateResult } from '../shared/update';
import type { Theme } from './theme';
import { useI18n } from './i18n';
import { LANG_NAMES, LANGS, type T } from '../shared/i18n';

declare global {
  interface Window { imager: ImagerApi }
}
export const api = window.imager;

/*
 * The page shell, laid out as Fedora's installer (anaconda-webui) does it:
 * a masthead, then one wizard that fills the rest of the window, its step
 * nav running the full height and its footer pinned to the bottom.
 */
export function Shell({ children, onSettings }: { children: React.ReactNode; onSettings: () => void }) {
  const { t, lang } = useI18n();
  const [langOpen, setLangOpen] = useState(false);
  const masthead = (
    <Masthead display={{ default: 'inline' }}>
      <MastheadMain>
        <MastheadBrand>
          <MastheadLogo component="span" className="brand">
            <img src="resources/woa-mark.svg" alt="" className="brand-mark" />
            <span className="brand-name">WoA RK3576 Imager</span>
          </MastheadLogo>
        </MastheadBrand>
      </MastheadMain>
      <MastheadContent>
        <Toolbar isFullHeight isStatic>
          <ToolbarContent>
            <ToolbarGroup align={{ default: 'alignEnd' }}>
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
      <Content component="p">
        {t('drivers.windows')}{' '}
        <Button variant="link" isInline component="a" href="https://zadig.akeo.ie/" target="_blank">zadig.akeo.ie</Button>
      </Content>
    );
  }
  if (api.platform === 'linux') {
    return (
      <>
        <Content component="p">{t('drivers.linux')}</Content>
        <CopyBlock text={'echo \'SUBSYSTEM=="usb", ATTR{idVendor}=="2207", TAG+="uaccess"\' | sudo tee /etc/udev/rules.d/70-woa-rk3576-imager.rules\nsudo udevadm control --reload-rules && sudo udevadm trigger'} />
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
  const notes = <Button variant="link" isInline component="a" href={offer.url} target="_blank">Release notes</Button>;
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
              <CopyBlock text="brew upgrade --cask woa-rk3576-imager" />
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
              <FlexItem flex={{ default: 'flexNone' }}><Spinner size="md" aria-label="Working" /></FlexItem>
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

type AppSettings = { updateCheck: boolean; betaUpdates?: boolean; resetAfterMaskrom: boolean };

export function SettingsModal({ open, onClose, theme, setTheme, onOffer, onUpdate, writing }: {
  open: boolean; onClose: () => void; theme: Theme; setTheme: (t: Theme) => void;
  /** A check found a newer version. */
  onOffer: (o: UpdateOffer) => void;
  /** The user wants it. */
  onUpdate: () => void;
  writing: boolean;
}) {
  const { t, lang, setLang } = useI18n();
  const [s, setS] = useState<AppSettings | null>(null);
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => { if (open) { api.getSettings().then(setS); setCheck(null); } }, [open]);
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
    <Modal isOpen={open} onClose={onClose} variant="small" aria-labelledby="settings-title">
      <ModalHeader title={t('settings')} labelId="settings-title" />
      <ModalBody>
        {s && (
          <Form onSubmit={(e) => e.preventDefault()}>
              <FormGroup label={t('settings.updates')} fieldId="updates" role="group">
                <Stack hasGutter id="updates">
                  <Switch id="set-update" label={t('settings.updateCheck')} isChecked={s.updateCheck}
                    onChange={(_e, v) => { set({ updateCheck: v }); }} />
                  <Switch id="set-beta" label={t('settings.beta')} isChecked={s.betaUpdates === true}
                    onChange={(_e, v) => { set({ betaUpdates: v }).then(checkNow); }} />
                  <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
                    <FlexItem flex={{ default: 'flexNone' }}>
                      <Button variant="secondary" onClick={checkNow} isLoading={checking} isDisabled={checking}>{t('settings.checkNow')}</Button>
                    </FlexItem>
                    {check && <FlexItem className="update-result" aria-live="polite">{checkWords(check, t)}</FlexItem>}
                    {check?.state === 'newer' && (
                      <FlexItem><Button variant="link" isInline isDisabled={writing} onClick={onUpdate}>{t('settings.update')}</Button></FlexItem>
                    )}
                  </Flex>
                </Stack>
              </FormGroup>
            <Switch id="set-reset" label={t('settings.reset')} isChecked={s.resetAfterMaskrom}
              onChange={(_e, v) => { set({ resetAfterMaskrom: v }); }} />
            <FormGroup label={t('settings.appearance')} fieldId="appearance" role="group">
              <ToggleGroup aria-label={t('settings.appearance')} id="appearance">
                {(['system', 'light', 'dark'] as Theme[]).map((th) => (
                  <ToggleGroupItem key={th} text={t(`settings.theme.${th}`)} isSelected={theme === th} onChange={() => setTheme(th)} />
                ))}
              </ToggleGroup>
            </FormGroup>
            <FormGroup label={t('settings.language')} fieldId="language" role="group">
              <ToggleGroup aria-label={t('settings.language')} id="language">
                {LANGS.map((l) => (
                  <ToggleGroupItem key={l} text={LANG_NAMES[l]} isSelected={lang === l} onChange={() => setLang(l)} />
                ))}
              </ToggleGroup>
            </FormGroup>
            <DescriptionList isCompact isHorizontal>
              <DescriptionListGroup><DescriptionListTerm>{t('settings.version')}</DescriptionListTerm><DescriptionListDescription>{api.version}</DescriptionListDescription></DescriptionListGroup>
              <DescriptionListGroup><DescriptionListTerm>{t('settings.license')}</DescriptionListTerm><DescriptionListDescription>GPL-2.0</DescriptionListDescription></DescriptionListGroup>
              <DescriptionListGroup><DescriptionListTerm>{t('settings.source')}</DescriptionListTerm><DescriptionListDescription>
                <Button variant="link" isInline component="a" href="https://github.com/gahingwoo/woa-rk3576-imager" target="_blank">github.com/gahingwoo/woa-rk3576-imager</Button>
              </DescriptionListDescription></DescriptionListGroup>
            </DescriptionList>
          </Form>
        )}
      </ModalBody>
      <ModalFooter><Button variant="primary" onClick={onClose}>{t('close')}</Button></ModalFooter>
    </Modal>
  );
}

