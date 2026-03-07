#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import pathlib
import re
import shlex
import shutil
import subprocess
import sys
import textwrap
import time
import urllib.parse
import uuid
from typing import Any, Dict, List, Optional, Tuple

GLOBAL_STATE_DIR = pathlib.Path.home() / '.openclaw' / 'agent-swarm'
GLOBAL_WORKTREE_ROOT = GLOBAL_STATE_DIR / 'worktree'
GLOBAL_TASKS_PATH = GLOBAL_STATE_DIR / 'agent-swarm-tasks.json'
GLOBAL_LAST_CHECK_PATH = GLOBAL_STATE_DIR / 'agent-swarm-last-check.json'

ACTIVE_AGENT_COMMANDS = {'codex', 'claude'}
DONE_MARKERS = [
    'final answer',
    'final summary',
    'completed',
    'task completed',
    '任务完成',
    '已完成',
    '完成了',
    '总结如下',
]
WAITING_MARKERS = [
    'need your input',
    'please confirm',
    'please choose',
    'waiting for your input',
    '请确认',
    '是否继续',
    '等待输入',
    '请输入',
]


def run(cmd: List[str], cwd: Optional[str] = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, check=check, text=True, capture_output=True)


def fail(msg: str, code: int = 1):
    print(json.dumps({'ok': False, 'error': msg}, ensure_ascii=False))
    sys.exit(code)


def ensure_global_state_dir() -> None:
    GLOBAL_STATE_DIR.mkdir(parents=True, exist_ok=True)
    GLOBAL_WORKTREE_ROOT.mkdir(parents=True, exist_ok=True)


def load_json(path: pathlib.Path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return default


def save_json(path: pathlib.Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')


def load_tasks() -> List[Dict[str, Any]]:
    ensure_global_state_dir()
    return load_json(GLOBAL_TASKS_PATH, [])


def save_tasks(tasks: List[Dict[str, Any]]) -> None:
    ensure_global_state_dir()
    save_json(GLOBAL_TASKS_PATH, tasks)


def is_git_repo(repo: pathlib.Path) -> bool:
    if not repo.exists() or not repo.is_dir():
        return False
    cp = run(['git', 'rev-parse', '--is-inside-work-tree'], cwd=str(repo), check=False)
    return cp.returncode == 0


def detect_tools() -> Dict[str, bool]:
    return {
        'codex': shutil.which('codex') is not None,
        'claude': shutil.which('claude') is not None,
        'tmux': shutil.which('tmux') is not None,
        'git': shutil.which('git') is not None,
    }


def pick_agent(requested: Optional[str], tools: Dict[str, bool]) -> str:
    if requested:
        if not tools.get(requested):
            fail(f"requested agent '{requested}' is not installed")
        return requested
    if tools.get('codex'):
        return 'codex'
    if tools.get('claude'):
        return 'claude'
    fail('neither codex nor claude is installed')


def validate_agent_command(agent: str) -> None:
    cp = run([agent, '--help'], check=False)
    if cp.returncode != 0:
        err = (cp.stderr or cp.stdout or '').strip()
        fail(f"agent command '{agent}' exists but '--help' failed: {err or 'unknown error'}")


def now_id() -> str:
    t = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    return f'{t}-{uuid.uuid4().hex[:6]}'


def parse_ts(value: Optional[str]) -> dt.datetime:
    if value:
        try:
            return dt.datetime.fromisoformat(value)
        except Exception:
            pass
    return dt.datetime.now()


def current_branch(repo: pathlib.Path) -> str:
    return run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd=str(repo)).stdout.strip()


def create_worktree(repo: pathlib.Path, task_id: str) -> Dict[str, str]:
    ensure_global_state_dir()
    repo_key = repo.name
    base = GLOBAL_WORKTREE_ROOT / repo_key
    base.mkdir(parents=True, exist_ok=True)
    wt = base / task_id
    branch = f'swarm/{task_id}'
    base_branch = current_branch(repo)
    run(['git', 'worktree', 'add', '-b', branch, str(wt), base_branch], cwd=str(repo))
    return {'worktree': str(wt), 'branch': branch, 'base_branch': base_branch}


def prepare_reused_worktree(parent: Dict[str, Any]) -> Tuple[bool, str, Dict[str, str]]:
    wt = pathlib.Path(parent.get('worktree', ''))
    repo = pathlib.Path(parent.get('repo', ''))
    if not wt.exists() or not wt.is_dir():
        return False, 'reuse_guard_failed:worktree_missing', {}
    if not repo.exists() or not repo.is_dir() or not is_git_repo(repo):
        return False, 'reuse_guard_failed:repo_missing_or_not_git', {}
    if not is_git_repo(wt):
        return False, 'reuse_guard_failed:worktree_not_git', {}

    status = run(['git', 'status', '--porcelain'], cwd=str(wt), check=False)
    if status.returncode != 0 or (status.stdout or '').strip() != '':
        return False, 'reuse_guard_failed:worktree_not_clean', {}

    session = parent.get('tmux_session')
    if session:
        alive = run(['tmux', 'has-session', '-t', session], check=False)
        if alive.returncode == 0:
            return False, 'reuse_guard_failed:parent_session_running', {}

    head = run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd=str(wt), check=False)
    if head.returncode != 0:
        return False, 'reuse_guard_failed:branch_unresolvable', {}

    return True, 'ok', {
        'worktree': str(wt),
        'branch': head.stdout.strip() or parent.get('branch', ''),
        'base_branch': parent.get('base_branch', ''),
    }


