// Trimming Windows while it is installed: what starts by itself on a 4 GB
// board with a slow eMMC and makes the first minutes slow. Everything is
// done offline, to the applied image, by woa-trim.cmd, which the shared
// CONFIGURE block (stage-scripts.ts) calls on the board in WinPE and on a
// Windows PC alike: DISM /Remove-ProvisionedAppxPackage for a list of apps,
// and values in the image's SOFTWARE, SYSTEM and default-user hives, almost
// all of them Microsoft's documented policies (Policy CSP and ADMX names
// in the comments). Chrome, when chosen, is installed on the first start by
// SetupComplete.cmd from Google's own MSI, downloaded on the PC at write
// time and checked there for its Authenticode signature (Google LLC).
//
// The lists are our own, written from Microsoft's documentation; nothing is
// taken from tiny11builder, whose repository carries no licence.
//
// Left alone on purpose: Windows Update, activation, the Store (unless its
// own option is chosen), Defender, WebView2, the drivers. Defender's
// real-time protection is not offered: on 22621/22631 Tamper Protection is
// on by default and makes Windows ignore DisableRealtimeMonitoring and
// DisableAntiSpyware, offline or not, so the option could not be kept.
//
// How to undo: docs/DESIGN.md ("Trimming Windows").

export interface TrimOptions {
  /** Inbox apps that start or update in the background: News, Weather, Teams, Phone Link, Clipchamp, ... */
  apps: boolean;
  /** OneDrive: not set up for new users, not started (DisableFileSyncNGSC). */
  onedrive: boolean;
  /** Copilot: TurnOffWindowsCopilot, and its app where the image has one. */
  copilot: boolean;
  /** Widgets: AllowNewsAndInterests 0. */
  widgets: boolean;
  /** Edge: no startup boost, no running in the background. */
  edgeBackground: boolean;
  /** Suggested and promoted apps, tips (CloudContent, ContentDeliveryManager). */
  suggestions: boolean;
  /** Diagnostic data at Required (AllowTelemetry 1, the lowest Pro honours). */
  telemetry: boolean;
  /** Search indexer: starts delayed instead of at boot (search still works). */
  searchDelayed: boolean;
  /** SysMain (Superfetch) off. */
  sysmain: boolean;
  /** Remove the Store and its purchase app (most inbox apps then cannot update). */
  removeStore: boolean;
  /** Remove Microsoft Edge (not WebView2) and stop Edge Update from installing it again. */
  removeEdge: boolean;
  /** Install Google Chrome (arm64, Google's MSI) on the first start and make it the default browser for new users. */
  chrome: boolean;
}

/** Nothing trimmed. */
export const NO_TRIM: TrimOptions = {
  apps: false, onedrive: false, copilot: false, widgets: false, edgeBackground: false, suggestions: false,
  telemetry: false, searchDelayed: false, sysmain: false, removeStore: false, removeEdge: false, chrome: false,
};

/**
 * The recommended set (Simple mode's switch, Advanced mode's starting
 * point): what only stops background work. Not the Store, not Edge, not
 * Chrome: those change what the user has.
 */
export const RECOMMENDED_TRIM: TrimOptions = {
  ...NO_TRIM, apps: true, onedrive: true, copilot: true, widgets: true, edgeBackground: true, suggestions: true,
  telemetry: true, searchDelayed: true, sysmain: true,
};

export const TRIM_KEYS = Object.keys(NO_TRIM) as Array<keyof TrimOptions>;

export function anyTrim(o: TrimOptions | undefined): boolean {
  return !!o && TRIM_KEYS.some((k) => o[k]);
}

