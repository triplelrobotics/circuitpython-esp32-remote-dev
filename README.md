# CircuitPython Remote

A lightweight VS Code extension for editing CircuitPython files wirelessly
through Web Workflow.

## Beta release

CircuitPython Remote 0.0.4 is available for early testing on macOS.

[Download the latest beta](https://github.com/triplelrobotics/circuitpython-esp32-remote-dev/releases/tag/v0.0.4)

Back up important files on the board before testing remote write, sync, and
delete operations.

### Compatibility

CircuitPython Remote requires a board and CircuitPython build that support Web
Workflow. It does not work with every CircuitPython board.

The current beta has been tested with:

- ESP32-S3-DevKitC-1-N8R8
- CircuitPython 10.2.1
- Web Workflow API v4
- VS Code on macOS

Other boards, operating systems, firmware versions, and Web Workflow API
versions have not yet been verified. Test reports are welcome.

## Features

- Discover `_circuitpython._tcp.local` devices over mDNS, including on Macs
  with multiple active network interfaces.
- Connect directly by IPv4 address when mDNS is unavailable.
- Browse and refresh remote files and directories through the Web Workflow
  `/fs/` API.
- Edit, create, rename, delete, upload, and download individual files; create
  and rename directories and delete them when empty.
- Protect known binary formats from accidental text writes while preserving
  binary upload, download, and project sync.
- Create a local project from a device and remember its device association.
- Sync selected new, modified, and locally deleted files from a local project
  to the linked device, with text diffs and confirmation before overwrites or
  deletions.
- Show program output wirelessly and request Reload and Run.
- Store Web Workflow passwords in VS Code Secret Storage.
- Retry transient read failures without retrying write or delete operations.

## Set up your CircuitPython board

### 1. Install current CircuitPython firmware

Back up the board, then install the latest stable CircuitPython release for
your exact board from [CircuitPython Downloads](https://circuitpython.org/downloads/).
For example, this extension is currently tested with CircuitPython 10.2.1; use
a newer stable release when one is available for your board. Older firmware
may contain Web Workflow issues already fixed in current releases.

### 2. Configure Wi-Fi and Web Workflow

Create or update `settings.toml` in the root of `CIRCUITPY`:

```toml
CIRCUITPY_WIFI_SSID="your-wifi"
CIRCUITPY_WIFI_PASSWORD="your-wifi-password"
CIRCUITPY_WEB_API_PASSWORD="choose-a-separate-password"
```

`CIRCUITPY_WEB_API_PASSWORD` is required. Do not reuse an important password:
Web Workflow uses unencrypted HTTP on the local network. Port 80 is the
default, so `CIRCUITPY_WEB_API_PORT` normally does not need to be set. Keep
`settings.toml` private and do not commit it to a public repository.

See the official
[CircuitPython environment variable reference](https://docs.circuitpython.org/en/latest/docs/environment.html)
for optional settings.

### 3. Make the filesystem writable over Wi-Fi

On native USB boards such as ESP32-S2 and ESP32-S3, Web Workflow cannot safely
write while the computer owns the `CIRCUITPY` USB drive.

For a temporary setup, eject `CIRCUITPY` in the operating system. For a
persistent wireless workflow, create `boot.py` in the root of `CIRCUITPY`:

```python
import storage

storage.disable_usb_drive()
```

Save all files and safely eject the drive before resetting. This intentionally
hides `CIRCUITPY` from the computer after the next hard reset. Know how to enter
safe mode or use the serial console before enabling it; see the official
[USB customization guide](https://learn.adafruit.com/customizing-usb-devices-in-circuitpython/circuitpy-midi-serial)
for recovery instructions.

### 4. Hard reset the board

Press the reset button or power-cycle the board after changing `settings.toml`
or `boot.py`. A soft reload is not sufficient for `boot.py` USB changes.

### 5. Check the network

Any router or access point mode is fine as long as the computer and board are
on the same local network and can communicate directly. Upstream Internet
access is optional.

Make sure the network allows local devices to communicate; some guest Wi-Fi
networks block device-to-device traffic. If you often connect by IP address,
you can reserve a stable address for the board in your router. Then verify Web
Workflow using the board's actual address:

```sh
curl --max-time 5 http://BOARD_IP/cp/version.json
```

Replace `BOARD_IP` with the address shown by your router. A JSON response
confirms that the HTTP service is reachable. Ping or mDNS discovery alone does
not prove that Web Workflow is running.

## Install and connect

1. Install **CircuitPython Remote** from the VS Code Extensions view, or install
   the beta VSIX from the GitHub release.
2. Open Explorer and find **CircuitPython Remote**.
3. Click the plug icon and select a discovered board.
4. If discovery does not find it, choose **Connect by IP Address** and enter an
   address shown for the board by your router.
5. Enter the board's `CIRCUITPY_WEB_API_PASSWORD`.
6. Expand the remote tree and use Refresh to reload it.

## Work directly with remote files

Use this workflow for quick edits and direct file management on the device.
Selecting a text file opens an editor backed directly by the board. Saving
writes the complete file to the device. Binary files such as `.mpy`, firmware,
images, audio, fonts, and archives remain visible but are not opened as text.

Use the tree toolbar or context menus to create files and folders, upload local
files, rename items, and run the program. Right-click a remote file to download
or delete it. Remote directory deletion is limited to empty directories.

## If discovery keeps searching

- Wait a few seconds, then run **Developer: Reload Window** or close and reopen
  VS Code to restart mDNS discovery.
- Use **Connect by IP Address**; a working IP connection does not depend on
  mDNS.
- Confirm the board and computer are on the same local network and that the
  network allows them to communicate directly.
- Test `/cp/version.json` with `curl`. If ping works but HTTP is refused or
  times out, hard reset the board and check `settings.toml`.
- Open **View → Output → CircuitPython Remote** for discovery, retry, and HTTP
  error details.

If browsing works but writes report a read-only filesystem, eject the
`CIRCUITPY` drive or configure `storage.disable_usb_drive()` as described above.

## Work with a local project

### Create a local project from the device

1. Connect to the device in the remote tree.
2. Open the Command Palette (`Cmd+Shift+P` on macOS or `Ctrl+Shift+P` on
   Windows/Linux), then run **CircuitPython Remote: Create Local Project from
   Device**, or use its tree toolbar icon.
3. Select an empty local directory.
4. Open the downloaded folder when prompted.

The extension links that exact workspace root to the source device. The linked
project and device appear in the VS Code status bar. Existing local projects
can be associated using **CircuitPython Remote: Link Workspace to Device**.

### Sync local changes to the device

1. Edit and save files in the linked local workspace.
2. Click the linked-project status item and choose **Sync Local Project to
   Device**, or run the same command from the Command Palette.
3. Review the new, modified, and remote-only files found by the comparison.
4. Select exactly which changes to apply, optionally review text diffs, and
   confirm the operation.

`settings.toml` and file deletions are not selected by default. Sync can create
needed remote directories, but it does not delete directories; locally deleted
folders may leave empty directories on the board.

Sync is intentionally **one-way from the local workspace to the device**.
Changes made directly on the board after creating the local project are not
merged back automatically and may be overwritten if selected during Sync.
Review diffs and keep a backup for important projects.

## Program output and Reload and Run

Use **CircuitPython Remote: Show Output** to open the wireless program output
channel. **Reload and Run** connects the same channel, interrupts the current
program, and requests a soft reload. This output view is not an interactive
REPL.

## Feedback

Found a problem or have an idea?

- [Report a bug](https://github.com/triplelrobotics/circuitpython-esp32-remote-dev/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/triplelrobotics/circuitpython-esp32-remote-dev/issues/new?template=feature_request.yml)

## Run from source

1. Open this repository in VS Code.
2. Run `npm install`.
3. Press `F5` and choose **Run CircuitPython Remote**.
4. Use the extension in the Extension Development Host window.

## Current limitations

- Local project sync is one-way and does not perform three-way conflict
  detection or merge remote changes back into the local workspace.
- Sync does not delete remote directories or provide atomic recovery from an
  interrupted write operation.
- The wireless output channel is not an interactive REPL.
- Serial access, firmware flashing, project templates, and AI features are
  outside the current scope.
- Testing is currently limited to the hardware and software listed under
  Compatibility.

See [CHANGELOG.md](CHANGELOG.md) for release history.
