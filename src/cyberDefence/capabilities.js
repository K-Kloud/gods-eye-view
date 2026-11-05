import { formatDate, formatNumber, msg, t } from '../i18n/index.js';
import {
  channelLeads,
  parseTransfers,
  publicChannel,
  PUBLIC_CHANNEL_PREFIX,
  traceTransfers,
} from './capabilityAnalysis.js';

const RESPONSE_STEPS = {
  oil: [
    msg(
      'Notify the operations and safety leads and follow the site incident plan before isolating or changing equipment.',
    ),
    msg(
      'Record affected assets, software versions and observed indicators from approved monitoring.',
    ),
    msg(
      'Review vendor and industrial control advisories and agree on a safe remediation window.',
    ),
  ],
  fraud: [
    msg(
      'Pause the suspected payment and verify the request through an independently known contact.',
    ),
    msg('Preserve redacted messages, timestamps and transaction references.'),
    msg(
      'Alert the payment provider and review payment approvals and payee changes.',
    ),
  ],
  privacy: [
    msg(
      'Ask the authorised response owner to contain the exposure and revoke compromised access.',
    ),
    msg(
      'Preserve audit records and document the affected data and systems using redacted references.',
    ),
    msg(
      'Review the organisation’s notification process and the official NDPC reporting route.',
    ),
  ],
  bank: [
    msg(
      'Contact the bank through a trusted channel to dispute unauthorised activity and request protective restrictions.',
    ),
    msg(
      'Secure affected accounts from a trusted device and review recovery settings and active sessions.',
    ),
    msg(
      'Record redacted transaction references and the bank’s complaint reference for follow-up.',
    ),
  ],
};
const TRANSFER_HEADERS = [
  msg('Hop'),
  msg('Transfer reference'),
  msg('Observed time (UTC)'),
  msg('Sender'),
  msg('Recipient'),
  msg('Amount'),
  msg('Source'),
];