/** Provisioned app packages removed by `apps`, by name (the part before the first underscore). */
export const TRIM_APPS = [
  'Clipchamp.Clipchamp',
  'Microsoft.549981C3F5F10', // Cortana
  'Microsoft.BingNews',
  'Microsoft.BingWeather',
  'Microsoft.GamingApp',
  'Microsoft.GetHelp',
  'Microsoft.Getstarted',
  'Microsoft.MicrosoftOfficeHub',
  'Microsoft.MicrosoftSolitaireCollection',
  'Microsoft.OutlookForWindows',
  'Microsoft.People',
  'Microsoft.PowerAutomateDesktop',
  'Microsoft.Todos',
  'Microsoft.WindowsFeedbackHub',
  'Microsoft.WindowsMaps',
  'Microsoft.YourPhone', // Phone Link, runs in the background
  'Microsoft.ZuneMusic',
  'Microsoft.ZuneVideo',
  'MicrosoftCorporationII.MicrosoftFamily',
  'MicrosoftTeams',
  'microsoft.windowscommunicationsapps', // Mail and Calendar
];
export const COPILOT_APPS = ['Microsoft.Copilot', 'Microsoft.Windows.Ai.Copilot.Provider'];
export const STORE_APPS = ['Microsoft.WindowsStore', 'Microsoft.StorePurchaseApp'];
/** The Edge package stub in the image; WebView2 is not an app package and is never touched. */
export const EDGE_APPS = ['Microsoft.MicrosoftEdge.Stable'];

/** Edge Update's application IDs (Microsoft Edge update policy documentation). */
export const EDGE_APP_ID = '{56EB18F8-B008-4CBD-B6D2-8C97FE7E9062}';
export const WEBVIEW2_APP_ID = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';

export const CHROME_MSI = {
  url: 'https://dl.google.com/chrome/install/googlechromestandaloneenterprise_arm64.msi',
  file: 'googlechromestandaloneenterprise_arm64.msi',
  /** Where it goes on the staging volume, and the defaults file next to it. */
  path: 'chrome/googlechromestandaloneenterprise_arm64.msi',
};

/**
 * DefaultAssociationsConfiguration (Policy CSP ApplicationDefaults): Chrome
 * for web pages, links and PDFs, applied to each new user at sign-in.
 */
export function chromeAssociations(): string {
  const a = (id: string) => `  <Association Identifier="${id}" ProgId="ChromeHTML" ApplicationName="Google Chrome" />`;
  return ['<?xml version="1.0" encoding="UTF-8"?>', '<DefaultAssociations>',
    ...['.htm', '.html', '.pdf', '.shtml', '.svg', '.webp', '.xht', '.xhtml', 'ftp', 'http', 'https'].map(a), '</DefaultAssociations>', ''].join('\r\n');
}

const reg = (key: string, name: string, type: 'REG_DWORD' | 'REG_SZ' | 'REG_EXPAND_SZ', data: string | number) =>
  `reg add "${key}" /v ${name} /t ${type} /d "${data}" /f >> "%LOG%" 2>&1`;

