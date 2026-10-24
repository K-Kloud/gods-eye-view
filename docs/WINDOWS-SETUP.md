# Open-i: Windows setup

Use Node.js **24.x, version 24.14.0 or later, or 26.x**. Download a supported
Windows distribution from [Node.js](https://nodejs.org/en/download). The app
does not require Python, Docker, Pinokio, or a database for this setup path.

## Install

Open PowerShell in the folder where you want the project:

```powershell
git clone https://github.com/K-Kloud/gods-eye-view.git
cd gods-eye-view
node --version
npm ci
.\Start-GodsEyeView.cmd doctor
```

The setup doctor should report that Node, npm, and dependencies are ready.
API keys are optional; missing provider keys do not prevent startup.

## Run

From the repository root:

```powershell
.\Start-GodsEyeView.cmd
```

Open [localhost:4173](http://localhost:4173) in a hardware-accelerated Chrome
or Edge browser and choose a starting view. Keep the terminal open; press
**Ctrl+C** there to stop the server. If port 4173 is already in use by this app,
open the existing URL instead of starting another copy.

The launcher checks the Node version, uses `npm.cmd` to avoid PowerShell
script-policy problems, and binds to localhost. If a previously prepared
workspace has a sibling `.tools/node-v24.14.0-win-x64` runtime, it selects that
runtime automatically. Otherwise it uses Node from your PATH. An existing
sibling `.tools/puppeteer` cache is also supported, without overriding a
`PUPPETEER_CACHE_DIR` you have already set.

You can run other package scripts through the same launcher:

```powershell
.\Start-GodsEyeView.cmd doctor
.\Start-GodsEyeView.cmd build
.\Start-GodsEyeView.cmd preview
.\Start-GodsEyeView.cmd test:track -- --offline-imagery
```

The tracking check requires the development server to be running in a
separate terminal. Preview serves an existing production build; run `build`
first. Provider Settings is available in development mode.

## Configure optional providers

Basic satellite imagery and public data layers work without API credentials.
Click **POWER UP → Provider Settings**, or open
[the setup panel](http://localhost:4173/?setup=1), to enable additional providers.
Click **SAVE KEYS** to save credentials into the ignored repository-root `.env`
and restart the development server.

| Capability                         | Credential                              |
| ---------------------------------- | --------------------------------------- |
| Photorealistic 3D                  | Cesium ion token or Google Maps API key |
| Voice                              | OpenAI or Gemini API key                |
| Live ships                         | AISStream key                           |
| Active fires                       | NASA FIRMS key                          |
| Live traffic instead of simulation | TomTom key                              |
| Mapillary street-level imagery     | Mapillary Client Token                  |

See the [README](../README.md) for signup links and the complete provider list,
and [SECURITY.md](../SECURITY.md) for credential restrictions and separate
Google browser/server keys. The tracked [.env.example](../.env.example)
documents advanced configuration without containing credentials.

Keep credentials, installed runtimes, npm dependencies, caches, and generated
builds out of commits. This repository already ignores `.env` variants,
`node_modules`, `dist`, `.gev-cache`, and `.gev-logs`.

## Verification snapshot — 23 October 2026

A local Windows setup using Node 24.14.0 and the original dependency lockfile
passed the setup doctor, production build, and all 67 focused onboarding
checks. Satellite imagery and live aircraft labels loaded without API keys.

The extended headless tracking regression recorded **105 passes and 4 failures**:
two arrival-rotation checks exceeded a strict 500 ms limit under SwiftShader,
and two checks reported the same terrain-height request returning HTTP 502.
The full browser regression was therefore not green, and credentialed
providers were not verified.

An online npm audit reported **five high-severity dependency advisories**
involving Vite, Puppeteer, puppeteer-core, chromium-bidi, and Zod. Dependency
security updates and the terrain-height failure remain outstanding; this
snapshot does not imply those issues were fixed.
