#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface AnyObj {
  [key: string]: any;
}

const GLOBAL_STATE_DIR = path.join(os.homedir(), '.agents', 'agent-swarm');
const GLOBAL_WORKTREE_ROOT = path.join(GLOBAL_STATE_DIR, 'worktree');
const GLOBAL_TASKS_DIR = path.join(GLOBAL_STATE_DIR, 'tasks');
const GLOBAL_TASKS_HISTORY_DIR = path.join(GLOBAL_TASKS_DIR, 'history');
const GLOBAL_LAST_CHECK_PATH = path.join(GLOBAL_STATE_DIR, 'agent-swarm-last-check.json');
const LEGACY_TASKS_PATH = path.join(GLOBAL_STATE_DIR, 'agent-swarm-tasks.json');

const RUNNING_MARKERS = [
  'esc to interrupt',
];
const TMUX_ENV_EXCLUDE = new Set(['TMUX', 'TMUX_PANE', 'PWD', 'OLDPWD', '_', 'SHLVL']);
const MODE_INTERACTIVE = 'interactive';
const MODE_BATCH = 'batch';
const TASK_STATUSES = new Set(['running', 'pending', 'success', 'failed', 'stopped']);
const TERMINAL_STATUSES = new Set(['success', 'failed', 'stopped']);
const INTERACTIVE_LOG_QUIET_SEC = 60;
const BATCH_TIMEOUT_SEC = 10_800;
const INTERACTIVE_PENDING_TIMEOUT_SEC = 10_800;
const REMINDER_MAX = 3;
const REMINDER_INTERVAL_SEC = 3600;
const DOD_PASS = 'pass';
const DOD_FAIL = 'fail';
const SELF_EXEC_BIN = process.execPath;
const SELF_EXEC_ARGV = [...process.execArgv];
const SELF_SCRIPT_PATH = path.resolve(process.argv[1] || __filename);

type TaskMode = typeof MODE_INTERACTIVE | typeof MODE_BATCH;

function printJson(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function fail(msg: string, code = 1): never {
  printJson({ ok: false, error: msg });
  process.exit(code);
}

function run(cmd: string[], cwd?: string, check = true): { code: number; stdout: string; stderr: string } {
  const res = spawnSync(cmd[0], cmd.slice(1), { cwd, encoding: 'utf-8' });
  const code = res.status ?? 1;
  const stdout = res.stdout ?? '';
  const stderr = res.stderr ?? '';
  if (check && code !== 0) {
    throw new Error(stderr || stdout || `command failed: ${cmd.join(' ')}`);
  }
  return { code, stdout, stderr };
}

function ensureGlobalStateDir(): void {
  fs.mkdirSync(GLOBAL_STATE_DIR, { recursive: true });
  fs.mkdirSync(GLOBAL_WORKTREE_ROOT, { recursive: true });
  fs.mkdirSync(GLOBAL_TASKS_DIR, { recursive: true });
  fs.mkdirSync(GLOBAL_TASKS_HISTORY_DIR, { recursive: true });
  if (fs.existsSync(LEGACY_TASKS_PATH)) {
    fs.rmSync(LEGACY_TASKS_PATH, { force: true });
  }
}

function loadJson<T>(p: string, fallback: T): T {
  if (!fs.existsSync(p)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function saveJson(p: string, data: unknown): void {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
}

function taskFileName(taskId: string): string {
  return `${encodeURIComponent(taskId)}.json`;
}

function taskFilePath(taskId: string): string {
  return path.join(GLOBAL_TASKS_DIR, taskFileName(taskId));
}

function taskLockPath(taskId: string): string {
  return path.join(GLOBAL_TASKS_DIR, `${taskFileName(taskId)}.lock`);
}

function withTaskFileLock<T>(taskId: string, fn: () => T): T {
  ensureGlobalStateDir();
  const lockDir = taskLockPath(taskId);
  const timeoutMs = 30_000;
  const staleMs = 120_000;
  const start = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      try {
        const st = fs.statSync(lockDir);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // If lock disappears between checks, simply retry.
      }

      if (Date.now() - start > timeoutMs) {
        fail(`timeout acquiring task lock: ${lockDir}`);
      }
      sleepMs(100);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Ignore unlock failure; stale lock reaper handles leftovers.
    }
  }
}

function loadTaskById(taskId: string): AnyObj | null {
  ensureGlobalStateDir();
  const p = taskFilePath(taskId);
  if (!fs.existsSync(p)) return null;
  return loadJson<AnyObj | null>(p, null);
}

function loadTasks(): AnyObj[] {
  ensureGlobalStateDir();
  const out: AnyObj[] = [];
  const entries = fs.readdirSync(GLOBAL_TASKS_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.json')) continue;
    const p = path.join(GLOBAL_TASKS_DIR, ent.name);
    const item = loadJson<AnyObj | null>(p, null);
    if (!item || typeof item !== 'object') continue;
    if (!item.id) item.id = decodeURIComponent(ent.name.slice(0, -5));
    out.push(item);
  }
  return out;
}

function saveTask(task: AnyObj): void {
  ensureGlobalStateDir();
  if (!task?.id) fail('task id missing while saving task');
  withTaskFileLock(task.id, () => {
    const p = taskFilePath(task.id);
    const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  });
}

function repoLockPath(repo: string): string {
  const real = path.resolve(repo);
  const key = Buffer.from(real).toString('base64').replace(/[^A-Za-z0-9]/g, '_');
  return path.join(GLOBAL_STATE_DIR, `repo-${key}.lock`);
}

function withRepoLock<T>(repo: string, fn: () => T): T {
  ensureGlobalStateDir();
  const lockDir = repoLockPath(repo);
  const timeoutMs = 60_000;
  const staleMs = 300_000;
  const start = Date.now();

  while (true) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const st = fs.statSync(lockDir);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > staleMs) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        // Lock changed while checking; retry.
      }
      if (Date.now() - start > timeoutMs) fail(`timeout acquiring repo lock: ${lockDir}`);
      sleepMs(100);
    }
  }

  try {
    return fn();
  } finally {
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // Ignore unlock failure; stale lock reaper handles leftovers.
    }
  }
}

function isGitRepo(repo: string): boolean {
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) return false;
  return run(['git', 'rev-parse', '--is-inside-work-tree'], repo, false).code === 0;
}

function detectTools(): AnyObj {
  const has = (bin: string) => run(['bash', '-lc', `command -v ${bin}`], undefined, false).code === 0;
  return {
    codex: has('codex'),
    claude: has('claude'),
    gemini: has('gemini'),
    tmux: has('tmux'),
    git: has('git'),
  };
}

function pickAgent(requested: string | undefined, tools: AnyObj): string {
  if (requested) {
    if (!tools[requested]) fail(`requested agent '${requested}' is not installed`);
    return requested;
  }
  if (tools.codex) return 'codex';
  if (tools.claude) return 'claude';
  if (tools.gemini) return 'gemini';
  fail('none of codex, claude, gemini is installed');
}

function validateAgentCommand(agent: string): void {
  const cp = run([agent, '--version'], undefined, false);
  if (cp.code === 0) return;
  const fallback = run([agent, '--help'], undefined, false);
  if (fallback.code !== 0) {
    const err = (fallback.stderr || fallback.stdout || cp.stderr || cp.stdout || '').trim();
    fail(`agent command '${agent}' exists but validation failed: ${err || 'unknown error'}`);
  }
}

