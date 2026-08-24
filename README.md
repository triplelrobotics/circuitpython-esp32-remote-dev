# CircuitPython Remote

A small VS Code extension for discovering CircuitPython Web Workflow devices
and browsing their files directly over Wi-Fi.

## Milestone 1: mDNS discovery

This version continuously browses for the `_circuitpython._tcp.local` mDNS
service. When a board appears, its IPv4 address is shown in the VS Code status
bar.

### Board prerequisite

CircuitPython Web Workflow must already be enabled in `settings.toml`:

```toml
CIRCUITPY_WIFI_SSID="your-wifi"
CIRCUITPY_WIFI_PASSWORD="your-wifi-password"
CIRCUITPY_WEB_API_PASSWORD="choose-a-separate-password"
```

Do not commit real passwords to this repository.

### Run locally

1. Open this folder in VS Code.
2. Run `npm install`.
3. Press `F5` and choose **Run CircuitPython Remote**.
4. In the Extension Development Host window, look at the left side of the
   status bar.
5. Power the CircuitPython board on the same LAN.

For detailed discovery logs, open **View → Output** and select
**CircuitPython Remote**.

Expected status:

```text
CircuitPython: 192.168.x.x
```

## Milestone 2: remote file browser

Open the **CircuitPython Remote** section in the Explorer sidebar, then click
the plug icon to select a discovered board. Enter the board's
`CIRCUITPY_WEB_API_PASSWORD` when prompted. The password is stored in VS Code's
Secret Storage and is never written to extension settings or this repository.

Directories are loaded on demand from the CircuitPython Web Workflow `/fs/`
API. Use the refresh icon in the view title to reload the tree. Selecting a
text file opens its current contents in an editor backed by the device. Saving
the editor writes the complete file back to the same remote path. Use the new
file button to create a file in the root, or right-click a remote directory to
create one inside that directory. Existing names are not overwritten. Remote
files can be deleted from their context menu after confirmation. Files with
unsaved editor changes must be saved or discarded before deletion. Individual
files can also be renamed within their current directory. Open editor tabs are
updated to use the new remote path. Known binary formats such as `.mpy`,
firmware, images, fonts, audio, and archives remain visible in the tree but are
blocked from text opening and saving to prevent accidental corruption. Renaming
between text and known binary file types is also blocked, while renaming within
the same category remains available.

Authentication failures offer a password retry. Missing password configuration,
unreachable devices, timeouts, missing paths, and invalid API responses are
reported as VS Code errors and in the **CircuitPython Remote** output channel.

## Current scope

- Implemented: automatic mDNS discovery, device selection, password
  authentication, remote file tree, refresh, editing existing remote text
  files, creating new files, deleting or renaming individual files, and binary
  file write protection.
- Not implemented: creating, deleting or renaming directories; uploading files;
  serial, REPL, firmware flashing, project templates, AI features, or complex
  configuration UI.