def build_agent_start_command(agent: str, exit_path: pathlib.Path) -> str:
    if agent == 'codex':
        base = 'codex --dangerously-bypass-approvals-and-sandbox'
    elif agent == 'claude':
        base = 'claude --dangerously-skip-permissions'
    else:
        fail(f'unsupported agent: {agent}')

    return (
        'set -o pipefail; '
        f'{base}; '
        'ec=$?; '
        f'echo "$ec" > {shlex.quote(str(exit_path))}; '
        'exec bash'
    )


def tmux_send_text(session: str, text: str) -> None:
    run(['tmux', 'send-keys', '-t', session, text, 'Enter'])
    run(['tmux', 'send-keys', '-t', session, 'Enter'])


def tmux_prime_session(session: str) -> None:
    run(['tmux', 'send-keys', '-t', session, 'Enter'])


def tmux_alive(session: Optional[str]) -> bool:
    if not session:
        return False
    return run(['tmux', 'has-session', '-t', session], check=False).returncode == 0


def tmux_current_command(session: str) -> str:
    cp = run(['tmux', 'display-message', '-p', '-t', session, '#{pane_current_command}'], check=False)
    if cp.returncode != 0:
        return ''
    return (cp.stdout or '').strip().lower()


def is_agent_pane_command(cmd: str, agent: str) -> bool:
    if not cmd:
        return False
    if cmd == agent:
        return True
    # Some wrappers may show node as pane current command.
    return cmd == 'node'


def wait_for_agent_ready(session: str, agent: str, timeout_sec: int = 20) -> bool:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if not tmux_alive(session):
            return False
        cmd = tmux_current_command(session)
        if is_agent_pane_command(cmd, agent):
            return True
        time.sleep(0.2)
    return False


def tmux_close_session(session: str) -> bool:
    if not tmux_alive(session):
        return True
    run(['tmux', 'send-keys', '-t', session, '/exit', 'Enter'], check=False)
    run(['tmux', 'send-keys', '-t', session, 'exit', 'Enter'], check=False)
    run(['tmux', 'send-keys', '-t', session, 'C-d'], check=False)
    run(['tmux', 'kill-session', '-t', session], check=False)
    return not tmux_alive(session)


def read_log_excerpt(log_path: pathlib.Path, max_chars: int = 1200) -> str:
    if not log_path.exists():
        return ''
    try:
        return log_path.read_text(encoding='utf-8', errors='ignore')[-max_chars:].strip()
    except Exception:
        return ''


def text_contains_any(text: str, markers: List[str]) -> bool:
    lowered = text.lower()
    return any(m in lowered for m in markers)


def ensure_unique_task_id(task_id: str, tasks: List[Dict[str, Any]]) -> None:
    if any(t.get('id') == task_id for t in tasks):
        fail(f'task id already exists: {task_id}')


def build_prompt(task_id: str, repo: pathlib.Path, worktree: str, user_task: str, parent_task_id: str = '') -> str:
    parent_line = f'Parent Task ID: {parent_task_id}\n' if parent_task_id else ''
    return textwrap.dedent(
        f'''
        You are a coding agent running in a git worktree.

        Task ID: {task_id}
        {parent_line}Repo: {repo}
        Worktree: {worktree}

        User task:
        {user_task}

        Rules:
        1) Make focused changes for this task only.
        2) Commit with clear message when done.
        3) Print concise final summary and next steps.
        '''
    ).strip() + '\n'


