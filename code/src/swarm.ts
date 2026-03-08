#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface AnyObj {
  [key: string]: any;
}

const GLOBAL_STATE_DIR = path.join(os.homedir(), '.openclaw', 'agent-swarm');
const GLOBAL_WORKTREE_ROOT = path.join(GLOBAL_STATE_DIR, 'worktree');
const GLOBAL_TASKS_PATH = path.join(GLOBAL_STATE_DIR, 'agent-swarm-tasks.json');
const GLOBAL_LAST_CHECK_PATH = path.join(GLOBAL_STATE_DIR, 'agent-swarm-last-check.json');
const GLOBAL_TASKS_LOCK_DIR = `${GLOBAL_TASKS_PATH}.lock`;

const WAITING_MARKERS = [
  'need your input', 'please confirm', 'please choose', 'waiting for your input', '请确认', '是否继续', '等待输入', '请输入',
];
const TMUX_ENV_EXCLUDE = new Set(['TMUX', 'TMUX_PANE', 'PWD', 'OLDPWD', '_', 'SHLVL']);

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

function loadTasks(): AnyObj[] {
  ensureGlobalStateDir();
  return loadJson<AnyObj[]>(GLOBAL_TASKS_PATH, []);
}

function saveTasks(tasks: AnyObj[]): void {
  ensureGlobalStateDir();
  saveJson(GLOBAL_TASKS_PATH, tasks);
}

function withTasksFileLock<T>(fn: () => T): T {
  ensureGlobalStateDir();
  const lockDir = GLOBAL_TASKS_LOCK_DIR;
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
        fail(`timeout acquiring tasks lock: ${lockDir}`);
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

function isGitRepo(repo: string): boolean {
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) return false;
  return run(['git', 'rev-parse', '--is-inside-work-tree'], repo, false).code === 0;
}

function detectTools(): AnyObj {
  const has = (bin: string) => run(['bash', '-lc', `command -v ${bin}`], undefined, false).code === 0;
  return {
    codex: has('codex'),
    claude: has('claude'),
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
  fail('neither codex nor claude is installed');
}

function validateAgentCommand(agent: string): void {
  const cp = run([agent, '--help'], undefined, false);
  if (cp.code !== 0) {
    const err = (cp.stderr || cp.stdout || '').trim();
    fail(`agent command '${agent}' exists but '--help' failed: ${err || 'unknown error'}`);
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

function currentBranch(repo: string): string {
  return run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], repo).stdout.trim();
}

function createWorktree(repo: string, taskId: string): AnyObj {
  ensureGlobalStateDir();
  const repoKey = path.basename(repo);
  const base = path.join(GLOBAL_WORKTREE_ROOT, repoKey);
  fs.mkdirSync(base, { recursive: true });
  const wt = path.join(base, taskId);
  const branch = `swarm/${taskId}`;
  const baseBranch = currentBranch(repo);
  run(['git', 'worktree', 'add', '-b', branch, wt, baseBranch], repo);
  return { worktree: wt, branch, base_branch: baseBranch };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function prepareReusedWorktree(parent: AnyObj): [boolean, string, AnyObj] {
  const wt = parent.worktree || '';
  const repo = parent.repo || '';
  if (!wt || !fs.existsSync(wt) || !fs.statSync(wt).isDirectory()) return [false, 'reuse_guard_failed:worktree_missing', {}];
  if (!repo || !isGitRepo(repo)) return [false, 'reuse_guard_failed:repo_missing_or_not_git', {}];
  if (!isGitRepo(wt)) return [false, 'reuse_guard_failed:worktree_not_git', {}];
  const status = run(['git', 'status', '--porcelain'], wt, false);
  if (status.code !== 0 || status.stdout.trim() !== '') return [false, 'reuse_guard_failed:worktree_not_clean', {}];
  const sess = parent.tmux_session || '';
  if (sess && run(['tmux', 'has-session', '-t', sess], undefined, false).code === 0) {
    return [false, 'reuse_guard_failed:parent_session_running', {}];
  }
  const head = run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], wt, false);
  if (head.code !== 0) return [false, 'reuse_guard_failed:branch_unresolvable', {}];
  return [true, 'ok', { worktree: wt, branch: head.stdout.trim() || parent.branch || '', base_branch: parent.base_branch || '' }];
}

