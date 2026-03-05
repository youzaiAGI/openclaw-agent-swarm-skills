#!/usr/bin/env python3
import argparse
import datetime as dt
import json
import pathlib
import shlex
import shutil
import subprocess
import sys
import textwrap
import uuid
from typing import Dict, Any, List

GLOBAL_STATE_DIR = pathlib.Path.home() / '.openclaw' / 'agent-swarm'
GLOBAL_WORKTREE_ROOT = GLOBAL_STATE_DIR / 'worktree'
GLOBAL_TASKS_PATH = GLOBAL_STATE_DIR / 'agent-swarm-tasks.json'
GLOBAL_LAST_CHECK_PATH = GLOBAL_STATE_DIR / 'agent-swarm-last-check.json'


def run(cmd: List[str], cwd: str = None, check: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=cwd, check=check, text=True, capture_output=True)


def fail(msg: str, code: int = 1):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
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


def is_git_repo(repo: pathlib.Path) -> bool:
    if not repo.exists() or not repo.is_dir():
        return False
    try:
        run(['git', 'rev-parse', '--is-inside-work-tree'], cwd=str(repo))
        return True
    except Exception:
        return False


def detect_tools() -> Dict[str, bool]:
    return {
        'codex': shutil.which('codex') is not None,
        'claude': shutil.which('claude') is not None,
        'tmux': shutil.which('tmux') is not None,
        'git': shutil.which('git') is not None,
    }


def pick_agent(requested: str, tools: Dict[str, bool]) -> str:
    if requested:
        if not tools.get(requested):
            fail(f"requested agent '{requested}' is not installed")
        return requested
    if tools.get('codex'):
        return 'codex'
    if tools.get('claude'):
        return 'claude'
    fail('neither codex nor claude is installed')


def now_id() -> str:
    t = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    return f"{t}-{uuid.uuid4().hex[:6]}"


def current_branch(repo: pathlib.Path) -> str:
    return run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd=str(repo)).stdout.strip()


def create_worktree(repo: pathlib.Path, task_id: str) -> Dict[str, str]:
    ensure_global_state_dir()
    repo_key = repo.name
    base = GLOBAL_WORKTREE_ROOT / repo_key
    base.mkdir(parents=True, exist_ok=True)
    wt = base / task_id
    branch = f"swarm/{task_id}"
    base_branch = current_branch(repo)
    run(['git', 'worktree', 'add', '-b', branch, str(wt), base_branch], cwd=str(repo))
    return {'worktree': str(wt), 'branch': branch, 'base_branch': base_branch}


def build_agent_command(agent: str, prompt_file: pathlib.Path) -> str:
    # Default to dangerous/skip-confirmation mode to avoid interactive approvals in tmux background runs.
    if agent == 'codex':
        return (
            f"codex --dangerously-bypass-approvals-and-sandbox "
            f"< {shlex.quote(str(prompt_file))}"
        )
    if agent == 'claude':
        return (
            f"claude --dangerously-skip-permissions "
            f"-p \"$(cat {shlex.quote(str(prompt_file))})\""
        )
    fail(f'unsupported agent: {agent}')


def load_tasks() -> List[Dict[str, Any]]:
    ensure_global_state_dir()
    return load_json(GLOBAL_TASKS_PATH, [])


def save_tasks(tasks: List[Dict[str, Any]]) -> None:
    ensure_global_state_dir()
    save_json(GLOBAL_TASKS_PATH, tasks)


def spawn_task(args):
    repo = pathlib.Path(args.repo).resolve()
    if not is_git_repo(repo):
        fail(f'target is not a git repository: {repo}')

    tools = detect_tools()
    if not tools['tmux']:
        fail('tmux is not installed')
    if not tools['git']:
        fail('git is not installed')

    agent = pick_agent(args.agent, tools)
    task_id = args.name or now_id()

    tasks = load_tasks()
    if any(t.get('id') == task_id for t in tasks):
        fail(f'task id already exists: {task_id}')

    wt_meta = create_worktree(repo, task_id)
    session = f"swarm-{task_id}".replace('/', '-')

    ensure_global_state_dir()
    per_repo_state = GLOBAL_STATE_DIR
    (per_repo_state / 'logs').mkdir(parents=True, exist_ok=True)
    (per_repo_state / 'prompts').mkdir(parents=True, exist_ok=True)

    prompt_text = textwrap.dedent(f"""
    You are a coding agent running in a git worktree.

    Task ID: {task_id}
    Repo: {repo}
    Worktree: {wt_meta['worktree']}

    User task:
    {args.task}

    Rules:
    1) Make focused changes for this task only.
    2) Commit with clear message when done.
    3) Print concise final summary and next steps.
    """).strip() + '\n'

    prompt_path = per_repo_state / 'prompts' / f'{task_id}.txt'
    log_path = per_repo_state / 'logs' / f'{task_id}.log'
    exit_path = per_repo_state / 'logs' / f'{task_id}.exit'
    prompt_path.write_text(prompt_text, encoding='utf-8')

    agent_cmd = build_agent_command(agent, prompt_path)
    inner = (
        f"cd {shlex.quote(wt_meta['worktree'])} && "
        f"( {agent_cmd} ) >> {shlex.quote(str(log_path))} 2>&1; "
        f"ec=$?; echo $ec > {shlex.quote(str(exit_path))}; exit $ec"
    )

    run(['tmux', 'new-session', '-d', '-s', session, 'bash', '-lc', inner])

    task = {
        'id': task_id,
        'status': 'running',
        'agent': agent,
        'repo': str(repo),
        'worktree': wt_meta['worktree'],
        'branch': wt_meta['branch'],
        'base_branch': wt_meta['base_branch'],
        'tmux_session': session,
        'task': args.task,
        'created_at': dt.datetime.now().isoformat(),
        'updated_at': dt.datetime.now().isoformat(),
        'log': str(log_path),
        'exit_file': str(exit_path),
    }
    tasks.append(task)
    save_tasks(tasks)

    print(json.dumps({'ok': True, 'task': task, 'tools': tools, 'registry': str(GLOBAL_TASKS_PATH)}, ensure_ascii=False, indent=2))


