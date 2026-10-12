# JankBot

JankBot is an employer-review MTG card and Commander deck demo. Scryfall supplies card data, local Ollama parses chat requests, and the scoring engine ranks cards. Employers can inspect cards, generate Commander decks, edit and validate lists, and export results.

## Protected Employer Demo

The native Windows deployment requires a one-click demo invitation. Employers click a hyperlink labeled **JankBot**, and the app establishes a restricted session without asking for a code. Seeing the public HTML does not grant access to inference, card search, deck validation, model status, or other visitors' jobs. There is no anonymous API access and no geographic filtering: invitations control access regardless of country.

Each invitation expires after 90 days. A shared link allows up to 32 concurrent sessions; legacy private code invitations allow two. The server caps all sessions at 128. Sessions expire after four hours. Limits follow the invitation rather than browser cookies, and all visitors using the same link share its allowance:
- Six chat requests per hour, twenty per day, sixty over the invitation's lifetime.
- Across all invitations: two chat requests per minute, twelve per hour, forty per day.
- One inference job runs at a time; at most three jobs remain unfinished.
- Quotas persist to a host-only usage ledger before admitting inference. Corrupted or unwritable ledgers fail closed.
- Failed inference still consumes an admitted request. Clearing cookies, signing in again, and restarting the server do not reset request quotas.

Invitations use 256-bit cryptographically random tokens. The server stores only their hashes. The hyperlink carries its token in a URL fragment (`#demo=...`), which browsers do not send with HTTP page requests. The page removes the fragment from the current history entry before exchanging the token through a same-origin JSON POST for a secure cookie. It does not save the token in browser storage. Authentication errors fail closed; the client never falls back to anonymous access.

The shared link is intended for your resume and portfolio, but anyone who obtains it can use the restricted demo. A public portfolio link is public authorization, not proof that someone is an employer. Referrer headers do not provide authentication. Expiration, revocation, shared quotas, and host resource limits bound use; they do not prevent all denial-of-service attacks. Keep link credentials out of source control, screenshots, and logs.

## Windows Hosting

The free deployment uses your computer and Tailscale Funnel. Tailscale's Personal plan is free for eligible non-commercial use. Funnel publishes a public HTTPS URL, not the entire computer. It remains in beta and has bandwidth limits. Your computer, internet connection, and services must stay running.

