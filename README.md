# Difftastic PR Review for Pulsar

Open a GitHub pull request in a native Pulsar tab, inspect Difftastic's side-by-side changes, and post review comments directly to GitHub.

## Install

You need Pulsar 1.131 or newer, GitHub CLI (`gh`), and Difftastic (`difft`). Use Difftastic 0.71 or newer with JSON line alignment. Install the package's npm dependencies with `npm install`.

From the extracted `difftastic-pr-review` directory:

```sh
gh auth status || gh auth login
npm install
pulsar -p link
```

Reload Pulsar. In the command palette, run **Difftastic Pr Review: Open** to open a new review tab. Enter a GitHub.com PR URL or `owner/repo#123`. Run it again to open additional tabs without replacing existing reviews. **Difftastic Pr Review: Open PR on Current Branch** uses the active editor's file to find its Git repository and current branch; it opens the only matching PR directly or shows a fuzzy-searchable picker when there are several. PRs in any state are included (up to 100). For a desktop launch with a different `PATH`, set the executable paths in the package settings.

## Review

- Pick a changed file to compare. The package reads source through `gh api` on demand, so it works from an unrelated workspace and doesn't modify your checkout. It uses complete GitHub patches to recover the before version and looks up the comparison merge base for files without a complete patch.
- Switch to **GitHub patch** to see the original line changes, including formatting-only edits. If the GitHub patch and the compared snapshots disagree, use the patch.
- Click a line number to post a review comment immediately to GitHub (not as a pending review). Only lines present in GitHub's PR patch can be commented on; switch to **GitHub patch** if a Difftastic line is disabled. The PR must still have the same base and head revisions. Comments on current diff lines are loaded from GitHub, stay visible after **Reload**, and can be deleted from the diff (with confirmation). Outdated comments and comments outside the available patch remain on GitHub. If posting fails or is interrupted, check GitHub before retrying to avoid duplicates.
- **Local drafts** lists drafts saved by older versions of this package. Current-revision drafts can be posted to GitHub or deleted; earlier-revision drafts can only be deleted. New comments are not saved as local drafts.
- Large files, binary files, and submodules may have limited structural output. The patch view is available whenever GitHub supplies a text patch.

Legacy drafts are saved in the Pulsar config directory under `difftastic-pr-review/drafts`. Posting a comment writes to GitHub using your `gh` account. The package accepts GitHub.com PRs, including private repositories accessible to that account.
