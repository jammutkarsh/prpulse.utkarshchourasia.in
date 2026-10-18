# PR Pulse - GitHub Pull Request Dashboard

<div align="center">

[![Chrome Extension](assets/chrome-web-store.png)](https://short.utkarshchourasia.in/prpulse)
[![Firefox Extension](assets/firefox-add-ons.png)](https://short.utkarshchourasia.in/prpulse-firefox)

</div>

> PR Pulse is a Pull Request dashboard for GitHub, delivered as a Chrome/Firefox extension.
> Say No to Navigation!

PR Pulse exists for one reason: checking pull requests on GitHub should not require repeated clicks, tab switching, and page loads across multiple repositories. GitHub is strong at showing one pull request at a time. It is much weaker at giving you a fast, holistic view of everything that needs your attention.

If you have not installed PR Pulse yet, you are probably still doing same routine many developers repeat all day: open GitHub, go to repository, find Pull Requests, open status, go back, switch repository, repeat. That navigation dance adds friction, personally it's very annoying to me when the page navigation breaks and doesn't load.

PR Pulse collapses that workflow into one dashboard inside your Chrome/Firefox browser. Open extension once, view your active pull requests quickly, and jump into GitHub only when you actually need deeper context.

## Screenshots

|                               |                               |
| :---------------------------: | :---------------------------: |
| ![Demo 1](assets/demo-01.png) | ![Demo 2](assets/demo-02.png) |
| ![Demo 3](assets/demo-03.png) | ![Demo 4](assets/demo-04.png) |

<!-- ## Why PR Pulse

PR Pulse is built around workflow efficiency, not dashboard vanity. It gives developers and reviewers a faster way to answer practical questions:

- What pull requests are waiting on me?
- Which ones need review?
- Which ones changed status since last time I checked?
- Where should I click next, if I need to act?

Instead of making you hunt through GitHub repository by repository, PR Pulse keeps that view in one place, so you can decide faster and move on.

## What You Miss Without It

- More unnecessary clicks before you reach useful information
- More waiting on GitHub page loads and navigation transitions
- More context switching between repositories and pull request tabs
- Less visibility into your full pull request workload at a glance
- More time spent finding work instead of doing work

PR Pulse is designed to remove that overhead. It is less about adding another tool and more about removing repeated friction from a workflow you already have.

## Built As Extension, Not Website

PR Pulse is intentionally a Chrome extension, not a hosted website.

- Your GitHub token stays on your device in Chrome extension storage
- Data is fetched directly from GitHub APIs
- You stay in control of when and how data syncs
- There is no requirement to push your pull request workflow into another external service

That local-first model matters. Developer workflow data should stay close to developer, not be routed through a third-party dashboard unless there is a real need.

## Sync On Your Terms

PR Pulse no longer assumes a fixed refresh cadence. You can configure how often data syncs, or choose to refresh manually when that fits your workflow better.

That means better control, less noise, and a setup that matches how you actually work instead of forcing one timing model for everyone. -->

## Installation

### Install

- Chrome: [PR Pulse on Chrome Web Store](https://short.utkarshchourasia.in/prpulse)
- Firefox: [PR Pulse on Firefox Add-ons](https://short.utkarshchourasia.in/prpulse-firefox)

### From Source (Developer Mode) - Unreleased version with the latest features and fixes

1. Clone and build the repository

```bash
git clone https://github.com/jammutkarsh/pr-pulse
cd pr-pulse
bun install
bun run generate
```

2. Chrome / Chromium: Run `bun run generate:chrome`, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `pr-pulse/dist/chrome` folder.
3. Firefox: Run `bun run generate:firefox`, open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and select `pr-pulse/dist/firefox/manifest.json`.
4. Pin the extension to your toolbar for easy access

<!-- ## Practical Value

PR Pulse helps you recover small pockets of time that disappear into routine GitHub navigation. Over day, that means fewer interruptions. Over week, that means less friction around reviews, updates, and follow-up. Over time, it becomes a calmer way to manage pull requests.

It is built for developers who want a clearer operational view of their PRs without turning that need into another browser ritual. -->

## Project Structure

```bash
pr-pulse/
├── extension/              # Extension runtime code, assets, and build scripts
│   ├── scripts/            # Build helpers including browser-specific manifest generation
│   ├── service-worker.ts   # Background sync logic
│   ├── lib/                # Shared libraries and providers
│   ├── src/popup/          # Popup application
│   ├── src/settings/       # Settings application
│   ├── src/onboarding/     # Onboarding flow
│   └── icons/              # Extension icons and assets
```

## Privacy

- Your GitHub token is stored locally in Chrome/Firefox extension storage
- No pull request data is sent to third-party servers by PR Pulse
- GitHub API communication happens directly from extension to GitHub

## License

[MIT](LICENSE)