def spawn_in_tmux(
    task_id: str,
    repo: pathlib.Path,
    worktree_meta: Dict[str, str],
    agent: str,
    user_task: str,
    tasks: List[Dict[str, Any]],
    parent_task_id: str = '',
) -> Dict[str, Any]:
    ensure_global_state_dir()
    per_repo_state = GLOBAL_STATE_DIR
    (per_repo_state / 'logs').mkdir(parents=True, exist_ok=True)
    (per_repo_state / 'prompts').mkdir(parents=True, exist_ok=True)

    session = f"swarm-{task_id}".replace('/', '-')
    prompt_path = per_repo_state / 'prompts' / f'{task_id}.txt'
    log_path = per_repo_state / 'logs' / f'{task_id}.log'
    exit_path = per_repo_state / 'logs' / f'{task_id}.exit'

    prompt_text = build_prompt(task_id, repo, worktree_meta['worktree'], user_task, parent_task_id)
    prompt_path.write_text(prompt_text, encoding='utf-8')
    log_path.write_text('', encoding='utf-8')

    cmd = build_agent_start_command(agent, exit_path)
    run(['tmux', 'new-session', '-d', '-s', session, '-c', worktree_meta['worktree'], 'bash', '-lc', cmd])
    run(['tmux', 'pipe-pane', '-o', '-t', session, f"cat >> {shlex.quote(str(log_path))}"], check=False)
    if not wait_for_agent_ready(session, agent, 20):
        if exit_path.exists():
            tail = read_log_excerpt(log_path, 300)
            tmux_close_session(session)
            fail(f'agent failed before ready in tmux session: {session}; {tail}')
        # Avoid false negatives from pane command detection; keep session and continue.
        time.sleep(1)
    tmux_prime_session(session)
    tmux_send_text(session, prompt_text)

    now = dt.datetime.now().isoformat()
    task = {
        'id': task_id,
        'status': 'running',
        'agent': agent,
        'repo': str(repo),
        'worktree': worktree_meta['worktree'],
        'branch': worktree_meta['branch'],
        'base_branch': worktree_meta['base_branch'],
        'tmux_session': session,
        'task': user_task,
        'parent_task_id': parent_task_id,
        'created_at': now,
        'updated_at': now,
        'last_activity_at': now,
        'log': str(log_path),
        'exit_file': str(exit_path),
    }
    tasks.append(task)
    save_tasks(tasks)
    return task


def spawn_task(args):
    repo = pathlib.Path(args.repo).resolve()
    if not is_git_repo(repo):
        fail(f'target is not a git repository: {repo}')

    tools = detect_tools()
    if not tools['tmux']:
        fail('tmux is not installed')
    if not tools['git']:
        fail('git is not installed')

    tasks = load_tasks()
    agent = pick_agent(args.agent, tools)
    validate_agent_command(agent)
    task_id = args.name or now_id()
    ensure_unique_task_id(task_id, tasks)

    wt_meta = create_worktree(repo, task_id)
    task = spawn_in_tmux(task_id, repo, wt_meta, agent, args.task, tasks)
    print(json.dumps({'ok': True, 'task': task, 'tools': tools, 'registry': str(GLOBAL_TASKS_PATH)}, ensure_ascii=False, indent=2))


def spawn_followup_task(args):
    tasks = load_tasks()
    parent = next((t for t in tasks if t.get('id') == args.from_id), None)
    if not parent:
        fail(f'task not found: {args.from_id}')

    repo = pathlib.Path(parent.get('repo', '')).resolve()
    if not is_git_repo(repo):
        fail(f'parent repo is invalid or not git: {repo}')

    tools = detect_tools()
    if not tools['tmux']:
        fail('tmux is not installed')
    if not tools['git']:
        fail('git is not installed')

    agent = pick_agent(args.agent, tools)
    validate_agent_command(agent)
    task_id = args.name or now_id()
    ensure_unique_task_id(task_id, tasks)

    if args.worktree_mode == 'new':
        wt_meta = create_worktree(repo, task_id)
    else:
        ok, reason, wt_meta = prepare_reused_worktree(parent)
        if not ok:
            fail(reason)

    task = spawn_in_tmux(task_id, repo, wt_meta, agent, args.task, tasks, parent_task_id=parent.get('id', ''))
    task['worktree_mode'] = args.worktree_mode
    save_tasks(tasks)
    print(json.dumps({'ok': True, 'task': task, 'parent_id': parent.get('id'), 'registry': str(GLOBAL_TASKS_PATH)}, ensure_ascii=False, indent=2))


def find_task_candidates(tasks: List[Dict[str, Any]], query: str) -> List[Dict[str, Any]]:
    q = query.strip().lower()
    candidates: List[Dict[str, Any]] = []
    for t in tasks:
        fields = [
            t.get('id', ''),
            t.get('tmux_session', ''),
            t.get('branch', ''),
            t.get('task', ''),
        ]
        score = 0
        for f in fields:
            fv = str(f).lower()
            if q == fv:
                score = max(score, 100)
            elif q in fv:
                score = max(score, 10)
        if score > 0:
            item = dict(t)
            item['_score'] = score
            candidates.append(item)
    candidates.sort(key=lambda x: x.get('_score', 0), reverse=True)
    return candidates


def parse_remote_url(remote_url: str) -> Dict[str, str]:
    """Parse git remote URL into forge + host + repo_path."""
    url = remote_url.strip()
    host = ''
    repo_path = ''
    if url.startswith('http://') or url.startswith('https://'):
        parsed = urllib.parse.urlparse(url)
        host = parsed.netloc.lower()
        repo_path = parsed.path.strip('/')
    else:
        m = re.match(r'^(?:[^@]+@)?([^:]+):(.+)$', url)
        if m:
            host = m.group(1).lower()
            repo_path = m.group(2).strip('/')

    if repo_path.endswith('.git'):
        repo_path = repo_path[:-4]

    forge = 'unknown'
    if 'github' in host:
        forge = 'github'
    elif 'gitlab' in host:
        forge = 'gitlab'
    elif 'gitea' in host:
        forge = 'gitea'

    return {'forge': forge, 'host': host, 'repo_path': repo_path, 'remote_url': remote_url}


