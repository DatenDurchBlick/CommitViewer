/**
 * GitHub API Wrapper
 * All calls go directly to api.github.com — no backend.
 */

const GitHubAPI = (() => {
  const BASE = 'https://api.github.com';

  let _token = null;

  function setToken(token) {
    _token = token ? token.trim() : null;
  }

  function getToken() { return _token; }

  function _headers() {
    const h = {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
    if (_token) h['Authorization'] = `Bearer ${_token}`;
    return h;
  }

  async function _fetch(path, params = {}) {
    const url = new URL(BASE + path);
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const res = await fetch(url.toString(), { headers: _headers() });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg = body.message || `HTTP ${res.status}`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    // Capture rate-limit info from headers
    const remaining = parseInt(res.headers.get('x-ratelimit-remaining') || '-1');
    const limit     = parseInt(res.headers.get('x-ratelimit-limit') || '-1');
    const reset     = parseInt(res.headers.get('x-ratelimit-reset') || '0');
    GitHubAPI._rateLimit = { remaining, limit, reset };

    return res.json();
  }

  /**
   * Validate token by fetching current user.
   * Returns { login, name } on success.
   */
  async function validateToken() {
    return _fetch('/user');
  }

  /**
   * Get all branches for a repo.
   */
  async function getBranches(owner, repo) {
    const branches = [];
    let page = 1;
    while (true) {
      const data = await _fetch(`/repos/${owner}/${repo}/branches`, { per_page: 100, page });
      branches.push(...data);
      if (data.length < 100) break;
      page++;
    }
    return branches;
  }

  /**
   * Get commits for a specific branch.
   * Returns array of commit objects.
   */
  async function getCommits(owner, repo, sha, perPage = 100) {
    return _fetch(`/repos/${owner}/${repo}/commits`, {
      sha,
      per_page: perPage
    });
  }

  /**
   * Fetch commits from ALL branches and merge into a unified list.
   * Returns { commits: Map<sha, commit>, branches: [{name, sha, color}] }
   */
  async function getAllCommits(owner, repo, maxCount = 100) {
    const branches = await getBranches(owner, repo);

    const BRANCH_COLORS = [
      '#6c63ff', '#ff6b9d', '#ffa502', '#2ed573',
      '#1e90ff', '#ff6348', '#eccc68', '#a29bfe',
      '#fd79a8', '#00cec9', '#e17055', '#74b9ff'
    ];

    const branchMeta = branches.map((b, i) => ({
      name: b.name,
      sha:  b.commit.sha,
      color: BRANCH_COLORS[i % BRANCH_COLORS.length]
    }));

    // Fetch commits per branch (concurrently, max 6 at a time)
    const commitMap = new Map(); // sha -> enriched commit obj
    const shaByBranch = new Map(); // branchName -> Set<sha>

    // Limit concurrency
    const chunks = [];
    for (let i = 0; i < branchMeta.length; i += 6) {
      chunks.push(branchMeta.slice(i, i + 6));
    }

    for (const chunk of chunks) {
      await Promise.all(chunk.map(async (branch) => {
        try {
          const commits = await getCommits(owner, repo, branch.sha, maxCount);
          const shas = new Set();
          commits.forEach(c => {
            shas.add(c.sha);
            if (!commitMap.has(c.sha)) {
              commitMap.set(c.sha, {
                sha:       c.sha,
                shortSha:  c.sha.slice(0, 7),
                message:   c.commit.message.split('\n')[0],
                fullMessage: c.commit.message,
                author:    c.commit.author.name,
                authorEmail: c.commit.author.email,
                date:      new Date(c.commit.author.date),
                parents:   c.parents.map(p => p.sha),
                branches:  [],
                color:     null
              });
            }
          });
          shaByBranch.set(branch.name, shas);
        } catch (e) {
          console.warn(`Failed to fetch commits for branch ${branch.name}:`, e.message);
        }
      }));
    }

    // Assign branches to commits
    branchMeta.forEach(branch => {
      const shas = shaByBranch.get(branch.name) || new Set();
      // The tip commit (branch.sha) belongs to this branch
      if (commitMap.has(branch.sha)) {
        const c = commitMap.get(branch.sha);
        c.branches.push(branch.name);
        if (!c.color) c.color = branch.color;
      }
      // Walk ancestors until we find a commit that already has a branch
      // (simplified: just tag the tip)
    });

    // Sort all commits by date desc
    const sorted = Array.from(commitMap.values()).sort((a, b) => b.date - a.date);

    // Assign colors to uncolored commits via parent tracing
    // Simple pass: color inherits from children
    const colorMap = new Map();
    branchMeta.forEach(b => colorMap.set(b.sha, b.color));

    sorted.forEach(c => {
      if (!c.color) {
        // Find first colored child
        for (const [sha, existing] of commitMap) {
          if (existing.parents.includes(c.sha) && existing.color) {
            c.color = existing.color;
            break;
          }
        }
        if (!c.color) c.color = BRANCH_COLORS[0];
      }
    });

    return { commits: sorted, branches: branchMeta };
  }

  /**
   * Get rate limit info.
   */
  async function getRateLimit() {
    return _fetch('/rate_limit');
  }

  return {
    setToken,
    getToken,
    validateToken,
    getBranches,
    getCommits,
    getAllCommits,
    getRateLimit,
    _rateLimit: { remaining: -1, limit: -1, reset: 0 }
  };
})();
