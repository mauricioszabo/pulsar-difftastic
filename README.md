# Difftastic for Pulsar

Open a GitHub pull request or a GitLab merge request in a native Pulsar tab, inspect Difftastic's side-by-side changes, and post review comments directly to GitHub or GitLab.

## Install

You need Pulsar 1.131 or newer, Difftastic (`difft`), and the CLI for your host: GitHub CLI (`gh`) for GitHub and GitLab CLI (`glab`) for GitLab. Use Difftastic 0.71 or newer with JSON line alignment.

## Usage

- **Difftastic: Open Pull Request** and **Difftastic: Open Current Branch Pull Request** use `gh`.
- **Difftastic: Open Merge Request** and **Difftastic: Open Current Branch Merge Request** use `glab`. Paste a merge request URL (any GitLab host `glab` is logged in to) or `group/project!123` for gitlab.com.