def get_remote_info(worktree: str, remote: str) -> Dict[str, str]:
    cp = run(['git', 'remote', 'get-url', remote], cwd=worktree, check=False)
    if cp.returncode != 0:
        fail(f"remote not found: {remote}")
    remote_url = (cp.stdout or '').strip()
    if not remote_url:
        fail(f"remote url is empty: {remote}")
    return parse_remote_url(remote_url)


def build_manual_pr_url(forge_info: Dict[str, str], source_branch: str, target_branch: str) -> str:
    forge = forge_info.get('forge', 'unknown')
    host = forge_info.get('host', '')
    repo_path = forge_info.get('repo_path', '')
    if not host or not repo_path:
        return ''

    if forge == 'github':
        source = urllib.parse.quote(source_branch, safe='')
        target = urllib.parse.quote(target_branch, safe='')
        return f"https://{host}/{repo_path}/compare/{target}...{source}?expand=1"
    if forge == 'gitlab':
        source = urllib.parse.quote(source_branch, safe='')
        target = urllib.parse.quote(target_branch, safe='')
        return (
            f"https://{host}/{repo_path}/-/merge_requests/new"
            f"?merge_request[source_branch]={source}&merge_request[target_branch]={target}"
        )
    return ''


def ensure_publishable(task: Dict[str, Any]) -> None:
    if task.get('status') != 'success':
        fail(f"task is not success: {task.get('status')}")
    dod = task.get('dod') or evaluate_default_dod(task)
    task['dod'] = dod
    if not dod.get('pass'):
        fail(f"task DoD not pass: {dod.get('reason', 'unknown')}")


def run_push(worktree: str, remote: str, branch: str) -> Tuple[bool, str]:
    cp = run(['git', 'push', '-u', remote, branch], cwd=worktree, check=False)
    if cp.returncode == 0:
        return True, ''
    err = (cp.stderr or cp.stdout or '').strip()
    return False, err or f'git push failed with code {cp.returncode}'


def detect_pr_cli(forge: str) -> str:
    if forge == 'github' and shutil.which('gh'):
        return 'gh'
    if forge == 'gitlab' and shutil.which('glab'):
        return 'glab'
    return ''


def create_pr_with_cli(
    cli_name: str,
    task: Dict[str, Any],
    target_branch: str,
    title: str,
    body: str,
) -> Tuple[bool, Dict[str, Any]]:
    worktree = task.get('worktree', '')
    source_branch = task.get('branch', '')

    if cli_name == 'gh':
        cmd = [
            'gh', 'pr', 'create',
            '--base', target_branch,
            '--head', source_branch,
            '--title', title,
            '--body', body,
        ]
        cp = run(cmd, cwd=worktree, check=False)
        if cp.returncode == 0:
            url = (cp.stdout or '').strip().splitlines()[-1] if (cp.stdout or '').strip() else ''
            return True, {'cli': 'gh', 'pr_url': url, 'raw_output': (cp.stdout or '').strip()}
        return False, {'cli': 'gh', 'error': (cp.stderr or cp.stdout or '').strip()}

    if cli_name == 'glab':
        cmd = [
            'glab', 'mr', 'create',
            '--source-branch', source_branch,
            '--target-branch', target_branch,
            '--title', title,
            '--description', body,
            '--yes',
        ]
        cp = run(cmd, cwd=worktree, check=False)
        if cp.returncode == 0:
            text = (cp.stdout or '').strip()
            mr_url = ''
            for line in text.splitlines():
                if line.startswith('http://') or line.startswith('https://'):
                    mr_url = line.strip()
            return True, {'cli': 'glab', 'pr_url': mr_url, 'raw_output': text}
        return False, {'cli': 'glab', 'error': (cp.stderr or cp.stdout or '').strip()}

    return False, {'error': f'unsupported cli: {cli_name}'}


def ensure_task_refreshed(tasks: List[Dict[str, Any]], task_id: str, args) -> Dict[str, Any]:
    idx = next((i for i, t in enumerate(tasks) if t.get('id') == task_id), None)
    if idx is None:
        fail(f'task not found: {task_id}')
    refreshed = update_status(dict(tasks[idx]), args)
    tasks[idx] = refreshed
    return refreshed


def default_pr_title(task: Dict[str, Any]) -> str:
    title = (task.get('task') or '').strip()
    if title:
        return title[:120]
    return f"Task {task.get('id', '')}"


