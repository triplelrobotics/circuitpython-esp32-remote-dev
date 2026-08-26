# CircuitPython Remote

A lightweight VS Code extension for discovering CircuitPython Web Workflow
devices and editing their files over Wi-Fi.

## Beta release

CircuitPython Remote 0.0.2 is available for early testing on macOS.

[Download the latest beta](https://github.com/triplelrobotics/circuitpython-esp32-remote-dev/releases/tag/v0.0.2)

Back up important files on the board before testing remote write and delete
operations.

## Feedback

Found a problem or have an idea?

- [Report a bug](https://github.com/triplelrobotics/circuitpython-esp32-remote-dev/issues/new?template=bug_report.yml)
- [Request a feature](https://github.com/triplelrobotics/circuitpython-esp32-remote-dev/issues/new?template=feature_request.yml)

## Features

- Discover `_circuitpython._tcp.local` devices over mDNS, including on Macs
  with multiple active network interfaces.
- Browse and refresh the remote filesystem through the Web Workflow `/fs/`
  API.
- Open, edit, save, create, delete, and rename individual text files.
- Protect known binary formats such as `.mpy`, firmware, images, audio, fonts,
  and archives from accidental text writes.
- Store Web Workflow passwords in VS Code Secret Storage.

## ESP32 setup

Enable CircuitPython Web Workflow in the board's `settings.toml`:

```toml
CIRCUITPY_WIFI_SSID="your-wifi"
CIRCUITPY_WIFI_PASSWORD="your-wifi-password"
CIRCUITPY_WEB_API_PASSWORD="choose-a-separate-password"
```

Do not commit real passwords to this repository. Restart the ESP32 after
changing `settings.toml`.

### Network setup

Connect the computer and ESP32 to the same local network. Upstream Internet
access is not required. For a TP-Link device connected behind another router,
**Access Point (AP) mode** is usually the simplest option because both devices
receive addresses from the same DHCP server.

Disable guest-network or client isolation. A DHCP reservation is recommended
if the ESP32 should keep the same address. Verify Web Workflow access using the
board's actual IP address:

```sh
curl --max-time 5 http://192.168.1.100/cp/version.json
```

If the request succeeds but discovery does not, check that mDNS/Bonjour traffic
is allowed between Wi-Fi and Ethernet clients.

## Use the extension

1. Open **CircuitPython Remote** in the Explorer sidebar.
2. Click the plug icon and select a discovered board.
3. Enter its `CIRCUITPY_WEB_API_PASSWORD`.
4. Browse the tree or use its toolbar and context menus to manage files.
5. Click the refresh icon to reload the remote filesystem.

Selecting a text file opens it in an editor backed by the ESP32. Saving the
editor writes the complete file to the device. Binary files remain visible but
cannot be opened or saved as text.

Errors and discovery details are available under **View → Output →
CircuitPython Remote**. Authentication failures offer a password retry.

## Run from source

1. Open this repository in VS Code.
2. Run `npm install`.
3. Press `F5` and choose **Run CircuitPython Remote**.
4. Use the extension in the Extension Development Host window.

When a board is discovered, the status bar displays an address such as:

```text
CircuitPython: 192.168.x.x
```

## Current limitations

The extension does not yet support directory creation, deletion, or renaming;
file uploads; serial or REPL access; firmware flashing; project templates; or
AI features.

See [CHANGELOG.md](CHANGELOG.md) for release history.