export function mountCapabilities({
  root,
  signal,
  readCases,
  openCase,
  startCase,
  showIndicators,
  say,
}) {
  const el = (id) => root.querySelector(`#cd-${id}`);
  const listen = (element, event, action) =>
    element.addEventListener(event, action, { signal });
  const node = (tag, text, className) => {
    const result = root.ownerDocument.createElement(tag);
    if (text !== undefined) result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  const stamp = (value) =>
    formatDate(new Date(value), {
      dateStyle: 'medium',
      timeStyle: 'medium',
      timeZone: 'UTC',
    });

  function fillCases(id, categories) {
    const select = el(`${id}-case`);
    const previous = select.value;
    const cases = readCases().filter(
      (row) =>
        categories.includes(row.category) &&
        ['open', 'review'].includes(row.status),
    );
    const blank = node(
      'option',
      cases.length ? t('Choose a case') : t('Create an open case first.'),
    );
    blank.value = '';
    select.replaceChildren(blank);
    for (const row of cases) {
      const option = node('option', row.title);
      option.value = row.id;
      select.append(option);
    }
    if (cases.some((row) => row.id === previous)) select.value = previous;
    el(`${id}-prepare`).disabled = !cases.length;
  }

  function renderChannels() {
    const host = el('channel-results');
    const leads = channelLeads(readCases(), el('channel-search').value);
    host.replaceChildren();
    if (!leads.length)
      host.append(
        node('p', t('No sourced channel observations match.'), 'cd-muted'),
      );
    for (const { channel, caseCount, observations } of leads.slice(0, 30)) {
      const card = node('article', undefined, 'cd-card');
      card.append(
        node(
          'code',
          channel.replace(/^https:/, 'hxxps:').replaceAll('.', '[.]'),
        ),
        node(
          'p',
          t('Cases: {cases} · Observations: {observations}', {
            cases: formatNumber(caseCount),
            observations: formatNumber(observations.length),
          }),
          'cd-muted',
        ),
      );
      const list = node('ul');
      for (const row of observations.slice(0, 6)) {
        const item = node('li');
        const open = node('button', row.title, 'scene-btn');
        open.type = 'button';
        // The current DOM owns this handler, so filtering does not accumulate
        // listeners on the lifetime signal for old results.
        open.onclick = () => {
          if (!signal.aborted) openCase(row.caseId);
        };
        item.append(
          open,
          node('p', `${row.source} · ${stamp(row.observedAt)}`, 'cd-muted'),
        );
        list.append(item);
      }
      card.append(list);
      host.append(card);
    }
  }

  listen(el('channel-search'), 'input', renderChannels);
  listen(el('channel-form'), 'submit', (event) => {
    event.preventDefault();
    let channel;
    try {
      channel = publicChannel(el('channel-url').value);
    } catch {
      say(
        t(
          'Enter a direct public HTTPS channel path without a query or fragment.',
        ),
      );
      return;
    }
    if (openCase(el('channel-case').value, PUBLIC_CHANNEL_PREFIX + channel))
      el('channel-url').value = '';
  });

  const clearTrace = () => el('transfer-results').replaceChildren();
  listen(el('transfer-form'), 'input', clearTrace);
  listen(el('transfer-form'), 'submit', (event) => {
    event.preventDefault();
    clearTrace();
    const host = el('transfer-results');
    const parsed = parseTransfers(el('transfer-rows').value);
    if (parsed.limit) {
      host.append(
        node(
          'p',
          t('Use at most 300 distinct transfer rows and 100,000 characters.'),
        ),
      );
      return;
    }
    if (parsed.line) {
      host.append(
        node(
          'p',
          t(
            'Row {line} is invalid or conflicts with an earlier reference. Use the six tab-separated fields and a UTC time such as 2026-01-01T12:00:00Z.',
            { line: formatNumber(parsed.line) },
          ),
        ),
      );
      return;
    }
    const ledger = el('transfer-ledger').value.trim();
    if (!ledger) {
      host.append(
        node('p', t('Enter the ledger or chain and asset for these rows.')),
      );
      return;
    }
    const matches = traceTransfers(
      parsed.rows,
      el('transfer-seed').value.trim(),
      el('transfer-direction').value,
      el('transfer-hops').valueAsNumber,
    );
    host.append(node('h4', ledger));
    host.append(
      node(
        'p',
        t('Transfers found: {count}', { count: formatNumber(matches.length) }),
      ),
    );
    if (!matches.length) {
      host.append(
        node(
          'p',
          t(
            'No matching path in the supplied rows for this direction and hop limit.',
          ),
          'cd-muted',
        ),
      );
      return;
    }
    const wrapper = node('div', undefined, 'cd-table-scroll');
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', t('Transfer trace results'));
    const table = node('table');
    const heading = node('tr');
    for (const label of TRANSFER_HEADERS) {
      const cell = node('th', t(label));
      cell.scope = 'col';
      heading.append(cell);
    }
    const head = node('thead');
    head.append(heading);
    const body = node('tbody');
    for (const row of matches) {
      const tr = node('tr');
      for (const value of [
        formatNumber(row.hop),
        row.reference,
        stamp(row.timeMs),
        row.from,
        row.to,
        row.amount,
        row.source,
      ])
        tr.append(node('td', value));
      body.append(tr);
    }
    table.append(head, body);
    wrapper.append(table);
    host.append(wrapper);
  });

  function renderSteps() {
    const checklist = el('response-checklist');
    checklist.replaceChildren();
    for (const step of RESPONSE_STEPS[el('response-kind').value]) {
      const label = node('label', undefined, 'cd-response-step');
      const check = node('input');
      check.type = 'checkbox';
      check.value = step;
      label.append(check, node('span', t(step)));
      checklist.append(label);
    }
  }
  listen(el('response-kind'), 'change', renderSteps);
  listen(el('response-form'), 'submit', (event) => {
    event.preventDefault();
    const complete = [
      ...el('response-steps').querySelectorAll('input:checked'),
    ];
    if (!complete.length) {
      say(t('Select a completed response step before preparing evidence.'));
      return;
    }
    const scenario = el('response-kind').selectedOptions[0].textContent;
    const summary = [
      scenario,
      t('Completed steps'),
      ...complete.map((check) => `• ${t(check.value)}`),
    ].join('\n');
    if (openCase(el('response-case').value, summary)) renderSteps();
  });
  listen(el('response-indicators'), 'click', showIndicators);
  for (const button of root.querySelectorAll('[data-cd-start]'))
    listen(button, 'click', () => startCase(button.dataset.cdStart));
  renderSteps();

  return {
    show(page) {
      if (['networks', 'financing', 'prevention'].includes(page)) say('');
      if (page === 'networks') {
        fillCases('channel', ['terrorism', 'kidnapping']);
        renderChannels();
      }
      if (page === 'prevention') fillCases('response', ['cyber']);
    },
  };
}