def default_pr_body(task: Dict[str, Any]) -> str:
    return (
        f"Auto-published from openclaw-agent-swarm.\n\n"
        f"- Task ID: {task.get('id', '')}\n"
        f"- Agent: {task.get('agent', '')}\n"
        f"- Source branch: {task.get('branch', '')}\n"
        f"- Target branch: {task.get('base_branch', '')}\n"
    )


def publish_task(args):
    tasks = load_tasks()
    task = ensure_task_refreshed(tasks, args.id, args)
    ensure_publishable(task)

    worktree = task.get('worktree', '')
    branch = task.get('branch', '')
    remote = args.remote
    target_branch = args.target_branch or task.get('base_branch', '')
    if not target_branch:
        fail('target branch is empty; use --target-branch')

    remote_info = get_remote_info(worktree, remote)
    ok, error = run_push(worktree, remote, branch)
    task['updated_at'] = dt.datetime.now().isoformat()
    task['publish'] = {
        'ok': ok,
        'remote': remote,
        'remote_branch': branch,
        'target_branch': target_branch,
        'published_at': task['updated_at'] if ok else '',
        'error': error,
        'forge': remote_info.get('forge'),
        'remote_url': remote_info.get('remote_url'),
    }

    result: Dict[str, Any] = {
        'ok': ok,
        'id': task.get('id'),
        'publish': task['publish'],
    }
    if not ok:
        manual_url = build_manual_pr_url(remote_info, branch, target_branch)
        if manual_url:
            result['manual_pr_url'] = manual_url
        save_tasks(tasks)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    if args.auto_pr:
        pr_args = argparse.Namespace(
            id=args.id,
            remote=remote,
            target_branch=target_branch,
            title=args.title,
            body=args.body,
            idle_quiet_sec=args.idle_quiet_sec,
            auto_close_idle_sec=args.auto_close_idle_sec,
            hard_timeout_sec=args.hard_timeout_sec,
        )
        pr_result = create_pr_task(pr_args, tasks=tasks, already_refreshed=True, emit_output=False)
        task = next((t for t in tasks if t.get('id') == args.id), task)
        result['pr'] = (pr_result or {}).get('pr', task.get('pr', {}))

    save_tasks(tasks)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def create_pr_task(
    args,
    tasks: Optional[List[Dict[str, Any]]] = None,
    already_refreshed: bool = False,
    emit_output: bool = True,
) -> Dict[str, Any]:
    if tasks is None:
        tasks = load_tasks()
    task = ensure_task_refreshed(tasks, args.id, args) if not already_refreshed else next(
        (t for t in tasks if t.get('id') == args.id), None
    )
    if not task:
        fail(f'task not found: {args.id}')

    worktree = task.get('worktree', '')
    source_branch = task.get('branch', '')
    target_branch = args.target_branch or task.get('base_branch', '')
    if not target_branch:
        fail('target branch is empty; use --target-branch')

    remote = args.remote
    remote_info = get_remote_info(worktree, remote)
    manual_url = build_manual_pr_url(remote_info, source_branch, target_branch)

    # Ensure branch is published before trying PR API.
    push_ok, push_error = run_push(worktree, remote, source_branch)
    if not push_ok:
        task['pr'] = {
            'ok': False,
            'state': 'manual_required',
            'error': f'push_failed_before_pr:{push_error}',
            'manual_url': manual_url,
            'forge': remote_info.get('forge'),
            'remote_url': remote_info.get('remote_url'),
        }
        task['updated_at'] = dt.datetime.now().isoformat()
        if tasks is not None:
            save_tasks(tasks)
        payload = {'ok': False, 'id': task.get('id'), 'pr': task['pr']}
        if emit_output:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        return payload

    title = args.title or default_pr_title(task)
    body = args.body or default_pr_body(task)
    cli_name = detect_pr_cli(remote_info.get('forge', 'unknown'))

    if not cli_name:
        task['pr'] = {
            'ok': False,
            'state': 'manual_required',
            'error': 'no_supported_pr_cli',
            'manual_url': manual_url,
            'forge': remote_info.get('forge'),
            'remote_url': remote_info.get('remote_url'),
        }
        task['updated_at'] = dt.datetime.now().isoformat()
        if tasks is not None:
            save_tasks(tasks)
        payload = {'ok': True, 'id': task.get('id'), 'pr': task['pr']}
        if emit_output:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        return payload

    created, detail = create_pr_with_cli(cli_name, task, target_branch, title, body)
    task['updated_at'] = dt.datetime.now().isoformat()
    if created:
        task['pr'] = {
            'ok': True,
            'state': 'opened',
            'url': detail.get('pr_url', ''),
            'cli': cli_name,
            'forge': remote_info.get('forge'),
            'remote_url': remote_info.get('remote_url'),
            'target_branch': target_branch,
            'source_branch': source_branch,
        }
        if tasks is not None:
            save_tasks(tasks)
        payload = {'ok': True, 'id': task.get('id'), 'pr': task['pr']}
        if emit_output:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        return payload

    task['pr'] = {
        'ok': False,
        'state': 'manual_required',
        'error': detail.get('error', 'pr_create_failed'),
        'manual_url': manual_url,
        'cli': cli_name,
        'forge': remote_info.get('forge'),
        'remote_url': remote_info.get('remote_url'),
        'target_branch': target_branch,
        'source_branch': source_branch,
    }
    if tasks is not None:
        save_tasks(tasks)
    payload = {'ok': True, 'id': task.get('id'), 'pr': task['pr']}
    if emit_output:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    return payload