/** woa-trim.cmd: run with W: the applied Windows, %LOG% the log; never stops the install. */
export function trimCmd(o: TrimOptions): string {
  const SW = 'HKLM\\WOATRIMSW';
  const SY = 'HKLM\\WOATRIMSYS\\ControlSet00!CS!';
  const DU = 'HKLM\\WOATRIMDEF';
  const apps = [...(o.apps ? TRIM_APPS : []), ...(o.copilot ? COPILOT_APPS : []), ...(o.removeStore ? STORE_APPS : []), ...(o.removeEdge ? EDGE_APPS : [])];
  const l: string[] = [
    '@echo off',
    'rem Written by Maskrom Studio: trims the applied Windows on W: (src/woa/trim.ts).',
    'rem Undo: docs/DESIGN.md, "Trimming Windows". A failure here is logged; the install goes on.',
    'setlocal enabledelayedexpansion',
    'echo Trimming Windows. >> "%LOG%"',
  ];
  if (apps.length) {
    l.push(
      'echo Removing app packages that run in the background.',
      'dism /English /Image:W:\\ /Get-ProvisionedAppxPackages > "%TEMP%\\woa-trim-apps.txt" 2>&1',
      'rem No pipes inside the loop: they run in a new cmd without delayed expansion.',
      'for /f "tokens=2 delims=: " %%p in (\'find "PackageName" "%TEMP%\\woa-trim-apps.txt"\') do (',
      '  set PKG=%%p',
      '  for %%a in (' + apps.join(' ') + ') do (',
      '    set "REST=!PKG:%%a_=!"',
      '    if not "!REST!"=="!PKG!" (',
      '      echo removing !PKG! >> "%LOG%"',
      '      dism /English /Image:W:\\ /Remove-ProvisionedAppxPackage /PackageName:!PKG! >> "%LOG%" 2>&1',
      '    )',
      '  )',
      ')',
    );
  }
  l.push(
    'reg load HKLM\\WOATRIMSW W:\\Windows\\System32\\config\\SOFTWARE >> "%LOG%" 2>&1 || goto :done',
    'reg load HKLM\\WOATRIMSYS W:\\Windows\\System32\\config\\SYSTEM >> "%LOG%" 2>&1 || goto :unloadsw',
    'reg load HKLM\\WOATRIMDEF W:\\Users\\Default\\NTUSER.DAT >> "%LOG%" 2>&1 || goto :unloadsys',
    'set CS=1',
    'for /f "tokens=3" %%v in (\'reg query HKLM\\WOATRIMSYS\\Select /v Current ^| find "Current"\') do set /a CS=%%v',
  );
  if (o.onedrive) {
    l.push('rem OneDrive: not set up for each new user, and not used (ADMX OneDrive DisableFileSyncNGSC).',
      `reg delete "${DU}\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v OneDriveSetup /f >> "%LOG%" 2>&1`,
      reg(`${SW}\\Policies\\Microsoft\\Windows\\OneDrive`, 'DisableFileSyncNGSC', 'REG_DWORD', 1));
  }
  if (o.copilot) {
    l.push('rem Copilot (Policy CSP WindowsAI/TurnOffWindowsCopilot), for the machine and new users.',
      reg(`${SW}\\Policies\\Microsoft\\Windows\\WindowsCopilot`, 'TurnOffWindowsCopilot', 'REG_DWORD', 1),
      reg(`${DU}\\Software\\Policies\\Microsoft\\Windows\\WindowsCopilot`, 'TurnOffWindowsCopilot', 'REG_DWORD', 1));
  }
  if (o.widgets) {
    l.push('rem Widgets (Policy CSP NewsAndInterests/AllowNewsAndInterests).',
      reg(`${SW}\\Policies\\Microsoft\\Dsh`, 'AllowNewsAndInterests', 'REG_DWORD', 0));
  }
  if (o.edgeBackground || o.removeEdge) {
    l.push('rem Edge: no startup boost, no background mode (Microsoft Edge policies).',
      reg(`${SW}\\Policies\\Microsoft\\Edge`, 'StartupBoostEnabled', 'REG_DWORD', 0),
      reg(`${SW}\\Policies\\Microsoft\\Edge`, 'BackgroundModeEnabled', 'REG_DWORD', 0));
  }
  if (o.suggestions) {
    l.push('rem Suggested and promoted apps, tips (Policy CSP Experience; ContentDeliveryManager for new users).',
      reg(`${SW}\\Policies\\Microsoft\\Windows\\CloudContent`, 'DisableWindowsConsumerFeatures', 'REG_DWORD', 1),
      reg(`${SW}\\Policies\\Microsoft\\Windows\\CloudContent`, 'DisableConsumerAccountStateContent', 'REG_DWORD', 1),
      ...['SilentInstalledAppsEnabled', 'SystemPaneSuggestionsEnabled', 'SoftLandingEnabled', 'PreInstalledAppsEnabled', 'OemPreInstalledAppsEnabled',
        'SubscribedContent-338388Enabled', 'SubscribedContent-338389Enabled', 'SubscribedContent-353694Enabled', 'SubscribedContent-353696Enabled']
        .map((v) => reg(`${DU}\\Software\\Microsoft\\Windows\\CurrentVersion\\ContentDeliveryManager`, v, 'REG_DWORD', 0)));
  }
  if (o.telemetry) {
    l.push('rem Diagnostic data: Required, the lowest level Pro honours (Policy CSP System/AllowTelemetry).',
      reg(`${SW}\\Policies\\Microsoft\\Windows\\DataCollection`, 'AllowTelemetry', 'REG_DWORD', 1));
  }
  if (o.searchDelayed) {
    l.push('rem The search indexer starts a little after boot instead of with it; search keeps working.',
      reg(`${SY}\\Services\\WSearch`, 'DelayedAutostart', 'REG_DWORD', 1));
  }
  if (o.sysmain) {
    l.push('rem SysMain (Superfetch) off: on a 4 GB board with an eMMC it mostly adds reads at boot.',
      reg(`${SY}\\Services\\SysMain`, 'Start', 'REG_DWORD', 4));
  }
  if (o.removeEdge) {
    l.push(
      'rem Edge: its files and entries go; WebView2 (EdgeWebView) and Edge Update stay, as other apps need them.',
      'rem Edge Update may not install Edge again, and Windows Update gets the blocker value',
      'rem (Microsoft Edge update policies, Install/Update per app; DoNotUpdateToEdgeWithChromium).',
      reg(`${SW}\\Policies\\Microsoft\\EdgeUpdate`, `Install${EDGE_APP_ID}`, 'REG_DWORD', 0),
      reg(`${SW}\\Policies\\Microsoft\\EdgeUpdate`, `Update${EDGE_APP_ID}`, 'REG_DWORD', 0),
      reg(`${SW}\\Microsoft\\EdgeUpdate`, 'DoNotUpdateToEdgeWithChromium', 'REG_DWORD', 1),
      `reg delete "${SW}\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Microsoft Edge" /f >> "%LOG%" 2>&1`,
      `reg delete "${SW}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Microsoft Edge" /f >> "%LOG%" 2>&1`,
      'for %%d in ("W:\\Program Files (x86)\\Microsoft\\Edge" "W:\\Program Files\\Microsoft\\Edge") do if exist %%d rd /s /q %%d >> "%LOG%" 2>&1',
      'del /f /q "W:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Microsoft Edge.lnk" >> "%LOG%" 2>&1',
      'del /f /q "W:\\Users\\Public\\Desktop\\Microsoft Edge.lnk" >> "%LOG%" 2>&1',
    );
  }
  if (o.chrome) {
    l.push('rem Chrome for new users\' web pages, links and PDFs (Policy CSP ApplicationDefaults/DefaultAssociationsConfiguration);',
      'rem SetupComplete.cmd installs it on the first start.',
      'mkdir "W:\\ProgramData\\Maskrom Studio" 2>nul',
      'copy /y "%STAGE%\\chrome\\defaults.xml" "W:\\ProgramData\\Maskrom Studio\\default-browser.xml" >> "%LOG%" 2>&1',
      'copy /y "%STAGE%\\' + CHROME_MSI.path.replace(/\//g, '\\') + '" "W:\\ProgramData\\Maskrom Studio\\chrome.msi" >> "%LOG%" 2>&1',
      reg(`${SW}\\Policies\\Microsoft\\Windows\\System`, 'DefaultAssociationsConfiguration', 'REG_SZ', 'C:\\ProgramData\\Maskrom Studio\\default-browser.xml'));
  }
  l.push(
    'reg unload HKLM\\WOATRIMDEF >> "%LOG%" 2>&1',
    ':unloadsys',
    'reg unload HKLM\\WOATRIMSYS >> "%LOG%" 2>&1',
    ':unloadsw',
    'reg unload HKLM\\WOATRIMSW >> "%LOG%" 2>&1',
    ':done',
    'echo Trimming done. >> "%LOG%"',
    'endlocal',
    'exit /b 0',
  );
  return `${l.join('\n')}\n`;
}

/** SetupComplete.cmd lines: Chrome from the MSI copied into the image, only when Google signed it. */
export function chromeFirstStart(): string[] {
  return [
    'rem Google Chrome (arm64), from Google\'s MSI downloaded when the board was written: installed only',
    'rem when its Authenticode signature is valid and Google LLC\'s.',
    'set CHROME=%ProgramData%\\Maskrom Studio\\chrome.msi',
    'if exist "%CHROME%" (',
    '  powershell.exe -NoProfile -Command "$s = Get-AuthenticodeSignature -LiteralPath $env:CHROME; if ($s.Status -eq \'Valid\' -and $s.SignerCertificate.Subject -match \'O=Google LLC\') { exit 0 } else { Write-Output (\'signature: \' + $s.Status + \' \' + $s.SignerCertificate.Subject); exit 1 }" >> "%LOG%" 2>&1',
    '  if not errorlevel 1 msiexec.exe /i "%CHROME%" /qn /norestart >> "%LOG%" 2>&1',
    '  del /f /q "%CHROME%" 2>nul',
    ')',
  ];
}