function buildAgentStartCommand(agent: string, exitPath: string): string {
  let base = '';
  if (agent === 'codex') base = 'codex --dangerously-bypass-approvals-and-sandbox';
  else if (agent === 'claude') base = 'claude --dangerously-skip-permissions';
  else fail(`unsupported agent: ${agent}`);

  return [
    'set -o pipefail;',
    `${base};`,
    'ec=$?;',
    `echo "$ec" > ${shellQuote(exitPath)};`,
    'exec bash',
  ].join(' ');
}

function tmuxSendText(session: string, text: string): void {
  run(['tmux', 'send-keys', '-t', session, text, 'Enter']);
  run(['tmux', 'send-keys', '-t', session, 'Enter']);
}

function tmuxSendEnter(session: string): void {
  run(['tmux', 'send-keys', '-t', session, 'Enter']);
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
      run(['tmux', 'send-keys', '-t', session, '2', 'Enter']);
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
  run(['tmux', 'send-keys', '-t', session, '/exit', 'Enter'], undefined, false);
  run(['tmux', 'send-keys', '-t', session, 'Enter']);
  run(['tmux', 'kill-session', '-t', session], undefined, false);
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

function ensureUniqueTaskId(taskId: string, tasks: AnyObj[]): void {
  if (tasks.some((t) => t.id === taskId)) fail(`task id already exists: ${taskId}`);
}

function buildPrompt(taskId: string, repo: string, worktree: string, userTask: string, parentTaskId = ''): string {
  const parentLine = parentTaskId ? `Parent Task ID: ${parentTaskId}\n` : '';
  return [
    'You are a coding agent running in a git worktree.',
    '',
    `Task ID: ${taskId}`,
    `${parentLine}Repo: ${repo}`,
    `Worktree: ${worktree}`,
    '',
    'User task:',
    userTask,
    '',
    'Rules:',
    '1) Make focused changes for this task only.',
    '2) Commit with clear message when done.',
    '3) Print concise final summary and next steps.',
    '',
  ].join('\n');
}

function spawnInTmux(taskId: string, repo: string, wtMeta: AnyObj, agent: string, userTask: string, tasks: AnyObj[], parentTaskId = ''): AnyObj {
  ensureGlobalStateDir();
  const logsDir = path.join(GLOBAL_STATE_DIR, 'logs');
  const promptsDir = path.join(GLOBAL_STATE_DIR, 'prompts');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(promptsDir, { recursive: true });

  const session = `swarm-${taskId}`.replace(/\//g, '-');
  const promptPath = path.join(promptsDir, `${taskId}.txt`);
  const logPath = path.join(logsDir, `${taskId}.log`);
  const exitPath = path.join(logsDir, `${taskId}.exit`);

  const promptText = buildPrompt(taskId, repo, wtMeta.worktree, userTask, parentTaskId);
  fs.writeFileSync(promptPath, promptText, 'utf-8');
  fs.writeFileSync(logPath, '', 'utf-8');

  const cmd = buildAgentStartCommand(agent, exitPath);
  tmuxNewSessionWithEnv(session, wtMeta.worktree, cmd);
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

  const now = nowIso();
  const task: AnyObj = {
    id: taskId,
    status: 'running',
    agent,
    repo,
    worktree: wtMeta.worktree,
    branch: wtMeta.branch,
    base_branch: wtMeta.base_branch,
    tmux_session: session,
    task: userTask,
    parent_task_id: parentTaskId,
    created_at: now,
    updated_at: now,
    last_activity_at: now,
    log: logPath,
    exit_file: exitPath,
  };
  tasks.push(task);
  saveTasks(tasks);
  return task;
}

function evaluateDefaultDod(task: AnyObj): AnyObj {
  const worktree = task.worktree;
  const baseBranch = task.base_branch;
  const branch = task.branch;
  const result: AnyObj = { checked: true, pass: false, commit: false, clean_worktree: false, reason: '' };
  if (!worktree || !fs.existsSync(worktree)) {
    result.reason = 'worktree_missing';
    return result;
  }
  if (task.status !== 'success') {
    result.reason = `status_not_success:${task.status}`;
    return result;
  }
  if (baseBranch && branch) {
    const cp = run(['git', 'rev-list', '--count', `${baseBranch}..${branch}`], worktree, false);
    result.commit = cp.code === 0 && Number.parseInt((cp.stdout || '0').trim() || '0', 10) > 0;
  }
  const sp = run(['git', 'status', '--porcelain'], worktree, false);
  result.clean_worktree = sp.code === 0 && sp.stdout.trim() === '';
  result.pass = Boolean(result.commit && result.clean_worktree);
  if (!result.pass) {
    if (!result.commit) result.reason = 'no_commit_on_task_branch';
    else if (!result.clean_worktree) result.reason = 'worktree_not_clean';
  } else {
    result.reason = 'ok';
  }
  return result;
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
  if (task.status !== 'success') fail(`task is not success: ${task.status}`);
  const dod = task.dod || evaluateDefaultDod(task);
  task.dod = dod;
  if (!dod.pass) fail(`task DoD not pass: ${dod.reason || 'unknown'}`);
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
  const old = task.status || 'unknown';
  const session = task.tmux_session || '';
  const exitFile = task.exit_file || '';
  const logPath = task.log || '';
  const now = new Date();

  const excerpt = readLogExcerpt(logPath);
  const cleanExcerpt = stripAnsi(excerpt);
  task.result_excerpt = cleanExcerpt;

  const prevExcerpt = task._last_excerpt || '';
  if (cleanExcerpt !== prevExcerpt) {
    task.last_activity_at = now.toISOString();
    task._last_excerpt = cleanExcerpt;
  }

  const lastActivity = parseTs(task.last_activity_at || task.updated_at || task.created_at);
  const idleSec = Math.max(0, Math.floor((now.getTime() - lastActivity.getTime()) / 1000));

  const alive = tmuxAlive(session);
  const hasWait = textContainsAny(cleanExcerpt, WAITING_MARKERS);

  const idleQuietSec = opts.idle_quiet_sec ?? 180;

  let next = old;
  if (!alive) {
    if (exitFile && fs.existsSync(exitFile)) {
      const codeText = fs.readFileSync(exitFile, 'utf-8').trim() || '1';
      const code = Number.parseInt(codeText, 10);
      task.exit_code = Number.isNaN(code) ? 1 : code;
      next = String(task.exit_code) === '0' ? 'success' : 'failed';
    } else if (['running', 'awaiting_input', 'auto_closing'].includes(old)) {
      next = 'stopped';
    }
  } else {
    if (idleSec >= idleQuietSec) {
      // Reclaim stale interactive sessions aggressively once idle threshold is reached.
      next = 'auto_closing';
      if (tmuxCloseSession(session)) {
        if (exitFile && fs.existsSync(exitFile)) {
          const codeText = fs.readFileSync(exitFile, 'utf-8').trim() || '1';
          const code = Number.parseInt(codeText, 10);
          task.exit_code = Number.isNaN(code) ? 1 : code;
          next = String(task.exit_code) === '0' ? 'success' : 'failed';
        } else {
          next = 'stopped';
        }
      } else {
        next = 'needs_human';
      }
    } else if (hasWait) {
      next = 'awaiting_input';
    } else if (exitFile && fs.existsSync(exitFile)) {
      next = 'auto_closing';
    } else {
      next = 'running';
    }
  }

  task.status = next;
  if (next !== old) task.updated_at = now.toISOString();
  task.dod = evaluateDefaultDod(task);
  return task;
}

function taskSummary(task: AnyObj): AnyObj {
  const status = task.status || 'unknown';
  const publish = task.publish || {};
  const pr = task.pr || {};
  let nextStep = '检查 session 与任务状态，必要时重试';
  if (['running', 'awaiting_input'].includes(status)) nextStep = 'attach 补充要求，或等待 heartbeat 下次轮询';
  else if (status === 'success') {
    if (publish.ok) nextStep = pr.ok ? 'PR/MR 已创建，继续评审与合并' : '分支已推送，执行 create-pr 或按手工链接创建 PR/MR';
    else nextStep = '任务已完成，是否执行 publish --auto-pr 推送并创建 PR/MR';
  } else if (['failed', 'needs_human'].includes(status)) nextStep = '查看日志并 attach 修正，或创建 follow-up 任务';

  return {
    id: task.id,
    agent: task.agent,
    repo: task.repo,
    worktree: task.worktree,
    branch: task.branch,
    tmux_session: task.tmux_session,
    status,
    dod: task.dod || {},
    publish,
    pr,
    result_excerpt: (task.result_excerpt || '').slice(-400),
    next_step: nextStep,
  };
}

function cmdSpawn(opts: AnyObj): void {
  const repo = path.resolve(opts.repo);
  if (!isGitRepo(repo)) fail(`target is not a git repository: ${repo}`);
  const tools = detectTools();
  if (!tools.tmux) fail('tmux is not installed');
  if (!tools.git) fail('git is not installed');
  const agent = pickAgent(opts.agent, tools);
  validateAgentCommand(agent);
  let task!: AnyObj;
  withTasksFileLock(() => {
    const tasks = loadTasks();
    const taskId = opts.name || nowId();
    ensureUniqueTaskId(taskId, tasks);
    const wtMeta = createWorktree(repo, taskId);
    task = spawnInTmux(taskId, repo, wtMeta, agent, opts.task, tasks);
  });
  printJson({ ok: true, task, tools, registry: GLOBAL_TASKS_PATH });
}

function cmdSpawnFollowup(opts: AnyObj): void {
  const tools = detectTools();
  if (!tools.tmux) fail('tmux is not installed');
  if (!tools.git) fail('git is not installed');
  const agent = pickAgent(opts.agent, tools);
  validateAgentCommand(agent);
  let task!: AnyObj;
  let parentId = '';
  withTasksFileLock(() => {
    const tasks = loadTasks();
    const parent = tasks.find((t) => t.id === opts.from);
    if (!parent) fail(`task not found: ${opts.from}`);
    const repo = path.resolve(parent.repo || '');
    if (!isGitRepo(repo)) fail(`parent repo is invalid or not git: ${repo}`);
    const taskId = opts.name || nowId();
    ensureUniqueTaskId(taskId, tasks);
    let wtMeta: AnyObj;
    if (opts.worktreeMode === 'new') wtMeta = createWorktree(repo, taskId);
    else {
      const [ok, reason, meta] = prepareReusedWorktree(parent);
      if (!ok) fail(reason);
      wtMeta = meta;
    }
    parentId = parent.id || '';
    task = spawnInTmux(taskId, repo, wtMeta, agent, opts.task, tasks, parentId);
    task.worktree_mode = opts.worktreeMode;
    saveTasks(tasks);
  });
  printJson({ ok: true, task, parent_id: parentId, registry: GLOBAL_TASKS_PATH });
}

function cmdAttach(opts: AnyObj): void {
  const tasks = loadTasks();
  const task = tasks.find((t) => t.id === opts.id);
  if (!task) fail(`task not found: ${opts.id}`);
  const msg = String(opts.message || '').trim();
  if (!msg) fail('message is empty');
  const status = task.status || 'unknown';
  const runningLike = new Set(['running', 'awaiting_input', 'auto_closing']);
  if (!runningLike.has(status)) {
    printJson({
      ok: true,
      id: opts.id,
      sent: false,
      requires_confirmation: true,
      reason: `task_not_running:${status}`,
      actions: [
        { action: 'spawn_followup_new_worktree', recommended: true },
        { action: 'spawn_followup_reuse_worktree', recommended: false },
        { action: 'force_attach_legacy_session', recommended: false },
      ],
    });
    return;
  }
  const session = task.tmux_session || '';
  if (!tmuxAlive(session)) {
    printJson({
      ok: true,
      id: opts.id,
      sent: false,
      requires_confirmation: true,
      reason: 'session_not_alive',
      actions: [
        { action: 'spawn_followup_new_worktree', recommended: true },
        { action: 'spawn_followup_reuse_worktree', recommended: false },
      ],
    });
    return;
  }
  try {
    tmuxSendText(session, msg);
  } catch (e) {
    fail(`failed to send message to tmux session ${session}: ${String(e)}`);
  }
  task.status = 'running';
  task.updated_at = nowIso();
  task.last_activity_at = task.updated_at;
  saveTasks(tasks);
  printJson({ ok: true, id: opts.id, sent: true, session });
}

function cmdCheck(opts: AnyObj): void {
  const tasks = loadTasks().map((t) => updateStatus({ ...t }, opts));
  saveTasks(tasks);
  const last = loadJson<Record<string, string>>(GLOBAL_LAST_CHECK_PATH, {});
  const latest: Record<string, string> = {};
  const changes: AnyObj[] = [];
  for (const t of tasks) {
    const tid = t.id;
    const status = t.status;
    latest[tid] = status;
    const prev = last[tid];
    if (prev !== status) {
      const publish = t.publish || {};
      const shouldPrompt = status === 'success' && (t.dod || {}).pass && !publish.ok;
      changes.push({
        id: tid,
        repo: t.repo,
        worktree: t.worktree,
        tmux_session: t.tmux_session,
        from: prev,
        to: status,
        dod: t.dod || {},
        result_excerpt: (t.result_excerpt || '').slice(-300),
        publish_prompt: shouldPrompt ? '任务已完成且DoD通过，是否现在执行 publish --auto-pr 推送远程并创建PR/MR？' : '',
      });
    }
  }
  saveJson(GLOBAL_LAST_CHECK_PATH, latest);
  printJson({ ok: true, registry: GLOBAL_TASKS_PATH, changes_only: Boolean(opts.changesOnly), changes, tasks: opts.changesOnly ? [] : tasks });
}

function cmdList(): void {
  printJson({ ok: true, registry: GLOBAL_TASKS_PATH, tasks: loadTasks() });
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
    const refreshed = updateStatus({ ...tasks[idx] }, opts);
    tasks[idx] = refreshed;
    saveTasks(tasks);
    printJson({ ok: true, task: taskSummary(refreshed) });
    return;
  }
  if (opts.query) {
    const candidates = findTaskCandidates(tasks, opts.query);
    if (!candidates.length) fail(`no tasks matched query: ${opts.query}`);
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
    const refreshed = updateStatus({ ...tasks[idx] }, opts);
    tasks[idx] = refreshed;
    saveTasks(tasks);
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
    saveTasks(tasks);
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
    saveTasks(tasks);
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
    saveTasks(tasks);
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
  saveTasks(tasks);
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
    saveTasks(tasks);
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
        hard_timeout_sec: opts.hardTimeoutSec,
      },
      tasks,
      true,
      false,
    );
    result.pr = prRes.pr || (tasks.find((t) => t.id === opts.id) || {}).pr || {};
  }

  saveTasks(tasks);
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
      opts[key] = next;
      i += 2;
    }
  }
  return opts;
}