def attach_task(args):
    tasks = load_tasks()
    task = next((t for t in tasks if t.get('id') == args.id), None)
    if not task:
        fail(f'task not found: {args.id}')

    msg = args.message.strip()
    if not msg:
        fail('message is empty')

    status = task.get('status', 'unknown')
    running_like = {'running', 'awaiting_input', 'auto_closing'}
    if status not in running_like:
        print(json.dumps({
            'ok': True,
            'id': args.id,
            'sent': False,
            'requires_confirmation': True,
            'reason': f'task_not_running:{status}',
            'actions': [
                {'action': 'spawn_followup_new_worktree', 'recommended': True},
                {'action': 'spawn_followup_reuse_worktree', 'recommended': False},
                {'action': 'force_attach_legacy_session', 'recommended': False},
            ],
        }, ensure_ascii=False, indent=2))
        return

    session = task.get('tmux_session', '')
    if not tmux_alive(session):
        print(json.dumps({
            'ok': True,
            'id': args.id,
            'sent': False,
            'requires_confirmation': True,
            'reason': 'session_not_alive',
            'actions': [
                {'action': 'spawn_followup_new_worktree', 'recommended': True},
                {'action': 'spawn_followup_reuse_worktree', 'recommended': False},
            ],
        }, ensure_ascii=False, indent=2))
        return

    try:
        tmux_send_text(session, msg)
    except Exception as e:
        fail(f'failed to send message to tmux session {session}: {e}')

    task['status'] = 'running'
    task['updated_at'] = dt.datetime.now().isoformat()
    task['last_activity_at'] = task['updated_at']
    save_tasks(tasks)
    print(json.dumps({'ok': True, 'id': args.id, 'sent': True, 'session': session}, ensure_ascii=False))


def evaluate_default_dod(task: Dict[str, Any]) -> Dict[str, Any]:
    worktree = task.get('worktree')
    base_branch = task.get('base_branch')
    branch = task.get('branch')

    result = {
        'checked': True,
        'pass': False,
        'commit': False,
        'clean_worktree': False,
        'reason': '',
    }

    if not worktree or not pathlib.Path(worktree).exists():
        result['reason'] = 'worktree_missing'
        return result

    if task.get('status') != 'success':
        result['reason'] = f"status_not_success:{task.get('status')}"
        return result

    if base_branch and branch:
        cp = run(['git', 'rev-list', '--count', f'{base_branch}..{branch}'], cwd=worktree, check=False)
        try:
            result['commit'] = cp.returncode == 0 and int((cp.stdout or '0').strip() or '0') > 0
        except Exception:
            result['commit'] = False

    sp = run(['git', 'status', '--porcelain'], cwd=worktree, check=False)
    result['clean_worktree'] = sp.returncode == 0 and (sp.stdout or '').strip() == ''

    result['pass'] = bool(result['commit'] and result['clean_worktree'])
    if not result['pass']:
        if not result['commit']:
            result['reason'] = 'no_commit_on_task_branch'
        elif not result['clean_worktree']:
            result['reason'] = 'worktree_not_clean'
    else:
        result['reason'] = 'ok'

    return result