function nowId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const rand = Math.random().toString(16).slice(2, 8);
  return `${ts}-${rand}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseTs(v?: string): Date {
  if (!v) return new Date();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function normalizeMode(raw: any): TaskMode {
  return String(raw || MODE_BATCH).toLowerCase() === MODE_INTERACTIVE ? MODE_INTERACTIVE : MODE_BATCH;
}

function modeSupportsAttach(modeRaw: any): boolean {
  return normalizeMode(modeRaw) === MODE_INTERACTIVE;
}

function currentBranch(repo: string): string {
  return run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], repo).stdout.trim();
}

function createWorktree(repo: string, taskId: string): AnyObj {
  ensureGlobalStateDir();
  return withRepoLock(repo, () => {
    const repoKey = path.basename(repo);
    const base = path.join(GLOBAL_WORKTREE_ROOT, repoKey);
    fs.mkdirSync(base, { recursive: true });
    const wt = path.join(base, taskId);
    const branch = `swarm/${taskId}`;
    const baseBranch = currentBranch(repo);
    run(['git', 'worktree', 'add', '-b', branch, wt, baseBranch], repo);
    return { worktree: wt, branch, base_branch: baseBranch };
  });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildSelfInvokeCmd(args: string[]): string {
  const parts = [SELF_EXEC_BIN, ...SELF_EXEC_ARGV, SELF_SCRIPT_PATH, ...args];
  return parts.map((p) => shellQuote(String(p))).join(' ');
}

function buildSelfInvokeCmdWithExitCode(taskId: string): string {
  const parts = [SELF_EXEC_BIN, ...SELF_EXEC_ARGV, SELF_SCRIPT_PATH];
  const quoted = parts.map((p) => shellQuote(String(p))).join(' ');
  return `${quoted} on-exit --id ${shellQuote(taskId)} --exit-code "$ec"`;
}

function prepareReusedWorktree(parent: AnyObj): [boolean, string, AnyObj] {
  const wt = parent.worktree || '';
  const repo = parent.repo || '';
  if (!wt || !fs.existsSync(wt) || !fs.statSync(wt).isDirectory()) return [false, 'reuse_guard_failed:worktree_missing', {}];
  if (!repo || !isGitRepo(repo)) return [false, 'reuse_guard_failed:repo_missing_or_not_git', {}];
  if (!isGitRepo(wt)) return [false, 'reuse_guard_failed:worktree_not_git', {}];
  const sess = parent.tmux_session || '';
  if (sess && run(['tmux', 'has-session', '-t', sess], undefined, false).code === 0) {
    return [false, 'reuse_guard_failed:parent_session_running', {}];
  }
  const head = run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], wt, false);
  if (head.code !== 0) return [false, 'reuse_guard_failed:branch_unresolvable', {}];
  return [true, 'ok', { worktree: wt, branch: head.stdout.trim() || parent.branch || '', base_branch: parent.base_branch || '' }];
}

function buildAgentStartCommand(
  agent: string,
  mode: TaskMode,
  taskId: string,
  promptPath: string,
  logPath: string,
  exitPath: string,
  continueSession = false,
): string {
  const promptQ = shellQuote(promptPath);
  const logQ = shellQuote(logPath);
  const exitQ = shellQuote(exitPath);
  const onExitInvoke = buildSelfInvokeCmdWithExitCode(taskId);
  const onExitCmd = `${onExitInvoke} >> ${logQ} 2>&1 || true;`;
  let interactiveBase = '';
  let batchBase = '';
  if (agent === 'codex') {
    interactiveBase = continueSession
      ? 'codex resume --last --dangerously-bypass-approvals-and-sandbox'
      : 'codex --dangerously-bypass-approvals-and-sandbox';
    batchBase = continueSession
      ? 'codex exec resume --last "$prompt" --dangerously-bypass-approvals-and-sandbox'
      : 'codex exec --dangerously-bypass-approvals-and-sandbox "$prompt"';
  } else if (agent === 'claude') {
    interactiveBase = continueSession
      ? 'claude --continue --dangerously-skip-permissions'
      : 'claude --dangerously-skip-permissions';
    batchBase = continueSession
      ? 'claude --dangerously-skip-permissions --continue -p "$prompt"'
      : 'claude --dangerously-skip-permissions -p "$prompt"';
  } else if (agent === 'gemini') {
    interactiveBase = continueSession
      ? 'gemini --resume latest --yolo'
      : 'gemini --yolo';
    batchBase = continueSession
      ? 'gemini --resume latest --prompt "$prompt" --yolo'
      : 'gemini --prompt "$prompt" --yolo';
  } else {
    fail(`unsupported agent: ${agent}`);
  }

  if (mode === MODE_BATCH) {
    return [
      'set -o pipefail;',
      `prompt="$(cat ${promptQ})";`,
      `${batchBase} >> ${logQ} 2>&1;`,
      'ec=$?;',
      `echo "$ec" > ${exitQ};`,
      onExitCmd,
    ].join(' ');
  }

  return [
    'set -o pipefail;',
    `${interactiveBase};`,
    'ec=$?;',
    `echo "$ec" > ${exitQ};`,
    onExitCmd,
    'exec bash',
  ].join(' ');
}

function tmuxSendText(session: string, text: string): void {
  // Avoid cross-session prompt/message mixups: the default tmux buffer is global.
  const bufferName = `swarm-${session}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  run(['tmux', 'set-buffer', '-b', bufferName, '--', text]);
  try {
    run(['tmux', 'paste-buffer', '-b', bufferName, '-d', '-t', session]);
  } finally {
    run(['tmux', 'delete-buffer', '-b', bufferName], undefined, false);
  }
  sleepMs(1000);
  tmuxSendEnter(session);
}

function tmuxSendEnter(session: string): void {
  run(['tmux', 'send-keys', '-t', session, 'Enter']);
}

function tmuxSendEscape(session: string): void {
  run(['tmux', 'send-keys', '-t', session, 'Escape']);
}

function tmuxCapturePane(session: string, startLines = 120): string {
  const cp = run(['tmux', 'capture-pane', '-p', '-S', `-${startLines}`, '-t', session], undefined, false);
  if (cp.code !== 0) return '';
  return cp.stdout || '';
}

function tmuxHandleStartupPrompts(session: string, timeoutSec = 8): void {
  const deadline = Date.now() + timeoutSec * 1000;
  let handledTrust = false;
  let handledBypass = false;

  while (Date.now() < deadline) {
    if (!tmuxAlive(session)) return;
    const paneText = stripAnsi(tmuxCapturePane(session, 160)).toLowerCase();
    const normalized = paneText.replace(/\s+/g, ' ');

    const hasTrustPrompt = normalized.includes('trust this folder')
      || normalized.includes('workspace trust')
      || normalized.includes('do you trust the contents of this directory');
    const hasBypassPrompt = normalized.includes('bypass permissions mode')
      && normalized.includes('no, exit')
      && normalized.includes('yes, i accept');

    if (hasBypassPrompt && !handledBypass) {
      run(['tmux', 'send-keys', '-t', session, 'Down']);
      sleepMs(1000);
      run(['tmux', 'send-keys', '-t', session, 'Enter']);
      handledBypass = true;
      sleepMs(300);
      continue;
    }

    if (hasTrustPrompt && !handledTrust) {
      tmuxSendEnter(session);
      handledTrust = true;
      sleepMs(300);
      continue;
    }

    if ((handledTrust || handledBypass) && !hasTrustPrompt && !hasBypassPrompt) {
      return;
    }

    sleepMs(200);
  }
}

function tmuxEnvPairs(): string[] {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== 'string') continue;
    if (TMUX_ENV_EXCLUDE.has(k)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (v.includes('\u0000')) continue;
    pairs.push(`${k}=${v}`);
  }
  return pairs;
}

function tmuxNewSessionWithEnv(session: string, cwd: string, cmd: string): void {
  const base = ['tmux', 'new-session', '-d', '-s', session, '-c', cwd];
  const withEnv = [...base];
  for (const p of tmuxEnvPairs()) withEnv.push('-e', p);
  withEnv.push('bash', '-lc', cmd);

  const first = run(withEnv, undefined, false);
  if (first.code === 0) return;

  const fallback = run([...base, 'bash', '-lc', cmd], undefined, false);
  if (fallback.code === 0) return;

  throw new Error(first.stderr || first.stdout || fallback.stderr || fallback.stdout || 'tmux new-session failed');
}

function tmuxAlive(session?: string): boolean {
  if (!session) return false;
  return run(['tmux', 'has-session', '-t', session], undefined, false).code === 0;
}

function tmuxCurrentCommand(session: string): string {
  const cp = run(['tmux', 'display-message', '-p', '-t', session, '#{pane_current_command}'], undefined, false);
  if (cp.code !== 0) return '';
  return cp.stdout.trim().toLowerCase();
}

function sleepMs(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, ms);
}

function isAgentPaneCommand(cmd: string, agent: string): boolean {
  if (!cmd) return false;
  if (cmd === agent) return true;
  // Some wrappers may still show node as current command.
  return cmd === 'node';
}

function waitForAgentReady(session: string, agent: string, timeoutSec = 20): boolean {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (!tmuxAlive(session)) return false;
    const cmd = tmuxCurrentCommand(session);
    if (isAgentPaneCommand(cmd, agent)) return true;
    sleepMs(200);
  }
  return false;
}

function tmuxCloseSession(session: string): boolean {
  if (!tmuxAlive(session)) return true;
  // Keep shutdown deterministic; no graceful probing branch.
  if (tmuxAlive(session)) run(['tmux', 'kill-session', '-t', session], undefined, false);
  return !tmuxAlive(session);
}

function readLogExcerpt(logPath: string, maxChars = 1200): string {
  if (!fs.existsSync(logPath)) return '';
  try {
    const text = fs.readFileSync(logPath, 'utf-8');
    return text.slice(-maxChars).trim();
  } catch {
    return '';
  }
}

function stripAnsi(text: string): string {
  return text
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B[@-_]/g, '');
}

function textContainsAny(text: string, markers: string[]): boolean {
  const t = text.toLowerCase();
  return markers.some((m) => t.includes(m));
}

function buildPrompt(taskId: string, _repo: string, worktree: string, userTask: string, parentTaskId = ''): string {
  const parentLine = parentTaskId ? `Parent Task ID: ${parentTaskId}\n` : '';
  return [
    'You are a coding agent running in a git worktree.',
    '',
    `Task ID: ${taskId}`,
    `${parentLine}Execution scope: Worktree only`,
    `Worktree: ${worktree}`,
    '',
    'User task:',
    userTask,
    '',
    'Rules:',
    '0) Operate only inside Worktree; do not create/edit/commit files outside Worktree.',
    '1) Make focused changes for this task only.',
    '2) Commit with clear message when done.',
    '3) Print concise final summary and next steps.',
    '',
  ].join('\n');
}

