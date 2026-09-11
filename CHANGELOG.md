# Changelog

## 0.0.3 - 2026-09-11

- Connect directly using a board's IPv4 address when mDNS discovery is
  unavailable.
- Create and rename remote directories, and delete empty remote directories.
- Upload individual local files to the remote root or a selected directory,
  with confirmation before overwriting an existing file.
- Download individual remote text or binary files while preserving their
  original names.

## 0.0.2 - 2026-08-24

- Browse CircuitPython devices across multiple active IPv4 interfaces.
- Select a discovered device and authenticate with VS Code Secret Storage.
- Browse and refresh the remote filesystem through the Web Workflow `/fs/` API.
- Open, edit, and save existing remote text files.
- Create, delete, and rename individual remote files.
- Protect known binary formats from accidental text opening and saving.
- Report authentication, network, timeout, and filesystem write errors.

## 0.0.1 - 2026-08-20

- Discover `_circuitpython._tcp.local` devices over mDNS.
- Show discovered device status in the VS Code status bar.
