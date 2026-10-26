# Nigeria Cyber Defence

Open the shield button in Open-i's top map toolbar. The optional workspace adds
public technical intelligence, a local case journal, and an aggregate map of
Nigeria-related reports. Existing layers, voice commands, tools, settings and
share-link identifiers retain their original interfaces.

## Workflow

1. Choose **New case**, enter a report title, category and optional Nigerian state
   or FCT. Categories describe reported activity, not a finding that someone is guilty.
2. Add a source name, optional HTTPS public report URL, observed UTC time, and an
   evidence excerpt or analyst note. Original evidence is append-only in the UI;
   corrections should be added as further evidence. Use the case status to record
   review, closure or retraction. The local activity log records these actions.
3. Use **Check these indicators**, or paste an excerpt into **Indicator check**.
   CVE IDs and public IPv4 addresses are matched exactly against public feeds.
   Domains, URLs and SHA-256 hashes are extracted for exact cross-case correlation.
   Candidate URLs are never visited or scanned by the checker.
4. **Public intelligence → Refresh feeds** retrieves the public lists. Only fixed
   feed URLs are fetched; no case contents, pasted indicators or source URLs are
   sent in those requests. Nothing is fetched merely by opening the workspace.
5. **Map reports** adds a separate world-overlay source. Open/under-review cases
   are aggregated at rounded administrative-capital reference points for all 36
   states and FCT. Unspecified, closed and retracted cases are omitted. These are
   approximate state references, never person locations or exact incident sites.
6. **Export cases** creates a local JSON backup. **Import cases** validates an
   exported archive and its evidence hashes, rejects conflicting case IDs, and
   preserves existing records. Imports are atomic: invalid input changes nothing.

## Sources and interpretation

- [CISA KEV, official CISA mirror](https://github.com/cisagov/kev-data): known
  exploited vulnerability references and remediation text. This is global data,
  not a record of attacks in Nigeria or proof that a particular asset was compromised.
  The mirror is maintained by CISA; its data is CC0. Server cache: one hour.
- [Feodo Tracker recommended list](https://feodotracker.abuse.ch/blocklist/):
  botnet command-and-control infrastructure indicators. Retrieved timestamps are
  separate from last-seen dates. Missing or older-than-30-day sightings are labelled
  historical; a match never identifies an operator. Server cache: 15 minutes.
  [Provider terms](https://abuse.ch/terms-of-use/) apply.
- [ngCERT](https://cert.gov.ng/) and [NCCC's ngCERT page](https://nccc.gov.ng/ngcert):
  links for reviewing Nigeria's official advisories. ngCERT blocked automated
  requests during implementation, so this release does not scrape or claim a live
  Nigerian incident feed. Relevant public reports can be attached manually.

No match is not a safety verdict. Reused IPs, shared infrastructure and syndicated
reports can produce misleading correlations. Analysts must independently assess
source reliability and attribution. The module cannot locate kidnappers, identify
terrorists, intercept communications, access private devices or automatically
determine who committed an offence. It does not contact authorities.

## Storage, integrity and limits

Cases remain in this browser profile under `open-i.cyber-defence.v1`; they are not
stored on GitHub or uploaded to an AI provider. This is local plaintext storage,
not an encrypted evidence vault or a multi-user case-management service. Use the
workspace on a trusted machine. Exported files contain the case material itself.

Each evidence digest covers its ID, source, URL, observation/recording times and
text. SHA-256 detects changes against the stored digest; it does not establish
source authenticity, a legally verified chain of custody, or resistance to someone
who can edit both the material and its digest. The activity log is local metadata.

Limits: 200 cases, 100 evidence entries per case, 20,000 characters per excerpt,
1,000 activity entries per case, and a 2 MB archive/storage limit. A failed write
keeps the previous live case set. An unreadable existing archive is preserved and
editing is disabled; export its raw backup before repairing browser storage.
The module intentionally keeps case material out of share links and voice/MCP
entity context. Overlay counts reset to hidden on reload.

The feed proxy accepts same-site GET requests only, rejects query parameters and
redirects, bounds source bodies to 4 MiB, coalesces requests and rate-limits callers.
Source failures are marked unavailable or stale; last-good records retain their
original retrieval timestamp. Local cases remain usable without network access.

## Verification

Run `npm test`, `npm run check:boundaries`, `npm run build`, and
`npm run qa:cyber-defence` against a running dev server. The browser check uses an
isolated disposable profile and explicitly synthetic feed/evidence fixtures. It
checks creation, evidence digests, XSS handling, status history, exact matching,
source-only network requests, map toggling, import/export and preservation of the
existing layer catalog. Screenshots and fixture exports go to ignored
`qa-artifacts/cyber-defence/`, never the user's case store.

Local verification on 26 October 2026: production build, package boundaries,
formatting, translations, and the cyber-defence browser workflow passed. Both
real public feeds responded successfully. The browser check also covered stale
results after a failed refresh and a narrow viewport.
The application startup/teardown check passed, all 66 first-run browser checks
passed with a clean console, and all 15 allocation checks passed.

The full unit run reported 8,319 passes, five failures and 11 skips. The failures
revealed old branding snapshots, a Windows file-URL conversion in an asset test,
a terrain test reading the developer's cache, and a five-second KML subprocess
deadline under parallel load. After test-harness corrections, all 118 tests in
the affected groups passed in isolation; existing application behavior was not
changed. The full parallel suite was not repeated after those corrections.
The tracking harness reported 105 passes and four failures: two 500 ms arrival
timing checks and two terrain rate-limit checks. This is not a clean full-suite
certification.