def update_status(task: Dict[str, Any], args) -> Dict[str, Any]:
    old = task.get('status', 'unknown')
    session = task.get('tmux_session', '')
    exit_file = pathlib.Path(task.get('exit_file', ''))
    log_path = pathlib.Path(task.get('log', ''))
    now = dt.datetime.now()

    excerpt = read_log_excerpt(log_path)
    task['result_excerpt'] = excerpt

    prev_excerpt = task.get('_last_excerpt', '')
    if excerpt != prev_excerpt:
        task['last_activity_at'] = now.isoformat()
        task['_last_excerpt'] = excerpt

    last_activity = parse_ts(task.get('last_activity_at') or task.get('updated_at') or task.get('created_at'))
    idle_sec = max(0, int((now - last_activity).total_seconds()))

    alive = tmux_alive(session)
    pane_cmd = tmux_current_command(session) if alive else ''

    has_done_marker = text_contains_any(excerpt, DONE_MARKERS)
    has_wait_marker = text_contains_any(excerpt, WAITING_MARKERS)

    new = old
    idle_quiet_sec = getattr(args, 'idle_quiet_sec', 180)
    auto_close_idle_sec = getattr(args, 'auto_close_idle_sec', 900)
    hard_timeout_sec = getattr(args, 'hard_timeout_sec', 7200)

    if not alive:
        if exit_file.exists():
            code = exit_file.read_text(encoding='utf-8').strip() or '1'
            try:
                task['exit_code'] = int(code)
            except Exception:
                task['exit_code'] = 1
            new = 'success' if str(task['exit_code']) == '0' else 'failed'
        elif old in {'running', 'awaiting_input', 'auto_closing'}:
            new = 'stopped'
        else:
            new = old
    else:
        if pane_cmd in ACTIVE_AGENT_COMMANDS:
            if has_wait_marker:
                new = 'awaiting_input'
            elif has_done_marker and idle_sec >= auto_close_idle_sec:
                new = 'auto_closing'
                if tmux_close_session(session):
                    if exit_file.exists():
                        code = exit_file.read_text(encoding='utf-8').strip() or '1'
                        try:
                            task['exit_code'] = int(code)
                        except Exception:
                            task['exit_code'] = 1
                        new = 'success' if str(task['exit_code']) == '0' else 'failed'
                    else:
                        new = 'success'
                else:
                    new = 'needs_human'
            else:
                new = 'running'
        else:
            # Session is alive but agent process is gone (usually back to shell).
            if exit_file.exists():
                code = exit_file.read_text(encoding='utf-8').strip() or '1'
                try:
                    task['exit_code'] = int(code)
                except Exception:
                    task['exit_code'] = 1
                if idle_sec >= idle_quiet_sec:
                    if tmux_close_session(session):
                        new = 'success' if str(task['exit_code']) == '0' else 'failed'
                    else:
                        new = 'needs_human'
                else:
                    new = 'auto_closing'
            elif idle_sec >= hard_timeout_sec:
                new = 'needs_human'
            else:
                new = 'running'

    task['status'] = new
    if new != old:
        task['updated_at'] = now.isoformat()

    task['dod'] = evaluate_default_dod(task)
    return task


def task_summary(task: Dict[str, Any]) -> Dict[str, Any]:
    status = task.get('status', 'unknown')
    publish = task.get('publish') or {}
    pr = task.get('pr') or {}
    if status in {'running', 'awaiting_input'}:
        next_step = 'attach 补充要求，或等待 heartbeat 下次轮询'
    elif status in {'success'}:
        if publish.get('ok'):
            if pr.get('ok'):
                next_step = 'PR/MR 已创建，继续评审与合并'
            else:
                next_step = '分支已推送，执行 create-pr 或按手工链接创建 PR/MR'
        else:
            next_step = '任务已完成，是否执行 publish --auto-pr 推送并创建 PR/MR'
    elif status in {'failed', 'needs_human'}:
        next_step = '查看日志并 attach 修正，或创建 follow-up 任务'
    else:
        next_step = '检查 session 与任务状态，必要时重试'

    return {
        'id': task.get('id'),
        'agent': task.get('agent'),
        'repo': task.get('repo'),
        'worktree': task.get('worktree'),
        'branch': task.get('branch'),
        'tmux_session': task.get('tmux_session'),
        'status': status,
        'dod': task.get('dod', {}),
        'publish': publish,
        'pr': pr,
        'result_excerpt': (task.get('result_excerpt') or '')[-400:],
        'next_step': next_step,
    }