function numOrDefault(v: any, d: number): number {
  const n = Number.parseInt(String(v ?? ''), 10);
  return Number.isNaN(n) ? d : n;
}

function addTimingDefaults(opts: AnyObj): AnyObj {
  return {
    ...opts,
    idle_quiet_sec: numOrDefault(opts.idleQuietSec, 180),
    auto_close_idle_sec: numOrDefault(opts.autoCloseIdleSec, 900),
    hard_timeout_sec: numOrDefault(opts.hardTimeoutSec, 7200),
  };
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
      '  check',
      '  status',
      '  publish',
      '  create-pr',
      '  list',
      '',
    ].join('\n'),
  );
}

function showCommandHelp(cmd: string): void {
  const lines: Record<string, string[]> = {
    spawn: ['usage: swarm.ts spawn --repo <repo> --task <task> [--agent codex|claude] [--name <name>]'],
    'spawn-followup': ['usage: swarm.ts spawn-followup --from <id> --task <task> --worktree-mode new|reuse [--agent codex|claude] [--name <name>]'],
    attach: ['usage: swarm.ts attach --id <id> --message <text>'],
    check: ['usage: swarm.ts check [--changes-only] [--idle-quiet-sec N] [--auto-close-idle-sec N] [--hard-timeout-sec N]'],
    status: ['usage: swarm.ts status [--id <id>|--query <q>] [--idle-quiet-sec N] [--auto-close-idle-sec N] [--hard-timeout-sec N]'],
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
      cmdSpawn({ repo: String(optsRaw.repo), task: String(optsRaw.task), agent: optsRaw.agent, name: optsRaw.name });
      return;
    }
    if (cmd === 'spawn-followup') {
      if (!optsRaw.from || !optsRaw.task || !optsRaw.worktreeMode) fail('spawn-followup requires --from --task --worktree-mode');
      if (!['new', 'reuse'].includes(String(optsRaw.worktreeMode))) fail('worktree mode must be new|reuse');
      cmdSpawnFollowup({ from: String(optsRaw.from), task: String(optsRaw.task), worktreeMode: String(optsRaw.worktreeMode), agent: optsRaw.agent, name: optsRaw.name });
      return;
    }
    if (cmd === 'attach') {
      if (!optsRaw.id || !optsRaw.message) fail('attach requires --id and --message');
      cmdAttach({ id: String(optsRaw.id), message: String(optsRaw.message) });
      return;
    }
    if (cmd === 'check') {
      const o = addTimingDefaults(optsRaw);
      cmdCheck({ ...o, changesOnly: Boolean(optsRaw.changesOnly) });
      return;
    }
    if (cmd === 'status') {
      const o = addTimingDefaults(optsRaw);
      cmdStatus({ ...o, id: optsRaw.id, query: optsRaw.query });
      return;
    }
    if (cmd === 'publish') {
      if (!optsRaw.id) fail('publish requires --id');
      const o = addTimingDefaults(optsRaw);
      cmdPublish({
        ...o,
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
      const o = addTimingDefaults(optsRaw);
      createPrTask({
        ...o,
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
