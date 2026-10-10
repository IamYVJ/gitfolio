(function () {
  "use strict";

  const API = "https://api.github.com";
  // Public mirror of the profile contribution calendar; GitHub only exposes it to signed-in API clients.
  const CONTRIB_API = "https://github-contributions-api.jogruber.de/v4/";
  const ANON_SCAN = 10;    // repos scanned for code stats without a token (60 requests/hour)
  const AUTH_SCAN = 300;
  const ANON_PAGES = 3, AUTH_PAGES = 10; // x100 repos
  const STATS_WAITS = [4000, 6000, 8000, 10000, 12000]; // pauses between polls for GitHub's line counts
  const TTL = 60 * 60e3;
  const TOKEN_KEY = "gitfolio:token", CACHE_PREFIX = "gitfolio:c:";
  const PAGE = 12;

  let token = null, viewer = null;
  let S = null;                       // everything known about the profile on screen
  let run = 0, ctrl = null;           // bumps on every lookup so stale responses are dropped
  const rate = { limit: null, remaining: null, reset: null };
  const ui = { sort: "stars", all: false };

  /* ---------------------------------------------------------------- utils */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function compact(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, "") + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2).replace(/\.?0+$/, "") + "M";
    if (n >= 1e5) return Math.round(n / 1e3) + "K";
    if (n >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
    return full(n);
  }
  function full(n) { return Number(n).toLocaleString("en-US"); }
  function plural(n, word) { return full(n) + " " + word + (n === 1 ? "" : "s"); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function pad(n) { return String(n).padStart(2, "0"); }
  function monthYear(iso) { return MONTHS[+iso.slice(5, 7) - 1] + " " + iso.slice(0, 4); }
  function fullDate(iso) { return +iso.slice(8, 10) + " " + MONTHS[+iso.slice(5, 7) - 1] + " " + iso.slice(0, 4); }
  function today() { const n = new Date(); return n.getFullYear() + "-" + pad(n.getMonth() + 1) + "-" + pad(n.getDate()); }
  function addDays(iso, n) {
    const d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function clock(epoch) { const d = new Date(epoch * 1000); return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
  function store(area, key, val) {
    try {
      if (val === undefined) return JSON.parse(area.getItem(key) || "null");
      if (val === null) area.removeItem(key); else area.setItem(key, JSON.stringify(val));
    } catch (e) { return null; }
  }
  function safeUrl(u) {
    if (!u) return "";
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    try { return new URL(u).href; } catch (e) { return ""; }
  }
  // Runs fn over items, at most `limit` at a time.
  function pool(items, limit, fn) {
    let i = 0;
    function next() { return i < items.length ? fn(items[i++]).then(next) : null; }
    return Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  }

  const STAR_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z"/></svg>';
  const FORK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="12" cy="19" r="2"/><path d="M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7M12 12v5"/></svg>';

  // GitHub's own language colours (github-linguist), so the chart matches what people see on github.com.
  const LANG = {
    JavaScript: "#f1e05a", TypeScript: "#3178c6", Python: "#3572A5", Java: "#b07219", C: "#555555", "C++": "#f34b7d",
    "C#": "#178600", Go: "#00ADD8", Rust: "#dea584", Ruby: "#701516", PHP: "#4F5D95", Swift: "#F05138",
    Kotlin: "#A97BFF", Dart: "#00B4AB", HTML: "#e34c26", CSS: "#663399", SCSS: "#c6538c", Less: "#1d365d",
    Shell: "#89e051", PowerShell: "#012456", Batchfile: "#C1F12E", Vue: "#41b883", Svelte: "#ff3e00", Astro: "#ff5a03",
    "Jupyter Notebook": "#DA5B0B", R: "#198CE7", Lua: "#000080", Perl: "#0298c3", Scala: "#c22d40", Haskell: "#5e5086",
    Elixir: "#6e4a7e", Erlang: "#B83998", Clojure: "#db5855", "Objective-C": "#438eff", Dockerfile: "#384d54",
    Makefile: "#427819", CMake: "#DA3434", TeX: "#3D6117", "Vim Script": "#199f4b", Zig: "#ec915c", Nix: "#7e7eff",
    HCL: "#844FBA", Solidity: "#AA6746", Assembly: "#6E4C13", MATLAB: "#e16737", Julia: "#a270ba", OCaml: "#ef7a08",
    EJS: "#a91e50", MDX: "#fcb32c", Handlebars: "#f7931e", Roff: "#ecdebe", GLSL: "#5686a5", "F#": "#b845fc",
    Nim: "#ffc200", PLpgSQL: "#336790", Groovy: "#4298b8", Starlark: "#76d275", Pug: "#a86454", Smarty: "#f0c040"
  };
  const OTHER = "#5f7892";
  function langColor(name) {
    if (LANG[name]) return LANG[name];
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return "hsl(" + h + " 45% 55%)";
  }

  /* ------------------------------------------------------------ GitHub API */
  function headers() {
    const h = { Accept: "application/vnd.github+json" };
    if (token) h.Authorization = "Bearer " + token;
    return h;
  }
  function apiError(kind, message) { const e = new Error(message); e.kind = kind; return e; }

  // opts.raw returns the Response (for endpoints where the status code matters).
  async function gh(path, opts) {
    const res = await fetch(API + path, { headers: headers(), signal: ctrl && ctrl.signal });
    const h = res.headers;
    // Search has its own bucket; only the core one decides how many repos we can scan.
    if (path.indexOf("/search/") !== 0 && h.get("x-ratelimit-remaining") != null) {
      rate.limit = +h.get("x-ratelimit-limit");
      rate.remaining = +h.get("x-ratelimit-remaining");
      rate.reset = +h.get("x-ratelimit-reset");
      renderRate();
    }
    if (res.status === 401 && token) throw apiError("auth", "GitHub rejected the saved token. Sign in again.");
    if ((res.status === 403 || res.status === 429) && (h.get("x-ratelimit-remaining") === "0" || h.get("retry-after"))) {
      throw apiError("rate", "GitHub's request limit is used up" + (h.get("x-ratelimit-reset") ? " until " + clock(+h.get("x-ratelimit-reset")) : "") + ".");
    }
    if (opts && opts.raw) return res;
    if (res.status === 404) throw apiError("missing", "Not found.");
    if (!res.ok) throw apiError("http", "GitHub returned an error (" + res.status + ").");
    return res.json();
  }

  async function graphql(query, variables) {
    const res = await fetch(API + "/graphql", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, headers()),
      body: JSON.stringify({ query: query, variables: variables }),
      signal: ctrl && ctrl.signal
    });
    if (!res.ok) throw apiError("http", "GraphQL " + res.status);
    const body = await res.json();
    if (body.errors || !body.data) throw apiError("http", "GraphQL error");
    return body.data;
  }

  function hasBudget() { return !!token || rate.remaining == null || rate.remaining > 2; }

  /* --------------------------------------------------------------- fetchers */
  async function fetchRepos(login) {
    const own = viewer && viewer.login.toLowerCase() === login.toLowerCase();
    const base = own ? "/user/repos?affiliation=owner&visibility=all" : "/users/" + login + "/repos?type=owner";
    const maxPages = token ? AUTH_PAGES : ANON_PAGES;
    let out = [];
    for (let page = 1; page <= maxPages; page++) {
      const batch = await gh(base + "&sort=pushed&per_page=100&page=" + page);
      out = out.concat(batch.map(function (r) {
        return {
          name: r.name, full: r.full_name, url: r.html_url, desc: r.description, fork: r.fork, priv: r.private,
          archived: r.archived, language: r.language, stars: r.stargazers_count, forks: r.forks_count,
          size: r.size, pushed: r.pushed_at
        };
      }));
      if (batch.length < 100) return { repos: out, truncated: false };
    }
    return { repos: out, truncated: true };
  }

  // Search only returns a count here; any failure just leaves the stat blank.
  function searchCount(kind, q) {
    return gh("/search/" + kind + "?per_page=1&q=" + encodeURIComponent(q))
      .then(function (r) { return r.total_count; })
      .catch(function (e) { if (e.name === "AbortError") throw e; return null; });
  }

  async function fetchContribGraphQL(login) {
    const years = (await graphql("query($login:String!){user(login:$login){contributionsCollection{contributionYears}}}", { login: login }))
      .user.contributionsCollection.contributionYears;
    const parts = years.map(function (y) {
      return "y" + y + ':contributionsCollection(from:"' + y + '-01-01T00:00:00Z",to:"' + y + '-12-31T23:59:59Z")' +
        "{contributionCalendar{weeks{contributionDays{date contributionCount}}}}";
    });
    const data = await graphql("query($login:String!){user(login:$login){" + parts.join(" ") + "}}", { login: login });
    const days = [];
    Object.keys(data.user).forEach(function (k) {
      data.user[k].contributionCalendar.weeks.forEach(function (w) {
        w.contributionDays.forEach(function (d) { days.push([d.date, d.contributionCount]); });
      });
    });
    return days;
  }

  async function fetchContribMirror(login) {
    const res = await fetch(CONTRIB_API + encodeURIComponent(login), { signal: ctrl && ctrl.signal });
    if (!res.ok) throw apiError("http", "Contributions " + res.status);
    return (await res.json()).contributions.map(function (d) { return [d.date, d.count]; });
  }

  // -> sorted [[date, count], ...] over the account's whole history, or null.
  async function fetchContrib(login) {
    let days = null;
    if (token) days = await fetchContribGraphQL(login).catch(function (e) { if (e.name === "AbortError") throw e; return null; });
    if (!days) days = await fetchContribMirror(login).catch(function (e) { if (e.name === "AbortError") throw e; return null; });
    if (!days) return null;
    const end = today();
    return days.filter(function (d) { return d[0] <= end; }).sort(function (a, b) { return a[0] < b[0] ? -1 : 1; });
  }

  // Lines and commits come from GitHub's contributor statistics, which it computes on demand:
  // the first request for a cold repo answers 202 and the numbers are ready a few seconds later.
  async function fetchRepoStats(repo, me) {
    const entry = S.scan[repo.full] || (S.scan[repo.full] = {});
    if (!hasBudget()) { S.rateHit = true; return; }
    let res;
    try { res = await gh("/repos/" + repo.full + "/stats/contributors", { raw: true }); }
    catch (e) { if (e.kind === "rate") { S.rateHit = true; return; } throw e; }
    if (res.status === 202) { entry.pending = true; return; }
    entry.pending = false;
    entry.stats = true;
    entry.lines = entry.added = entry.deleted = entry.commits = 0;
    if (res.status !== 200) { entry.stats = res.status === 204; return; }
    const list = await res.json();
    if (!Array.isArray(list)) { entry.stats = false; return; }
    let net = 0;
    list.forEach(function (c) {
      let a = 0, d = 0;
      c.weeks.forEach(function (w) { a += w.a; d += w.d; });
      net += a - d;
      if (c.author && c.author.login.toLowerCase() === me) { entry.added += a; entry.deleted += d; entry.commits += c.total; }
    });
    entry.lines = Math.max(0, net);
  }

  async function fetchRepoLangs(repo) {
    const entry = S.scan[repo.full] || (S.scan[repo.full] = {});
    if (!hasBudget()) { S.rateHit = true; return; }
    try { entry.langs = await gh("/repos/" + repo.full + "/languages"); }
    catch (e) { if (e.kind === "rate") S.rateHit = true; else if (e.name === "AbortError") throw e; }
  }

  /* ----------------------------------------------------------------- cache */
  function cacheKey(login) { return CACHE_PREFIX + (token ? "a:" : "p:") + login.toLowerCase(); }
  function cacheGet(login) {
    const hit = store(localStorage, cacheKey(login));
    return hit && Date.now() - hit.t < hit.ttl ? hit.S : null;
  }
  function cachePut() {
    // Incomplete results expire quickly so a reload picks up what GitHub hadn't finished computing.
    const ttl = S.rateHit || derive().pending ? 3 * 60e3 : TTL;
    try {
      const keys = Object.keys(localStorage).filter(function (k) { return k.indexOf(CACHE_PREFIX) === 0; });
      keys.map(function (k) { return [k, (store(localStorage, k) || {}).t || 0]; })
        .sort(function (a, b) { return b[1] - a[1]; }).slice(5)
        .forEach(function (k) { localStorage.removeItem(k[0]); });
      localStorage.setItem(cacheKey(S.user.login), JSON.stringify({ t: Date.now(), ttl: ttl, S: S }));
    } catch (e) { /* storage full or blocked: the page still works, just without the cache */ }
  }
  function cacheClear(prefix) {
    try {
      Object.keys(localStorage).forEach(function (k) { if (k.indexOf(prefix) === 0) localStorage.removeItem(k); });
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ load */
  const view = $("#view"), home = $("#home"), statusEl = $("#status");

  function setStatus(text, frac, isError) {
    statusEl.hidden = !text;
    statusEl.classList.toggle("is-error", !!isError);
    $("#status-text").textContent = text || "";
    $("#status-bar").style.width = Math.round((frac || 0) * 100) + "%";
  }

  function showHome(error) {
    run++;
    if (ctrl) ctrl.abort();
    S = null;
    document.body.classList.add("is-home");
    document.title = "gitfolio — GitHub stats for any username";
    home.hidden = false; view.hidden = true;
    setStatus("");
    $("#home-err").hidden = !error;
    $("#home-err").textContent = error || "";
  }

  async function load(login, force) {
    const id = ++run;
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    const alive = function () { return id === run; };

    document.body.classList.remove("is-home");
    home.hidden = true;
    $("#q-nav").value = login;
    ui.all = false;

    const cached = !force && cacheGet(login);
    if (cached) {
      S = cached;
      view.hidden = false;
      shell(); renderAll(); setStatus("");
      return;
    }

    S = null;
    view.hidden = true;
    setStatus("Fetching @" + login + "…", 0.05);
    try {
      const user = await gh("/users/" + encodeURIComponent(login));
      if (!alive()) return;
      S = { user: user, repos: null, counts: null, contrib: undefined, scan: {}, scanList: [], scanDone: false, rateHit: false, truncated: false, anon: !token };
      const me = user.login.toLowerCase();
      view.hidden = false;
      shell(); renderAll();
      window.scrollTo(0, 0);

      setStatus("Listing repositories…", 0.15);
      const listed = await fetchRepos(user.login);
      if (!alive()) return;
      S.repos = listed.repos; S.truncated = listed.truncated;

      // Decide how many repos the remaining request budget can cover (three requests each, worst case).
      const sources = S.repos.filter(function (r) { return !r.fork && r.size > 0; })
        .sort(function (a, b) { return b.stars - a.stars || (a.pushed < b.pushed ? 1 : -1); });
      const cap = token ? AUTH_SCAN : Math.max(0, Math.min(ANON_SCAN, Math.floor(((rate.remaining == null ? 60 : rate.remaining) - 4 - STATS_WAITS.length) / 3)));
      const list = sources.slice(0, cap);
      S.scanList = list.map(function (r) { return r.full; });
      renderAll();

      const isUser = user.type === "User";
      const side = Promise.all([
        isUser ? searchCount("commits", "author:" + user.login) : null,
        isUser ? searchCount("issues", "author:" + user.login + " type:pr") : null,
        isUser ? searchCount("issues", "author:" + user.login + " type:issue") : null,
        isUser ? fetchContrib(user.login) : null
      ]).then(function (r) {
        if (!alive()) return;
        S.counts = { commits: r[0], prs: r[1], issues: r[2] };
        S.contrib = r[3];
        renderAll();
      });

      let done = 0;
      const steps = list.length * 2 || 1;
      const tick = function () {
        if (!alive()) return;
        done++;
        setStatus("Reading code stats · " + Math.min(list.length, Math.ceil(done / 2)) + "/" + list.length + " repos", 0.2 + 0.75 * done / steps);
        renderSoon();
      };
      await pool(list, 4, function (r) { return fetchRepoStats(r, me).then(tick); });
      await pool(list, 4, function (r) { return fetchRepoLangs(r).then(tick); });
      // Cold repos take GitHub up to half a minute. Rather than re-asking for all of them (each ask
      // costs a request), poll one and sweep the rest once it comes back ready.
      let sweeps = token ? 3 : 1;
      for (let i = 0; i < STATS_WAITS.length && sweeps; i++) {
        const waiting = list.filter(function (r) { return S.scan[r.full].pending; });
        if (!waiting.length || S.rateHit) break;
        setStatus("Waiting for GitHub to count lines in " + plural(waiting.length, "repo") + " · can take half a minute", 0.95);
        await sleep(STATS_WAITS[i]);
        if (!alive()) return;
        await fetchRepoStats(waiting[0], me);
        if (S.scan[waiting[0].full].pending) continue;
        await pool(waiting.slice(1), 4, function (r) { return fetchRepoStats(r, me); });
        sweeps--;
        renderSoon();
      }
      await side;
      if (!alive()) return;
      S.scanDone = true;
      S.at = Date.now();
      renderAll();
      setStatus("");
      cachePut();
    } catch (e) {
      if (!alive() || e.name === "AbortError") return;
      if (e.kind === "auth") { signOut(true); return; }
      const msg = e.kind === "missing" ? "No GitHub user named “" + login + "”."
        : e.kind === "rate" ? e.message + (token ? "" : " Sign in to get 5,000 requests an hour.")
        : e.kind ? e.message : "Couldn't reach GitHub. Check your connection and try again.";
      if (S && S.repos) { S.scanDone = true; S.rateHit = S.rateHit || e.kind === "rate"; renderAll(); setStatus(msg, 0, true); }
      else if (e.kind === "missing") { history.replaceState(null, "", location.pathname + location.search); showHome(msg); }
      else { view.hidden = true; setStatus(msg, 0, true); }
    }
  }

  /* ---------------------------------------------------------------- derive */
  function derive() {
    const d = { stars: 0, forks: 0, sources: 0, forked: 0, top: null, lines: 0, added: 0, deleted: 0, commits: 0, scanned: 0, pending: 0, langs: {}, langMode: "bytes", langRepos: 0 };
    (S.repos || []).forEach(function (r) {
      d.stars += r.stars; d.forks += r.forks;
      if (r.fork) d.forked++; else d.sources++;
      if (r.stars && (!d.top || r.stars > d.top.stars)) d.top = r;
    });
    S.scanList.forEach(function (name) {
      const e = S.scan[name];
      if (!e) return;
      if (e.pending) d.pending++;
      if (e.stats) { d.scanned++; d.lines += e.lines; d.added += e.added; d.deleted += e.deleted; d.commits += e.commits; }
      if (e.langs) { d.langRepos++; Object.keys(e.langs).forEach(function (k) { d.langs[k] = (d.langs[k] || 0) + e.langs[k]; }); }
    });
    if (!d.langRepos && S.scanDone) {
      d.langMode = "repos";
      (S.repos || []).forEach(function (r) { if (!r.fork && r.language) d.langs[r.language] = (d.langs[r.language] || 0) + 1; });
    }
    return d;
  }

  function contribStats(days) {
    const map = new Map(days), end = today();
    const start = addDays(end, -(52 * 7 + new Date(end + "T00:00:00Z").getUTCDay()));
    const cells = [];
    let year = 0, best = null;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const c = map.get(d) || 0;
      cells.push([d, c]);
      year += c;
      if (c && (!best || c > best[1])) best = [d, c];
    }
    const nonzero = cells.map(function (c) { return c[1]; }).filter(Boolean).sort(function (a, b) { return a - b; });
    const q = function (p) { return nonzero[Math.floor(p * (nonzero.length - 1))] || 0; };
    const cuts = [q(0.25), q(0.5), q(0.75)];

    let total = 0, longest = 0, streak = 0, prev = null;
    const byYear = {};
    days.forEach(function (d) {
      total += d[1];
      byYear[d[0].slice(0, 4)] = (byYear[d[0].slice(0, 4)] || 0) + d[1];
      streak = d[1] > 0 ? (prev && addDays(prev, 1) === d[0] ? streak + 1 : 1) : 0;
      prev = d[1] > 0 ? d[0] : null;
      if (streak > longest) longest = streak;
    });
    let current = 0, cursor = map.get(end) ? end : addDays(end, -1);
    while (map.get(cursor) > 0) { current++; cursor = addDays(cursor, -1); }

    return {
      cells: cells, year: year, best: best, total: total, longest: longest, current: current, byYear: byYear,
      level: function (c) { return !c ? 0 : c <= cuts[0] ? 1 : c <= cuts[1] ? 2 : c <= cuts[2] ? 3 : 4; }
    };
  }

  /* ---------------------------------------------------------------- render */
  function head(ref, title) {
    return '<header class="sec-head"><span class="ref">' + ref + "</span><h2>" + title +
      '</h2><span class="sec-head__trace" aria-hidden="true"></span></header>';
  }

  function shell() {
    view.innerHTML =
      '<section class="profile"><div class="wrap profile__inner" id="v-profile"></div></section>' +
      '<section class="section section--tight"><div class="wrap"><dl class="readout" id="v-stats"></dl><div class="notes" id="v-notes"></div></div></section>' +
      '<section class="section section--alt"><div class="wrap">' + head("01", "Contributions") + '<div id="v-contrib"></div></div></section>' +
      '<section class="section"><div class="wrap">' + head("02", "Languages") + '<div id="v-langs"></div></div></section>' +
      '<section class="section section--alt"><div class="wrap">' + head("03", "Repositories") +
        '<div class="toolbar"><p class="sec-sub" id="v-repos-sub"></p>' +
        '<label class="sort"><span class="sr">Sort repositories</span><select id="sort">' +
        '<option value="stars">Most stars</option><option value="pushed">Recently pushed</option>' +
        '<option value="lines">Most lines</option><option value="added">Most lines added</option></select></label></div>' +
        '<div class="grid" id="v-repos"></div><p class="more" id="v-more"></p></div></section>' +
      '<section class="section"><div class="wrap"><details class="method"><summary>HOW THESE NUMBERS ARE COUNTED</summary><ul>' +
        "<li><b>Repos, stars, forks</b> — repositories the account owns. Stars and forks are summed across all of them.</li>" +
        "<li><b>Commits</b> — commits authored by this user that GitHub's search has indexed (default branches of public repos, plus private ones your token can see).</li>" +
        "<li><b>Lines of code</b> — lines added minus lines deleted, by every contributor, over the whole history of each scanned source repo. That is the number of lines in the repo today, counting every tracked file (docs, config and lockfiles included). Forks are left out.</li>" +
        "<li><b>Lines added</b> — lines this user added in those same repos, from GitHub's contributor statistics. Generated and vendored files count if they were committed.</li>" +
        "<li><b>Contributions</b> — the profile contribution calendar: commits, pull requests, issues and reviews.</li>" +
        "<li><b>Languages</b> — bytes of code per language, as detected by GitHub, summed over the scanned repos.</li>" +
        "<li>Without sign-in GitHub allows 60 requests an hour, enough to scan the " + ANON_SCAN + " most-starred source repos. Signed in, every repo is scanned.</li>" +
      "</ul></details></div></section>";
    $("#sort").value = ui.sort;
  }

  let renderTimer = 0;
  function renderSoon() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () { renderTimer = 0; if (S) renderAll(); }, 500);
  }

  function renderAll() {
    if (!S) return;
    const d = derive();
    document.title = (S.user.name || S.user.login) + " (@" + S.user.login + ") · gitfolio";
    renderProfile();
    renderStats(d);
    renderNotes(d);
    renderContrib();
    renderLangs(d);
    renderRepos(d);
  }

  function renderProfile() {
    const u = S.user, meta = [];
    if (u.company) meta.push(esc(u.company));
    if (u.location) meta.push(esc(u.location));
    const blog = safeUrl(u.blog);
    if (blog) meta.push('<a href="' + esc(blog) + '" target="_blank" rel="noopener nofollow">' + esc(u.blog.replace(/^https?:\/\//i, "").replace(/\/$/, "")) + "</a>");
    meta.push("Joined " + monthYear(u.created_at));
    if (S.at) meta.push("Updated " + clock(S.at / 1000));
    $("#v-profile").innerHTML =
      '<img class="avatar" src="' + esc(u.avatar_url) + '" alt="" width="112" height="112">' +
      '<div class="profile__copy">' +
        '<h1 class="profile__name">' + esc(u.name || u.login) + "</h1>" +
        '<p class="profile__handle mono"><a href="' + esc(u.html_url) + '" target="_blank" rel="noopener">@' + esc(u.login) + "</a>" +
          (u.type !== "User" ? " · " + esc(u.type) : "") + "</p>" +
        (u.bio ? '<p class="profile__bio">' + esc(u.bio) + "</p>" : "") +
        '<ul class="profile__meta mono">' + meta.map(function (m) { return "<li>" + m + "</li>"; }).join("") + "</ul>" +
      "</div>" +
      '<div class="profile__actions">' +
        '<a class="btn btn--ghost btn--sm" href="' + esc(u.html_url) + '" target="_blank" rel="noopener">View on GitHub ↗</a>' +
        '<button class="btn btn--ghost btn--sm" type="button" data-act="refresh">Refresh</button>' +
      "</div>";
  }

  // value: number, null (unavailable) or undefined (still loading)
  function stat(label, value, sub, title) {
    const body = value === undefined ? '<span class="skel"></span>' : value === null ? "—" : compact(value);
    return '<div title="' + esc(title || "") + '"><dt>' + label + "</dt><dd" + (value === null ? ' class="is-na"' : "") +
      (typeof value === "number" ? ' aria-label="' + full(value) + '"' : "") + ">" + body +
      '</dd><span class="sub">' + (sub || "") + "</span></div>";
  }

  function renderStats(d) {
    const u = S.user, loaded = !!S.repos, c = S.counts;
    const cs = S.contrib ? contribStats(S.contrib) : null;
    const pendingLoc = S.scanDone ? null : undefined;
    const exact = function (n) { return n == null ? "" : full(n); };
    $("#v-stats").innerHTML =
      stat("Repos", loaded ? S.repos.length : u.public_repos, loaded ? d.sources + " source · " + d.forked + " forked" : "", "Repositories owned by this account") +
      stat("Stars", loaded ? d.stars : undefined, d.top ? "top: " + esc(d.top.name) : "", loaded ? exact(d.stars) + " stars across owned repos" : "") +
      stat("Forks", loaded ? d.forks : undefined, "of owned repos", loaded ? exact(d.forks) + " forks of owned repos" : "") +
      stat("Commits", c ? c.commits : undefined, "all time", c ? exact(c.commits) + " authored commits indexed by GitHub" : "") +
      stat("Contributions", S.contrib === undefined ? undefined : cs ? cs.year : null, cs ? compact(cs.total) + " all time" : "past year", cs ? exact(cs.year) + " contributions in the past year" : "") +
      stat("Lines of code", d.scanned ? d.lines : pendingLoc, d.scanned ? d.scanned + " of " + d.sources + " repos" : "", d.scanned ? exact(d.lines) + " lines currently in the scanned repos" : "") +
      stat("Lines added", d.scanned ? d.added : pendingLoc, d.scanned ? "−" + compact(d.deleted) + " deleted" : "", d.scanned ? exact(d.added) + " lines added by @" + u.login + " in the scanned repos" : "") +
      stat("Pull requests", c ? c.prs : undefined, "opened", c ? exact(c.prs) + " pull requests opened" : "") +
      stat("Issues", c ? c.issues : undefined, "opened", c ? exact(c.issues) + " issues opened" : "") +
      stat("Followers", u.followers, compact(u.following) + " following", exact(u.followers) + " followers");
  }

  function renderNotes(d) {
    const notes = [];
    if (S.user.type !== "User") notes.push("This is an organization account, so commits, contributions and per-user line counts don't apply.");
    if (S.scanDone) {
      const skipped = d.sources - S.scanList.length;
      if (S.anon && skipped > 0 && S.scanList.length) notes.push("Lines of code and languages cover the " + S.scanList.length + " most-starred of " + d.sources + " source repos. " + '<button class="linkbtn" data-act="signin">Sign in</button> to scan all of them.');
      if (S.rateHit) notes.push("GitHub's request limit ran out" + (rate.reset ? " (resets " + clock(rate.reset) + ")" : "") + ", so code stats are incomplete." + (S.anon ? ' <button class="linkbtn" data-act="signin">Sign in</button> for 5,000 requests an hour.' : ""));
      if (d.pending) notes.push("GitHub is still computing line counts for " + plural(d.pending, "repo") + ". " + '<button class="linkbtn" data-act="refresh">Refresh</button> in a minute.');
      if (S.truncated) notes.push("Only the " + full(S.repos.length) + " most recently pushed repos were listed.");
      if (S.user.type === "User" && S.contrib === null) notes.push("The contribution calendar couldn't be loaded right now.");
    }
    $("#v-notes").innerHTML = notes.map(function (n) { return '<p class="note"><span>' + n + "</span></p>"; }).join("");
  }

  function renderContrib() {
    const el = $("#v-contrib");
    if (S.contrib === undefined) { el.innerHTML = '<p class="empty mono">Loading contribution calendar…</p>'; return; }
    if (!S.contrib || !S.contrib.length) { el.innerHTML = '<p class="empty">No contribution calendar available for this account.</p>'; return; }
    const cs = contribStats(S.contrib);

    const STEP = 14, CELL = 11, LEFT = 28, TOP = 16;
    const first = new Date(cs.cells[0][0] + "T00:00:00Z").getUTCDay();
    let rects = "", labels = "", lastMonth = -1;
    cs.cells.forEach(function (c, i) {
      const col = Math.floor((i + first) / 7), row = (i + first) % 7;
      rects += '<rect class="l' + cs.level(c[1]) + '" x="' + (LEFT + col * STEP) + '" y="' + (TOP + row * STEP) + '" width="' + CELL + '" height="' + CELL +
        '" data-tip="<b>' + (c[1] ? plural(c[1], "contribution") : "No contributions") + "</b> · " + fullDate(c[0]) + '"/>';
      const month = +c[0].slice(5, 7);
      if (row === 0 && month !== lastMonth) {
        if (col < 52) labels += '<text x="' + (LEFT + col * STEP) + '" y="9">' + MONTHS[month - 1] + "</text>";
        lastMonth = month;
      }
    });
    ["Mon", "Wed", "Fri"].forEach(function (name, i) {
      labels += '<text x="0" y="' + (TOP + (i * 2 + 1) * STEP + 9) + '">' + name + "</text>";
    });

    const years = Object.keys(cs.byYear).sort().slice(-12);
    const peak = Math.max.apply(null, years.map(function (y) { return cs.byYear[y]; })) || 1;
    const bars = years.map(function (y) {
      const n = cs.byYear[y];
      return '<div class="yr" data-tip="<b>' + plural(n, "contribution") + "</b> · " + y + '"><span class="yr__n">' + compact(n) +
        '</span><i style="height:' + Math.round(n / peak * 100) + '%"></i><span>' + y + "</span></div>";
    }).join("");

    el.innerHTML =
      '<p class="sec-sub">' + plural(cs.year, "contribution") + " in the past year.</p>" +
      '<div class="contrib">' +
        '<div class="panel">' +
          '<div class="heat__scroll"><svg class="heat" viewBox="0 0 ' + (LEFT + 53 * STEP) + " " + (TOP + 7 * STEP) + '" role="img" aria-label="Daily contributions over the past year">' + labels + rects + "</svg></div>" +
          '<div class="heat__foot mono"><span>' + fullDate(cs.cells[0][0]) + " – " + fullDate(cs.cells[cs.cells.length - 1][0]) + "</span>" +
            '<span class="heat__key">Less <i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i> More</span></div>' +
          (years.length > 1 ? '<div class="years" role="img" aria-label="Contributions per year">' + bars + "</div>" : "") +
        "</div>" +
        '<dl class="specs">' +
          "<div><dt>Past year</dt><dd>" + full(cs.year) + "</dd></div>" +
          "<div><dt>All time</dt><dd>" + full(cs.total) + "</dd></div>" +
          "<div><dt>Current streak</dt><dd>" + plural(cs.current, "day") + "</dd></div>" +
          "<div><dt>Longest streak</dt><dd>" + plural(cs.longest, "day") + "</dd></div>" +
          "<div><dt>Best day</dt><dd>" + (cs.best ? full(cs.best[1]) + "<small>" + fullDate(cs.best[0]) + "</small>" : "—") + "</dd></div>" +
        "</dl>" +
      "</div>";
    const scroller = $(".heat__scroll", el);
    scroller.scrollLeft = scroller.scrollWidth;
  }

  function renderLangs(d) {
    const el = $("#v-langs");
    let rows = Object.keys(d.langs).map(function (k) { return { name: k, n: d.langs[k], color: langColor(k) }; })
      .sort(function (a, b) { return b.n - a.n; });
    if (!rows.length) {
      el.innerHTML = '<p class="empty' + (S.scanDone ? "" : " mono") + '">' + (S.scanDone ? "No language data for this account." : "Reading languages…") + "</p>";
      return;
    }
    const sum = rows.reduce(function (t, r) { return t + r.n; }, 0);
    if (rows.length > 9) {
      const rest = rows.slice(8);
      rows = rows.slice(0, 8).concat({ name: "Other (" + rest.length + ")", n: rest.reduce(function (t, r) { return t + r.n; }, 0), color: OTHER });
    }
    const pct = function (n) { const p = n / sum * 100; return (p < 0.1 ? "<0.1" : p.toFixed(1)) + "%"; };
    const amount = function (n) { return d.langMode === "repos" ? plural(n, "repo") : n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB"; };
    el.innerHTML =
      '<p class="sec-sub">' + (d.langMode === "repos"
        ? "By primary language of each source repo."
        : "By bytes of code across " + plural(d.langRepos, "scanned repo") + ".") + "</p>" +
      '<div class="panel">' +
        '<div class="langbar" role="img" aria-label="Language share">' + rows.map(function (r) {
          return '<i style="flex:' + r.n + " 0 0;background:" + r.color + '" data-tip="<b>' + esc(r.name) + "</b> · " + pct(r.n) + " · " + amount(r.n) + '"></i>';
        }).join("") + "</div>" +
        '<ul class="langs">' + rows.map(function (r) {
          return '<li title="' + esc(amount(r.n)) + '"><i class="dot" style="background:' + r.color + '"></i><span class="name">' + esc(r.name) + '</span><span class="pct">' + pct(r.n) + "</span></li>";
        }).join("") + "</ul>" +
      "</div>";
  }

  function renderRepos(d) {
    const grid = $("#v-repos"), more = $("#v-more"), sub = $("#v-repos-sub");
    if (!S.repos) { sub.textContent = "Listing repositories…"; grid.innerHTML = ""; more.innerHTML = ""; return; }
    sub.textContent = plural(S.repos.length, "repo") + " · " + full(d.stars) + " stars · " + full(d.forks) + " forks";
    const scanOf = function (r) { return S.scan[r.full] || {}; };
    const key = {
      stars: function (r) { return r.stars; },
      pushed: function (r) { return Date.parse(r.pushed) || 0; },
      lines: function (r) { return scanOf(r).lines || 0; },
      added: function (r) { return scanOf(r).added || 0; }
    }[ui.sort];
    const sorted = S.repos.slice().sort(function (a, b) { return key(b) - key(a) || (a.pushed < b.pushed ? 1 : -1); });
    const shown = ui.all ? sorted : sorted.slice(0, PAGE);

    grid.innerHTML = shown.map(function (r) {
      const e = scanOf(r);
      const tag = r.priv ? '<span class="pin pin--amber">Private</span>' : r.fork ? '<span class="pin">Fork</span>' : r.archived ? '<span class="pin">Archived</span>' : "";
      return '<a class="card" href="' + esc(r.url) + '" target="_blank" rel="noopener">' +
        '<div class="card__top"><h3 class="card__title">' + esc(r.name) + "</h3>" + tag + "</div>" +
        (r.desc ? '<p class="card__desc">' + esc(r.desc) + "</p>" : "") +
        '<div class="card__meta">' +
          (r.language ? '<span><i class="dot" style="background:' + langColor(r.language) + '"></i>' + esc(r.language) + "</span>" : "") +
          '<span title="Stars">' + STAR_SVG + compact(r.stars) + "</span>" +
          '<span title="Forks">' + FORK_SVG + compact(r.forks) + "</span>" +
          (r.pushed ? "<span>" + monthYear(r.pushed) + "</span>" : "") +
        "</div>" +
        (e.stats ? '<div class="card__loc"><span><b>' + compact(e.lines) + "</b> lines</span>" +
          '<span title="Lines added and deleted by @' + esc(S.user.login) + '"><b>+' + compact(e.added) + "</b> / −" + compact(e.deleted) + "</span>" +
          "<span><b>" + compact(e.commits) + "</b> " + (e.commits === 1 ? "commit" : "commits") + "</span></div>"
          : e.pending ? '<div class="card__loc"><span>Line counts still computing…</span></div>' : "") +
      "</a>";
    }).join("") || '<p class="empty">No public repositories.</p>';

    more.innerHTML = sorted.length > PAGE
      ? '<button class="linkbtn" data-act="toggle">' + (ui.all ? "Show fewer" : "Show all " + full(sorted.length) + " repos") + "</button>"
      : "";
  }

  function renderRate() {
    if (rate.limit == null) return;
    $("#rate").textContent = "API · " + full(rate.remaining) + "/" + full(rate.limit) + " requests left · resets " + clock(rate.reset) +
      (token ? "" : " · not signed in");
  }

  /* --------------------------------------------------------------- sign-in */
  const dialog = $("#signin"), acct = $("#acct");

  function renderAcct() {
    acct.innerHTML = viewer ? '<img src="' + esc(viewer.avatar_url) + '" alt="">' + esc(viewer.login) : "Sign in";
    $("#si-form").hidden = !!viewer;
    $("#si-me").hidden = !viewer;
    $("#si-title").textContent = viewer ? "Signed in" : "Sign in with a token";
    if (viewer) {
      $("#si-avatar").src = viewer.avatar_url;
      $("#si-login").textContent = "@" + viewer.login;
      $("#si-mine").href = "#" + viewer.login;
    }
  }

  // Resolves to the account behind a token, or throws with a message fit for the dialog.
  async function whoIs(tok) {
    const res = await fetch(API + "/user", { headers: { Accept: "application/vnd.github+json", Authorization: "Bearer " + tok } });
    if (res.status === 401) throw new Error("GitHub rejected that token. Check it was copied in full and hasn't expired.");
    if (!res.ok) throw new Error("GitHub returned an error (" + res.status + "). Try again in a moment.");
    return res.json();
  }

  function signOut(expired) {
    token = null; viewer = null;
    store(sessionStorage, TOKEN_KEY, null);
    store(localStorage, TOKEN_KEY, null);
    cacheClear(CACHE_PREFIX + "a:");
    rate.limit = null;
    $("#rate").textContent = "API · idle";
    renderAcct();
    if (expired) {
      $("#si-err").textContent = "Your saved token no longer works. Sign in again or carry on without it.";
      $("#si-err").hidden = false;
      dialog.showModal();
    }
    route(true);
  }

  acct.addEventListener("click", function () { dialog.showModal(); });
  $("#si-close").addEventListener("click", function () { dialog.close(); });
  dialog.addEventListener("click", function (e) { if (e.target === dialog) dialog.close(); });
  $("#si-out").addEventListener("click", function () { dialog.close(); signOut(false); });
  $("#si-mine").addEventListener("click", function () { dialog.close(); });
  $("#si-form").addEventListener("submit", async function (e) {
    e.preventDefault();
    const input = $("#si-token"), err = $("#si-err"), btn = $("#si-submit");
    const tok = input.value.trim();
    if (!tok) return;
    err.hidden = true;
    btn.disabled = true;
    try {
      viewer = await whoIs(tok);
      token = tok;
      store($("#si-remember").checked ? localStorage : sessionStorage, TOKEN_KEY, tok);
      input.value = "";
      renderAcct();
      dialog.close();
      route(true);
    } catch (ex) {
      err.textContent = ex.message === "Failed to fetch" ? "Couldn't reach GitHub. Check your connection." : ex.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
    }
  });

  /* ----------------------------------------------------------------- route */
  function parseLogin(raw) {
    let s = String(raw || "").trim();
    const m = s.match(/github\.com\/([^\/?#\s]+)/i);
    if (m) s = m[1];
    s = s.replace(/^[@\/]+/, "");
    return /^[a-z\d](?:[a-z\d-]{0,38})$/i.test(s) ? s : null;
  }

  function route(force) {
    let raw = "";
    try { raw = decodeURIComponent(location.hash.slice(1)); } catch (e) { /* malformed hash */ }
    if (!raw || raw === "main") { showHome(); return; }
    const login = parseLogin(raw);
    if (!login) { showHome("That doesn't look like a GitHub username."); return; }
    load(login, force === true);
  }

  document.querySelectorAll(".lookup").forEach(function (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const input = form.elements.q, login = parseLogin(input.value);
      if (!login) {
        if (document.body.classList.contains("is-home")) showHome(input.value.trim() ? "That doesn't look like a GitHub username." : "");
        input.focus();
        return;
      }
      input.blur();
      if (location.hash.slice(1).toLowerCase() === login.toLowerCase()) load(login, false);
      else location.hash = login;
    });
  });
  window.addEventListener("hashchange", function () { route(false); });

  view.addEventListener("click", function (e) {
    const btn = e.target.closest("[data-act]");
    if (!btn || !S) return;
    const act = btn.dataset.act;
    if (act === "refresh") load(S.user.login, true);
    else if (act === "signin") dialog.showModal();
    else if (act === "toggle") { ui.all = !ui.all; renderRepos(derive()); }
  });
  view.addEventListener("change", function (e) {
    if (e.target.id === "sort" && S) { ui.sort = e.target.value; renderRepos(derive()); }
  });

  /* --------------------------------------------------------------- tooltip */
  const tip = $("#tip");
  document.addEventListener("pointermove", function (e) {
    const mark = e.target.closest && e.target.closest("[data-tip]");
    if (!mark) { tip.hidden = true; return; }
    tip.innerHTML = mark.dataset.tip;
    tip.hidden = false;
    const half = tip.offsetWidth / 2 + 8;
    tip.style.left = Math.max(half, Math.min(window.innerWidth - half, e.clientX)) + "px";
    tip.style.top = Math.max(tip.offsetHeight + 14, e.clientY) + "px";
  });
  document.addEventListener("scroll", function () { tip.hidden = true; }, { passive: true, capture: true });

  /* ------------------------------------------------------------------ init */
  const nav = $("#nav");
  function onScroll() { nav.classList.toggle("is-scrolled", window.scrollY > 8); }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  (async function init() {
    const saved = store(sessionStorage, TOKEN_KEY) || store(localStorage, TOKEN_KEY);
    if (saved) {
      try { viewer = await whoIs(saved); token = saved; }
      catch (e) {
        // Only forget the token when GitHub says it's bad, not when the network is down.
        if (/rejected/.test(e.message)) { store(sessionStorage, TOKEN_KEY, null); store(localStorage, TOKEN_KEY, null); }
      }
    }
    renderAcct();
    route(false);
  })();
})();
