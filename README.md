# BravePiP

**Watch videos in Picture-in-Picture and save playback or the original video.**

BravePiP is a lightweight Manifest V3 extension for desktop Brave. Click the toolbar icon to open Brave's familiar native Picture-in-Picture (PiP) window, or use the **▣ PiP** button that appears when you hover over a video. A small **Save playback** button on the source page saves captured playback without adding menus to the floating video.

Plain JavaScript. No build step, account, or backend required.

> **Status:** Experimental. Install locally as an unpacked extension. On GNOME with Wayland, keeping PiP above other applications may require a desktop window setting; see [Always on top](#always-on-top-on-gnome--wayland).

## Features

- **One-click PiP:** open the main video from the toolbar; click again to close it.
- **Video hover button:** choose a particular video, including through player overlays such as YouTube's controls.
- **Automatic video selection:** prefer loaded, playing videos and use the largest when several are playing.
- **Native floating window:** move and resize PiP using Brave's window controls.
- **One-click playback saving:** capture starts automatically with PiP; save a finalized WebM from the source page.
- **Optional autosave:** enable a remembered checkbox to record playback and save each video when it finishes, including subsequent videos in the same page's playlist.
- **Separate download menu:** right-click the extension icon to save playback or download an available original file.
- **Organized downloads:** save files to `PiPBrave` inside Brave's configured download directory, normally `Downloads/PiPBrave`.
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

Left-click the extension icon to toggle PiP. Right-click it for **Autosave playback when videos finish**, **Save captured playback**, and **Download original video**. Opening PiP or enabling autosave activates the extension on that tab.

### Autosave

Autosave is **off by default**. To turn it on:

1. Open a video page before starting playback.
2. Right-click the extension icon and check **Autosave playback when videos finish**. This activates capture on the current tab without opening or closing PiP.
3. Play the video. When it ends, Brave saves a finalized `.webm` to **Downloads/PiPBrave**, or the `PiPBrave` subfolder of your configured download directory.

The checkbox is remembered across browser restarts and applies to tabs where you activate the extension. Subsequent videos in the same page's playlist record automatically. Autosave selects the main visible video or the video in PiP. Closing PiP does not stop autosave: playback continues recording on the source page until the video ends. The floating window keeps its normal browser controls.

Enable autosave **before playback starts** to capture from the beginning. Enabling it partway through records from the current position; it cannot recover earlier playback. Skipping or seeking records only what actually plays. Keep the source tab open until saving finishes. After a refresh or navigation to a new page, activate the extension again; the extension does not have permanent access to every site.

Long recordings save automatically in **10-minute parts**, then immediately start the next part. The final part saves when the video ends. Filenames include `part-1`, `part-2`, and so on. Changing sources before the video ends saves the captured portion with `partial` in its name. Live streams save in parts, and looping players that never emit an end event also use this limit. Up to three recordings can be active or waiting to save; if downloads repeatedly fail, capture waits for space and shows an error. Use **Retry save** to retry a failed download.

Uncheck the same menu option to stop autosave. This discards unfinished automatic captures; downloads already started can finish. The usual one-click **Save playback** behavior remains available. Any manual recording buffered before enabling autosave is retained for saving after you turn autosave off.

### Saving playback

With autosave off, recording starts automatically when PiP opens; no manual start time, stop time, or format selection is needed. PiP keeps its standard browser controls.

1. Open PiP and let the video play.
2. Click the small **↓ Save playback** button at the bottom-right of the source page, or choose **Save captured playback** from the extension icon's right-click menu.
3. Brave saves a `.webm` file to `PiPBrave` inside its configured download directory, normally **Downloads/PiPBrave**.

Saving finalizes the playback captured since PiP opened or the previous save. If PiP is still open, the next capture starts automatically after the download completes. Closing PiP stops the capture and keeps it available through the same **Save playback** button. Save before refreshing or navigating away from the source page: unsaved recordings remain only in that page's memory. Keep the page open until a download finishes.

Recordings contain video and available audio in their original playback order; they cannot recover content played before capture began. A capture stops after **10 minutes** to bound memory use, and files larger than **256 MiB** are rejected. Once a capture stops, save it to start the next one. A previous unsaved recording is preserved if you reopen PiP or switch videos; save it before capturing the new video.

The recorder waits for the browser to finish the WebM container, including duration and seek metadata, and checks that it decodes before starting the download. The Save button is briefly unavailable while capture starts or a file is being prepared. This requires a recent Brave build with finalized WebM recording support. **No FFmpeg, MP4/MP3 conversion, or other dependency is required.**

Files receive a sanitized page title and timestamp, and existing files are not overwritten. If you changed Brave's download directory, `PiPBrave` is created under that directory instead of the usual Downloads folder. The extension does not change your global download preference.

### Downloading an original file

For a complete source file, right-click the extension icon and choose **Download original video**. This option stays outside the PiP window. It downloads direct HTTP(S) media files and ordinary video Blobs without re-encoding or changing their format.

A MediaSource `blob:` URL or a streaming playlist is not a complete video file. Many YouTube/adaptive-stream players use these sources, so the original-file action will report that no downloadable file is available. **Save playback** can still work where browser capture is permitted. Protected media and cross-origin sources without capture access cannot be recorded; capture failure does not prevent native PiP viewing.

After updating, reload the extension in `brave://extensions` and refresh the video tab. Brave may ask you to accept new permissions, including `storage` for the autosave preference.

## Permissions and privacy

The extension requests only the permissions declared in [manifest.json](manifest.json):

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporarily access the current tab after you click the extension. |
| `scripting` | Run the video selection and PiP controls on that tab. |
| `downloads` | Save videos in the `PiPBrave` subfolder and check whether this extension's downloads completed. |
| `contextMenus` | Put the autosave checkbox and download actions in the extension icon's right-click menu. |
| `storage` | Remember the autosave preference locally and apply changes to activated tabs. |

Site access can stay set to **When you click the extension**. The extension does not request access to every website, collect analytics, store browsing history, or send page contents to a backend. Captured media stays in local memory until saved or discarded; saved files are managed by Brave and appear in its download history. Original-file downloads request the source URL from the video's server.

## Troubleshooting

| Problem | What to try |
| --- | --- |
| Changes to the code do not appear | Click **Reload** on the extension's card in `brave://extensions`, then refresh the video tab. |
| Clicking opens a menu | Left-click the icon for PiP. Right-click opens the separate save/download menu. |
| “No video found” | Open a page with a video in its main document. Embedded frames and shadow-root players are not currently supported. |
| “Start playing the video” | Start playback so the video metadata loads, then try again. |
| Brave requires an interaction inside the page | Hover over the video and click **▣ PiP**. |
| “This player does not allow Picture-in-Picture” | The player may disable PiP. The extension respects that restriction. |
| A **!** badge appears | Hover the toolbar icon to read the error. Internal browser pages and other restricted pages cannot run the extension. |
| PiP disappears behind another application | Follow the GNOME/Wayland steps below if they apply to your desktop. |
| **Save playback** is disabled | Let playback run briefly, or wait while a file is finalized. Hover the button to read capture status or an error. |
| Autosave misses the beginning | Enable it before starting playback. Recording cannot recover previously played content. |
| Autosave is enabled but a new tab does not record | Activate the extension on that tab. Site access stays limited to tabs you authorize. |
| The original video cannot be downloaded | The player may use an adaptive stream, live stream, or protected source. Use **Save playback** when recording is supported. |
| The capture limit is reached | Click **Save playback**. Capture resumes automatically if PiP is still open. |
| Downloads appear in a different folder | Check Brave's download location. `PiPBrave` is created beneath that location. |

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
- Original downloads require a complete source file; adaptive-stream assembly is not supported. Recording requires browser capture access and saves only playback captured during this session.
- The video stays in its original page/player. If a site replaces the video element, native PiP may close; captured playback can be saved and PiP reopened on the new video.
- Browser internal pages and other restricted sites do not allow script injection.
- The extension cannot force desktop window stacking or set the native PiP window's precise position or appearance.
- Desktop Brave is the development target. Other browsers and operating systems have not been verified by this project's test runs.

## Development

Edit the source files directly, reload the extension in `brave://extensions`, and refresh the video tab. There are no packages to install or assets to build for the extension itself.

| File | Responsibility |
| --- | --- |
| [manifest.json](manifest.json) | Extension metadata, permissions, and service worker registration. |
| [background.js](background.js) | Toolbar clicks, autosave preference/menu, script injection, and toolbar error feedback. |
| [content.js](content.js) | Native PiP toggling, automatic capture lifecycle, the small page save button, and original downloads. |
| [toggle.js](toggle.js) | Request native PiP directly from the toolbar gesture. |
| [recorder.js](recorder.js) | Playback capture, finalized WebM validation, recording limits, and capture cleanup. |
| [autosave.js](autosave.js) | Playback events, per-video autosave sessions, recording parts, and failed-download retries. |
| [downloads.js](downloads.js) | Download requests, safe filenames, destination paths, and completion status. |
| [tests/extension.test.mjs](tests/extension.test.mjs) | Browser integration tests for native PiP, finalized captures, seeking, complete playback, audio, and original downloads. |
| [tests/downloads.test.mjs](tests/downloads.test.mjs) | Download validation, filename safety, and error handling. |
| [tests/autosave.test.mjs](tests/autosave.test.mjs) | Autosave lifecycle, consecutive captures, recording parts, disabling, and retries. |
| [tests/background.test.mjs](tests/background.test.mjs) | Saved checkbox preference and independent toolbar/menu actions. |

### Run the tests

Requirements: **Node.js 18+** and a Brave build that supports the DevTools `Extensions.triggerAction` command. No npm packages are required.

From the project root:

```sh
node --test tests/*.test.mjs
```

The test runner uses `/usr/bin/brave-browser` by default. To use another executable path on Linux:

```sh
BRAVE_BINARY="/path/to/brave-browser" node --test tests/*.test.mjs
```

The suite starts a local HTTP server, loads the extension in an isolated headless Brave profile, and generates video locally. Downloads are isolated in the test profile's temporary `Downloads/PiPBrave` folder. Tests cover toolbar and hover controls, video selection, recorded-file duration, seeking and playback through the final frame, audio preservation, original-file byte integrity, filenames, download errors, unchanged video placement, and restricted players/pages. Autosave tests check end-of-video saving, consecutive videos, disabling during capture, persisted settings, recording parts, and retries.

**Headless tests do not verify desktop window stacking.** For a manual check, open PiP on your desktop, focus an overlapping application, and confirm that the video remains visible. Repeat after reopening PiP and, if enabled, when switching workspaces.

## Contributing

Bug reports and focused improvements are welcome. When reporting a problem, include your Brave version, operating system, reproduction steps, and any error shown on the page or toolbar. For Linux window-stacking issues, include your desktop environment and whether the session uses Wayland or X11.

For code changes, run the browser tests and describe any manual checks. Keep permissions limited to what the feature needs and document changes to supported players or platforms.

## Roadmap

- [ ] Discover videos inside frames and supported shadow roots.
- [ ] Add keyboard shortcuts.
- [ ] Improve icons and accessibility.
- [ ] Prepare packaging and store listing assets.
