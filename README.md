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

### Pinned Local Model

`model-profile.json` defines exactly one model tag, its SHA-256 manifest digest, and its explicit thinking policy. The app, owner setup and native deployment share that profile. An environment override that disagrees with it stops startup. Inference checks the installed digest before every request; a missing or changed model fails rather than selecting an alternate. Thinking-capable deployments explicitly disable thinking to preserve the bounded structured-output workload. This does not disable card evidence, schema validation or server-side rules checks.

Provisioning verifies the source manifest and every selected deployed blob against their SHA-256 digests. Public users cannot edit the profile, pull models, choose a model or trigger an alternate backend. A model upgrade requires an owner-reviewed profile change, benchmark and redeployment. Upstream tag changes require explicit review; `npm run setup -- --pull` does not accept a mismatched digest.

See [the restricted model benchmark](docs/model-benchmark.md) for the protocol, measurements and limits of the comparison. Raw run reports remain owner-local under `.runtime/benchmarks/`; they do not contain invitation or host-control credentials.

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

Public requests cannot pull models, refresh caches, write card data, choose backend URLs, execute commands, upload arbitrary files, or access arbitrary host files. Deck text import reads a bounded local text file in the browser and submits only parsed card names for validation. The server serves a fixed asset allowlist and rejects linked assets and traversal paths. Cookies use HttpOnly, Secure, and SameSite=Strict; mutations require the configured origin. Body sizes, URL lengths, API rates, sockets, and request duration are bounded. Forwarding headers cannot create a trusted visitor identity.

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

Explanation generation uses an evidence-selection contract. Ollama chooses a relevant answer, two distinct supporting points and a budget statement from dynamically supplied enums containing exact Oracle excerpts, explicitly labeled heuristic signals and measured deck facts. It does not freely rewrite rules text. This deliberately trades conversational prose for verifiable wording after live testing found unsupported ability claims from the small model. The server independently validates all choices and fails unsupported output rather than truncating it or substituting another answer. No model failure bypasses this contract. Card budgets validate in the browser and on the server; failed requests retain the original message for correction or retry.

Performance improvements include bounded name-query and candidate-pool caches, immutable card-feature memoization, a single inference stage for recognized requests, compact evidence prompts, ten-minute model retention, lazy deck thumbnails, in-place card selection, and cancellation of stale autocomplete searches. Authenticated server-sent events deliver real job stages rather than simulated progress or repeated polling. Visitors can cancel queued or running requests; canceled results never become saved results. The response includes stage timings and Ollama token/duration measurements. Cache contents disappear or invalidate when the underlying catalog is replaced; they do not substitute for expired data.

## Deck Workspace

The selected format, per-card price limit, total purchase budget, land count, second commander, ownership quantities and locked cards travel with each deck revision. Known prices use integer cents. Owned copies reduce the purchase estimate, not the full deck estimate. Unpriced purchases fail budget checks rather than silently costing zero. Prices cover the lowest tracked available English paper nonfoil USD printing, with its printing identifier and update date retained; estimates exclude shipping, tax and retailer inventory guarantees.

Commander generation fills exactly 100 cards including one commander or a compatible pair, honors selected land count, copy exceptions, color identity and snapshot legality, and enforces nonland draw, ramp and interaction minima. Curve targets influence selection; weighted mana demand informs basic land allocation. Mana source counts are not casting-probability calculations. Commander eligibility includes legendary Vehicles and Spacecraft with printed power/toughness and explicit card-text exceptions. Pair validation handles Partner, Partner with, Friends forever, Backgrounds and Doctor's companion.

Generation, recommendations, locked cards and manual validation share main-deck eligibility checks. Attractions and Contraptions require separate supplementary decks and cannot occupy the main list. Dungeons, planes, phenomena, schemes, vanguards, conspiracies, sticker sheets, tokens, emblems, art-series objects and unsupported card types also cannot occupy its slots. Verified meld fronts remain eligible; combined meld backs do not. Owner-prepared Scryfall component metadata distinguishes those objects, including relations pointing to a different printing. Missing or conflicting meld metadata fails closed rather than guessing. Commander validation additionally checks basic land types against the commanders' color identity. Ordinary cards that mention Attractions or create tokens remain eligible.

