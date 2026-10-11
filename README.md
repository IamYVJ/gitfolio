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

A static site can't do GitHub's OAuth login, because exchanging the login code needs a client secret held on a server. Sign-in therefore uses a [personal access token](https://github.com/settings/tokens):

- **classic token with no scopes** — public data, 5,000 requests an hour, every repo scanned. Safest: it can't read or change anything private.
- **fine-grained token** with read-only *Contents* and *Metadata* — also your private repos when you view your own profile.

Give the token an expiry date, and never use one that can write. gitfolio only reads, and it warns you if the token you paste has write scopes.

## Security

A token kept in the browser can be read by anything that runs script on the page, by browser extensions, and by anyone using the same browser profile. That can't be fully removed on a static site, so the page is built to keep the exposure small:

- The token is kept in `sessionStorage` (gone when the tab closes) unless you tick "Remember on this device".
- It is sent only to `api.github.com`, in the `Authorization` header. It is never put in a URL, the cache, an export or a log, and the third-party contributions mirror is called without it.
- A Content-Security-Policy allows scripts only from this site (no inline or third-party script) and network requests only to GitHub's API and the contributions mirror.
- All text from GitHub is escaped before it reaches the page, links are restricted to `http(s)`, and data from the mirror is validated first.
- Pasted text that isn't shaped like a GitHub token is rejected before anything is sent.
- The page refuses to run inside another site's frame, and sends no referrer or cookies with its requests.

At the bottom of the page, **Clear cache** forgets saved lookups, and **Clear data** removes everything gitfolio stored in the browser, token included. To cut off a token completely, also delete it at github.com/settings/tokens.
