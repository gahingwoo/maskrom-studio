// Pieces of the page that came from Roxora Imager's App.tsx unchanged but
// for the names: the shell, step layout, copy blocks, the driver note, and
// the update and settings dialogs. Offer changes here back to Roxora Imager.
import { useEffect, useState } from 'react';
import {
  Alert, Button, CodeBlock, CodeBlockAction, CodeBlockCode, Content, DescriptionList,
  DescriptionListDescription, DescriptionListGroup, DescriptionListTerm, ExpandableSection, Flex, FlexItem, Form,
  FormGroup, Masthead, MastheadBrand, MastheadContent, MastheadLogo, MastheadMain, Modal, ModalBody, ModalFooter,
  ModalHeader, Page, Progress, ProgressMeasureLocation, Spinner, Stack, StackItem, Switch, Title, ToggleGroup,
  ToggleGroupItem, Toolbar, ToolbarContent, ToolbarGroup, ToolbarItem,
} from '@patternfly/react-core';
import { CogIcon } from '@patternfly/react-icons/dist/esm/icons/cog-icon';
import { formatBytes } from '../shared/format';
import type { ImagerApi } from '../shared/ipc';
import { APT_COMMAND, type UpdateCheck, type UpdateOffer, type UpdateResult } from '../shared/update';
import type { Theme } from './theme';

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
                <Button variant="plain" icon={<CogIcon />} onClick={onSettings}>Settings</Button>
              </ToolbarItem>
            </ToolbarGroup>
          </ToolbarContent>
        </Toolbar>
      </MastheadContent>
    </Masthead>
  );
  return <Page masthead={masthead} isContentFilled>{children}</Page>;
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
  if (api.platform === 'win32') {
    return (
      <Content component="p">
        Windows needs the WinUSB driver for the board in Maskrom mode. Install it once with Zadig: choose the
        device with ID 2207 in Zadig's list, select WinUSB and click Install Driver.{' '}
        <Button variant="link" isInline component="a" href="https://zadig.akeo.ie/" target="_blank">zadig.akeo.ie</Button>
      </Content>
    );
  }
  if (api.platform === 'linux') {
    return (
      <>
        <Content component="p">
          The .deb and .rpm packages install a udev rule that lets you use the board without root. With the
          AppImage, add the rule once:
        </Content>
        <CopyBlock text={'echo \'SUBSYSTEM=="usb", ATTR{idVendor}=="2207", TAG+="uaccess"\' | sudo tee /etc/udev/rules.d/70-woa-rk3576-imager.rules\nsudo udevadm control --reload-rules && sudo udevadm trigger'} />
      </>
    );
  }
  return <Content component="p">macOS needs no driver.</Content>;
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
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(t);
  }, [copied]);
  const actions = (
    <CodeBlockAction>
      <Button variant="link" className="copy-button" aria-live="polite" onClick={() => { copyText(text); setCopied(true); }}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </CodeBlockAction>
  );
  return <CodeBlock actions={actions}><CodeBlockCode>{text}</CodeBlockCode></CodeBlock>;
}

/** What pressing Update will do, by how this copy was installed. Shown before anything is downloaded. */
function updatePlan(o: UpdateOffer): string {
  const file = o.asset ? `${o.asset.name} (${formatBytes(o.asset.size)})` : '';
  const checked = 'checks it against the SHA-256 GitHub lists for it';
  switch (o.kind) {
    case 'brew': return 'This copy was installed with Homebrew. WoA RK3576 Imager runs Homebrew for you: "brew update", then "brew upgrade --cask woa-rk3576-imager". You then restart the app.';
    case 'dmg': return `WoA RK3576 Imager downloads ${file} to your Downloads folder, ${checked}, and puts the new app in place of this one. You then restart the app.`;
    case 'windows': return `WoA RK3576 Imager downloads the installer ${file}, ${checked}, then closes and starts the installer.`;
    case 'appimage': return `WoA RK3576 Imager downloads ${file}, ${checked}, and puts it in place of the AppImage you are running. You then restart the app.`;
    case 'deb': case 'rpm': return `WoA RK3576 Imager downloads ${file}, ${checked}, and installs it with the system's package manager, which asks for your password. You then restart the app.`;
    default: return '';
  }
}