The UI reports that checked construction rules pass, not that the app implements every card-text exception or simulates a legal game. These checks follow [Wizards' September 25, 2026 Comprehensive Rules](https://media.wizards.com/2026/downloads/MagicCompRules%2020260925.txt), including 100.2, 108.2, 309.2, 315.3, 712.4, 717.2 and 903.5d. Supplementary-deck construction is not implemented, and these fixes do not silently create or substitute one. Existing saved lists that contain ineligible entries show validation errors when reopened; the app does not silently remove their cards.

An invalid saved list can remain canonical diagnostic chat context, explicitly marked as failing construction checks. This lets visitors request a fresh build or a repair proposal instead of becoming trapped behind the invalid draft. The original list remains unchanged; every proposed output must pass construction and budget validation before the server returns it, and applying it still requires revision matching and fresh validation.

Follow-ups receive canonical deck names, the selected card, a revision number and bounded recent conversation. Common workspace commands route explicitly; other phrasing uses a constrained Ollama action schema. The model cannot execute commands, choose tools or URLs, alter access controls, or silently override budgets. A budget or replacement request produces a quantity-aware proposal. Applying a proposal requires an unchanged revision and a fresh server validation. Model-selected evidence remains distinct from measured costs and deterministic validation; heuristic signals never become certified rules claims.

The workspace groups and filters cards by type/role, sorts by price/mana/name/synergy, displays Oracle text and official rulings, and supports card locks, owned quantities, deck text import/export and twenty-step deck undo/redo. Mobile users switch between Chat, Deck and Card views. Saved lists refresh against the current catalog before use. Saving manual edits requires successful format and budget validation.

## Evidence Preparation

Owner-only setup imports official Scryfall Oracle data, functional tags, rulings and English paper printing prices. It also prepares a streamed Commander Spellbook snapshot containing concrete published variants; template-dependent variants are excluded explicitly. Public requests read only prepared snapshots. To refresh evidence individually:

```powershell
npm run data:enrich
npm run data:deck-zones
npm run data:combos
```

Combo matching checks card quantities and required commanders. The interface retains published prerequisites, zones, board state and source links for inspection. It does not claim that merely holding the matching cards executes a combo. Synergy features and role classification remain heuristic. Official data sources: [Scryfall bulk data](https://scryfall.com/docs/api/bulk-data) and [Commander Spellbook API](https://spacecowmedia.github.io/commander-spellbook-backend/api.html).

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
npm run evaluate
npm run evaluate:llm -- --limit=3
```

Tests cover fragment removal before token exchange, no token storage, one-click authentication, invalid/expired/revoked links, shared session bounds, session reuse, rotation with preserved quotas, forged cookies, session ownership, login limits, persistent and concurrent quotas, failed storage, unauthenticated API denial, origin checks, request limits, static traversal, snapshot-only lookups, and Node file/subprocess permissions. Host deployment performs a separate real Windows-account access check.

The deck evaluator uses the actual prepared catalog and a 512 MiB JavaScript heap. The optional LLM evaluator contains 100 intent cases and reports actual success counts and median/p95 durations for the requested subset. It uses only installed models, never automatically pulls an alternate model, and does not measure explanation truth or strategic play quality. A corpus containing 100 cases does not mean all 100 ran. Intent accuracy and deck legality do not establish strategic quality; review explanations and combo prerequisites independently.

An October 14, 2026 host check passed 71 automated tests. Two real catalog builds produced legal 100-card, 37-land lists within the selected $75 budget. A real protected follow-up produced a $29.72 proposal under a $30 purchase limit. The installed 0.5B model classified two of three raw intent test prompts correctly; the explicit request grammar handles the standard card/deck templates separately. Complex phrasing remains a known limitation, not a solved accuracy claim. A separate real-model evidence-selection check returned exact Oracle quotations without the unsupported ability paraphrase observed during development. After the owner opened the public page, browser verification passed at desktop and mobile sizes: invitation sign-in, real $32.25 deck generation under a $40 limit, selected-card costs, deck filtering, mobile navigation and rejection of a 99-card edit. The checked mobile deck view had no horizontal overflow, and the browser reported no application warnings or errors during that pass.

Deck generation supports Commander. Other listed formats support card recommendations and deck validation. Synergy scoring remains heuristic, not proof of globally optimal decks or the cheapest purchasable deck. The application does not implement a complete MTG rules simulator or certify Commander brackets.

The optional Docker configuration has resource and privilege restrictions and requires an explicit HTTPS origin and employer configuration mount. Docker is not installed or verified on this host; the native Windows deployment above is the tested hosting route. Container setup must prepare `oracle-cards.compact.jsonl` using `scripts/prepare-snapshot.js` in its data volume before starting the public app.

These changes make unsolicited interaction harder and reduce the damage an application compromise could cause. They do not promise zero risk, prevent every denial-of-service attack, or constitute a penetration test.