function spawnInTmux(
  taskId: string,
  repo: string,
  wtMeta: AnyObj,
  agent: string,
  mode: TaskMode,
  userTask: string,
  parentTaskId = '',
  dodSpec: AnyObj = {},
  continueSession = false,
): AnyObj {
  ensureGlobalStateDir();
  const logsDir = path.join(GLOBAL_STATE_DIR, 'logs');
  const promptsDir = path.join(GLOBAL_STATE_DIR, 'prompts');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });

  const session = `swarm-${mode}-${taskId}`.replace(/\//g, '-');
  const promptPath = path.join(promptsDir, `${taskId}.txt`);
  const logPath = path.join(logsDir, `${taskId}.log`);
  const exitPath = path.join(logsDir, `${taskId}.exit`);

  const promptText = buildPrompt(taskId, repo, wtMeta.worktree, userTask, parentTaskId);
  fs.writeFileSync(promptPath, promptText, 'utf-8');
  fs.writeFileSync(logPath, '', 'utf-8');
  if (mode === MODE_BATCH) {
    fs.writeFileSync(exitPath, '', 'utf-8');
    fs.rmSync(exitPath, { force: true });
  }

  const cmd = buildAgentStartCommand(agent, mode, taskId, promptPath, logPath, exitPath, continueSession);
  tmuxNewSessionWithEnv(session, wtMeta.worktree, cmd);
  if (mode === MODE_INTERACTIVE) {
    run(['tmux', 'pipe-pane', '-o', '-t', session, `cat >> ${shellQuote(logPath)}`], undefined, false);
    if (!waitForAgentReady(session, agent, 20)) {
      if (fs.existsSync(exitPath)) {
        const tail = readLogExcerpt(logPath, 300);
        tmuxCloseSession(session);
        fail(`agent failed before ready in tmux session: ${session}; ${tail}`);
      }
      // Avoid false negatives from pane command detection; keep session and continue.
      sleepMs(1000);
    }
    tmuxHandleStartupPrompts(session);
    tmuxSendText(session, promptText);
  }

  const now = nowIso();
  const task: AnyObj = {
    id: taskId,
    mode,
    status: 'running',
    agent,
    repo,
    worktree: wtMeta.worktree,
    branch: wtMeta.branch,
    base_branch: wtMeta.base_branch,
    tmux_session: session,
    task: userTask,
    dod_spec: dodSpec,
    parent_task_id: parentTaskId,
    created_at: now,
    updated_at: now,
    last_activity_at: now,
    log: logPath,
    exit_file: exitPath,
    timeout_since: '',
  };
  return task;
}

