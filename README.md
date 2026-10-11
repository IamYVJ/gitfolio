# gitfolio

GitHub stats for any username, in the browser. No sign-in needed.

Live at https://iamyvj.github.io/gitfolio/ — link straight to a profile with `#username`, e.g. `https://iamyvj.github.io/gitfolio/#IamYVJ`.

- Repos, stars, forks, followers
- Commits, pull requests and issues (all time)
- Lines of code in the user's repos, and lines the user added and deleted
- Contribution calendar for the past year, per-year totals, streaks and best day
- Language breakdown by bytes of code
- Every repo as a card, sortable by stars, activity or lines
- Export: everything on the page as JSON, or the repo list as CSV

It's a plain static site with no build step, so it runs as-is on GitHub Pages:
**Settings → Pages → Deploy from a branch → `main` / root**.

## Structure

```
index.html              page shell (home, sign-in dialog)
assets/css/style.css    all styles
assets/js/main.js       GitHub API calls, caching, rendering
favicon.svg
.nojekyll               serve files as-is (skip Jekyll)
```

To run it locally, serve the folder with any static server, e.g. `python -m http.server 4173`.

## Where the numbers come from

| Stat | Source |
| --- | --- |
| Repos, stars, forks | `GET /users/{user}/repos`, summed over repos the account owns |
| Commits, PRs, issues | `GET /search/commits` and `/search/issues` total counts |
| Lines of code, lines added | `GET /repos/{repo}/stats/contributors` — weekly additions and deletions per contributor |
| Languages | `GET /repos/{repo}/languages` — bytes per language |
| Contributions | Signed in: GitHub GraphQL `contributionCalendar`. Otherwise the public mirror at `github-contributions-api.jogruber.de` |

Things worth knowing:

- **Lines of code** is additions minus deletions by all contributors over a repo's history, so it counts every tracked file, not just source code. Forks are skipped.
- GitHub computes contributor stats on demand. The first lookup of a rarely visited repo can take up to half a minute; the page waits and fills the numbers in.
- **Without sign-in** GitHub allows 60 API requests an hour per IP. That covers the profile plus line counts and languages for the 10 most-starred source repos. Results are cached in `localStorage` for an hour so reloads are free.
- The only third party involved is the contributions mirror, used when not signed in. It receives the username being looked up and nothing else.

## Signing in

A static site can't do GitHub's OAuth login, because exchanging the login code needs a client secret held on a server. Sign-in therefore uses a [fine-grained personal access token](https://github.com/settings/personal-access-tokens).

The sign-in dialog links to GitHub's token form with everything pre-filled for the least access the page needs:

- **Expiry** — 1 day by default (the shortest GitHub allows), or 7 or 30 days.
- **Permissions** — none, which means read-only access to public repos. Ticking "include my private repos" adds read-only *Metadata*, the only permission the stats need; you then pick *All repositories* on GitHub's form.

A classic token that carries any write scope (`repo`, `workflow`, …) is refused. GitHub doesn't let a page read back a fine-grained token's permissions, so for those the pre-filled link is the safeguard.

When you sign out you can also **revoke** the token, which asks GitHub to disable it permanently.

## Security

- **Not stored by default.** The token is held in memory for the visit and is gone on reload.
- **Encrypted if remembered.** "Remember on this device" asks for a passphrase and stores the token only as AES-GCM ciphertext, with the key derived from the passphrase (PBKDF2-SHA-256, 600,000 rounds). The passphrase is never stored; you type it to unlock.
- **Sent only to GitHub.** The token goes to `api.github.com` in the `Authorization` header. It is never put in a URL, the cache, an export or a log, and the third-party contributions mirror is called without it.
- **Private data stays in memory.** Lookups made while signed in are not written to `localStorage`.
- **Script lockdown.** A Content-Security-Policy allows scripts only from this site (no inline or third-party script) and network requests only to GitHub's API and the contributions mirror.
- **Untrusted data.** Text from GitHub is escaped before it reaches the page, links are restricted to `http(s)`, and data from the mirror is validated first.
- **Paste check.** Text that isn't shaped like a GitHub token is rejected before anything is sent.
- **Framing and leakage.** The page refuses to run inside another site's frame, and sends no referrer or cookies with its requests.

What this doesn't cover: while you are signed in, the token is in the page's memory, so malicious script running on the page or a hostile browser extension could still use it. A short-lived, read-only token is what limits the damage in that case.

At the bottom of the page, **Clear cache** forgets saved lookups, and **Clear data** removes everything gitfolio stored in the browser, the encrypted token included.
