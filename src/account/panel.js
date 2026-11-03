import './panel.css';
import {
  t,
  msg,
  getLocale,
  describeUnsavedWork,
  persistLocaleAndReload,
  registerUnsavedWork,
} from '../i18n/index.js';
import {
  readStoredVoiceTier,
  writeStoredVoiceTier,
} from '../voice/realtimePreferences.js';
import { EMPTY_PROFILE, normalizeProfile } from './model.js';

const TITLES = {
  overview: msg('Overview'),
  profile: msg('Profile'),
  preferences: msg('Preferences'),
  views: msg('Saved views'),
  security: msg('Security'),
  privacy: msg('Privacy and data'),
};
const ERRORS = {
  not_configured: msg('Cloud sign-in is not configured yet.'),
  sign_in_required: msg('Your session has expired. Sign in again.'),
  request_rejected: msg(
    'The request was refused. Refresh the page and try again.',
  ),
  invalid_request: msg('Check the form fields and try again.'),
  invalid_profile: msg(
    'Check field lengths, time zone and saved views. Up to twenty views are supported.',
  ),
  reauthenticate: msg('Verify your identity, then retry this change.'),
  invalid_code: msg('The verification code is invalid or expired.'),
  password_policy: msg(
    'Use at least twelve characters with uppercase, lowercase, a number and a symbol.',
  ),
  email_unavailable: msg('This email address cannot be used.'),
  credentials_rejected: msg(
    'Your credentials were rejected. Check your password or sign in again.',
  ),
  rate_limited: msg('Too many requests. Wait a moment and try again.'),
  service_unavailable: msg(
    'The account service is unavailable. Your globe and local data are unchanged.',
  ),
};