function runShell(command: string, cwd: string, timeoutMs: number): AnyObj {
  const res = spawnSync('bash', ['-lc', command], { cwd, encoding: 'utf-8', timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  const timedOut = res.error?.name === 'TimeoutError';
  return {
    code: timedOut ? 124 : (res.status ?? 1),
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.error ? String(res.error.message || res.error) : ''),
    timed_out: timedOut,
  };
}

function dedupeStrings(input: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const v = String(raw || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function normalizeCommandList(raw: any): string[] {
  if (Array.isArray(raw)) {
    const arr: string[] = [];
    for (const item of raw) {
      const text = String(item || '');
      const parts = text.split('\n').flatMap((line) => line.split(','));
      arr.push(...parts);
    }
    return dedupeStrings(arr);
  }
  const one = String(raw || '').trim();
  if (!one) return [];
  return dedupeStrings(one.split('\n').flatMap((line) => line.split(',')));
}

function defaultDodSpec(): AnyObj {
  return {
    checks: {
      allowed_statuses: ['pending', 'success'],
      require_clean_worktree: true,
      require_commits_ahead_base: false,
      ci_commands: [],
    },
    actions: {
      push_command: 'git push -u origin HEAD',
      pr_command: '',
    },
  };
}

function parseDodSpecJson(opts: AnyObj): AnyObj {
  if (opts.dodJsonFile) {
    const p = path.resolve(String(opts.dodJsonFile));
    if (!fs.existsSync(p)) fail(`dod json file not found: ${p}`);
    try {
      const raw = fs.readFileSync(p, 'utf-8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('dod json file must be an object');
      }
      return parsed;
    } catch {
      fail('invalid --dod-json-file content');
    }
  }
  if (opts.dodJson) {
    try {
      const parsed = JSON.parse(String(opts.dodJson));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail('--dod-json must be a json object');
      }
      return parsed;
    } catch {
      fail('invalid --dod-json payload');
    }
  }
  return {};
}

function normalizeDodSpec(input: AnyObj, inherited: AnyObj = {}): AnyObj {
  const assertNoLegacyKeys = (spec: AnyObj, label: string): void => {
    const legacyKeys = [
      'allowed_statuses',
      'require_clean_worktree',
      'require_commits_ahead_base',
      'ci_commands',
      'push_command',
      'pr_command',
    ];
    const hits = legacyKeys.filter((k) => Object.prototype.hasOwnProperty.call(spec, k));
    if (hits.length) {
      fail(`${label} uses legacy DoD keys (${hits.join(', ')}). Use dod_spec.checks.* and dod_spec.actions.*`);
    }
  };

  const defaults = defaultDodSpec();
  const base = inherited && typeof inherited === 'object' && !Array.isArray(inherited) ? inherited : {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  assertNoLegacyKeys(base, 'inherited dod_spec');
  assertNoLegacyKeys(src, 'dod_spec');

  const baseChecks = base.checks && typeof base.checks === 'object' && !Array.isArray(base.checks) ? base.checks : {};
  const srcChecks = src.checks && typeof src.checks === 'object' && !Array.isArray(src.checks) ? src.checks : {};
  const mergedChecks = { ...defaults.checks, ...baseChecks, ...srcChecks };

  const baseActions = base.actions && typeof base.actions === 'object' && !Array.isArray(base.actions) ? base.actions : {};
  const srcActions = src.actions && typeof src.actions === 'object' && !Array.isArray(src.actions) ? src.actions : {};
  const mergedActions = { ...defaults.actions, ...baseActions, ...srcActions };

  const allowed = dedupeStrings(
    normalizeCommandList(mergedChecks.allowed_statuses).filter((s) => TASK_STATUSES.has(s)),
  );
  const ci = dedupeStrings(normalizeCommandList(mergedChecks.ci_commands));
  return {
    checks: {
      allowed_statuses: allowed.length ? allowed : defaults.checks.allowed_statuses,
      require_clean_worktree: Boolean(mergedChecks.require_clean_worktree),
      require_commits_ahead_base: Boolean(mergedChecks.require_commits_ahead_base),
      ci_commands: ci,
    },
    actions: {
      push_command: String(mergedActions.push_command || '').trim(),
      pr_command: String(mergedActions.pr_command || '').trim(),
    },
  };
}

function buildDodSpecFromOpts(opts: AnyObj, inherited: AnyObj = {}): AnyObj {
  const jsonSpec = parseDodSpecJson(opts);
  const cliCiCommands = normalizeCommandList(opts.ciCommands);
  const merged: AnyObj = { ...jsonSpec };
  const checksFromJson = jsonSpec?.checks && typeof jsonSpec.checks === 'object' && !Array.isArray(jsonSpec.checks)
    ? jsonSpec.checks
    : {};
  if (Object.prototype.hasOwnProperty.call(checksFromJson, 'ci_commands') || cliCiCommands.length) {
    merged.checks = {
      ...checksFromJson,
      ci_commands: dedupeStrings([
        ...normalizeCommandList(checksFromJson.ci_commands),
        ...cliCiCommands,
      ]),
    };
  }
  return normalizeDodSpec(merged, inherited);
}

function isStringArray(v: any): boolean {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function ensureTaskDodSpec(task: AnyObj): AnyObj {
  const current = task?.dod_spec && typeof task.dod_spec === 'object' ? task.dod_spec : {};
  const normalized = normalizeDodSpec(current);
  task.dod_spec = normalized;
  return normalized;
}

function dodPassed(dod: AnyObj): boolean {
  return String(dod?.status || '') === DOD_PASS;
}

function clearDod(task: AnyObj): void {
  task.dod = {};
}

function ensureTaskSessionClosed(task: AnyObj): void {
  const session = String(task.tmux_session || '');
  if (!session) return;
  tmuxCloseSession(session);
}

function evaluateDefaultDod(task: AnyObj): AnyObj {
  const worktree = String(task.worktree || '');
  const status = String(task.status || '');
  const dodSpec = ensureTaskDodSpec(task);
  const checksSpec = dodSpec.checks && typeof dodSpec.checks === 'object' ? dodSpec.checks : {};
  const actionsSpec = dodSpec.actions && typeof dodSpec.actions === 'object' ? dodSpec.actions : {};
  const allowedStatuses = isStringArray(checksSpec.allowed_statuses) ? checksSpec.allowed_statuses : [];
  const ciCommands = isStringArray(checksSpec.ci_commands) ? dedupeStrings(checksSpec.ci_commands) : [];
  const result: AnyObj = {
    reason: '',
    error: '',
    terminal: isTerminalStatus(status),
    worktree_clean: null,
    commits_ahead_base: null,
    checks: [] as AnyObj[],
    actions: {
      push: { command: String(actionsSpec.push_command || ''), executed: false },
      pr: { command: String(actionsSpec.pr_command || ''), executed: false },
    },
  };
  const dod: AnyObj = {
    status: DOD_FAIL,
    result,
    dod_spec: dodSpec,
    updated_at: nowIso(),
  };

  if (!worktree || !fs.existsSync(worktree)) {
    result.reason = 'worktree_missing';
    return dod;
  }
  const statusAllowed = allowedStatuses.includes(status);
  result.checks.push({
    name: 'status_allowed',
    pass: statusAllowed,
    status,
    allowed_statuses: allowedStatuses,
  });
  if (!statusAllowed) {
    result.reason = `status_not_allowed:${status || 'unknown'}`;
    return dod;
  }

  if (Boolean(checksSpec.require_clean_worktree)) {
    const sp = run(['git', 'status', '--porcelain'], worktree, false);
    result.worktree_clean = sp.code === 0 && sp.stdout.trim() === '';
    result.checks.push({ name: 'worktree_clean', pass: result.worktree_clean });
    if (!result.worktree_clean) {
      result.reason = 'worktree_not_clean';
      return dod;
    }
  }

  const testTimeoutSec = 300;
  if (Boolean(checksSpec.require_commits_ahead_base)) {
    const baseBranch = String(task.base_branch || '').trim();
    if (!baseBranch) {
      result.checks.push({ name: 'commits_ahead_base', pass: false, base_branch: '' });
      result.reason = 'base_branch_missing_for_commit_check';
      return dod;
    }
    const cpAhead = run(['git', 'rev-list', '--count', `${baseBranch}..HEAD`], worktree, false);
    const ahead = cpAhead.code === 0 ? Number.parseInt((cpAhead.stdout || '0').trim(), 10) : 0;
    const passAhead = Number.isFinite(ahead) && ahead > 0;
    result.commits_ahead_base = Number.isFinite(ahead) ? ahead : 0;
    result.checks.push({
      name: 'commits_ahead_base',
      pass: passAhead,
      base_branch: baseBranch,
      count: result.commits_ahead_base,
    });
    if (!passAhead) {
      result.reason = 'no_commits_ahead_base';
      return dod;
    }
  }

  for (const cmd of ciCommands) {
    const startedAt = Date.now();
    const cp = runShell(cmd, worktree, testTimeoutSec * 1000);
    const durationMs = Date.now() - startedAt;
    const pass = cp.code === 0;
    result.checks.push({
      name: 'ci_command',
      cmd,
      pass,
      exit_code: cp.code,
      timed_out: Boolean(cp.timed_out),
      duration_ms: durationMs,
      output: (cp.stdout || cp.stderr || '').slice(-2000),
    });
    if (!pass) {
      result.reason = 'ci_commands_failed';
      if (cp.timed_out) result.error = `ci_command_timeout:${cmd}`;
      return dod;
    }
  }

  if (status === 'success') {
    const pushCommand = String(actionsSpec.push_command || '').trim();
    if (pushCommand) {
      const pushRes = runShell(pushCommand, worktree, testTimeoutSec * 1000);
      result.actions.push = {
        command: pushCommand,
        executed: true,
        exit_code: pushRes.code,
        timed_out: Boolean(pushRes.timed_out),
        output: (pushRes.stdout || pushRes.stderr || '').slice(-2000),
      };
      if (pushRes.code !== 0) {
        result.reason = 'push_command_failed';
        if (pushRes.timed_out) result.error = `push_command_timeout:${pushCommand}`;
        return dod;
      }
    }
    const prCommand = String(actionsSpec.pr_command || '').trim();
    if (prCommand) {
      const prRes = runShell(prCommand, worktree, testTimeoutSec * 1000);
      result.actions.pr = {
        command: prCommand,
        executed: true,
        exit_code: prRes.code,
        timed_out: Boolean(prRes.timed_out),
        output: (prRes.stdout || prRes.stderr || '').slice(-2000),
      };
      if (prRes.code !== 0) {
        result.reason = 'pr_command_failed';
        if (prRes.timed_out) result.error = `pr_command_timeout:${prCommand}`;
        return dod;
      }
    }
  }

  dod.status = DOD_PASS;
  result.reason = 'ok';
  return dod;
}

function applyDodOnStatusTransition(task: AnyObj, oldStatus: string, nextStatus: string, _mode: TaskMode): void {
  if (oldStatus === nextStatus) return;
  if (nextStatus === 'pending' || nextStatus === 'success') {
    task.dod = evaluateDefaultDod(task);
    return;
  }
  clearDod(task);
}

function parseRemoteUrl(remoteUrl: string): AnyObj {
  const url = remoteUrl.trim();
  let host = '';
  let repoPath = '';
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const u = new URL(url);
    host = u.host.toLowerCase();
    repoPath = u.pathname.replace(/^\//, '');
  } else {
    const m = url.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (m) {
      host = m[1].toLowerCase();
      repoPath = m[2].replace(/^\//, '');
    }
  }
  if (repoPath.endsWith('.git')) repoPath = repoPath.slice(0, -4);
  let forge = 'unknown';
  if (host.includes('github')) forge = 'github';
  else if (host.includes('gitlab')) forge = 'gitlab';
  else if (host.includes('gitea')) forge = 'gitea';
  return { forge, host, repo_path: repoPath, remote_url: remoteUrl };
}

function getRemoteInfo(worktree: string, remote: string): AnyObj {
  const cp = run(['git', 'remote', 'get-url', remote], worktree, false);
  if (cp.code !== 0) fail(`remote not found: ${remote}`);
  const remoteUrl = cp.stdout.trim();
  if (!remoteUrl) fail(`remote url is empty: ${remote}`);
  return parseRemoteUrl(remoteUrl);
}

function buildManualPrUrl(forgeInfo: AnyObj, sourceBranch: string, targetBranch: string): string {
  const forge = forgeInfo.forge || 'unknown';
  const host = forgeInfo.host || '';
  const repoPath = forgeInfo.repo_path || '';
  if (!host || !repoPath) return '';
  if (forge === 'github') {
    return `https://${host}/${repoPath}/compare/${encodeURIComponent(targetBranch)}...${encodeURIComponent(sourceBranch)}?expand=1`;
  }
  if (forge === 'gitlab') {
    return `https://${host}/${repoPath}/-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(sourceBranch)}&merge_request[target_branch]=${encodeURIComponent(targetBranch)}`;
  }
  return '';
}

function ensurePublishable(task: AnyObj): void {
  const mode = normalizeMode(task.mode);
  const status = String(task.status || '');
  const statusAllowed = (mode === MODE_INTERACTIVE && (status === 'stopped' || status === 'success'))
    || (mode === MODE_BATCH && status === 'success');
  if (!statusAllowed) {
    fail(`task is not publishable for mode/status: mode=${mode} status=${status || 'unknown'}`);
  }
  const dod = task.dod && typeof task.dod === 'object' ? task.dod : {};
  if (!dodPassed(dod)) fail(`task DoD not pass: ${(dod.result || {}).reason || 'unknown'}`);
}

function runPush(worktree: string, remote: string, branch: string): [boolean, string] {
  const cp = run(['git', 'push', '-u', remote, branch], worktree, false);
  if (cp.code === 0) return [true, ''];
  return [false, (cp.stderr || cp.stdout || `git push failed with code ${cp.code}`).trim()];
}

function detectPrCli(forge: string): string {
  if (forge === 'github' && run(['bash', '-lc', 'command -v gh'], undefined, false).code === 0) return 'gh';
  if (forge === 'gitlab' && run(['bash', '-lc', 'command -v glab'], undefined, false).code === 0) return 'glab';
  return '';
}

function createPrWithCli(cliName: string, task: AnyObj, targetBranch: string, title: string, body: string): [boolean, AnyObj] {
  const worktree = task.worktree || '';
  const source = task.branch || '';
  if (cliName === 'gh') {
    const cp = run(['gh', 'pr', 'create', '--base', targetBranch, '--head', source, '--title', title, '--body', body], worktree, false);
    if (cp.code === 0) {
      const lines = cp.stdout.trim().split(/\r?\n/).filter(Boolean);
      return [true, { cli: 'gh', pr_url: lines.length ? lines[lines.length - 1] : '', raw_output: cp.stdout.trim() }];
    }
    return [false, { cli: 'gh', error: (cp.stderr || cp.stdout).trim() }];
  }
  if (cliName === 'glab') {
    const cp = run(['glab', 'mr', 'create', '--source-branch', source, '--target-branch', targetBranch, '--title', title, '--description', body, '--yes'], worktree, false);
    if (cp.code === 0) {
      const lines = cp.stdout.trim().split(/\r?\n/).filter(Boolean);
      const url = lines.find((l) => l.startsWith('http://') || l.startsWith('https://')) || '';
      return [true, { cli: 'glab', pr_url: url, raw_output: cp.stdout.trim() }];
    }
    return [false, { cli: 'glab', error: (cp.stderr || cp.stdout).trim() }];
  }
  return [false, { error: `unsupported cli: ${cliName}` }];
}

function ensureTaskRefreshed(tasks: AnyObj[], taskId: string, opts: AnyObj): AnyObj {
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx < 0) fail(`task not found: ${taskId}`);
  const refreshed = updateStatus({ ...tasks[idx] }, opts);
  tasks[idx] = refreshed;
  return refreshed;
}

function defaultPrTitle(task: AnyObj): string {
  const title = (task.task || '').trim();
  return title ? title.slice(0, 120) : `Task ${task.id || ''}`;
}

function defaultPrBody(task: AnyObj): string {
  return [
    'Auto-published from openclaw-agent-swarm.',
    '',
    `- Task ID: ${task.id || ''}`,
    `- Agent: ${task.agent || ''}`,
    `- Source branch: ${task.branch || ''}`,
    `- Target branch: ${task.base_branch || ''}`,
  ].join('\n');
}

function findTaskCandidates(tasks: AnyObj[], query: string): AnyObj[] {
  const q = query.trim().toLowerCase();
  const out: AnyObj[] = [];
  for (const t of tasks) {
    const fields = [t.id || '', t.tmux_session || '', t.branch || '', t.task || ''];
    let score = 0;
    for (const f of fields) {
      const fv = String(f).toLowerCase();
      if (q === fv) score = Math.max(score, 100);
      else if (fv.includes(q)) score = Math.max(score, 10);
    }
    if (score > 0) out.push({ ...t, _score: score });
  }
  out.sort((a, b) => (b._score || 0) - (a._score || 0));
  return out;
}

function updateStatus(task: AnyObj, opts: AnyObj): AnyObj {
  const mode = normalizeMode(task.mode);
  task.mode = mode;
  const old = String(task.status || 'running');
  const session = task.tmux_session || '';
  const exitFile = task.exit_file || '';
  const logPath = task.log || '';
  const now = new Date();
  const nowIsoStr = now.toISOString();
  if (isTerminalStatus(old)) {
    return task;
  }

  const excerpt = readLogExcerpt(logPath);
  const cleanExcerpt = stripAnsi(excerpt);
  const prevExcerpt = task.result_excerpt || '';
  if (cleanExcerpt !== prevExcerpt) {
    task.last_activity_at = nowIsoStr;
  }
  task.result_excerpt = cleanExcerpt;

  const lastActivity = parseTs(task.last_activity_at || task.updated_at || task.created_at);
  const runSec = Math.max(0, Math.floor((now.getTime() - lastActivity.getTime()) / 1000));
  const alive = tmuxAlive(session);
  const paneExcerpt = alive ? stripAnsi(tmuxCapturePane(session, 180)) : '';
  const mergedExcerpt = [cleanExcerpt, paneExcerpt].filter(Boolean).join('\n');
  const hasRunningHint = textContainsAny(mergedExcerpt, RUNNING_MARKERS);
  let convergedReason = '';

  let next = old as string;
  if (mode === MODE_BATCH) {
    const hasExit = Boolean(exitFile && fs.existsSync(exitFile));
    if (hasExit) {
      const codeText = fs.readFileSync(exitFile, 'utf-8').trim() || '1';
      const code = Number.parseInt(codeText, 10);
      task.exit_code = Number.isNaN(code) ? 1 : code;
      next = String(task.exit_code) === '0' ? 'success' : 'failed';
      convergedReason = `exit_file_code:${task.exit_code}`;
      // exit exists but session still alive means leaked tmux shell; reclaim it.
      if (alive) tmuxCloseSession(session);
      try {
        fs.rmSync(exitFile, { force: true });
      } catch {
        // Ignore exit cleanup failure.
      }
    } else if (!alive) {
      next = 'stopped';
      convergedReason = 'tmux_not_alive_no_exit_file_batch';
    } else {
      next = 'running';
    }
  } else {
    if (!alive) {
      next = 'stopped';
      convergedReason = 'tmux_not_alive_interactive';
    } else if (exitFile && fs.existsSync(exitFile)) {
      // Interactive mode should not normally emit exit file; if it does, treat as failed.
      const codeText = fs.readFileSync(exitFile, 'utf-8').trim() || '1';
      const code = Number.parseInt(codeText, 10);
      task.exit_code = Number.isNaN(code) ? 1 : code;
      next = 'failed';
      convergedReason = `interactive_exit_code:${task.exit_code}`;
      if (alive) tmuxCloseSession(session);
    } else {
      next = hasRunningHint ? 'running' : 'pending';
    }
  }

  task.status = next;
  const isInteractivePending = mode === MODE_INTERACTIVE && next === 'pending';
  const isBatchLongRunning = mode === MODE_BATCH && next === 'running' && runSec >= BATCH_TIMEOUT_SEC;
  if (isInteractivePending || isBatchLongRunning) {
    if (!task.timeout_since) task.timeout_since = nowIsoStr;
  } else if (next !== old) {
    task.timeout_since = '';
  }
  if (next !== old) task.updated_at = nowIsoStr;
  if (next !== old && isTerminalStatus(next)) {
    task.converged_at = nowIsoStr;
    if (convergedReason) task.converged_reason = convergedReason;
  }
  applyDodOnStatusTransition(task, old, next, mode);
  if (next !== old && isTerminalStatus(next)) {
    // Always attempt one more cleanup at terminal transition to avoid leaked sessions.
    ensureTaskSessionClosed(task);
  }
  return task;
}

function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

function logQuietLongEnough(task: AnyObj, now: Date, minQuietSec: number): boolean {
  const status = String(task.status || '');
  if (isTerminalStatus(status)) return false;
  const logPath = String(task.log || '');
  if (!logPath || !fs.existsSync(logPath)) return true;
  try {
    const st = fs.statSync(logPath);
    const quietSec = Math.floor((now.getTime() - st.mtime.getTime()) / 1000);
    return quietSec >= minQuietSec;
  } catch {
    return true;
  }
}

function shouldKeepLastCheckEntry(task: AnyObj, now: Date, maxAgeSec = 86400): boolean {
  const status = String(task.status || '');
  if (!isTerminalStatus(status)) return true;
  const updated = parseTs(task.updated_at || task.last_activity_at || task.created_at);
  const ageSec = Math.floor((now.getTime() - updated.getTime()) / 1000);
  return ageSec < maxAgeSec;
}

function archiveExpiredTasks(tasks: AnyObj[], now: Date, maxAgeSec = 86400): void {
  ensureGlobalStateDir();
  for (const task of tasks) {
    const status = String(task.status || '');
    if (!isTerminalStatus(status)) continue;
    const updated = parseTs(task.updated_at || task.last_activity_at || task.created_at);
    const ageSec = Math.floor((now.getTime() - updated.getTime()) / 1000);
    if (ageSec < maxAgeSec) continue;
    const src = taskFilePath(String(task.id || ''));
    if (!task.id || !fs.existsSync(src)) continue;
    const day = updated.toISOString().slice(0, 10);
    const dstDir = path.join(GLOBAL_TASKS_HISTORY_DIR, day);
    fs.mkdirSync(dstDir, { recursive: true });
    const dst = path.join(dstDir, taskFileName(task.id));
    fs.renameSync(src, dst);
  }
}

function taskSummary(task: AnyObj): AnyObj {
  const mode = normalizeMode(task.mode);
  const status = task.status || 'unknown';
  const publish = task.publish || {};
  const pr = task.pr || {};
  let nextStep = '检查 session 与任务状态，必要时重试';
  if (mode === MODE_INTERACTIVE && ['running', 'pending'].includes(status)) nextStep = '可 attach 补充要求，或等待下一次轮询';
  else if (mode === MODE_BATCH && status === 'running') nextStep = '等待任务结束，或执行 cancel 终止任务';
  else if (status === 'success') {
    if (publish.ok) nextStep = pr.ok ? 'PR/MR 已创建，继续评审与合并' : '分支已推送，执行 create-pr 或按手工链接创建 PR/MR';
    else nextStep = '任务已完成，是否执行 publish --auto-pr 推送并创建 PR/MR';
  } else if (['failed', 'stopped'].includes(status)) nextStep = '查看日志后创建 follow-up 任务（new|reuse）';
  return {
    id: task.id,
    mode,
    agent: task.agent,
    repo: task.repo,
    worktree: task.worktree,
    branch: task.branch,
    tmux_session: task.tmux_session,
    status,
    dod_spec: normalizeDodSpec(task.dod_spec || {}),
    dod: task.dod || {},
    publish,
    pr,
    result_excerpt: (task.result_excerpt || '').slice(-400),
    next_step: nextStep,
  };
}

function cmdSpawn(opts: AnyObj): void {
  const mode = normalizeMode(opts.mode);
  const repo = path.resolve(opts.repo);
  if (!isGitRepo(repo)) fail(`target is not a git repository: ${repo}`);
  const tools = detectTools();
  if (!tools.tmux) fail('tmux is not installed');
  if (!tools.git) fail('git is not installed');
  const agent = pickAgent(opts.agent, tools);
  validateAgentCommand(agent);
  const tasks = loadTasks();
  const existing = new Set(tasks.map((t) => String(t.id || '')));
  let taskId = String(opts.name || '').trim();
  if (taskId) {
    if (existing.has(taskId) || fs.existsSync(taskFilePath(taskId))) fail(`task id already exists: ${taskId}`);
  } else {
    do taskId = nowId();
    while (existing.has(taskId) || fs.existsSync(taskFilePath(taskId)));
  }
  const wtMeta = createWorktree(repo, taskId);
  const dodSpec = buildDodSpecFromOpts(opts);
  const task = spawnInTmux(taskId, repo, wtMeta, agent, mode, opts.task, '', dodSpec);
  task.dod = {};
  saveTask(task);
  printJson({ ok: true, task, tools, registry: GLOBAL_TASKS_DIR });
}

function cmdSpawnFollowup(opts: AnyObj): void {
  const tools = detectTools();
  if (!tools.tmux) fail('tmux is not installed');
  if (!tools.git) fail('git is not installed');
  const sessionMode = String(opts.sessionMode || '').toLowerCase();
  const tasks = loadTasks();
  const parent = tasks.find((t) => t.id === opts.from);
  if (!parent) fail(`task not found: ${opts.from}`);
  if (!isTerminalStatus(String(parent.status || ''))) {
    fail(`follow-up only allowed for terminal parent task, got: ${parent.status || 'unknown'}`);
  }
  const parentAgent = String(parent.agent || '').trim();
  if (!parentAgent) fail(`parent task agent missing: ${opts.from}`);
  const requestedAgent = String(opts.agent || '').trim();
  let agent = '';
  if (sessionMode === 'reuse') {
    if (requestedAgent && requestedAgent !== parentAgent) {
      fail(`reuse mode requires same agent as parent: parent=${parentAgent} requested=${requestedAgent}`);
    }
    agent = parentAgent;
  } else {
    agent = requestedAgent || parentAgent;
  }
  if (!agent || !tools[agent]) {
    fail(`follow-up agent '${agent || 'unknown'}' is not installed`);
  }
  validateAgentCommand(agent);
  const repo = path.resolve(parent.repo || '');
  if (!isGitRepo(repo)) fail(`parent repo is invalid or not git: ${repo}`);
  const mode = normalizeMode(parent.mode || MODE_BATCH);
  const inheritedDodSpec = normalizeDodSpec(parent.dod_spec || {});
  const dodSpec = buildDodSpecFromOpts(opts, inheritedDodSpec);
  const existing = new Set(tasks.map((t) => String(t.id || '')));
  let taskId = String(opts.name || '').trim();
  if (taskId) {
    if (existing.has(taskId) || fs.existsSync(taskFilePath(taskId))) fail(`task id already exists: ${taskId}`);
  } else {
    do taskId = nowId();
    while (existing.has(taskId) || fs.existsSync(taskFilePath(taskId)));
  }
  const [ok, reason, wtMeta] = prepareReusedWorktree(parent);
  if (!ok) fail(reason);
  const parentId = parent.id || '';
  const continueSession = sessionMode === 'reuse';
  const task = spawnInTmux(taskId, repo, wtMeta, agent, mode, opts.task, parentId, dodSpec, continueSession);
  task.session_mode = sessionMode;
  task.dod = {};
  saveTask(task);
  printJson({ ok: true, task, parent_id: parentId, registry: GLOBAL_TASKS_DIR });
}

function cmdAttach(opts: AnyObj): void {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === opts.id);
  if (!task) fail(`task not found: ${opts.id}`);
  const msg = String(opts.message || '').trim();
  if (!msg) fail('message is empty');
  const status = String(task.status || 'unknown');
  if (isTerminalStatus(status)) {
    printJson({
      ok: false,
      id: opts.id,
      error: `task_already_terminal:${status}`,
      requires_confirmation: false,
    });
    return;
  }
  const mode = normalizeMode(task.mode);
  if (!modeSupportsAttach(mode)) {
    printJson({
      ok: false,
      id: opts.id,
      sent: false,
      error: 'attach_not_supported_in_batch_mode',
      requires_confirmation: true,
      reason: 'attach_not_supported_in_batch_mode',
      actions: [
        { action: 'spawn_followup_new_worktree', recommended: true },
        { action: 'spawn_followup_reuse_worktree', recommended: false },
      ],
    });
    return;
  }
  const session = task.tmux_session || '';
  try {
    tmuxSendText(session, msg);
  } catch (e) {
    printJson({
      ok: false,
      id: opts.id,
      sent: false,
      error: 'attach_failed_tmux_send',
      detail: String(e),
      session,
      requires_confirmation: true,
      actions: [{ action: 'manual_attach_tmux_session', recommended: true }],
    });
    return;
  }
  task.status = 'running';
  clearDod(task);
  task.updated_at = nowIso();
  task.last_activity_at = task.updated_at;
  saveTask(task);
  printJson({ ok: true, id: opts.id, sent: true, session });
}

function cmdCancel(opts: AnyObj): void {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === opts.id);
  if (!task) fail(`task not found: ${opts.id}`);

  const status = String(task.status || 'unknown');
  const mode = normalizeMode(task.mode);
  const session = String(task.tmux_session || '');
  const reason = String(opts.reason || '').trim();
  const now = nowIso();

  if (isTerminalStatus(status)) {
    printJson({
      ok: false,
      id: opts.id,
      cancelled: false,
      already_terminal: true,
      status,
      error: `task_already_terminal:${status}`,
      requires_confirmation: false,
    });
    return;
  }

  const killed = tmuxCloseSession(session);

  if (!killed) {
    printJson({
      ok: false,
      id: opts.id,
      error: 'cancel_failed_session_still_alive',
      requires_confirmation: true,
      actions: [{ action: 'manual_kill_tmux_session', recommended: true }],
    });
    return;
  }

  const method = 'kill_only';
  const nextStatus = mode === MODE_INTERACTIVE && status === 'pending' ? 'success' : 'stopped';

  task.status = nextStatus;
  task.updated_at = now;
  task.last_activity_at = now;
  task.converged_at = now;
  task.converged_reason = reason
    ? `user_cancelled:${method}:${reason}`
    : `user_cancelled:${method}`;
  task.cancel = {
    at: now,
    by_user: true,
    method,
    session_killed: killed,
    reason,
  };
  applyDodOnStatusTransition(task, status, nextStatus, mode);
  ensureTaskSessionClosed(task);
  saveTask(task);

  printJson({
    ok: true,
    id: opts.id,
    cancelled: true,
    status: task.status,
    converged_reason: task.converged_reason,
    cancel: task.cancel,
  });
}

function cmdOnExit(opts: AnyObj): void {
  if (!opts.id) fail('on-exit requires --id');
  const id = String(opts.id);
  let task = loadTaskById(id);
  if (!task) {
    // Spawn can save task metadata slightly after tmux starts; allow short retry window.
    for (let i = 0; i < 30 && !task; i += 1) {
      sleepMs(100);
      task = loadTaskById(id);
    }
  }
  if (!task) fail(`task not found: ${opts.id}`);

  const mode = normalizeMode(task.mode);
  const old = String(task.status || 'running');
  if (isTerminalStatus(old)) {
    printJson({ ok: true, id: task.id, already_terminal: true, status: old });
    return;
  }

  const ecNum = Number.parseInt(String(opts.exitCode ?? ''), 10);
  const exitCode = Number.isNaN(ecNum) ? 1 : ecNum;
  const next = mode === MODE_BATCH
    ? (exitCode === 0 ? 'success' : 'failed')
    : 'failed';
  const now = nowIso();

  task.mode = mode;
  task.exit_code = exitCode;
  task.status = next;
  task.updated_at = now;
  task.last_activity_at = now;
  task.converged_at = now;
  task.converged_reason = mode === MODE_BATCH
    ? `exit_file_code:${exitCode}`
    : `interactive_exit_code:${exitCode}`;
  applyDodOnStatusTransition(task, old, next, mode);
  if (isTerminalStatus(next)) ensureTaskSessionClosed(task);
  saveTask(task);

  const exitFile = String(task.exit_file || '');
  if (exitFile) {
    try {
      fs.rmSync(exitFile, { force: true });
    } catch {
      // Ignore cleanup failure; status already persisted.
    }
  }

  printJson({ ok: true, id: task.id, status: task.status, exit_code: task.exit_code, converged_reason: task.converged_reason });
}

function cmdCheck(opts: AnyObj): void {
  const loaded = loadTasks();
  const now = new Date();
  const refreshFlags = loaded.map((t) => {
    const mode = normalizeMode(t.mode);
    const status = String(t.status || '');
    if (isTerminalStatus(status)) return false;
    if (mode === MODE_INTERACTIVE) {
      if (!tmuxAlive(String(t.tmux_session || ''))) return true;
      return logQuietLongEnough(t, now, INTERACTIVE_LOG_QUIET_SEC);
    }
    if (status !== 'running') return false;
    const exitFile = String(t.exit_file || '');
    if (exitFile && fs.existsSync(exitFile)) return true;
    if (!tmuxAlive(String(t.tmux_session || ''))) return true;
    const started = parseTs(t.timeout_since || t.last_activity_at || t.updated_at || t.created_at);
    const runningSec = Math.max(0, Math.floor((now.getTime() - started.getTime()) / 1000));
    return runningSec >= BATCH_TIMEOUT_SEC;
  });
  const tasks = loaded.map((t, idx) => (refreshFlags[idx] ? updateStatus({ ...t }, opts) : { ...t }));

  for (let i = 0; i < tasks.length; i += 1) {
    if (!refreshFlags[i]) continue;
    saveTask(tasks[i]);
  }
  archiveExpiredTasks(tasks, now, Number(opts.archiveAgeSec || 86400));
  const lastRaw = loadJson<AnyObj>(GLOBAL_LAST_CHECK_PATH, {});
  const last = lastRaw && typeof lastRaw === 'object' && lastRaw.tasks && typeof lastRaw.tasks === 'object'
    ? lastRaw.tasks as Record<string, AnyObj>
    : lastRaw as Record<string, AnyObj>;
  const latest: Record<string, AnyObj> = {};
  const changes: AnyObj[] = [];
  for (const t of tasks) {
    if (!shouldKeepLastCheckEntry(t, now, Number(opts.archiveAgeSec || 86400))) continue;
    const tid = t.id;
    const status = t.status;
    const mode = normalizeMode(t.mode);
    latest[tid] = {
      last_status: status,
      updated_at: t.updated_at || now.toISOString(),
      reminder_count: 0,
      last_reminder_at: '',
    };
    const prev: any = last[tid];
    const prevStatus = String(prev?.last_status || '');
    const prevReminderCount = Math.max(0, Number.parseInt(String(prev?.reminder_count || 0), 10) || 0);
    const prevReminderAt = String(prev?.last_reminder_at || '');
    let reminderCount = prevReminderCount;
    let lastReminderAt = prevReminderAt;

    const timeoutSince = parseTs(t.timeout_since || t.last_activity_at || t.updated_at || t.created_at);
    const timeoutAgeSec = Math.max(0, Math.floor((now.getTime() - timeoutSince.getTime()) / 1000));
    const lastReminderTs = prevReminderAt ? parseTs(prevReminderAt) : new Date(0);
    const sinceLastReminderSec = Math.max(0, Math.floor((now.getTime() - lastReminderTs.getTime()) / 1000));
    const needReminderByStatus = (mode === MODE_INTERACTIVE && status === 'pending' && timeoutAgeSec >= INTERACTIVE_PENDING_TIMEOUT_SEC)
      || (mode === MODE_BATCH && status === 'running' && timeoutAgeSec >= BATCH_TIMEOUT_SEC);
    if (!needReminderByStatus) {
      reminderCount = 0;
      lastReminderAt = '';
    }
    const emitReminder = needReminderByStatus
      && reminderCount < REMINDER_MAX
      && sinceLastReminderSec >= REMINDER_INTERVAL_SEC;
    if (emitReminder) {
      reminderCount += 1;
      lastReminderAt = now.toISOString();
    }
    latest[tid].reminder_count = reminderCount;
    latest[tid].last_reminder_at = lastReminderAt;

    if (prevStatus !== status || reminderCount !== prevReminderCount) {
      const publish = t.publish || {};
      const shouldPrompt = status === 'success' && dodPassed(t.dod || {}) && !publish.ok;
      const timeoutPrompt = emitReminder
        ? (mode === MODE_INTERACTIVE
          ? '任务 pending 超过3小时，建议检查日志并决定是否 cancel（将转为 success）'
          : '任务运行超过3小时，建议检查日志并决定是否 cancel（将转为 stopped）')
        : '';
      changes.push({
        id: tid,
        mode,
        repo: t.repo,
        worktree: t.worktree,
        tmux_session: t.tmux_session,
        from: prevStatus,
        to: status,
        converged_reason: t.converged_reason || '',
        dod: t.dod || {},
        result_excerpt: (t.result_excerpt || '').slice(-300),
        timeout_prompt: timeoutPrompt,
        publish_prompt: shouldPrompt ? '任务已完成且DoD通过，是否现在执行 publish --auto-pr 推送远程并创建PR/MR？' : '',
      });
    }
  }
  saveJson(GLOBAL_LAST_CHECK_PATH, {
    meta: {
      updated_at: now.toISOString(),
      archive_age_sec: Number(opts.archiveAgeSec || 86400),
    },
    tasks: latest,
  });
  const activeTasks = opts.changesOnly ? [] : loadTasks();
  printJson({ ok: true, registry: GLOBAL_TASKS_DIR, changes_only: Boolean(opts.changesOnly), changes, tasks: activeTasks });
}

function cmdList(): void {
  printJson({ ok: true, registry: GLOBAL_TASKS_DIR, tasks: loadTasks() });
}

function cmdStatus(opts: AnyObj): void {
  const tasks = loadTasks();
  if (!tasks.length) {
    printJson({ ok: true, task: null, message: 'no tasks found' });
    return;
  }
  if (opts.id) {
    const idx = tasks.findIndex((t) => t.id === opts.id);
    if (idx < 0) fail(`task not found: ${opts.id}`);
    const current = { ...tasks[idx] };
    if (isTerminalStatus(String(current.status || ''))) {
      printJson({ ok: true, task: taskSummary(current) });
      return;
    }
    const refreshed = updateStatus(current, opts);
    saveTask(refreshed);
    printJson({ ok: true, task: taskSummary(refreshed) });
    return;
  }
  if (opts.query) {
    const candidates = findTaskCandidates(tasks, opts.query);
    if (!candidates.length) {
      printJson({
        ok: false,
        requires_confirmation: false,
        error: `query_no_match:${opts.query}`,
      });
      return;
    }
    if (candidates.length > 1 && candidates[0]._score === candidates[1]._score) {
      printJson({
        ok: false,
        requires_confirmation: true,
        error: `ambiguous query: ${opts.query}`,
        candidates: candidates.slice(0, 5).map((c) => ({ id: c.id, branch: c.branch, tmux_session: c.tmux_session, status: c.status })),
      });
      return;
    }
    const target = candidates[0];
    const idx = tasks.findIndex((t) => t.id === target.id);
    const current = { ...tasks[idx] };
    if (isTerminalStatus(String(current.status || ''))) {
      printJson({ ok: true, task: taskSummary(current) });
      return;
    }
    const refreshed = updateStatus(current, opts);
    saveTask(refreshed);
    printJson({ ok: true, task: taskSummary(refreshed) });
    return;
  }
  const latest = [...tasks].sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || ''))).slice(0, 10);
  printJson({ ok: true, tasks: latest.map(taskSummary) });
}

