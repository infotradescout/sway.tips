"""Pinned PR249 merge in a new owned worktree; never writes a remote ref."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

HEAD = 'b354e1a6a842d39d8601f49323f56d2603348a1f'
BASE = 'e15db1518ef2b1823442d18479d71af4ee0ca95a'
ANCESTOR = '80127f127bc1ec1b3ea7a32b89eea244f5953a1f'
BRANCH = 'implement/direct-music-control-20260916'
PIN = '58ceb46de0ab10463dcdd7187985d91d8b4bf45a'
HOST_FILES = ['package.json', 'public/sw.js', 'scripts/grindzone-host.contract.test.mjs',
              'scripts/prepare-grindzone-host.mjs', 'server.ts']


def run(*args, cwd, check=True):
    return subprocess.run(args, cwd=cwd, check=check, text=True, capture_output=True)


def git(*args, cwd):
    return run('git', *args, cwd=cwd).stdout


def one_replace(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Expected exactly one merge anchor: {old!r}')
    return text.replace(old, new, 1)


def resolve_server(head, base):
    """Keep Sway byte-for-byte except for the two known shared-host additions."""
    direct = "import { registerDirectMusicRoutes } from './src/server/direct-music/routes';\n"
    imports = "import { createServer as createHttpServer } from 'node:http';\nimport { pathToFileURL } from 'node:url';\n"
    if not head.startswith(direct) or not base.startswith(imports):
        raise RuntimeError('Server import boundary changed; refusing an unreviewed merge')
    start = '  // Shared compute only: GrindZone keeps separate pairing and no Sway database access.\n'
    end = '  httpServer.listen(PORT, "0.0.0.0", () => {\n'
    if base.count(start) != 1 or base.count(end) != 1:
        raise RuntimeError('Shared-host startup boundary changed')
    block = base[base.index(start):base.index(end) + len(end)]
    if PIN not in block or 'phoneHost?.attach(httpServer);' not in block:
        raise RuntimeError('Pinned relay or WebSocket attachment missing')
    merged = one_replace(head, direct, direct + imports)
    merged = one_replace(merged, '  app.listen(PORT, "0.0.0.0", () => {\n', block)
    reversed_text = one_replace(merged, direct + imports, direct)
    reversed_text = one_replace(reversed_text, block, '  app.listen(PORT, "0.0.0.0", () => {\n')
    if reversed_text != head:
        raise RuntimeError('Sway runtime preservation failed')
    return merged


def main():
    repository, destination, evidence = map(lambda p: Path(p).resolve(), sys.argv[1:4])
    if destination.exists():
        raise RuntimeError('Worktree must be new; existing work will not be reset')
    evidence.mkdir(parents=True, exist_ok=False)
    remote = git('remote', 'get-url', 'origin', cwd=repository).strip()
    if remote not in ('https://github.com/infotradescout/sway.tips', 'https://github.com/infotradescout/sway.tips.git'):
        raise RuntimeError('Unexpected repository origin')
    refs = dict(line.split()[::-1] for line in git('ls-remote', 'origin',
                'refs/heads/main', 'refs/heads/' + BRANCH, cwd=repository).splitlines())
    if refs.get('refs/heads/main') != BASE or refs.get('refs/heads/' + BRANCH) != HEAD:
        raise RuntimeError('Source refs advanced; preserving newer work instead of overwriting it')
    if git('merge-base', HEAD, BASE, cwd=repository).strip() != ANCESTOR:
        raise RuntimeError('Unexpected merge base')
    main_delta = sorted(git('diff', '--name-only', ANCESTOR, BASE, cwd=repository).splitlines())
    if main_delta != HOST_FILES:
        raise RuntimeError('Main changed outside the reviewed shared-host files')
    git('worktree', 'add', '--detach', str(destination), HEAD, cwd=repository)
    git('config', 'user.name', 'Sway scoped continuation', cwd=destination)
    git('config', 'user.email', '263459961+infotradescout@users.noreply.github.com', cwd=destination)
    result = run('git', 'merge', '--no-commit', '--no-ff', BASE, cwd=destination, check=False)
    (evidence / 'merge.log').write_text(result.stdout + result.stderr, encoding='utf-8')
    unresolved = sorted(set(git('diff', '--name-only', '--diff-filter=U', cwd=destination).splitlines()))
    if result.returncode != 1 or unresolved != ['server.ts']:
        raise RuntimeError(f'Unexpected merge outcome: exit={result.returncode}, conflicts={unresolved}')
    head_server = subprocess.check_output(['git', 'show', f'{HEAD}:server.ts'], cwd=destination).decode('utf-8')
    base_server = subprocess.check_output(['git', 'show', f'{BASE}:server.ts'], cwd=destination).decode('utf-8')
    merged_server = resolve_server(head_server, base_server)
    (destination / 'server.ts').write_bytes(merged_server.encode('utf-8'))
    hp = json.loads(git('show', f'{HEAD}:package.json', cwd=destination))
    mp = json.loads((destination / 'package.json').read_text(encoding='utf-8'))
    if mp['scripts']['build'] != hp['scripts']['build'] + ' && node scripts/prepare-grindzone-host.mjs':
        raise RuntimeError('Build integration is not strictly additive')
    mp['scripts']['build'] = hp['scripts']['build']
    if mp != hp:
        raise RuntimeError('Sway package scripts or dependencies were lost')
    for name in HOST_FILES[1:4]:
        actual = (destination / name).read_bytes()
        expected = subprocess.check_output(['git', 'show', f'{BASE}:{name}'], cwd=destination)
        if actual != expected:
            raise RuntimeError(f'Shared-host file changed: {name}')
    for name in HOST_FILES:
        if re.search(rb'^(<<<<<<<|=======|>>>>>>>)', (destination / name).read_bytes(), re.M):
            raise RuntimeError(f'Unresolved conflict marker in {name}')
    git('add', '--', *HOST_FILES, cwd=destination)
    actual_delta = sorted(git('diff', '--cached', '--name-only', HEAD, cwd=destination).splitlines())
    if actual_delta != HOST_FILES:
        raise RuntimeError(f'Unexpected candidate changes: {actual_delta}')
    git('diff', '--cached', '--check', cwd=destination)
    git('commit', '-m', 'Reconcile PR249 with shared-host GrindZone without replacing either runtime [skip ci]', cwd=destination)
    sha = git('rev-parse', 'HEAD', cwd=destination).strip()
    tree = git('rev-parse', 'HEAD^{tree}', cwd=destination).strip()
    if git('show', '-s', '--format=%P', sha, cwd=destination).strip().split() != [HEAD, BASE]:
        raise RuntimeError('Both source parents must be retained')
    git('branch', 'sway-pr249-exact-candidate', sha, cwd=destination)
    git('bundle', 'create', str(evidence / 'candidate.bundle'), 'sway-pr249-exact-candidate',
        '^' + HEAD, '^' + BASE, cwd=destination)
    receipt = {'status': 'merge_prepared_not_published', 'source': sha, 'tree': tree,
               'parents': [HEAD, BASE], 'changed_from_sway': HOST_FILES,
               'grindzone_relay_pin': PIN, 'runtime_preservation': 'reversible_exact_byte_check',
               'hashes': {name: hashlib.sha256((destination / name).read_bytes()).hexdigest() for name in HOST_FILES},
               'full_hosted_gates': 'not_repeated', 'production': 'unchanged',
               'real_player_acceptance': 'not_executed', 'native_acceptance': 'pending',
               'registry_supplement': 'pending'}
    (evidence / 'merge.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(receipt))
    if 'GITHUB_OUTPUT' in os.environ:
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            output.write(f'candidate={sha}\n')


if __name__ == '__main__':
    main()
