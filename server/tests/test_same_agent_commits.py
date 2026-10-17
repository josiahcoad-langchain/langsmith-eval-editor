"""A commit that only touches evals or docs leaves results current; one that touches the agent's code does not."""

import subprocess

import main


def _commit(repo, path, text):
    (repo / path).parent.mkdir(parents=True, exist_ok=True)
    (repo / path).write_text(text)
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True)
    subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", path], cwd=repo, check=True)
    return subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True, check=True).stdout.strip()


def test_only_commits_that_change_the_agent_paths_move_the_agent(tmp_path, monkeypatch):
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    before_agent = _commit(tmp_path, "src/agent.py", "v1")
    agent = _commit(tmp_path, "src/agent.py", "v2")
    eval_only = _commit(tmp_path, "tests/evals.json", "{}")
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(main, "AGENT_PATHS", ["src"])

    same = main._same_agent_commits()

    assert eval_only in same and agent in same
    assert before_agent not in same
