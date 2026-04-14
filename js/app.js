/**
 * CommitViewer — Main Application Logic
 */

(function () {
  'use strict';

  // ── Storage ────────────────────────────────────────────────────────────────

  const Storage = {
    get(key, fallback = null) {
      try { const v = localStorage.getItem(key); return v !== null ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch {} },
    del(key)      { try { localStorage.removeItem(key); } catch {} }
  };

  const KEY_TOKEN   = 'cv_token';
  const KEY_REPOS   = 'cv_repos';
  const KEY_ACTIVE  = 'cv_active_repo';
  const KEY_COMMITS = 'cv_commits_';
  const KEY_SETTINGS = 'cv_settings';

  // ── State ──────────────────────────────────────────────────────────────────

  let token    = Storage.get(KEY_TOKEN);
  let repos    = Storage.get(KEY_REPOS, []);   // [{owner, name, favorite}]
  let active   = Storage.get(KEY_ACTIVE);      // "owner/name"
  let settings = { ...{ commitCount: 100 }, ...Storage.get(KEY_SETTINGS, {}) };

  // ── DOM refs ───────────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);

  const screens = {
    setup:    $('screen-setup'),
    main:     $('screen-main'),
    settings: $('screen-settings')
  };

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    }

    // Init graph canvas
    GitGraph.init($('graph-canvas'), onCommitClick);

    // Wire events
    _bindSetup();
    _bindMain();
    _bindSettings();
    _bindDrawer();

    // Navigate to the right screen
    if (!token) {
      _showScreen('setup');
    } else {
      GitHubAPI.setToken(token);
      _showScreen('main');
      if (active) {
        _loadRepo(active);
      } else if (repos.length) {
        _loadRepo(repos[0].owner + '/' + repos[0].name);
      }
    }
  }

  // ── Screen Management ──────────────────────────────────────────────────────

  function _showScreen(name) {
    Object.entries(screens).forEach(([k, el]) => {
      el.classList.toggle('active', k === name);
    });
  }

  // ── Setup Screen ───────────────────────────────────────────────────────────

  function _bindSetup() {
    $('btn-toggle-token').addEventListener('click', () => {
      const inp = $('input-token');
      inp.type  = inp.type === 'password' ? 'text' : 'password';
    });

    $('btn-setup-save').addEventListener('click', async () => {
      const t    = $('input-token').value.trim();
      const repo = $('input-repo').value.trim();

      if (!t || !repo) { _showSetupError('Bitte Token und Repository angeben.'); return; }
      if (!/^[^/]+\/[^/]+$/.test(repo)) { _showSetupError('Format: owner/repository'); return; }

      _setSetupLoading(true);
      GitHubAPI.setToken(t);

      try {
        await GitHubAPI.validateToken();
      } catch (e) {
        _setSetupLoading(false);
        _showSetupError('Token ungültig: ' + e.message);
        return;
      }

      // Save token & repo
      token = t;
      Storage.set(KEY_TOKEN, token);

      const [owner, name] = repo.split('/');
      _addRepo(owner, name);
      active = repo;
      Storage.set(KEY_ACTIVE, active);

      _setSetupLoading(false);
      _showScreen('main');
      _loadRepo(repo);
    });
  }

  function _showSetupError(msg) {
    const el = $('setup-error');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function _setSetupLoading(loading) {
    $('btn-setup-save').disabled = loading;
    $('btn-setup-label').textContent = loading ? 'Wird geprüft…' : 'Speichern & Graph laden';
    $('btn-setup-spinner').classList.toggle('hidden', !loading);
    $('setup-error').classList.add('hidden');
  }

  // ── Main Screen ────────────────────────────────────────────────────────────

  function _bindMain() {
    $('btn-settings').addEventListener('click', () => _showScreen('settings'));
    $('btn-repos').addEventListener('click', _openDrawer);
    $('btn-refresh').addEventListener('click', () => { if (active) _loadRepo(active, true); });
    $('btn-close-panel').addEventListener('click', _closePanel);
    $('btn-retry').addEventListener('click', () => { if (active) _loadRepo(active, true); });
  }

  async function _loadRepo(repoStr, forceRefresh = false) {
    if (!repoStr) return;
    active = repoStr;
    Storage.set(KEY_ACTIVE, active);

    const [owner, name] = repoStr.split('/');

    // Update header
    $('header-repo-name').textContent = name;
    $('header-branch-name').textContent = owner;

    // Show loading
    _setState('loading');

    // Check cache
    const cacheKey = KEY_COMMITS + repoStr;
    if (!forceRefresh) {
      const cached = Storage.get(cacheKey);
      if (cached) {
        _renderGraph(cached.commits, cached.branches);
        _setState('graph');
        _updateRateLimit();
        // Refresh in background
        _fetchAndCache(owner, name, cacheKey, true);
        return;
      }
    }

    _startRefreshAnim();
    try {
      await _fetchAndCache(owner, name, cacheKey, false);
    } catch (e) {
      _setState('error', e.message);
    }
    _stopRefreshAnim();
  }

  async function _fetchAndCache(owner, name, cacheKey, silent = false) {
    try {
      const { commits, branches } = await GitHubAPI.getAllCommits(owner, name, settings.commitCount);
      if (!commits.length) { _setState('empty'); return; }

      Storage.set(cacheKey, { commits: _serializeCommits(commits), branches });
      _renderGraph(commits, branches);
      _setState('graph');
      _updateRateLimit();
    } catch (e) {
      if (!silent) throw e;
    }
  }

  function _serializeCommits(commits) {
    // dates are objects; convert to ISO strings for storage
    return commits.map(c => ({ ...c, date: c.date instanceof Date ? c.date.toISOString() : c.date }));
  }

  function _deserializeCommits(commits) {
    return commits.map(c => ({ ...c, date: c.date instanceof Date ? c.date : new Date(c.date) }));
  }

  function _renderGraph(commits, branches) {
    const deserialized = _deserializeCommits(commits);
    GitGraph.setData(deserialized);
  }

  function _setState(state, msg = '') {
    $('loading-state').classList.toggle('hidden', state !== 'loading');
    $('error-state').classList.toggle('hidden',   state !== 'error');
    $('empty-state').classList.toggle('hidden',   state !== 'empty');
    $('graph-canvas').style.visibility = state === 'graph' ? 'visible' : 'hidden';
    if (state === 'error') $('error-state-msg').textContent = msg || 'Fehler beim Laden';
  }

  function _startRefreshAnim() {
    $('refresh-icon').classList.add('spinning');
  }
  function _stopRefreshAnim() {
    $('refresh-icon').classList.remove('spinning');
  }

  function _updateRateLimit() {
    const rl = GitHubAPI._rateLimit;
    if (rl.remaining < 0) return;
    const bar = $('rate-limit-bar');
    $('rate-limit-text').textContent = `API: ${rl.remaining}/${rl.limit} Anfragen verbleibend`;
    bar.classList.toggle('hidden', rl.remaining > 100);
  }

  // ── Commit Panel ───────────────────────────────────────────────────────────

  function onCommitClick(commit) {
    $('panel-hash').textContent = commit.shortSha;
    $('panel-message').textContent = commit.fullMessage || commit.message;
    $('panel-author').textContent  = commit.author;
    $('panel-date').textContent    = _formatDate(commit.date);

    const panelBranches = $('panel-branches');
    panelBranches.innerHTML = '';
    (commit.branches || []).forEach((b, i) => {
      const span = document.createElement('span');
      span.className = 'branch-tag';
      span.textContent = b;
      span.style.borderColor = commit.color || '#6c63ff';
      span.style.color       = commit.color || '#6c63ff';
      panelBranches.appendChild(span);
    });

    $('commit-panel').classList.remove('hidden');
  }

  function _closePanel() {
    $('commit-panel').classList.add('hidden');
  }

  function _formatDate(date) {
    if (!(date instanceof Date)) date = new Date(date);
    return date.toLocaleString('de-DE', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  // ── Repos Drawer ───────────────────────────────────────────────────────────

  function _bindDrawer() {
    const drawer = $('drawer-repos');

    $('btn-close-repos').addEventListener('click', _closeDrawer);
    $('btn-add-repo').addEventListener('click', _showAddRepoModal);

    // Close on overlay click (we'll create one dynamically)
    $('btn-cancel-repo').addEventListener('click', _hideAddRepoModal);
    $('btn-confirm-repo').addEventListener('click', _confirmAddRepo);
  }

  function _openDrawer() {
    _renderReposList();
    $('drawer-repos').classList.remove('hidden');
    $('drawer-overlay').onclick = _closeDrawer;
  }

  function _closeDrawer() {
    $('drawer-repos').classList.add('hidden');
  }

  function _renderReposList() {
    const list = $('repos-list');
    list.innerHTML = '';

    const sorted = [...repos].sort((a, b) => (b.favorite ? 1 : 0) - (a.favorite ? 1 : 0));

    sorted.forEach(r => {
      const key = `${r.owner}/${r.name}`;
      const isActive = key === active;

      const item = document.createElement('div');
      item.className = 'repo-item' + (isActive ? ' active' : '');

      const initial = r.name[0].toUpperCase();
      item.innerHTML = `
        <div class="repo-item-icon">${initial}</div>
        <div class="repo-item-info">
          <div class="repo-item-name">${_esc(r.name)}</div>
          <div class="repo-item-owner">${_esc(r.owner)}</div>
        </div>
        <div class="repo-item-actions">
          <button class="repo-item-fav${r.favorite ? ' active' : ''}" title="Favorit" data-key="${_esc(key)}">
            ${r.favorite ? '★' : '☆'}
          </button>
          <button class="repo-item-del icon-btn" title="Entfernen" data-key="${_esc(key)}">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>
        </div>`;

      item.addEventListener('click', (e) => {
        if (e.target.closest('.repo-item-fav')) {
          _toggleFavorite(key);
          return;
        }
        if (e.target.closest('.repo-item-del')) {
          _removeRepo(key);
          return;
        }
        _closeDrawer();
        _loadRepo(key);
      });

      list.appendChild(item);
    });

    if (!repos.length) {
      list.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:24px;">Noch keine Repositories</p>';
    }
  }

  function _showAddRepoModal() {
    $('modal-add-repo').classList.remove('hidden');
    $('input-new-repo').value = '';
    $('add-repo-error').classList.add('hidden');
    setTimeout(() => $('input-new-repo').focus(), 50);
  }

  function _hideAddRepoModal() {
    $('modal-add-repo').classList.add('hidden');
  }

  async function _confirmAddRepo() {
    const val = $('input-new-repo').value.trim();
    if (!val || !/^[^/]+\/[^/]+$/.test(val)) {
      $('add-repo-error').textContent = 'Format: owner/repository';
      $('add-repo-error').classList.remove('hidden');
      return;
    }
    const [owner, name] = val.split('/');
    _addRepo(owner, name);
    _hideAddRepoModal();
    _renderReposList();
  }

  function _addRepo(owner, name) {
    const key = `${owner}/${name}`;
    if (!repos.find(r => `${r.owner}/${r.name}` === key)) {
      repos.push({ owner, name, favorite: false });
      Storage.set(KEY_REPOS, repos);
    }
  }

  function _removeRepo(key) {
    repos = repos.filter(r => `${r.owner}/${r.name}` !== key);
    Storage.set(KEY_REPOS, repos);
    Storage.del(KEY_COMMITS + key);
    if (active === key) {
      active = repos.length ? `${repos[0].owner}/${repos[0].name}` : null;
      Storage.set(KEY_ACTIVE, active);
    }
    _renderReposList();
  }

  function _toggleFavorite(key) {
    const r = repos.find(r => `${r.owner}/${r.name}` === key);
    if (r) { r.favorite = !r.favorite; Storage.set(KEY_REPOS, repos); }
    _renderReposList();
  }

  // ── Settings Screen ────────────────────────────────────────────────────────

  function _bindSettings() {
    $('btn-back-settings').addEventListener('click', () => {
      _showScreen('main');
    });

    $('btn-toggle-settings-token').addEventListener('click', () => {
      const inp = $('settings-token');
      inp.type = inp.type === 'password' ? 'text' : 'password';
    });

    $('btn-save-token').addEventListener('click', async () => {
      const t = $('settings-token').value.trim();
      if (!t) return;
      GitHubAPI.setToken(t);
      try {
        await GitHubAPI.validateToken();
        token = t;
        Storage.set(KEY_TOKEN, token);
        alert('Token gespeichert!');
      } catch (e) {
        alert('Token ungültig: ' + e.message);
      }
    });

    $('settings-commit-count').addEventListener('change', (e) => {
      settings.commitCount = parseInt(e.target.value);
      Storage.set(KEY_SETTINGS, settings);
    });

    $('btn-clear-cache').addEventListener('click', () => {
      repos.forEach(r => Storage.del(KEY_COMMITS + `${r.owner}/${r.name}`));
      alert('Cache geleert!');
    });

    $('btn-reset-app').addEventListener('click', () => {
      if (confirm('App komplett zurücksetzen? Alle Daten werden gelöscht.')) {
        localStorage.clear();
        location.reload();
      }
    });

    // Populate settings fields on show
    screens.settings.addEventListener('transitionend', () => {});
    $('btn-settings').addEventListener('click', () => {
      $('settings-token').value = token || '';
      $('settings-commit-count').value = settings.commitCount;
    });
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  function _esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Start ──────────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);

})();