function createPrTask(opts: AnyObj, tasksInput?: AnyObj[], alreadyRefreshed = false, emitOutput = true): AnyObj {
  const tasks = tasksInput || loadTasks();
  let task: AnyObj | undefined;
  if (!alreadyRefreshed) task = ensureTaskRefreshed(tasks, opts.id, opts);
  else task = tasks.find((t) => t.id === opts.id);
  if (!task) fail(`task not found: ${opts.id}`);

  const worktree = task.worktree || '';
  const sourceBranch = task.branch || '';
  const targetBranch = opts.targetBranch || task.base_branch || '';
  if (!targetBranch) fail('target branch is empty; use --target-branch');

  const remote = opts.remote || 'origin';
  const remoteInfo = getRemoteInfo(worktree, remote);
  const manualUrl = buildManualPrUrl(remoteInfo, sourceBranch, targetBranch);

  const [pushOk, pushError] = runPush(worktree, remote, sourceBranch);
  if (!pushOk) {
    task.pr = {
      ok: false,
      state: 'manual_required',
      error: `push_failed_before_pr:${pushError}`,
      manual_url: manualUrl,
      forge: remoteInfo.forge,
      remote_url: remoteInfo.remote_url,
    };
    task.updated_at = nowIso();
    saveTask(task);
    const payload = { ok: false, id: task.id, pr: task.pr };
    if (emitOutput) printJson(payload);
    return payload;
  }

  const title = opts.title || defaultPrTitle(task);
  const body = opts.body || defaultPrBody(task);
  const cli = detectPrCli(remoteInfo.forge || 'unknown');
  if (!cli) {
    task.pr = {
      ok: false,
      state: 'manual_required',
      error: 'no_supported_pr_cli',
      manual_url: manualUrl,
      forge: remoteInfo.forge,
      remote_url: remoteInfo.remote_url,
    };
    task.updated_at = nowIso();
    saveTask(task);
    const payload = { ok: true, id: task.id, pr: task.pr };
    if (emitOutput) printJson(payload);
    return payload;
  }

  const [created, detail] = createPrWithCli(cli, task, targetBranch, title, body);
  task.updated_at = nowIso();
  if (created) {
    task.pr = {
      ok: true,
      state: 'opened',
      url: detail.pr_url || '',
      cli,
      forge: remoteInfo.forge,
      remote_url: remoteInfo.remote_url,
      target_branch: targetBranch,
      source_branch: sourceBranch,
    };
    saveTask(task);
    const payload = { ok: true, id: task.id, pr: task.pr };
    if (emitOutput) printJson(payload);
    return payload;
  }

  task.pr = {
    ok: false,
    state: 'manual_required',
    error: detail.error || 'pr_create_failed',
    manual_url: manualUrl,
    cli,
    forge: remoteInfo.forge,
    remote_url: remoteInfo.remote_url,
    target_branch: targetBranch,
    source_branch: sourceBranch,
  };
  saveTask(task);
  const payload = { ok: true, id: task.id, pr: task.pr };
  if (emitOutput) printJson(payload);
  return payload;
}