/** Optional standalone surface. No automatic camera/settings/evidence changes on sign-in. */
export function mountAccountDashboard({ signal, dataManager, styleManager }) {
  const root = document.getElementById('account-dashboard');
  const opener = document.getElementById('account-open');
  if (!root || !opener || signal?.aborted) return null;
  const lifetime = new AbortController();
  const el = (name) => root.querySelector(`#account-${name}`);
  const listen = (node, type, fn) =>
    node.addEventListener(type, fn, { signal: lifetime.signal });
  let state = { configured: false, user: null, profile: { ...EMPTY_PROFILE } };
  let tab = 'overview';
  let dirty = false;
  let busy = false;
  let expiry;
  const unregister = registerUnsavedWork(() =>
    dirty ? msg('unsaved account settings') : null,
  );
  const status = (message, error = false) => {
    el('status').textContent = message;
    el('status').hidden = !message;
    el('status').dataset.error = String(error);
  };

  async function request(path, method = 'GET', body) {
    const response = await fetch(`/api/account/${path}`, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(state.csrf ? { 'X-CSRF-Token': state.csrf } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
    });
    let result;
    try {
      result = await response.json();
    } catch {
      throw new Error('service_unavailable');
    }
    if (!response.ok) {
      if (response.status === 401) {
        state = {
          ...state,
          user: null,
          csrf: null,
          profile: { ...EMPTY_PROFILE },
        };
        dirty = false;
        render();
      }
      throw new Error(result.error ?? 'service_unavailable');
    }
    return result;
  }

  async function run(operation, success) {
    if (busy) return;
    busy = true;
    root.setAttribute('aria-busy', 'true');
    try {
      await operation();
      if (!lifetime.signal.aborted && success) status(t(success));
    } catch (error) {
      if (!lifetime.signal.aborted)
        status(t(ERRORS[error.message] ?? ERRORS.service_unavailable), true);
    } finally {
      busy = false;
      root.removeAttribute('aria-busy');
    }
  }

  function timestamp(seconds) {
    return new Intl.DateTimeFormat(getLocale(), {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: state.profile.timeZone,
    }).format(new Date(seconds * 1000));
  }

  function selectTab(name) {
    if (!TITLES[name] || (!state.user && name !== 'overview')) return;
    if (tab !== name && dirty) {
      if (!globalThis.confirm(t('Discard unsaved account settings?'))) return;
      dirty = false;
      fillForms();
    }
    tab = name;
    el('title').textContent = t(TITLES[name]);
    root.querySelectorAll('[data-account-page]').forEach((node) => {
      node.hidden = node.dataset.accountPage !== name;
    });
    root.querySelectorAll('[data-account-tab]').forEach((button) => {
      if (button.dataset.accountTab === name)
        button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    if (name === 'security') void run(loadSecurity);
  }

  function renderViews() {
    const list = el('views');
    list.replaceChildren();
    if (!state.profile.views.length) {
      const empty = document.createElement('li');
      empty.textContent = t('No saved views yet.');
      list.append(empty);
    }
    state.profile.views.forEach((view, index) => {
      const row = document.createElement('li');
      const link = document.createElement('a');
      link.textContent = view.name;
      // A validated hash on this application's root; never an arbitrary URL.
      link.href = new URL(`/${view.hash}`, location.origin).href;
      listen(link, 'click', (event) => {
        event.preventDefault();
        if (allowNavigation()) {
          location.assign(link.href);
          location.reload();
        }
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = t('Remove');
      remove.setAttribute(
        'aria-label',
        t('Remove {name}', { name: view.name }),
      );
      listen(
        remove,
        'click',
        () =>
          void run(async () => {
            await saveProfile({
              views: state.profile.views.filter((_, i) => i !== index),
            });
            renderViews();
          }, msg('Saved.')),
      );
      row.append(link, remove);
      list.append(row);
    });
  }

  function render() {
    if (!state.user) clearSensitive();
    const profile = state.profile;
    const name = profile.name || state.user?.email || t('Guest');
    el('sidebar-name').textContent = name;
    el('sidebar-state').textContent = state.user
      ? t('Cloud account')
      : t('This device');
    el('avatar').textContent = name
      .split(/\s+/)
      .map((part) => Array.from(part)[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
    el('greeting').textContent = state.user
      ? t('Welcome, {name}', { name: profile.name || state.user.email })
      : t('Welcome to Open-i');
    el('mode').textContent = state.user ? t('Signed in') : t('Guest');
    el('guest').hidden = Boolean(state.user);
    el('setup-notice').hidden = state.configured;
    el('login').disabled = el('signup').disabled = !state.configured;
    el('signup').hidden = state.configured && !state.signupAllowed;
    root.querySelectorAll('[data-account-tab]').forEach((node) => {
      node.disabled = !state.user && node.dataset.accountTab !== 'overview';
    });
    const layers = [...(dataManager?.layers?.values() ?? [])];
    el('layer-count').textContent = String(layers.length);
    el('active-count').textContent = String(
      layers.filter((layer) => layer.enabled).length,
    );
    el('view-count').textContent = String(profile.views.length);
    const providerButton = document.getElementById('key-setup-chip');
    el('providers').hidden = !providerButton || providerButton.hidden;
    fillForms();
    renderViews();
    selectTab(state.user ? tab : 'overview');
    clearTimeout(expiry);
    if (state.user)
      expiry = setTimeout(
        () => {
          state = {
            ...state,
            user: null,
            csrf: null,
            profile: { ...EMPTY_PROFILE },
          };
          dirty = false;
          render();
          status(t(ERRORS.sign_in_required), true);
        },
        Math.max(0, state.user.expiresAt * 1000 - Date.now()),
      );
  }

  function fillForms() {
    for (const formId of ['profile-form', 'preferences-form']) {
      for (const input of el(formId).elements)
        if (input.name && Object.hasOwn(state.profile, input.name))
          input.value = state.profile[input.name];
    }
  }

  function clearSensitive() {
    el('mfa-secret').textContent = '';
    el('mfa-form').hidden = true;
    for (const id of [
      'password-form',
      'email-code-form',
      'mfa-form',
      'delete-form',
    ])
      el(id).reset();
  }

  async function load() {
    state = await request('session');
    state.profile = normalizeProfile(state.profile ?? EMPTY_PROFILE);
    render();
    if (state.user && tab === 'security') await loadSecurity();
  }
  async function loadSecurity() {
    const security = await request('security');
    el('security-summary').textContent = t(
      '{email} · {verification} · Session ends {time}',
      {
        email: security.email,
        verification: security.verified
          ? t('Verified')
          : t('Verification pending'),
        time: timestamp(security.expiresAt),
      },
    );
    el('mfa-state').textContent = security.mfa
      ? t('Authenticator enabled')
      : t('Authenticator not enabled');
    el('mfa-start').hidden = security.mfa;
    el('mfa-disable').hidden = !security.mfa;
  }
  async function saveProfile(patch) {
    const result = await request(
      'profile',
      'PUT',
      normalizeProfile({ ...state.profile, ...patch }),
    );
    state.profile = result.profile;
    el('view-count').textContent = String(state.profile.views.length);
  }
  function allowNavigation() {
    const unsaved = describeUnsavedWork();
    return (
      !unsaved.length ||
      globalThis.confirm(
        t('Leave with unsaved work: {items}?', { items: unsaved.join(', ') }),
      )
    );
  }
  async function login(signup = false, reauthenticate = false) {
    if (!allowNavigation()) return;
    const result = await request('login', 'POST', {
      signup,
      reauthenticate,
      returnHash: styleManager.shareLinkManager.captureHash() ?? location.hash,
    });
    location.assign(result.url);
  }
  function close() {
    if (dirty && !globalThis.confirm(t('Discard unsaved account settings?')))
      return;
    dirty = false;
    root.close();
  }

  listen(opener, 'click', () => {
    root.showModal();
    status('');
    void run(load);
  });
  listen(el('close'), 'click', close);
  listen(root, 'cancel', (event) => {
    event.preventDefault();
    close();
  });
  listen(root, 'keydown', (event) => event.stopPropagation());
  listen(root, 'close', () => {
    clearSensitive();
  });
  listen(el('globe-brand'), 'click', (event) => {
    event.preventDefault();
    close();
  });
  listen(el('guest-globe'), 'click', close);
  root
    .querySelectorAll('[data-account-tab]')
    .forEach((node) =>
      listen(node, 'click', () => selectTab(node.dataset.accountTab)),
    );
  for (const formId of ['profile-form', 'preferences-form'])
    listen(el(formId), 'input', () => {
      dirty = true;
    });
  listen(el('login'), 'click', () => void run(() => login()));
  listen(el('signup'), 'click', () => void run(() => login(true)));
  listen(el('reauth'), 'click', () => void run(() => login(false, true)));
  for (const name of ['logout', 'logout-all'])
    listen(
      el(name),
      'click',
      () =>
        void run(async () => {
          if (allowNavigation()) {
            const result = await request(name, 'POST', {});
            location.assign(result.url);
          }
        }),
    );

  const submit = (id, operation, success = msg('Saved.')) =>
    listen(el(id), 'submit', (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const values = Object.fromEntries(new FormData(form));
      void run(() => operation(values, form), success);
    });
  submit('profile-form', async (values) => {
    await saveProfile(values);
    dirty = false;
    render();
  });
  submit('preferences-form', async (values) => {
    await saveProfile(values);
    dirty = false;
  });
  listen(el('apply'), 'click', () => {
    if (!allowNavigation()) return;
    if (readStoredVoiceTier() !== state.profile.voiceTier) {
      const button = document.getElementById('gev-voice-tier');
      if (button) button.click();
      else writeStoredVoiceTier(state.profile.voiceTier);
    }
    if (getLocale() !== state.profile.language)
      persistLocaleAndReload(state.profile.language);
    else status(t('Preferences applied to this device.'));
  });
  submit('view-form', async (values, form) => {
    const hash = styleManager.shareLinkManager.captureHash();
    await saveProfile({
      views: [...state.profile.views, { name: values.viewName, hash }],
    });
    form.reset();
    renderViews();
  });
  submit(
    'password-form',
    async (values, form) => {
      try {
        await request('password', 'POST', values);
      } finally {
        form.reset();
      }
    },
    msg('Password updated.'),
  );
  submit(
    'email-form',
    async (values) => {
      await request('email', 'POST', values);
    },
    msg('Check your new email address for a verification code.'),
  );
  submit(
    'email-code-form',
    async (values, form) => {
      await request('email/verify', 'POST', values);
      form.reset();
      await loadSecurity();
    },
    msg('Email verified.'),
  );
  listen(
    el('email-resend'),
    'click',
    () =>
      void run(
        () => request('email/resend', 'POST', {}),
        msg('Verification code sent.'),
      ),
  );
  listen(
    el('mfa-start'),
    'click',
    () =>
      void run(async () => {
        const result = await request('mfa/start', 'POST', {});
        el('mfa-secret').textContent = result.secret;
        el('mfa-form').hidden = false;
      }),
  );
  submit(
    'mfa-form',
    async (values, form) => {
      await request('mfa/verify', 'POST', values);
      form.reset();
      el('mfa-secret').textContent = '';
      form.hidden = true;
      await loadSecurity();
    },
    msg('Authenticator enabled'),
  );
  listen(
    el('mfa-disable'),
    'click',
    () =>
      void run(async () => {
        await request('mfa/disable', 'POST', {});
        await loadSecurity();
      }, msg('Authenticator disabled.')),
  );
  listen(
    el('export'),
    'click',
    () =>
      void run(async () => {
        const data = await request('export');
        const url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], {
            type: 'application/json',
          }),
        );
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'open-i-account.json';
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }),
  );
  submit('delete-form', async (values) => {
    if (!allowNavigation()) return;
    const result = await request('delete', 'POST', values);
    location.assign(result.url);
  });
  root.querySelectorAll('[data-account-shortcut]').forEach((button) =>
    listen(button, 'click', () => {
      close();
      if (root.open) return;
      const target = {
        cyber: 'cyber-defence-open',
        providers: 'key-setup-chip',
      }[button.dataset.accountShortcut];
      if (target) document.getElementById(target)?.click();
    }),
  );
  const destroy = () => {
    clearTimeout(expiry);
    unregister();
    lifetime.abort();
    dirty = false;
    if (root.open) root.close();
    el('mfa-secret').textContent = '';
  };
  signal?.addEventListener('abort', destroy, { once: true });
  const callbackStatus = new URL(location.href).searchParams.get('account');
  if (callbackStatus) {
    const url = new URL(location.href);
    url.searchParams.delete('account');
    history.replaceState(null, '', url.href);
    root.showModal();
    void run(async () => {
      await load();
      status(
        callbackStatus === 'signed_in'
          ? t('Signed in')
          : t('Sign-in was cancelled or could not be completed. Try again.'),
        callbackStatus !== 'signed_in',
      );
    });
  } else if (document.body.dataset.accountRequired === 'true') {
    root.showModal();
    void run(async () => {
      await load();
      if (state.user) root.close();
    });
  }
  return { destroy };
}
