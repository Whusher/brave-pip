# BravePiP

**Open videos in a floating Picture-in-Picture window with one click.**

BravePiP is a lightweight Manifest V3 extension for desktop Brave. Click the toolbar icon to open a video in Brave's native Picture-in-Picture (PiP) window, or use the **▣ PiP** button that appears when you hover over a video.

Plain JavaScript. No build step, account, or backend required.

> **Status:** Experimental. Install locally as an unpacked extension. On GNOME with Wayland, keeping PiP above other applications may require a desktop window setting; see [Always on top](#always-on-top-on-gnome--wayland).

## Features

- **One-click PiP:** open the main video from the toolbar; click again to close it.
- **Video hover button:** choose a particular video, including through player overlays such as YouTube's controls.
- **Automatic video selection:** prefer loaded, playing videos and use the largest when several are playing.
- **Native floating window:** move and resize PiP using Brave's window controls.
- **Visible errors:** read an on-page message or hover the toolbar's **!** badge for the reason a request failed.
- **Access on demand:** activate the extension on a tab when you need it.

## Installation

You need desktop Brave and a local copy of this repository. Node.js is only needed to run the development tests.

1. Clone this repository, or choose **Code → Download ZIP** on GitHub and extract the archive.
2. Open `brave://extensions` in Brave.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the project folder containing `manifest.json`.
6. Pin **Floating Video for Brave** from Brave's extensions menu for easy access.

Keep the project folder on your computer: Brave loads the extension from that location.

## Usage

1. Open a page containing an HTML5 video and start playback.
2. **Left-click** the extension's toolbar icon to open PiP.
3. Move or resize the floating window as needed.
4. Click the toolbar icon again, or close the PiP window, to exit.

After the first toolbar click, hovering over a video also reveals a **▣ PiP** button. Use it to select a particular video on pages with multiple players. Refreshing the page removes the hover controls; click the toolbar icon to activate them again.

Right-clicking the extension icon opens Brave's extension menu. Use a left-click to toggle PiP.

## Permissions and privacy

The extension requests only the permissions declared in [manifest.json](manifest.json):

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporarily access the current tab after you click the extension. |
| `scripting` | Run the video selection and PiP controls on that tab. |

Site access can stay set to **When you click the extension**. The extension does not request access to every website, collect analytics, store browsing history, or send page contents to a backend.

## Troubleshooting

| Problem | What to try |
| --- | --- |
| Changes to the code do not appear | Click **Reload** on the extension's card in `brave://extensions`, then refresh the video tab. |
| Clicking opens a menu | Left-click the icon. Right-click opens Brave's extension menu. |
| “No video found” | Open a page with a video in its main document. Embedded frames and shadow-root players are not currently supported. |
| “Start playing the video” | Start playback so the video metadata loads, then try again. |
| Brave requires an interaction inside the page | Hover over the video and click **▣ PiP**. |
| “This player does not allow Picture-in-Picture” | The player may disable PiP. The extension respects that restriction. |
| A **!** badge appears | Hover the toolbar icon to read the error. Internal browser pages and other restricted pages cannot run the extension. |
| PiP disappears behind another application | Follow the GNOME/Wayland steps below if they apply to your desktop. |

### Always on top on GNOME / Wayland

BravePiP opens Brave's native PiP window. The desktop window manager controls how that window stacks above other applications. The browser PiP API does not expose an `alwaysOnTop` setting; changing a web page's CSS `z-index` cannot change desktop window order.

If another application covers PiP on GNOME with Wayland:

1. Focus the floating PiP window.
2. Press **Alt+Space** to open GNOME's window menu.
3. Enable **Always on Top**.
4. To keep PiP visible when switching workspaces, reopen the menu and enable **Always on Visible Workspace**.

These settings apply to the current window. You may need to repeat them after closing and reopening PiP. The available actions are defined in GNOME's [window menu](https://github.com/GNOME/gnome-shell/blob/main/js/ui/windowMenu.js).

BravePiP stays browser-only and does not install desktop helpers or change operating system settings.

## Known limitations

- Video discovery is limited to the page's main document. Videos inside iframes or shadow roots are not discovered.
- Players that disable PiP, restrictive page permissions policies, and some protected media may prevent playback in PiP.
- Browser internal pages and other restricted sites do not allow script injection.
- The extension cannot force desktop window stacking or set the native PiP window's precise position or appearance.
- Desktop Brave is the development target. Other browsers and operating systems have not been verified by this project's test runs.

## Development

Edit the source files directly, reload the extension in `brave://extensions`, and refresh the video tab. There are no packages to install or assets to build for the extension itself.

| File | Responsibility |
| --- | --- |
| [manifest.json](manifest.json) | Extension metadata, permissions, and service worker registration. |
| [background.js](background.js) | Toolbar clicks, script injection, and toolbar error feedback. |
| [content.js](content.js) | Video discovery, hover controls, PiP toggling, and on-page messages. |
| [tests/extension.test.mjs](tests/extension.test.mjs) | Browser integration tests using native PiP and real toolbar actions. |

### Run the tests

Requirements: **Node.js 18+** and a Brave build that supports the DevTools `Extensions.triggerAction` command. No npm packages are required.

From the project root:

```sh
node --test tests/extension.test.mjs
```

The test runner uses `/usr/bin/brave-browser` by default. To use another executable path on Linux:

```sh
BRAVE_BINARY="/path/to/brave-browser" node --test tests/extension.test.mjs
```

The suite starts a local HTTP server, loads the extension in an isolated headless Brave profile, and generates video locally. It covers toolbar toggling, duplicate-control prevention, hover controls over player overlays, video selection, recovery after a missing video, and failures caused by unloaded videos, player restrictions, permissions policies, or restricted browser pages.

**Headless tests do not verify desktop window stacking.** For a manual check, open PiP on your desktop, focus an overlapping application, and confirm that the video remains visible. Repeat after reopening PiP and, if enabled, when switching workspaces.

## Contributing

Bug reports and focused improvements are welcome. When reporting a problem, include your Brave version, operating system, reproduction steps, and any error shown on the page or toolbar. For Linux window-stacking issues, include your desktop environment and whether the session uses Wayland or X11.

For code changes, run the browser tests and describe any manual checks. Keep permissions limited to what the feature needs and document changes to supported players or platforms.

## Roadmap

- [ ] Discover videos inside frames and supported shadow roots.
- [ ] Add keyboard shortcuts.
- [ ] Improve icons and accessibility.
- [ ] Prepare packaging and store listing assets.
