// "Report a problem": a GitHub issue opened with its title and body filled
// in, and the whole log saved to a file to attach. What leaves the computer
// is scrubbed first: the home folder and the user name, e-mail and IP
// addresses, USB serial numbers, the app's file tokens and anything that
// looks like a key or password. No Electron here, so the tests use it.

export const ISSUES_NEW = 'https://github.com/gahingwoo/maskrom-studio/issues/new';
/** GitHub refuses longer links; the body is cut to fit, the full log goes in the saved file. */
export const MAX_URL = 8000;

export interface Who {
  /** The home folder as the OS has it (/home/ann, /Users/ann, C:\Users\ann). */
  home: string;
  user: string;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function scrub(text: string, who: Who): string {
  let out = text;
  if (who.home && who.home.length > 1) {
    // As written, and with the other slash (logs mix them on Windows).
    for (const h of new Set([who.home, who.home.replace(/\\/g, '/'), who.home.replace(/\//g, '\\')])) {
      out = out.replace(new RegExp(escape(h), 'gi'), '~');
    }
  }
  out = out
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    // An IPv4 address, not a four-part version number ("version 10.0.22631.2428", "v1.0.0.135").
    .replace(/(?<![\w.])(?<!version |v)(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/gi, '<ip>')
    .replace(/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '<ip>')
    .replace(/(serial(?:\s*number)?["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1<serial>')
    .replace(/(app:\/\/local\/file\/)[A-Za-z0-9_-]+/g, '$1<token>')
    .replace(/((?:token|password|passwd|secret|key|authorization)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, '$1<removed>')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '<removed>');
  if (who.user && who.user.length >= 3 && !/^(root|user|admin|test)$/i.test(who.user)) {
    out = out.replace(new RegExp(`\\b${escape(who.user)}\\b`, 'gi'), '<user>');
  }
  return out;
}

export interface ReportFacts {
  version: string;
  commit: string;
  os: string;
  arch: string;
  board: string | null;
  mode: string;
  /** The task, e.g. "Windows to the eMMC". */
  task: string | null;
  /** The step that failed, as the run page named it. */
  step: string | null;
  error: string | null;
  detail?: string | null;
  log: string[];
}

function body(f: ReportFacts, logLines: string[], who: Who): string {
  const s = (x: string | null | undefined) => scrub(x ?? '', who);
  return [
    '## What happened',
    '',
    '<!-- What you did and what you expected. -->',
    '',
    '## Details',
    '',
    `- Maskrom Studio ${f.version} (${f.commit})`,
    `- ${f.os}, ${f.arch}`,
    `- Board: ${f.board ?? '(none chosen)'}`,
    `- Mode: ${f.mode}`,
    ...(f.task ? [`- Task: ${f.task}`] : []),
    ...(f.step ? [`- Step that failed: ${s(f.step)}`] : []),
    ...(f.error ? [`- Error: ${s(f.error)}`] : []),
    ...(f.detail ? ['', '```', s(f.detail), '```'] : []),
    '',
    `## Log (${logLines.length === f.log.length ? 'all' : `last ${logLines.length}`} lines)`,
    '',
    'Please attach the full log, saved with "Save full log", to this issue.',
    '',
    '```',
    ...logLines.map(s),
    '```',
    '',
  ].join('\n');
}

/** The link to a new issue, its log cut from the front until it fits MAX_URL. */
export function issueUrl(f: ReportFacts, who: Who): string {
  const title = `${f.error ? scrub(f.error, who).slice(0, 90) : 'Problem'} (${f.board ?? 'no board'}, ${f.os})`;
  for (let n = Math.min(50, f.log.length); ; n = n > 10 ? n - 10 : n - 1) {
    const lines = n > 0 ? f.log.slice(-n) : [];
    const url = `${ISSUES_NEW}?${new URLSearchParams({ title, body: body(f, lines, who), labels: 'bug' }).toString()}`;
    if (url.length <= MAX_URL || n <= 0) return url.length <= MAX_URL ? url : `${ISSUES_NEW}?${new URLSearchParams({ title, labels: 'bug' }).toString()}`;
  }
}

/** The whole log for the file to attach, with the same facts on top. */
export function fullLog(f: ReportFacts, who: Who): string {
  return body(f, f.log, who).replace('Please attach the full log, saved with "Save full log", to this issue.\n\n', '');
}