function cmdPublish(opts: AnyObj): void {
  const tasks = loadTasks();
  const task = ensureTaskRefreshed(tasks, opts.id, opts);
  ensurePublishable(task);
  const worktree = task.worktree || '';
  const branch = task.branch || '';
  const remote = opts.remote || 'origin';
  const targetBranch = opts.targetBranch || task.base_branch || '';
  if (!targetBranch) fail('target branch is empty; use --target-branch');

  const remoteInfo = getRemoteInfo(worktree, remote);
  const [ok, error] = runPush(worktree, remote, branch);
  task.updated_at = nowIso();
  task.publish = {
    ok,
    remote,
    remote_branch: branch,
    target_branch: targetBranch,
    published_at: ok ? task.updated_at : '',
    error,
    forge: remoteInfo.forge,
    remote_url: remoteInfo.remote_url,
  };

  const result: AnyObj = { ok, id: task.id, publish: task.publish };
  if (!ok) {
    const manualUrl = buildManualPrUrl(remoteInfo, branch, targetBranch);
    if (manualUrl) result.manual_pr_url = manualUrl;
    saveTask(task);
    printJson(result);
    return;
  }

  if (opts.autoPr) {
    const prRes = createPrTask(
      {
        id: opts.id,
        remote,
        targetBranch,
        title: opts.title,
        body: opts.body,
        idle_quiet_sec: opts.idleQuietSec,
        auto_close_idle_sec: opts.autoCloseIdleSec,
      },
      tasks,
      true,
      false,
    );
    result.pr = prRes.pr || (tasks.find((t) => t.id === opts.id) || {}).pr || {};
  }

  saveTask(task);
  printJson(result);
}