def check_tasks(args):
    tasks = [update_status(dict(t), args) for t in load_tasks()]
    save_tasks(tasks)

    last = load_json(GLOBAL_LAST_CHECK_PATH, {})
    latest = {}
    changes = []

    for t in tasks:
        tid = t.get('id')
        status = t.get('status')
        latest[tid] = status
        prev = last.get(tid)
        if prev != status:
            publish = t.get('publish') or {}
            should_prompt_publish = status == 'success' and (t.get('dod') or {}).get('pass') and not publish.get('ok')
            changes.append({
                'id': tid,
                'repo': t.get('repo'),
                'worktree': t.get('worktree'),
                'tmux_session': t.get('tmux_session'),
                'from': prev,
                'to': status,
                'dod': t.get('dod', {}),
                'result_excerpt': (t.get('result_excerpt') or '')[-300:],
                'publish_prompt': (
                    '任务已完成且DoD通过，是否现在执行 publish --auto-pr 推送远程并创建PR/MR？'
                    if should_prompt_publish else ''
                ),
            })

    save_json(GLOBAL_LAST_CHECK_PATH, latest)
    payload = {
        'ok': True,
        'registry': str(GLOBAL_TASKS_PATH),
        'changes_only': bool(args.changes_only),
        'changes': changes,
        'tasks': [] if args.changes_only else tasks,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def list_tasks(_args):
    print(json.dumps({'ok': True, 'registry': str(GLOBAL_TASKS_PATH), 'tasks': load_tasks()}, ensure_ascii=False, indent=2))


def status_task(args):
    tasks = load_tasks()
    if not tasks:
        print(json.dumps({'ok': True, 'task': None, 'message': 'no tasks found'}, ensure_ascii=False, indent=2))
        return

    if args.id:
        task = next((t for t in tasks if t.get('id') == args.id), None)
        if not task:
            fail(f'task not found: {args.id}')
        refreshed = update_status(dict(task), args)
        for i, t in enumerate(tasks):
            if t.get('id') == args.id:
                tasks[i] = refreshed
                break
        save_tasks(tasks)
        print(json.dumps({'ok': True, 'task': task_summary(refreshed)}, ensure_ascii=False, indent=2))
        return

    if args.query:
        candidates = find_task_candidates(tasks, args.query)
        if not candidates:
            fail(f'no tasks matched query: {args.query}')
        if len(candidates) > 1 and candidates[0].get('_score') == candidates[1].get('_score'):
            print(json.dumps({
                'ok': False,
                'requires_confirmation': True,
                'error': f'ambiguous query: {args.query}',
                'candidates': [
                    {
                        'id': c.get('id'),
                        'branch': c.get('branch'),
                        'tmux_session': c.get('tmux_session'),
                        'status': c.get('status'),
                    }
                    for c in candidates[:5]
                ],
            }, ensure_ascii=False, indent=2))
            return

        target = candidates[0]
        refreshed = update_status(dict(target), args)
        for i, t in enumerate(tasks):
            if t.get('id') == refreshed.get('id'):
                tasks[i] = refreshed
                break
        save_tasks(tasks)
        print(json.dumps({'ok': True, 'task': task_summary(refreshed)}, ensure_ascii=False, indent=2))
        return

    latest = sorted(tasks, key=lambda x: x.get('updated_at', ''), reverse=True)[:10]
    print(json.dumps({'ok': True, 'tasks': [task_summary(t) for t in latest]}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description='OpenClaw task swarm helper')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p_spawn = sub.add_parser('spawn')
    p_spawn.add_argument('--repo', required=True)
    p_spawn.add_argument('--task', required=True)
    p_spawn.add_argument('--agent', choices=['codex', 'claude'])
    p_spawn.add_argument('--name')
    p_spawn.set_defaults(func=spawn_task)

    p_follow = sub.add_parser('spawn-followup')
    p_follow.add_argument('--from', dest='from_id', required=True)
    p_follow.add_argument('--task', required=True)
    p_follow.add_argument('--worktree-mode', choices=['new', 'reuse'], required=True)
    p_follow.add_argument('--agent', choices=['codex', 'claude'])
    p_follow.add_argument('--name')
    p_follow.set_defaults(func=spawn_followup_task)

    p_attach = sub.add_parser('attach')
    p_attach.add_argument('--id', required=True)
    p_attach.add_argument('--message', required=True)
    p_attach.set_defaults(func=attach_task)

    p_check = sub.add_parser('check')
    p_check.add_argument('--changes-only', action='store_true')
    p_check.add_argument('--idle-quiet-sec', type=int, default=180)
    p_check.add_argument('--auto-close-idle-sec', type=int, default=900)
    p_check.add_argument('--hard-timeout-sec', type=int, default=7200)
    p_check.set_defaults(func=check_tasks)

    p_status = sub.add_parser('status')
    p_status.add_argument('--id')
    p_status.add_argument('--query')
    p_status.add_argument('--idle-quiet-sec', type=int, default=180)
    p_status.add_argument('--auto-close-idle-sec', type=int, default=900)
    p_status.add_argument('--hard-timeout-sec', type=int, default=7200)
    p_status.set_defaults(func=status_task)

    p_publish = sub.add_parser('publish')
    p_publish.add_argument('--id', required=True)
    p_publish.add_argument('--remote', default='origin')
    p_publish.add_argument('--target-branch')
    p_publish.add_argument('--auto-pr', action='store_true')
    p_publish.add_argument('--title')
    p_publish.add_argument('--body')
    p_publish.add_argument('--idle-quiet-sec', type=int, default=180)
    p_publish.add_argument('--auto-close-idle-sec', type=int, default=900)
    p_publish.add_argument('--hard-timeout-sec', type=int, default=7200)
    p_publish.set_defaults(func=publish_task)

    p_pr = sub.add_parser('create-pr')
    p_pr.add_argument('--id', required=True)
    p_pr.add_argument('--remote', default='origin')
    p_pr.add_argument('--target-branch')
    p_pr.add_argument('--title')
    p_pr.add_argument('--body')
    p_pr.add_argument('--idle-quiet-sec', type=int, default=180)
    p_pr.add_argument('--auto-close-idle-sec', type=int, default=900)
    p_pr.add_argument('--hard-timeout-sec', type=int, default=7200)
    p_pr.set_defaults(func=create_pr_task)

    p_list = sub.add_parser('list')
    p_list.set_defaults(func=list_tasks)

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