def attach_task(args):
    tasks = load_tasks()
    task = next((t for t in tasks if t.get('id') == args.id), None)
    if not task:
        fail(f"task not found: {args.id}")

    msg = args.message.strip()
    if not msg:
        fail('message is empty')

    session = task.get('tmux_session')
    try:
        run(['tmux', 'send-keys', '-t', session, msg, 'Enter'])
    except Exception as e:
        fail(f'failed to send message to tmux session {session}: {e}')

    task['updated_at'] = dt.datetime.now().isoformat()
    save_tasks(tasks)
    print(json.dumps({'ok': True, 'id': args.id, 'sent': True, 'session': session}, ensure_ascii=False))


def evaluate_default_dod(task: Dict[str, Any]) -> Dict[str, Any]:
    """Default DoD (no project-specific config):
    1) task process exit success
    2) at least one commit on task branch vs base_branch
    3) worktree is clean (no uncommitted changes)
    """
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

    # commit check: task branch has commits ahead of base
    if base_branch and branch:
        cp = run(
            ['git', 'rev-list', '--count', f'{base_branch}..{branch}'],
            cwd=worktree,
            check=False,
        )
        try:
            result['commit'] = (cp.returncode == 0 and int((cp.stdout or '0').strip() or '0') > 0)
        except Exception:
            result['commit'] = False

    # clean worktree check
    sp = run(['git', 'status', '--porcelain'], cwd=worktree, check=False)
    result['clean_worktree'] = (sp.returncode == 0 and (sp.stdout or '').strip() == '')

    result['pass'] = bool(result['commit'] and result['clean_worktree'])
    if not result['pass']:
        if not result['commit']:
            result['reason'] = 'no_commit_on_task_branch'
        elif not result['clean_worktree']:
            result['reason'] = 'worktree_not_clean'
    else:
        result['reason'] = 'ok'

    return result


def update_status(task: Dict[str, Any]) -> Dict[str, Any]:
    old = task.get('status', 'unknown')
    session = task.get('tmux_session')
    exit_file = pathlib.Path(task.get('exit_file', ''))

    alive = True
    try:
        run(['tmux', 'has-session', '-t', session])
    except Exception:
        alive = False

    if alive:
        new = 'running'
    else:
        if exit_file.exists():
            code = exit_file.read_text(encoding='utf-8').strip() or '1'
            task['exit_code'] = int(code)
            new = 'success' if code == '0' else 'failed'
        elif old == 'running':
            new = 'stopped'
        else:
            new = old

    task['status'] = new
    if new != old:
        task['updated_at'] = dt.datetime.now().isoformat()

    log_path = pathlib.Path(task.get('log', ''))
    if log_path.exists():
        try:
            tail = log_path.read_text(encoding='utf-8', errors='ignore')[-800:]
            task['result_excerpt'] = tail.strip()
        except Exception:
            pass

    # default DoD validation (no project-specific checks/config)
    task['dod'] = evaluate_default_dod(task)
    return task


def check_tasks(args):
    tasks = [update_status(dict(t)) for t in load_tasks()]
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
            changes.append({
                'id': tid,
                'repo': t.get('repo'),
                'worktree': t.get('worktree'),
                'tmux_session': t.get('tmux_session'),
                'from': prev,
                'to': status,
                'dod': t.get('dod', {}),
                'result_excerpt': (t.get('result_excerpt') or '')[-300:]
            })

    save_json(GLOBAL_LAST_CHECK_PATH, latest)
    print(json.dumps({
        'ok': True,
        'registry': str(GLOBAL_TASKS_PATH),
        'changes_only': bool(args.changes_only),
        'changes': changes,
        'tasks': [] if args.changes_only else tasks,
    }, ensure_ascii=False, indent=2))


def list_tasks(_args):
    print(json.dumps({'ok': True, 'registry': str(GLOBAL_TASKS_PATH), 'tasks': load_tasks()}, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description='OpenClaw task swarm helper')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p_spawn = sub.add_parser('spawn')
    p_spawn.add_argument('--repo', required=True)
    p_spawn.add_argument('--task', required=True)
    p_spawn.add_argument('--agent', choices=['codex', 'claude'])
    p_spawn.add_argument('--name')
    p_spawn.set_defaults(func=spawn_task)

    p_attach = sub.add_parser('attach')
    p_attach.add_argument('--id', required=True)
    p_attach.add_argument('--message', required=True)
    p_attach.set_defaults(func=attach_task)

    p_check = sub.add_parser('check')
    p_check.add_argument('--changes-only', action='store_true')
    p_check.set_defaults(func=check_tasks)

    p_list = sub.add_parser('list')
    p_list.set_defaults(func=list_tasks)

    args = parser.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