function parseArgv(argv: string[]): AnyObj {
  const opts: AnyObj = {};
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      i += 1;
      continue;
    }
    const keyRaw = token.slice(2);
    const key = keyRaw.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      opts[key] = true;
      i += 1;
    } else {
      if (opts[key] === undefined) opts[key] = next;
      else if (Array.isArray(opts[key])) opts[key].push(next);
      else opts[key] = [opts[key], next];
      i += 2;
    }
  }
  return opts;
}

function showHelp(): void {
  process.stdout.write(
    [
      'usage: swarm.ts <command> [options]',
      '',
      'commands:',
      '  spawn',
      '  spawn-followup',
      '  attach',
      '  cancel',
      '  check',
      '  status',
      '  publish',
      '  create-pr',
      '  list',
      '  on-exit (internal)',
      '',
    ].join('\n'),
  );
}

function showCommandHelp(cmd: string): void {
  const lines: Record<string, string[]> = {
    spawn: ['usage: swarm.ts spawn --repo <repo> --task <task> [--mode interactive|batch] [--agent codex|claude|gemini] [--name <name>] [--ci-commands <cmds>] [--dod-json <json>|--dod-json-file <path>]'],
    'spawn-followup': ['usage: swarm.ts spawn-followup --from <id> --task <task> --session-mode new|reuse [--agent codex|claude|gemini] [--name <name>] [--ci-commands <cmds>] [--dod-json <json>|--dod-json-file <path>]'],
    attach: ['usage: swarm.ts attach --id <id> --message <text>'],
    cancel: ['usage: swarm.ts cancel --id <id> [--reason <text>]'],
    check: ['usage: swarm.ts check [--changes-only]'],
    status: ['usage: swarm.ts status [--id <id>|--query <q>]'],
    'on-exit': ['usage: swarm.ts on-exit --id <id> --exit-code <int>'],
    publish: ['usage: swarm.ts publish --id <id> [--remote origin] [--target-branch <branch>] [--auto-pr] [--title <t>] [--body <b>]'],
    'create-pr': ['usage: swarm.ts create-pr --id <id> [--remote origin] [--target-branch <branch>] [--title <t>] [--body <b>]'],
    list: ['usage: swarm.ts list'],
  };
  process.stdout.write(`${(lines[cmd] || ['usage: swarm.ts --help']).join('\n')}\n`);
}

