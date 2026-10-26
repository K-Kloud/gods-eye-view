import './panel.css';
import {
  t,
  msg,
  formatDate,
  formatNumber,
  registerUnsavedWork,
} from '../i18n/index.js';
import {
  CATEGORIES,
  STATUSES,
  STATES,
  LIMITS,
  extractIndicators,
  matchIndicators,
  relatedCases,
} from './model.js';
import { createCaseStore, STORAGE_KEY } from './store.js';
import { createCaseMap } from './map.js';

const CATEGORY_LABELS = {
  cyber: msg('Cyber incident'),
  kidnapping: msg('Kidnapping report'),
  terrorism: msg('Terrorism report'),
  other: msg('Other report'),
};
const STATUS_LABELS = {
  open: msg('Open'),
  review: msg('Under review'),
  closed: msg('Closed'),
  retracted: msg('Retracted'),
};
const ACTION_LABELS = {
  created: msg('Case created'),
  'evidence-added': msg('Evidence added'),
  ...STATUS_LABELS,
};

/** Opt-in local workspace. It neither changes the layer catalog nor exposes case data to voice/MCP. */
export function mountCyberDefence({ viewer, signal }) {
  if (signal?.aborted) return null;
  const root = document.getElementById('cyber-defence');
  const opener = document.getElementById('cyber-defence-open');
  if (!root || !opener) return null;
  const lifetime = new AbortController();
  const listen = (node, event, fn) =>
    node.addEventListener(event, fn, { signal: lifetime.signal });
  const el = (id) => root.querySelector(`#cd-${id}`);
  const map = createCaseMap(viewer);
  let store,
    storage,
    selected = null,
    intelligence = null,
    loadingFeeds = null,
    locked = true,
    rawArchive = null;
  const stamp = (value) =>
    value
      ? `${formatDate(new Date(value), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' })} UTC`
      : '—';
  const node = (tag, value, className) => {
    const result = document.createElement(tag);
    if (value !== undefined) result.textContent = value;
    if (className) result.className = className;
    return result;
  };
  const say = (message) => {
    el('message').textContent = message;
  };
  const button = (label, action, className = 'scene-btn') => {
    const b = node('button', label, className);
    b.type = 'button';
    listen(b, 'click', action);
    return b;
  };
  const link = (label, url) => {
    const a = node('a', label);
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    return a;
  };
  function option(select, value, label) {
    const o = node('option', label);
    o.value = value;
    select.append(o);
  }
  for (const [id, first] of [
    ['filter-state', t('All states')],
    ['state', t('Unspecified')],
  ]) {
    option(el(id), '', first);
    for (const state of Object.keys(STATES)) option(el(id), state, state);
  }
  for (const category of CATEGORIES)
    option(el('category'), category, t(CATEGORY_LABELS[category]));
  const hasDraft = () =>
    (!el('case-form').hidden && !!el('case-title').value.trim()) ||
    (!el('evidence-form').hidden && !!el('summary').value.trim());
  const discardDraft = () =>
    !hasDraft() || window.confirm(t('Discard unsaved case evidence?'));
  const formButtons = () => [
    el('new'),
    ...el('case-form').querySelectorAll('button'),
    ...el('evidence-form').querySelectorAll('button'),
  ];
  function switchPage(page) {
    root
      .querySelectorAll('[data-cd-tab]')
      .forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.cdTab === page)),
      );
    root.querySelectorAll('[data-cd-page]').forEach((p) => {
      p.hidden = p.dataset.cdPage !== page;
    });
  }
  function newCase() {
    if (locked || !discardDraft()) return;
    el('evidence-form').reset();
    selected = null;
    el('detail').replaceChildren();
    el('evidence-form').hidden = true;
    el('case-form').hidden = false;
    el('case-form').reset();
    el('case-title').focus();
    renderList();
  }
  function renderList() {
    const cases = store?.list() || [];
    const host = el('case-list');
    host.replaceChildren();
    el('count').textContent = t('Cases: {count}', {
      count: formatNumber(cases.length),
    });
    const search = el('search').value.trim().toLowerCase(),
      state = el('filter-state').value;
    const filtered = cases.filter(
      (c) =>
        (!state || c.state === state) &&
        `${c.title} ${c.state} ${c.evidence.map((e) => e.summary).join(' ')}`
          .toLowerCase()
          .includes(search),
    );
    for (const c of filtered) {
      const b = button('', () => selectCase(c.id), 'cd-case');
      b.setAttribute('aria-current', String(selected === c.id));
      b.append(
        node('strong', c.title),
        node(
          'small',
          `${c.state || t('Unspecified')} · ${t(CATEGORY_LABELS[c.category])} · ${t(STATUS_LABELS[c.status])}`,
        ),
      );
      host.append(b);
    }
    if (!filtered.length)
      host.append(
        node(
          'p',
          t('No cases yet. Add a sourced report to begin.'),
          'cd-muted',
        ),
      );
    map.sync(cases);
  }
  function selectCase(id) {
    if (id !== selected && !discardDraft()) return;
    if (id !== selected) el('evidence-form').reset();
    selected = id;
    el('case-form').hidden = true;
    el('evidence-form').hidden = locked;
    el('observed').value = new Date().toISOString().slice(0, 16);
    renderList();
    renderDetail();
  }
  function renderDetail() {
    const cases = store?.list() || [],
      c = cases.find((row) => row.id === selected),
      host = el('detail');
    host.replaceChildren();
    if (!c) return;
    host.append(node('h3', c.title));
    host.append(
      node(
        'p',
        `${t(CATEGORY_LABELS[c.category])} · ${c.state || t('Unspecified')}`,
        'cd-muted',
      ),
    );
    const label = node('label', t('Case status'));
    const select = node('select');
    select.id = 'cd-status';
    select.className = 'gev-field';
    select.disabled = locked;
    label.htmlFor = select.id;
    for (const status of STATUSES)
      option(select, status, t(STATUS_LABELS[status]));
    select.value = c.status;
    listen(select, 'change', async () => {
      select.disabled = true;
      try {
        await store.setStatus(c.id, select.value);
        renderList();
        renderDetail();
      } catch {
        say(
          t('Unable to save. Check the required fields and browser storage.'),
        );
        select.value = c.status;
        select.disabled = locked;
      }
    });
    host.append(label, select);
    if (c.state)
      host.append(
        button(t('View state reference'), () => {
          root.close();
          map.fly(c.state);
        }),
      );
    host.append(
      node(
        'p',
        t(
          'Categories describe reports, not findings of guilt. Source claims require independent verification.',
        ),
        'cd-muted',
      ),
    );
    host.append(node('h3', t('Evidence timeline')));
    if (!c.evidence.length)
      host.append(node('p', t('No evidence attached.'), 'cd-muted'));
    for (const e of [...c.evidence].sort((a, b) =>
      b.observedAt.localeCompare(a.observedAt),
    )) {
      const card = node('article', undefined, 'cd-card');
      card.append(node('small', stamp(e.observedAt)), node('p', e.summary));
      card.append(
        node('p', e.source || t('Manual entry — unverified'), 'cd-muted'),
      );
      if (e.sourceUrl) card.append(link(e.sourceUrl, e.sourceUrl));
      const digest = node('details');
      digest.append(
        node('summary', t('Evidence digest')),
        node('code', e.sha256),
      );
      card.append(digest);
      const indicators = extractIndicators(e.summary);
      if (indicators.length)
        card.append(
          button(t('Check these indicators'), () => {
            el('indicator-text').value = e.summary;
            switchPage('indicators');
            checkIndicators();
          }),
        );
      host.append(card);
    }
    const related = relatedCases(c, cases);
    if (related.length) {
      host.append(node('h3', t('Shared technical indicators')));
      for (const other of related) {
        const b = button(other.title, () => selectCase(other.id));
        host.append(b, node('p', other.indicators.join(' · '), 'cd-muted'));
      }
      host.append(
        node(
          'p',
          t(
            'Technical overlap is a lead, not proof that reports share an offender.',
          ),
          'cd-muted',
        ),
      );
    }
    const activity = node('details');
    activity.append(node('summary', t('Local activity log')));
    const list = node('ol');
    for (const a of c.activity)
      list.append(node('li', `${stamp(a.at)} · ${t(ACTION_LABELS[a.action])}`));
    activity.append(list);
    host.append(activity);
  }
  async function change(work, done) {
    if (locked) return;
    formButtons().forEach((b) => {
      b.disabled = true;
    });
    try {
      await work();
      if (!lifetime.signal.aborted) {
        done?.();
        say(t('Saved locally.'));
      }
    } catch {
      say(t('Unable to save. Check the required fields and browser storage.'));
    } finally {
      formButtons().forEach((b) => {
        b.disabled = locked;
      });
    }
  }
  function renderFeeds() {
    const host = el('feed-state');
    host.replaceChildren();
    for (const [id, name, url] of [
      ['kev', 'CISA KEV', 'https://github.com/cisagov/kev-data'],
      ['feodo', 'Feodo Tracker', 'https://feodotracker.abuse.ch/blocklist/'],
    ]) {
      const feed = intelligence?.[id],
        card = node('article', undefined, 'cd-card');
      card.append(link(name, url));
      card.append(
        node(
          'p',
          !feed
            ? t('Not loaded')
            : feed.state === 'ready'
              ? t('Available')
              : feed.state === 'stale'
                ? t('Stale intelligence')
                : t('Unavailable'),
        ),
      );
      if (feed)
        card.append(
          node(
            'small',
            `${t('Records: {count}', { count: formatNumber(feed.records.length) })} · ${stamp(feed.retrievedAt)}`,
          ),
        );
      host.append(card);
    }
    const advisories = el('advisories');
    advisories.replaceChildren();
    for (const row of [...(intelligence?.kev?.records || [])]
      .sort((a, b) => b.added.localeCompare(a.added))
      .slice(0, 12)) {
      const card = node('article', undefined, 'cd-card');
      card.append(
        link(`${row.id} · ${row.title}`, row.url),
        node('p', row.description),
        node('p', row.action, 'cd-muted'),
      );
      advisories.append(card);
    }
  }
  async function refresh() {
    if (loadingFeeds) return loadingFeeds;
    for (const id of ['refresh', 'check']) el(id).disabled = true;
    say(t('Loading public intelligence…'));
    loadingFeeds = (async () => {
      try {
        // The request has no indicators, case fields or user-selected upstream URL.
        const response = await fetch('/api/cyber-defence/intel', {
          signal: AbortSignal.any([
            lifetime.signal,
            AbortSignal.timeout(35000),
          ]),
          cache: 'no-store',
        });
        if (!response.ok) throw new Error('unavailable');
        const payload = await response.json();
        if (
          !['kev', 'feodo'].every((k) => Array.isArray(payload?.[k]?.records))
        )
          throw new Error('invalid-feed');
        intelligence = payload;
        say(
          Object.values(payload).some((f) => f.state !== 'ready')
            ? t('Some feeds are unavailable or stale. Check source timestamps.')
            : t('Public intelligence updated.'),
        );
      } catch {
        if (intelligence)
          for (const feed of Object.values(intelligence))
            if (feed.state === 'ready') feed.state = 'stale';
        if (!lifetime.signal.aborted)
          say(t('Public intelligence unavailable. Local cases remain usable.'));
      } finally {
        if (!lifetime.signal.aborted) {
          renderFeeds();
          for (const id of ['refresh', 'check']) el(id).disabled = false;
        }
        loadingFeeds = null;
      }
      return intelligence;
    })();
    return loadingFeeds;
  }
  async function checkIndicators() {
    const candidates = extractIndicators(el('indicator-text').value);
    const host = el('indicator-results');
    host.replaceChildren();
    if (!candidates.length) {
      say(t('No supported indicators found.'));
      return;
    }
    await refresh();
    if (lifetime.signal.aborted) return;
    for (const item of matchIndicators(candidates, intelligence)) {
      const card = node(
        'article',
        undefined,
        `cd-card${item.record ? ' cd-alert' : ''}`,
      );
      // Defanged technical values remain text, never clickable destinations.
      card.append(
        node(
          'code',
          item.value.replace(/^https?/, 'hxxp').replace(/\./g, '[.]'),
        ),
      );
      const result =
        item.coverage === 'unsupported'
          ? t('Extracted for case correlation; no matching feed configured.')
          : item.coverage === 'unavailable'
            ? t('Not checked — feed unavailable.')
            : item.coverage === 'no-match'
              ? t('No feed match; this is not a safety verdict.')
              : item.historical
                ? t(
                    'Historical infrastructure match; current activity is not established.',
                  )
                : item.type === 'cve'
                  ? t(
                      'Known exploited vulnerability reference; not proof of compromise.',
                    )
                  : t(
                      'Listed C2 infrastructure; this does not identify its operator.',
                    );
      card.append(node('p', result));
      if (item.stale)
        card.append(node('p', t('Stale intelligence'), 'cd-muted'));
      if (item.record) {
        const r = item.record;
        card.append(
          node('p', r.title || `${r.malware} · ${r.lastSeen || '—'}`),
        );
        card.append(link(t('Source'), r.url));
      }
      host.append(card);
    }
  }
  listen(opener, 'click', () => {
    if (!root.open) root.showModal();
  });
  listen(el('close'), 'click', () => root.close());
  listen(root, 'close', () => opener.focus({ preventScroll: true }));
  listen(root, 'keydown', (e) => e.stopPropagation());
  root
    .querySelectorAll('[data-cd-tab]')
    .forEach((b) => listen(b, 'click', () => switchPage(b.dataset.cdTab)));
  listen(el('new'), 'click', newCase);
  listen(el('search'), 'input', renderList);
  listen(el('filter-state'), 'change', renderList);
  listen(el('case-form'), 'submit', (e) => {
    e.preventDefault();
    change(
      async () => {
        const c = await store.create({
          title: el('case-title').value,
          category: el('category').value,
          state: el('state').value,
        });
        selected = c.id;
      },
      () => {
        el('case-form').reset();
        selectCase(selected);
      },
    );
  });
  listen(el('evidence-form'), 'submit', (e) => {
    e.preventDefault();
    const id = selected;
    change(
      () =>
        store.append(id, {
          summary: el('summary').value,
          source: el('source').value,
          sourceUrl: el('source-url').value,
          observedAt: new Date(`${el('observed').value}Z`).toISOString(),
        }),
      () => {
        el('evidence-form').reset();
        selectCase(id);
      },
    );
  });
  listen(el('refresh'), 'click', refresh);
  listen(el('check'), 'click', checkIndicators);
  listen(el('map'), 'click', () => {
    const visible = map.toggle(store?.list() || []);
    el('map').setAttribute('aria-pressed', String(visible));
    if (visible)
      say(
        t(
          'Only open state-linked reports are mapped, at approximate reference points.',
        ),
      );
  });
  listen(el('export'), 'click', () => {
    const body = locked ? rawArchive : store.export();
    if (!body) return;
    const url = URL.createObjectURL(
      new Blob([body], { type: 'application/json' }),
    );
    const a = node('a');
    a.href = url;
    a.download = `open-i-cases-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  listen(el('import'), 'click', () => {
    if (!locked) el('import-file').click();
  });
  listen(el('import-file'), 'change', async () => {
    const file = el('import-file').files?.[0];
    el('import-file').value = '';
    if (!file || locked) return;
    try {
      if (file.size > LIMITS.bytes) throw new Error('limit');
      await store.import(await file.text());
      renderList();
      renderDetail();
      say(t('Cases imported. Existing records were preserved.'));
    } catch {
      say(
        t(
          'Invalid archive, conflicting case IDs or changed evidence. No data was imported.',
        ),
      );
    }
  });
  const removeUnsaved = registerUnsavedWork(() =>
    hasDraft() ? msg('unsaved case evidence') : null,
  );
  formButtons().forEach((b) => {
    b.disabled = true;
  });
  el('import').disabled = true;
  renderFeeds();
  const ready = (async () => {
    try {
      storage = window.localStorage;
      rawArchive = storage.getItem(STORAGE_KEY);
      store = createCaseStore(storage);
      await store.load();
      if (lifetime.signal.aborted) return;
      locked = false;
      formButtons().forEach((b) => {
        b.disabled = false;
      });
      el('import').disabled = false;
      renderList();
    } catch {
      if (!lifetime.signal.aborted)
        say(
          t(
            'Local case storage could not be read. Existing data was preserved; export a backup before clearing storage.',
          ),
        );
    }
  })();
  const destroy = () => {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    signal?.removeEventListener('abort', destroy);
    removeUnsaved();
    map.destroy();
    if (root.open) root.close();
  };
  signal?.addEventListener('abort', destroy, { once: true });
  return { ready, destroy };
}