Official sources:
- [Personal pricing](https://tailscale.com/pricing)
- [Funnel scope and limitations](https://tailscale.com/docs/features/tailscale-funnel)
- [Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [Node permission model limitations](https://nodejs.org/api/permissions.html)

Install Node 24 or newer, Ollama, and Tailscale. Sign into Tailscale. Prepare the configured model and current card index from this directory:

```powershell
npm run setup -- --pull
```

From an Administrator PowerShell under the same Windows account:

```powershell
npm run start:public
npm run publish:free
```

The launcher creates a dedicated non-administrator local account with a random password. Its encrypted credential remains under the original owner's private `.runtime/` folder. It copies the app, a streamed read-only card snapshot, and only the selected model into `C:\ProgramData\JankBotEmployerDemo`. It explicitly denies that runtime account access to the original project, including private access codes and host credentials. It does not change the original owner's access.

Before starting, the launcher verifies that the runtime account cannot read the original workspace or private host credential and cannot modify deployed application files. Publishing refuses an anonymous deployment, an incorrect HTTPS origin, a non-loopback listener, or a server running under another Windows account.

The demo Ollama instance uses loopback port 11435 and a separate model store. Your original Ollama instance on port 11434 remains unchanged. Cloud inference is disabled for the demo. Model requests use two CPU threads, no GPU offload, and a 90-second timeout per inference stage. Windows Job Objects enforce:
- App: 768 MiB committed-memory cap, 10% aggregate CPU cap, one process.
- Demo Ollama and child runners: 2 GiB committed-memory cap, 25% aggregate CPU cap, four processes.

Trusted PowerShell supervisors hold the job handles. Stopping a supervisor terminates its managed processes. The Node app additionally uses the permission model: read access only to deployed code, card data, hashed invitation configuration, and the usage ledger; write access only to the ledger files; no subprocess, worker, native-addon, or inspector grants.

The Node permission model and a standard Windows account are defense in depth, not a VM or a guarantee against malicious code or operating-system exploits. The job limits bound the demo's processes, not unrelated software already running on your laptop.

The launcher and supervisors clear unrelated environment variables in their own processes, including API keys and Node preload options. This does not change your normal terminal's environment. The selected format and price cap remain authoritative; model output cannot override those controls.

## Resume and Portfolio Link

The launcher creates a shared invitation labeled `Resume and portfolio` and writes the actual URL, website HTML, and Markdown into this owner-only file:

```text
.runtime/jankbot-link.txt
```

Use **JankBot** as the visible link text in your resume, with the complete URL from that file as its hyperlink destination. The generated HTML uses `target="_blank"` and `rel="noopener noreferrer"`. `.runtime/jankbot-link.html` provides a local clickable preview. The plain site address does not grant new visitors access. Do not give out the Windows service-account credential or host-control token.

Generate or redisplay a separately labeled one-click invitation:

```powershell
npm run demo:link -- -Name "Employer 4"
```

Revoke the shared invitation:

```powershell
npm run demo:revoke -- -Name "Resume and portfolio"
```

Replace a leaked or expired link explicitly:

```powershell
npm run demo:rotate-link -- -Name "Resume and portfolio"
```

Rotation changes the token and renews its 90-day expiration, but preserves the invitation identity and all consumed quotas. Update the hyperlink in your resume and portfolio with the newly generated URL. Repeated generation and normal redeployments reuse the existing token instead of silently issuing replacement credentials. The private link registry remains in `.runtime/demo-links.json`; missing or mismatched credentials require explicit rotation.

Restart the managed demo after invitation changes. Restarting expires all browser sessions, applies revocation/rotation, and preserves usage quotas. A revoked or expired shared invitation intentionally blocks normal startup until you explicitly rotate it:

```powershell
npm run stop:public
npm run start:public
```

Funnel continues forwarding the same port across restart. Disable public access immediately with:

```powershell
& "C:\Program Files\Tailscale\tailscale.exe" funnel --https=443 off
```

Logs and verification results live in `C:\ProgramData\JankBotEmployerDemo\logs`. No service launches automatically after reboot; rerun the start and publish commands. The stop script verifies recorded process identity before terminating the demo and leaves your original Ollama instance alone.

The Tailscale device is named `jankbot`, so its public address begins with `https://jankbot.` and retains your tailnet's `.ts.net` suffix. This changes the Tailscale device name, not the Windows computer name. Changing it again requires restarting the app with the new HTTPS origin and republishing Funnel; previously distributed URLs must also change. See [Tailscale machine names](https://tailscale.com/docs/concepts/machine-names).

## Maintenance

Public requests cannot pull models, refresh caches, write card data, choose backend URLs, execute commands, upload files, or access arbitrary files. The server serves a fixed asset allowlist and rejects linked assets and traversal paths. Cookies use HttpOnly, Secure, and SameSite=Strict; mutations require the configured origin. Body sizes, URL lengths, API rates, sockets, and request duration are bounded. Forwarding headers cannot create a trusted visitor identity.

The demo uses an explicit read-only Scryfall snapshot, with its date visible in the UI. Unknown cards return an error rather than triggering an unrestricted network lookup. Snapshots older than seven days fail readiness. Refresh and redeploy from the owner account:

```powershell
npm run stop:public
npm run setup
npm run start:public
```

Keep Windows, Node, Ollama, and Tailscale updated. Avoid storing unrelated private material in the deployment directory. Back up the private invitation/configuration files and usage ledger if you need to preserve access and quotas.

## Card Names and Workshop UI

Card-name resolution uses the local Scryfall catalog and pinned Fuse.js fuzzy search. Exact names, punctuation-normalized names, and unambiguous face aliases resolve first. A typo corrects automatically only when its fuzzy score, competing-match gap, and length meet conservative thresholds. The response explicitly identifies the correction. Short names, multiple close matches, and unknown names return selectable catalog cards or a clear no-match message, never fabricated cards. Art-series objects do not shadow playable cards.

Standard deck/card request templates use a dedicated command parser that preserves misspellings; more complex messages still use Ollama intent extraction. Recognized ambiguous requests return choices before entering the inference queue or consuming its allowance. Confirming a choice validates its exact catalog name and still requires Ollama for the explanation. Failed inference never becomes a fallback answer. Formats, price controls, authentication, resource caps, and persisted quotas remain authoritative.

Explanation generation uses an Ollama JSON schema with bounded strings, exactly two short synergy points, and card-name enums drawn only from the supplied prompt data. The server independently validates those constraints and fails malformed output rather than truncating it or substituting another answer. Card budgets validate in the browser and on the server; failed requests retain the original message for correction or retry.

Performance improvements include bounded name-query and candidate-pool caches, immutable card-feature memoization, a single inference stage for recognized requests, fewer duplicate prompt tokens, ten-minute model retention, lazy deck thumbnails, in-place card selection, cancellation of stale autocomplete searches, and 800 ms job polling. The UI displays elapsed request time. Cache contents disappear or invalidate when the underlying catalog is replaced; they do not substitute for expired data.

The interface uses original Scryfall card scans and Command Tower artwork, attributed in `public/credits.txt`, plus pinned Lucide icons. It uses local serif/system fonts, a light drafting surface, a responsive spellbook drawer, and a compact card inspector. No external UI CDN or generated imitation card artwork is required. This is an unofficial fan project, not affiliated with Wizards of the Coast.

Install locked dependencies before running the app:

```powershell
npm ci --ignore-scripts
```

The four artwork files and selected icon SVGs are included application assets. To explicitly refresh those assets from Scryfall and the installed Lucide package:

```powershell
node scripts/prepare-ui-assets.js
```

Public requests cannot run that preparation script. Native deployment copies only the required Fuse.js runtime files into its read-only application directory; Docker installs only locked production dependencies.

## Verification

```powershell
npm test
```

Tests cover fragment removal before token exchange, no token storage, one-click authentication, invalid/expired/revoked links, shared session bounds, session reuse, rotation with preserved quotas, forged cookies, session ownership, login limits, persistent and concurrent quotas, failed storage, unauthenticated API denial, origin checks, request limits, static traversal, snapshot-only lookups, and Node file/subprocess permissions. Host deployment performs a separate real Windows-account access check.

Deck generation supports Commander. Other listed formats support card recommendations and deck validation. Synergy scoring remains heuristic, not proof of globally optimal decks or cheapest prices across all printings. The application does not implement a complete MTG rules simulator.

The optional Docker configuration has resource and privilege restrictions and requires an explicit HTTPS origin and employer configuration mount. Docker is not installed or verified on this host; the native Windows deployment above is the tested hosting route. Container setup must prepare `oracle-cards.compact.jsonl` using `scripts/prepare-snapshot.js` in its data volume before starting the public app.

These changes make unsolicited interaction harder and reduce the damage an application compromise could cause. They do not promise zero risk, prevent every denial-of-service attack, or constitute a penetration test.