function main(): void {
  try {
    const [, , cmd = '', ...rest] = process.argv;
    if (!cmd || cmd === '-h' || cmd === '--help') {
      showHelp();
      return;
    }

    const optsRaw = parseArgv(rest);
    if (optsRaw.help || optsRaw.h) {
      showCommandHelp(cmd);
      return;
    }
    if (cmd === 'spawn') {
      if (!optsRaw.repo || !optsRaw.task) fail('spawn requires --repo and --task');
      cmdSpawn({
        repo: String(optsRaw.repo),
        task: String(optsRaw.task),
        mode: optsRaw.mode,
        agent: optsRaw.agent,
        name: optsRaw.name,
        ciCommands: optsRaw.ciCommands,
        dodJson: optsRaw.dodJson,
        dodJsonFile: optsRaw.dodJsonFile,
      });
      return;
    }
    if (cmd === 'spawn-followup') {
      const sessionMode = optsRaw.sessionMode;
      if (!optsRaw.from || !optsRaw.task || !sessionMode) {
        fail('spawn-followup requires --from --task --session-mode');
      }
      if (!['new', 'reuse'].includes(String(sessionMode))) fail('session mode must be new|reuse');
      cmdSpawnFollowup({
        from: String(optsRaw.from),
        task: String(optsRaw.task),
        sessionMode: String(sessionMode),
        agent: optsRaw.agent,
        name: optsRaw.name,
        ciCommands: optsRaw.ciCommands,
        dodJson: optsRaw.dodJson,
        dodJsonFile: optsRaw.dodJsonFile,
      });
      return;
    }
    if (cmd === 'attach') {
      if (!optsRaw.id || !optsRaw.message) fail('attach requires --id and --message');
      cmdAttach({ id: String(optsRaw.id), message: String(optsRaw.message) });
      return;
    }
    if (cmd === 'cancel') {
      if (!optsRaw.id) fail('cancel requires --id');
      cmdCancel({ id: String(optsRaw.id), reason: optsRaw.reason });
      return;
    }
    if (cmd === 'check') {
      cmdCheck({ ...optsRaw, changesOnly: Boolean(optsRaw.changesOnly) });
      return;
    }
    if (cmd === 'status') {
      cmdStatus({ ...optsRaw, id: optsRaw.id, query: optsRaw.query });
      return;
    }
    if (cmd === 'on-exit') {
      cmdOnExit({
        id: optsRaw.id,
        exitCode: optsRaw.exitCode,
      });
      return;
    }
    if (cmd === 'publish') {
      if (!optsRaw.id) fail('publish requires --id');
      cmdPublish({
        ...optsRaw,
        id: String(optsRaw.id),
        remote: String(optsRaw.remote || 'origin'),
        targetBranch: optsRaw.targetBranch,
        autoPr: Boolean(optsRaw.autoPr),
        title: optsRaw.title,
        body: optsRaw.body,
      });
      return;
    }
    if (cmd === 'create-pr') {
      if (!optsRaw.id) fail('create-pr requires --id');
      createPrTask({
        ...optsRaw,
        id: String(optsRaw.id),
        remote: String(optsRaw.remote || 'origin'),
        targetBranch: optsRaw.targetBranch,
        title: optsRaw.title,
        body: optsRaw.body,
      });
      return;
    }
    if (cmd === 'list') {
      cmdList();
      return;
    }
    fail(`unknown command: ${cmd}`);
  } catch (e) {
    fail(String(e));
  }
}

main();