/* The update itself: nothing is downloaded before the button in here is pressed. */
export function UpdateModal({ offer, onClose }: { offer: UpdateOffer | null; onClose: () => void }) {
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
  const working: Record<string, string> = {
    'brew-update': 'Homebrew is looking for the new version',
    'brew-upgrade': 'Homebrew is installing the new version. Do not quit WoA RK3576 Imager.',
    install: 'Putting the new app in place. Do not quit WoA RK3576 Imager.',
  };
  return (
    <Modal isOpen onClose={close} variant="small" aria-labelledby="update-title">
      <ModalHeader title={`Update to WoA RK3576 Imager ${offer.version}${offer.beta ? ' (beta)' : ''}`} labelId="update-title" />
      <ModalBody>
        <Stack hasGutter>
          {brew && !canInstall && (
            <>
              <Content component="p">This copy was installed with Homebrew. Update it in Terminal with:</Content>
              <CopyBlock text="brew upgrade --cask woa-rk3576-imager" />
            </>
          )}
          {apt && (
            <>
              <Content component="p">
                This copy was installed from a package repository, and the system's software updates keep it up to date.
                WoA RK3576 Imager {offer.version} comes with them once the repository has it. To update now, in a terminal:
              </Content>
              <CopyBlock text={APT_COMMAND} />
            </>
          )}
          {!brew && !apt && !canInstall && (
            <Content component="p">
              The app cannot update this copy itself{offer.kind === 'none' ? '' : ': the release has no package for this computer'}.
              Get the new version from the release page.
            </Content>
          )}
          {canInstall && !busy && !result && <Content component="p">{updatePlan(offer)}</Content>}
          {busy && stage === 'download' && progress && (
            <Progress title={`Downloading ${offer.asset?.name ?? ''}`} measureLocation={ProgressMeasureLocation.top}
              value={progress.total ? Math.min(100, Math.floor(progress.bytes * 100 / progress.total)) : 0}
              label={`${formatBytes(progress.bytes)} of ${formatBytes(progress.total)}`} />
          )}
          {busy && stage !== 'download' && (
            <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }} flexWrap={{ default: 'nowrap' }}>
              <FlexItem flex={{ default: 'flexNone' }}><Spinner size="md" aria-label="Working" /></FlexItem>
              <FlexItem>{working[stage] ?? 'Installing'}</FlexItem>
            </Flex>
          )}
          {result && (
            <Alert isInline variant={result.ok ? 'success' : 'danger'} title={result.ok ? result.message : result.reason} />
          )}
          {result && !result.ok && result.command && <CopyBlock text={result.command} />}
          {log && (
            <ExpandableSection toggleText="Output" className="log">
              <CodeBlock><CodeBlockCode>{log}</CodeBlockCode></CodeBlock>
            </ExpandableSection>
          )}
          <StackItem>{notes}</StackItem>
        </Stack>
      </ModalBody>
      <ModalFooter>
        {canInstall && !busy && !result && <Button variant="primary" onClick={start}>{brew ? 'Update with Homebrew' : 'Download and install'}</Button>}
        {busy && canCancel && <Button variant="secondary" onClick={() => api.cancelUpdate?.()}>Cancel</Button>}
        {result?.ok && result.restart && <Button variant="primary" onClick={() => api.restartApp?.()}>Restart now</Button>}
        {result && !result.ok && canInstall && <Button variant="secondary" onClick={start}>Try again</Button>}
        {!busy && <Button variant="link" onClick={close}>{result?.ok && result.restart ? 'Later' : result || !canInstall ? 'Close' : 'Cancel'}</Button>}
      </ModalFooter>
    </Modal>
  );
}

/** The answer to "Check now", in a sentence. */
function checkWords(c: UpdateCheck): string {
  if (c.state === 'error') return c.message;
  if (c.state === 'newer') return `WoA RK3576 Imager ${c.offer.version}${c.offer.beta ? ' (beta)' : ''} is available.`;
  const beta = c.newerBeta ? ` A newer beta, ${c.newerBeta}, is out; turn on beta versions to be offered it.` : '';
  return (c.beta ? `You have ${c.version}, a beta version. There is no newer normal release yet.`
    : `You have the newest version (${c.version}).`) + beta;
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
      <ModalHeader title="Settings" labelId="settings-title" />
      <ModalBody>
        {s && (
          <Form onSubmit={(e) => e.preventDefault()}>
              <FormGroup label="Updates" fieldId="updates" role="group">
                <Stack hasGutter id="updates">
                  <Switch id="set-update" label="Check for a new version once a day" isChecked={s.updateCheck}
                    onChange={(_e, v) => { set({ updateCheck: v }); }} />
                  <Switch id="set-beta" label="Also offer beta versions (pre-releases)" isChecked={s.betaUpdates === true}
                    onChange={(_e, v) => { set({ betaUpdates: v }).then(checkNow); }} />
                  <Flex spaceItems={{ default: 'spaceItemsMd' }} alignItems={{ default: 'alignItemsCenter' }}>
                    <FlexItem flex={{ default: 'flexNone' }}>
                      <Button variant="secondary" onClick={checkNow} isLoading={checking} isDisabled={checking}>Check now</Button>
                    </FlexItem>
                    {check && <FlexItem className="update-result" aria-live="polite">{checkWords(check)}</FlexItem>}
                    {check?.state === 'newer' && (
                      <FlexItem><Button variant="link" isInline isDisabled={writing} onClick={onUpdate}>Update</Button></FlexItem>
                    )}
                  </Flex>
                </Stack>
              </FormGroup>
            <Switch id="set-reset" label="Restart the board after a Maskrom write" isChecked={s.resetAfterMaskrom}
              onChange={(_e, v) => { set({ resetAfterMaskrom: v }); }} />
            <FormGroup label="Appearance" fieldId="appearance" role="group">
              <ToggleGroup aria-label="Appearance" id="appearance">
                {(['system', 'light', 'dark'] as Theme[]).map((t) => (
                  <ToggleGroupItem key={t} text={t[0].toUpperCase() + t.slice(1)} isSelected={theme === t} onChange={() => setTheme(t)} />
                ))}
              </ToggleGroup>
            </FormGroup>
            <DescriptionList isCompact isHorizontal>
              <DescriptionListGroup><DescriptionListTerm>Version</DescriptionListTerm><DescriptionListDescription>{api.version}</DescriptionListDescription></DescriptionListGroup>
              <DescriptionListGroup><DescriptionListTerm>License</DescriptionListTerm><DescriptionListDescription>GPL-2.0</DescriptionListDescription></DescriptionListGroup>
              <DescriptionListGroup><DescriptionListTerm>Source</DescriptionListTerm><DescriptionListDescription>
                <Button variant="link" isInline component="a" href="https://github.com/gahingwoo/woa-rk3576-imager" target="_blank">github.com/gahingwoo/woa-rk3576-imager</Button>
              </DescriptionListDescription></DescriptionListGroup>
            </DescriptionList>
          </Form>
        )}
      </ModalBody>
      <ModalFooter><Button variant="primary" onClick={onClose}>Close</Button></ModalFooter>
    </Modal>
  );
}

