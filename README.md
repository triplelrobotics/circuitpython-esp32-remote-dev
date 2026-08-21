# CircuitPython Remote

A small VS Code extension for discovering CircuitPython Web Workflow devices
and, in later milestones, editing their files directly over Wi-Fi.

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

## Current scope

- Implemented: automatic mDNS discovery and IP display.
- Not implemented yet: authentication, remote file tree, open, or save.
