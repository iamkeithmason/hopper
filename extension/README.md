# Hopper browser extension (HOP-8)

Save to Hopper from Chrome or Brave on the desktop. Manifest V3, no build step, not on the Chrome Web Store: you load it yourself.

## Install

1. Download this `extension` folder (or the `hopper-extension.zip` Claude sends) and unzip it somewhere it can stay.
2. Open `chrome://extensions` (Brave: `brave://extensions`) and turn on **Developer mode**.
3. Click **Load unpacked** and pick the folder.
4. The Options page opens. Paste the capture token from the Supabase dashboard (Vault, secret `hopper_capture_token`) and click **Save and test**. It should say "Connected".
5. Pin the Hopper icon to the toolbar.

## Ways to save

- **Toolbar button** or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>: the page, with an optional "why I saved it" note (it helps the design read), any selected text as a quote, a Lock tick box, and **With screenshot** to add a picture of what's on screen.
- **Right-click**: save the page, an image, a link, selected text as a quote, or a screenshot of the view.
- **Hover over a large image**: a Save button appears in its corner (switch it off in Options).

On a YouTube video, any of these also reads the video's transcript off the page (it opens the description's "Show transcript" panel for a moment) and sends it with the save. Hopper keeps it and writes a short summary of what the video says, which shows on the note and helps search (HOP-61). Videos without captions save as before.

The badge on the icon shows ✓ when a right-click save lands, or ! with the reason in its tooltip if it didn't.

## How it works

- Saves go to the `hopper-clip` edge function with the capture token. `hopper-clip` can only save, never read. It passes the capture to `hopper-api`, which links, embeds, files and tags the note as it does for the app. New images then get a design read from `hopper-design` on its next sweep.
- Images and screenshots are shrunk in the browser to JPEG, at most 1600px on the long side, like the app does.
- If a site won't hand over an image (some block it), the image's address is saved as a link instead.

## Updating

After pulling changes, click the reload arrow on the Hopper card in `chrome://extensions`.
