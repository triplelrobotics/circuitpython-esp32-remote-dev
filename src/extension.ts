import * as vscode from "vscode";
import { homedir, networkInterfaces } from "os";
import { basename } from "path";
import { request as httpRequest } from "http";
import { randomBytes } from "crypto";
import { Duplex } from "stream";
import { StringDecoder } from "string_decoder";
import { Bonjour, Browser, Service, ServiceConfig } from "bonjour-service";

interface CircuitPythonDevice {
  key: string;
  name: string;
  hostname: string;
  ip: string;
  port: number;
}

interface DiscoveryBrowser {
  bonjour: Bonjour;
  browser: Browser;
  interfaceName: string;
  interfaceAddress: string;
}

interface BonjourInterfaceOptions extends Partial<ServiceConfig> {
  bind: string;
  interface: string;
}

const binaryFileExtensions = new Set([
  ".7z", ".bin", ".bmp", ".elf", ".flac", ".gif", ".gz", ".hex",
  ".ico", ".jpeg", ".jpg", ".mp3", ".mpy", ".ogg", ".otf", ".pcf",
  ".pdf", ".png", ".tar", ".ttf", ".uf2", ".wav", ".webp", ".woff",
  ".woff2", ".zip",
]);

function isKnownBinaryPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot >= 0 && binaryFileExtensions.has(name.slice(dot).toLocaleLowerCase());
}

function isSystemMetadataName(name: string): boolean {
  return name === ".DS_Store"
    || name === ".Trashes"
    || name === ".Spotlight-V100"
    || name === ".fseventsd"
    || name === ".metadata_never_index"
    || name.startsWith(".Trash-")
    || name.startsWith("._");
}

function isSafeRemoteName(name: string): boolean {
  return name.length > 0
    && name !== "."
    && name !== ".."
    && !/[\\/\0]/.test(name);
}

interface DirectoryEntry {
  name: string;
  directory: boolean;
  modified_ns?: number;
  file_size?: number;
}

interface DirectoryResponse {
  files: DirectoryEntry[];
}

interface VersionResponse {
  web_api_version?: number;
  board_name?: string;
  hostname?: string;
}

interface ProjectDownloadSummary {
  files: number;
  directories: number;
  skipped: number;
  includesSettings: boolean;
}

interface ProjectSyncUploadCandidate {
  path: string;
  localUri: vscode.Uri;
  content: Uint8Array;
  status: "new" | "modified";
  binary: boolean;
  remoteSize?: number;
}

interface ProjectSyncDeleteCandidate {
  path: string;
  status: "deleted";
  binary: boolean;
  remoteSize?: number;
}

type ProjectSyncCandidate = ProjectSyncUploadCandidate | ProjectSyncDeleteCandidate;

interface ProjectSyncQuickPickItem extends vscode.QuickPickItem {
  candidate: ProjectSyncCandidate;
}

interface WorkspaceDeviceBindings {
  [folderUri: string]: CircuitPythonDevice;
}

function isLocalProjectMetadata(path: string, name: string, directory: boolean): boolean {
  if (isSystemMetadataName(name)) return true;
  if (directory && (name === ".git" || name === ".vscode"
    || name === "node_modules" || name === "__pycache__")) return true;
  return path === "/boot_out.txt"
    || name === ".gitignore"
    || name === ".circuitpythonignore"
    || name.toLocaleLowerCase().endsWith(".vsix");
}

function formatByteCount(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

interface DeviceQuickPickItem extends vscode.QuickPickItem {
  device?: CircuitPythonDevice;
  manual: boolean;
}

class WebWorkflowError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

class CircuitPythonDiscovery implements vscode.Disposable {
  private readonly devices = new Map<string, CircuitPythonDevice>();
  private readonly deviceSources = new Map<string, Set<string>>();
  private readonly browsers: DiscoveryBrowser[] = [];
  private readonly status: vscode.StatusBarItem;

  constructor(private readonly output: vscode.OutputChannel) {
    this.status = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      50,
    );
    this.status.command = "circuitpythonRemote.discover";
    this.status.tooltip = "Click to view discovered CircuitPython devices";
    this.status.show();
  }

  start(): void {
    if (this.browsers.length > 0) {
      return;
    }

    this.status.text = "$(loading~spin) CircuitPython: searching…";
    this.output.appendLine(
      "Searching for _circuitpython._tcp.local devices…",
    );

    for (const network of this.ipv4Interfaces()) {
      try {
        const options: BonjourInterfaceOptions = {
          bind: "0.0.0.0",
          interface: network.address,
        };
        const bonjour = new Bonjour(options, (error: unknown) => {
          this.output.appendLine(
            `mDNS error on ${network.name} (${network.address}): ${String(error)}`,
          );
        });
        const browser = bonjour.find({
          type: "circuitpython",
          protocol: "tcp",
        });
        const source = `${network.name}:${network.address}`;
        browser.on("up", (service: Service) => this.onDeviceUp(service, source));
        browser.on("down", (service: Service) => this.onDeviceDown(service, source));
        this.browsers.push({
          bonjour,
          browser,
          interfaceName: network.name,
          interfaceAddress: network.address,
        });
        this.output.appendLine(
          `Browsing mDNS on ${network.name} (${network.address})`,
        );
      } catch (error) {
        this.output.appendLine(
          `Unable to browse mDNS on ${network.name} (${network.address}): ${String(error)}`,
        );
      }
    }
  }

  async showDevices(): Promise<void> {
    const devices = [...this.devices.values()];
    if (devices.length === 0) {
      void vscode.window.showInformationMessage(
        "No CircuitPython Web Workflow device found yet. Still searching…",
      );
      return;
    }

    const selected = await vscode.window.showQuickPick(
      devices.map((device) => ({
        label: device.name,
        description: `${device.ip}:${device.port}`,
        detail: device.hostname,
        device,
      })),
      { placeHolder: "Discovered CircuitPython devices" },
    );

    if (selected) {
      void vscode.window.showInformationMessage(
        `${selected.device.name} — ${selected.device.hostname} — ${selected.device.ip}:${selected.device.port}`,
      );
    }
  }

  async pickDevice(): Promise<CircuitPythonDevice | "manual" | undefined> {
    const devices = [...this.devices.values()];
    const items: DeviceQuickPickItem[] = [...devices.map((device) => ({
      label: device.name,
      description: `${device.ip}:${device.port}`,
      detail: device.hostname,
      device,
      manual: false,
    })), {
      label: "$(globe) Connect by IP Address…",
      detail: "Connect without mDNS discovery",
      manual: true,
    }];
    const selected = await vscode.window.showQuickPick(
      items,
      { placeHolder: devices.length > 0
        ? "Select a CircuitPython device"
        : "No devices discovered yet; enter an IP address to connect directly" },
    );

    return selected?.manual ? "manual" : selected?.device;
  }

  getDevice(key: string): CircuitPythonDevice | undefined {
    return this.devices.get(key);
  }

  addManualDevice(device: CircuitPythonDevice): void {
    this.devices.set(device.key, device);
  }

  private onDeviceUp(service: Service, source: string): void {
    const ip = this.preferredIp(service.addresses ?? []);
    if (!ip) {
      this.output.appendLine(
        `Ignored ${service.name}: the mDNS response contained no IP address.`,
      );
      return;
    }

    const hostname = service.host || service.fqdn || service.name;
    const key = `${hostname}:${service.port}`;
    const device: CircuitPythonDevice = {
      key,
      name: service.name || hostname,
      hostname,
      ip,
      port: service.port,
    };

    const sources = this.deviceSources.get(key) ?? new Set<string>();
    sources.add(source);
    this.deviceSources.set(key, sources);
    this.devices.set(key, device);
    this.output.appendLine(
      `Found ${device.name} at ${device.ip}:${device.port} (${device.hostname}) via ${source}`,
    );
    this.updateStatus();
  }

  private onDeviceDown(service: Service, source: string): void {
    const hostname = service.host || service.fqdn || service.name;
    const key = `${hostname}:${service.port}`;
    const sources = this.deviceSources.get(key);
    sources?.delete(source);
    if (sources && sources.size > 0) {
      return;
    }
    this.deviceSources.delete(key);
    this.devices.delete(key);
    this.output.appendLine(`Device went offline: ${service.name || hostname}`);
    this.updateStatus();
  }

  private ipv4Interfaces(): { name: string; address: string }[] {
    const interfaces: { name: string; address: string }[] = [];
    for (const [name, addresses] of Object.entries(networkInterfaces())) {
      for (const address of addresses ?? []) {
        if (address.family === "IPv4" && !address.internal) {
          interfaces.push({ name, address: address.address });
        }
      }
    }
    return interfaces;
  }

  private preferredIp(addresses: string[]): string | undefined {
    return addresses.find((address) => /^\d{1,3}(\.\d{1,3}){3}$/.test(address))
      ?? addresses[0];
  }

  private updateStatus(): void {
    const devices = [...this.devices.values()];
    if (devices.length === 0) {
      this.status.text = "$(loading~spin) CircuitPython: searching…";
    } else if (devices.length === 1) {
      this.status.text = `$(radio-tower) CircuitPython: ${devices[0].ip}`;
    } else {
      this.status.text = `$(radio-tower) CircuitPython: ${devices.length} devices`;
    }
  }

  dispose(): void {
    for (const discovery of this.browsers) {
      discovery.browser.stop();
      discovery.bonjour.destroy();
    }
    this.status.dispose();
  }
}

class WebWorkflowClient implements vscode.Disposable {
  private consoleSocket: Duplex | undefined;
  private consoleDeviceKey: string | undefined;
  private consoleBuffer = Buffer.alloc(0);
  private consoleDecoder = new StringDecoder("utf8");
  private consoleEscapeState: "normal" | "escape" | "csi" | "osc" | "oscEscape" = "normal";

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly output: vscode.OutputChannel,
    private readonly consoleOutput: vscode.OutputChannel,
  ) {}

  async identifyDevice(ip: string, port: number): Promise<CircuitPythonDevice> {
    const url = `http://${ip}:${port}/cp/version.json`;
    this.output.appendLine(`GET ${url}`);
    let response: Response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new WebWorkflowError(`Unable to reach ${ip}:${port}: ${detail}`);
    }
    if (!response.ok) {
      throw new WebWorkflowError(`The device returned HTTP ${response.status} ${response.statusText}.`, response.status);
    }

    let body: VersionResponse;
    try { body = JSON.parse(await response.text()) as VersionResponse; }
    catch { throw new WebWorkflowError("The address did not return valid CircuitPython version information."); }
    if (typeof body.web_api_version !== "number") {
      throw new WebWorkflowError("The address does not appear to be a CircuitPython Web Workflow device.");
    }

    const hostname = body.hostname || ip;
    return {
      key: `manual:${ip}:${port}`,
      name: body.board_name || hostname,
      hostname,
      ip,
      port,
    };
  }

  async ensurePassword(device: CircuitPythonDevice): Promise<boolean> {
    if (await this.secrets.get(this.secretKey(device))) return true;
    const password = await vscode.window.showInputBox({
      title: `Connect to ${device.name}`,
      prompt: "Enter CIRCUITPY_WEB_API_PASSWORD",
      password: true,
      ignoreFocusOut: true,
    });
    if (password === undefined) return false;
    if (password.length === 0) {
      void vscode.window.showWarningMessage("The Web Workflow password cannot be empty.");
      return false;
    }
    await this.secrets.store(this.secretKey(device), password);
    return true;
  }

  async readDirectory(device: CircuitPythonDevice, path: string): Promise<DirectoryEntry[]> {
    const response = await this.request(device, path, {
      headers: { Accept: "application/json" },
    });
    let body: DirectoryResponse;
    try { body = JSON.parse(await response.text()) as DirectoryResponse; }
    catch { throw new WebWorkflowError("The device returned an invalid directory response."); }
    if (!Array.isArray(body.files)) throw new WebWorkflowError("The device response does not contain a file list.");
    return body.files;
  }

  async readFile(device: CircuitPythonDevice, path: string): Promise<Uint8Array> {
    const response = await this.request(device, path, {
      headers: { Accept: "*/*" },
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  async writeFile(device: CircuitPythonDevice, path: string, content: Uint8Array): Promise<void> {
    await this.request(device, path, {
      method: "PUT",
      body: Buffer.from(content),
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Timestamp": Date.now().toString(),
      },
    });
  }

  async createDirectory(device: CircuitPythonDevice, path: string): Promise<void> {
    await this.request(device, path.endsWith("/") ? path : `${path}/`, {
      method: "PUT",
      headers: { "X-Timestamp": Date.now().toString() },
    });
  }

  async deleteFile(device: CircuitPythonDevice, path: string): Promise<void> {
    await this.request(device, path, { method: "DELETE" });
  }

  async moveFile(device: CircuitPythonDevice, sourcePath: string, destinationPath: string): Promise<void> {
    await this.request(device, sourcePath, {
      method: "MOVE",
      headers: { "X-Destination": this.apiPath(destinationPath) },
    });
  }

  async connectOutput(device: CircuitPythonDevice): Promise<void> {
    if (this.consoleDeviceKey === device.key
      && this.consoleSocket
      && !this.consoleSocket.destroyed) return;
    this.disconnectOutput();

    const password = await this.secrets.get(this.secretKey(device));
    if (!password) throw new WebWorkflowError("No Web Workflow password is available.", 401);

    const authorization = `Basic ${Buffer.from(`:${password}`).toString("base64")}`;
    const webSocketKey = randomBytes(16).toString("base64");
    const origin = `http://${device.ip}${device.port === 80 ? "" : `:${device.port}`}`;
    this.output.appendLine(`WebSocket http://${device.ip}:${device.port}/cp/serial/`);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        error ? reject(error) : resolve();
      };
      const request = httpRequest({
        host: device.ip,
        port: device.port,
        path: "/cp/serial/",
        headers: {
          Authorization: authorization,
          Connection: "Upgrade",
          Origin: origin,
          Upgrade: "websocket",
          "Sec-WebSocket-Key": webSocketKey,
          "Sec-WebSocket-Version": "13",
        },
      });

      request.setTimeout(10_000, () => {
        request.destroy();
        finish(new WebWorkflowError(`Unable to reach ${device.ip}:${device.port}: connection timed out.`));
      });
      request.on("response", (response) => {
        response.resume();
        if (response.statusCode === 401) {
          finish(new WebWorkflowError("Incorrect Web Workflow password.", 401));
        } else if (response.statusCode === 403) {
          finish(new WebWorkflowError("The device rejected the wireless output connection (HTTP 403).", 403));
        } else {
          finish(new WebWorkflowError(`The device did not accept the WebSocket connection (HTTP ${response.statusCode ?? "unknown"}).`, response.statusCode));
        }
      });
      request.on("upgrade", (_response, socket, head) => {
        socket.setTimeout(0);
        this.consoleSocket = socket;
        this.consoleDeviceKey = device.key;
        this.consoleBuffer = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => this.receiveConsoleData(chunk));
        socket.on("error", (error) => {
          this.consoleOutput.appendLine(`\n[Wireless output error: ${error.message}]`);
        });
        socket.on("close", () => {
          if (this.consoleSocket !== socket) return;
          this.consoleSocket = undefined;
          this.consoleDeviceKey = undefined;
          this.consoleOutput.appendLine("\n[Wireless output disconnected]");
        });
        this.consoleOutput.appendLine(`\n[Connected to ${device.name} at ${device.ip}:${device.port}]`);
        if (head.length > 0) this.receiveConsoleData(head);
        finish();
      });
      request.on("error", (error) => {
        finish(new WebWorkflowError(`Unable to reach ${device.ip}:${device.port}: ${error.message}`));
      });
      request.end();
    });
  }

  async reloadAndRun(device: CircuitPythonDevice): Promise<void> {
    await this.connectOutput(device);
    this.sendConsoleText("\x03");
    await new Promise((resolve) => setTimeout(resolve, 150));
    this.sendConsoleText("\x04");
  }

  showOutput(): void {
    this.consoleOutput.show(true);
  }

  disconnectOutput(): void {
    this.consoleSocket?.destroy();
    this.consoleSocket = undefined;
    this.consoleDeviceKey = undefined;
    this.consoleBuffer = Buffer.alloc(0);
    this.consoleDecoder.end();
    this.consoleDecoder = new StringDecoder("utf8");
    this.consoleEscapeState = "normal";
  }

  dispose(): void {
    this.disconnectOutput();
    this.consoleOutput.dispose();
  }

  async forgetPassword(device: CircuitPythonDevice): Promise<void> {
    await this.secrets.delete(this.secretKey(device));
  }

  private async request(device: CircuitPythonDevice, path: string, init: RequestInit): Promise<Response> {
    const password = await this.secrets.get(this.secretKey(device));
    if (!password) throw new WebWorkflowError("No Web Workflow password is available.", 401);
    const url = `http://${device.ip}:${device.port}${this.apiPath(path)}`;
    const method = init.method ?? "GET";
    this.output.appendLine(`${method} ${url}`);
    const retryDelays = method === "GET" ? [300, 800] : [];
    let response: Response | undefined;
    for (let attempt = 0; response === undefined; attempt += 1) {
      try {
        response = await fetch(url, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Basic ${Buffer.from(`:${password}`).toString("base64")}`,
          },
          signal: AbortSignal.timeout(10_000),
        });
      } catch (error) {
        const cause = error instanceof Error
          ? (error as Error & { cause?: unknown }).cause
          : undefined;
        const detail = `${error instanceof Error ? error.message : String(error)}${cause instanceof Error ? `: ${cause.message}` : ""}`;
        const delay = retryDelays[attempt];
        if (delay === undefined) {
          throw new WebWorkflowError(`Unable to reach ${device.ip}:${device.port}: ${detail}`);
        }
        this.output.appendLine(
          `${method} ${url} failed (${detail}); retrying in ${delay} ms (${attempt + 2}/${retryDelays.length + 1})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    if (!response.ok) {
      if (response.status === 401) throw new WebWorkflowError("Incorrect Web Workflow password.", 401);
      if (response.status === 403) throw new WebWorkflowError("Web Workflow is disabled because CIRCUITPY_WEB_API_PASSWORD is not configured on the device.", 403);
      if (response.status === 404) throw new WebWorkflowError(`Remote path not found: ${path}`, 404);
      if (response.status === 409) throw new WebWorkflowError("The CircuitPython filesystem is not writable, usually because USB currently owns it.", 409);
      if (response.status === 412) throw new WebWorkflowError("The destination path is already in use.", 412);
      if (response.status === 413 || response.status === 417) throw new WebWorkflowError("The file is too large for the device to accept.", response.status);
      throw new WebWorkflowError(`The device returned HTTP ${response.status} ${response.statusText}.`, response.status);
    }
    return response;
  }

  private apiPath(path: string): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `/fs${encoded.startsWith("/") ? encoded : `/${encoded}`}`;
  }

  private receiveConsoleData(chunk: Buffer): void {
    this.consoleBuffer = Buffer.concat([this.consoleBuffer, chunk]);
    while (this.consoleBuffer.length >= 2) {
      const first = this.consoleBuffer[0];
      const second = this.consoleBuffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.consoleBuffer.length < 4) return;
        length = this.consoleBuffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.consoleBuffer.length < 10) return;
        const largeLength = this.consoleBuffer.readBigUInt64BE(2);
        if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.consoleSocket?.destroy(new Error("WebSocket frame is too large."));
          return;
        }
        length = Number(largeLength);
        offset = 10;
      }

      const masked = (second & 0x80) !== 0;
      const maskLength = masked ? 4 : 0;
      if (this.consoleBuffer.length < offset + maskLength + length) return;
      const mask = masked ? this.consoleBuffer.subarray(offset, offset + 4) : undefined;
      offset += maskLength;
      const payload = Buffer.from(this.consoleBuffer.subarray(offset, offset + length));
      this.consoleBuffer = this.consoleBuffer.subarray(offset + length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      const opcode = first & 0x0f;
      if (opcode === 0x8) {
        this.consoleSocket?.destroy();
      } else if (opcode === 0x9) {
        this.consoleSocket?.write(this.webSocketFrame(payload, 0xA));
      } else if (opcode === 0x0 || opcode === 0x1 || opcode === 0x2) {
        this.consoleOutput.append(this.stripConsoleSequences(this.consoleDecoder.write(payload)));
      }
    }
  }

  private stripConsoleSequences(text: string): string {
    let visible = "";
    for (const character of text) {
      if (this.consoleEscapeState === "normal") {
        if (character === "\x1b") this.consoleEscapeState = "escape";
        else if (character === "\x9b") this.consoleEscapeState = "csi";
        else visible += character;
      } else if (this.consoleEscapeState === "escape") {
        if (character === "[") this.consoleEscapeState = "csi";
        else if (character === "]") this.consoleEscapeState = "osc";
        else this.consoleEscapeState = "normal";
      } else if (this.consoleEscapeState === "csi") {
        const code = character.charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) this.consoleEscapeState = "normal";
      } else if (this.consoleEscapeState === "osc") {
        if (character === "\x07") this.consoleEscapeState = "normal";
        else if (character === "\x1b") this.consoleEscapeState = "oscEscape";
      } else if (character === "\\") {
        this.consoleEscapeState = "normal";
      } else if (character !== "\x1b") {
        this.consoleEscapeState = "osc";
      }
    }
    return visible;
  }

  private sendConsoleText(text: string): void {
    if (!this.consoleSocket || this.consoleSocket.destroyed) {
      throw new WebWorkflowError("The wireless output connection is not open.");
    }
    this.consoleSocket.write(this.webSocketFrame(Buffer.from(text, "utf8"), 0x1));
  }

  private webSocketFrame(payload: Buffer, opcode: number): Buffer {
    if (payload.length > 125) throw new WebWorkflowError("WebSocket command is too large.");
    const mask = randomBytes(4);
    const frame = Buffer.alloc(6 + payload.length);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | payload.length;
    mask.copy(frame, 2);
    for (let index = 0; index < payload.length; index += 1) {
      frame[6 + index] = payload[index] ^ mask[index % 4];
    }
    return frame;
  }

  private secretKey(device: CircuitPythonDevice): string {
    return `circuitpythonRemote.password.${device.key}`;
  }
}

class RemoteEntry extends vscode.TreeItem {
  constructor(readonly device: CircuitPythonDevice, readonly remotePath: string, readonly isDirectory: boolean) {
    super(remotePath.split("/").filter(Boolean).pop() ?? device.name,
      isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.contextValue = isDirectory ? "remoteDirectory" : "remoteFile";
    this.iconPath = new vscode.ThemeIcon(isDirectory ? "folder" : "file");
    this.tooltip = `${device.name}:${remotePath}`;
    if (!isDirectory) this.command = {
      command: "circuitpythonRemote.openFile",
      title: "Open Remote File",
      arguments: [this],
    };
  }
}

class RemoteFileTree implements vscode.TreeDataProvider<RemoteEntry> {
  private readonly changed = new vscode.EventEmitter<RemoteEntry | undefined | void>();
  readonly onDidChangeTreeData = this.changed.event;
  private selectedDevice: CircuitPythonDevice | undefined;

  constructor(private readonly client: WebWorkflowClient, private readonly output: vscode.OutputChannel) {}
  get device(): CircuitPythonDevice | undefined { return this.selectedDevice; }
  selectDevice(device: CircuitPythonDevice): void { this.selectedDevice = device; this.changed.fire(); }
  refresh(): void { this.changed.fire(); }
  getTreeItem(element: RemoteEntry): vscode.TreeItem { return element; }

  async getChildren(element?: RemoteEntry): Promise<RemoteEntry[]> {
    const device = element?.device ?? this.selectedDevice;
    if (!device) return [];
    const path = element?.remotePath ?? "/";
    try {
      const entries = await this.client.readDirectory(device, path);
      return entries.sort((left, right) => {
        if (left.directory !== right.directory) return left.directory ? -1 : 1;
        return left.name.localeCompare(right.name);
      }).map((entry) => {
        const childPath = `${path}${entry.name}${entry.directory ? "/" : ""}`;
        return new RemoteEntry(device, childPath, entry.directory);
      });
    } catch (error) {
      await this.handleError(device, error);
      return [];
    }
  }

  private async handleError(device: CircuitPythonDevice, error: unknown): Promise<void> {
    const workflowError = error instanceof WebWorkflowError ? error
      : new WebWorkflowError(error instanceof Error ? error.message : String(error));
    this.output.appendLine(`File tree error: ${workflowError.message}`);
    if (workflowError.status === 401) {
      await this.client.forgetPassword(device);
      const retry = await vscode.window.showErrorMessage(workflowError.message, "Enter Password Again");
      if (retry && await this.client.ensurePassword(device)) this.refresh();
      return;
    }
    void vscode.window.showErrorMessage(`CircuitPython Remote: ${workflowError.message}`);
  }
}

class RemoteFileSystem implements vscode.FileSystemProvider {
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changed.event;

  constructor(
    private readonly discovery: CircuitPythonDiscovery,
    private readonly client: WebWorkflowClient,
    private readonly refreshTree: () => void,
  ) {}

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    if (uri.path === "/") {
      return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }

    const device = this.deviceFor(uri);
    const path = uri.path.endsWith("/") ? uri.path.slice(0, -1) : uri.path;
    const slash = path.lastIndexOf("/");
    const parentPath = path.slice(0, slash + 1);
    const name = path.slice(slash + 1);
    const entries = await this.client.readDirectory(device, parentPath);
    const entry = entries.find((candidate) => candidate.name === name);
    if (!entry) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    return {
      type: entry.directory ? vscode.FileType.Directory : vscode.FileType.File,
      ctime: 0,
      mtime: entry.modified_ns ? entry.modified_ns / 1_000_000 : 0,
      size: entry.file_size ?? 0,
    };
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const entries = await this.client.readDirectory(this.deviceFor(uri), uri.path);
    return entries.map((entry) => [
      entry.name,
      entry.directory ? vscode.FileType.Directory : vscode.FileType.File,
    ]);
  }

  readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.client.readFile(this.deviceFor(uri), uri.path);
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    if (isKnownBinaryPath(uri.path)) {
      throw vscode.FileSystemError.NoPermissions(
        `Binary files cannot be saved as text: ${uri.path}`,
      );
    }
    const device = this.deviceFor(uri);
    try {
      await this.client.writeFile(device, uri.path, content);
      this.changed.fire([{ type: vscode.FileChangeType.Changed, uri }]);
      this.refreshTree();
    } catch (error) {
      if (error instanceof WebWorkflowError && error.status === 401) {
        await this.client.forgetPassword(device);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw vscode.FileSystemError.Unavailable(`CircuitPython Remote: ${message}`);
    }
  }

  async uploadFile(uri: vscode.Uri, content: Uint8Array, overwrite: boolean): Promise<void> {
    const device = this.deviceFor(uri);
    try {
      await this.client.writeFile(device, uri.path, content);
      this.changed.fire([{
        type: overwrite ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created,
        uri,
      }]);
      this.refreshTree();
    } catch (error) {
      if (error instanceof WebWorkflowError && error.status === 401) {
        await this.client.forgetPassword(device);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw vscode.FileSystemError.Unavailable(`CircuitPython Remote: ${message}`);
    }
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const device = this.deviceFor(uri);
    try {
      await this.client.createDirectory(device, uri.path);
      this.changed.fire([{ type: vscode.FileChangeType.Created, uri }]);
      this.refreshTree();
    } catch (error) {
      if (error instanceof WebWorkflowError && error.status === 401) {
        await this.client.forgetPassword(device);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw vscode.FileSystemError.Unavailable(`CircuitPython Remote: ${message}`);
    }
  }

  async delete(uri: vscode.Uri): Promise<void> {
    const device = this.deviceFor(uri);
    const file = await this.stat(uri);
    if (file.type === vscode.FileType.Directory) {
      const entries = await this.client.readDirectory(device, uri.path);
      if (entries.length > 0) {
        throw vscode.FileSystemError.NoPermissions("Only empty remote directories can be deleted.");
      }
    }

    try {
      await this.client.deleteFile(device, uri.path);
      this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
      this.refreshTree();
    } catch (error) {
      if (error instanceof WebWorkflowError && error.status === 401) {
        await this.client.forgetPassword(device);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw vscode.FileSystemError.Unavailable(`CircuitPython Remote: ${message}`);
    }
  }

  async rename(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    const device = this.deviceFor(oldUri);
    if (this.deviceFor(newUri).key !== device.key) {
      throw vscode.FileSystemError.NoPermissions("Moving files between devices is not supported.");
    }

    try {
      await this.client.moveFile(device, oldUri.path, newUri.path);
      this.changed.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
      this.refreshTree();
    } catch (error) {
      if (error instanceof WebWorkflowError && error.status === 401) {
        await this.client.forgetPassword(device);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw vscode.FileSystemError.Unavailable(`CircuitPython Remote: ${message}`);
    }
  }

  private deviceFor(uri: vscode.Uri): CircuitPythonDevice {
    const key = new URLSearchParams(uri.query).get("device");
    const device = key ? this.discovery.getDevice(key) : undefined;
    if (!device) {
      throw vscode.FileSystemError.Unavailable("The selected CircuitPython device is no longer available.");
    }
    return device;
  }
}

function remoteUri(device: CircuitPythonDevice, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: "circuitpython-remote",
    path,
    query: `device=${encodeURIComponent(device.key)}`,
  });
}

function parseIpv4Address(value: string): { ip: string; port: number } | undefined {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(value);
  if (!match) return undefined;
  const octets = match[1].split(".").map(Number);
  const port = match[2] ? Number(match[2]) : 80;
  if (octets.some((octet) => octet > 255) || port < 1 || port > 65535) return undefined;
  return { ip: match[1], port };
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceBindingsKey = "circuitpythonRemote.workspaceDeviceBindings";
  const output = vscode.window.createOutputChannel("CircuitPython Remote");
  const consoleOutput = vscode.window.createOutputChannel("CircuitPython Output");
  const discovery = new CircuitPythonDiscovery(output);
  const client = new WebWorkflowClient(context.secrets, output, consoleOutput);
  const tree = new RemoteFileTree(client, output);
  const treeView = vscode.window.createTreeView("circuitpythonRemote.files", { treeDataProvider: tree, showCollapseAll: true });
  const remoteFiles = new RemoteFileSystem(discovery, client, () => tree.refresh());
  const workspaceLinkStatus = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    49,
  );
  workspaceLinkStatus.command = "circuitpythonRemote.showWorkspaceLinkActions";

  const useDevice = async (device: CircuitPythonDevice): Promise<void> => {
    if (!(await client.ensurePassword(device))) return;
    if (tree.device?.key !== device.key) client.disconnectOutput();
    tree.selectDevice(device);
    treeView.title = `CircuitPython: ${device.name}`;
    void vscode.commands.executeCommand("setContext", "circuitpythonRemote.deviceSelected", true);
  };

  const localWorkspaceFolder = async (
    placeHolder: string,
  ): Promise<vscode.WorkspaceFolder | undefined> => {
    const folders = vscode.workspace.workspaceFolders?.filter(
      (folder) => folder.uri.scheme === "file",
    ) ?? [];
    if (folders.length === 0) {
      void vscode.window.showInformationMessage("Open a local CircuitPython project folder first.");
      return undefined;
    }
    if (folders.length === 1) return folders[0];

    const selected = await vscode.window.showQuickPick(
      folders.map((folder) => ({
        label: folder.name,
        description: folder.uri.fsPath,
        folder,
      })),
      { placeHolder },
    );
    return selected?.folder;
  };

  const workspaceBindings = (): WorkspaceDeviceBindings =>
    context.globalState.get<WorkspaceDeviceBindings>(workspaceBindingsKey, {});

  const openLinkedFolders = (): { folder: vscode.WorkspaceFolder; device: CircuitPythonDevice }[] => {
    const bindings = workspaceBindings();
    return (vscode.workspace.workspaceFolders ?? []).flatMap((folder) => {
      if (folder.uri.scheme !== "file") return [];
      const device = bindings[folder.uri.toString()];
      return device ? [{ folder, device }] : [];
    });
  };

  const activeWorkspaceFolder = (): vscode.WorkspaceFolder | undefined => {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    return activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined;
  };

  const activeLinkedFolder = (): { folder: vscode.WorkspaceFolder; device: CircuitPythonDevice } | undefined => {
    const activeFolder = activeWorkspaceFolder();
    if (!activeFolder) return undefined;
    const device = workspaceBindings()[activeFolder.uri.toString()];
    return device ? { folder: activeFolder, device } : undefined;
  };

  const updateWorkspaceLinkStatus = (): void => {
    const linkedFolders = openLinkedFolders();
    if (linkedFolders.length === 0) {
      workspaceLinkStatus.hide();
      return;
    }

    const activeFolder = activeWorkspaceFolder();
    const active = activeLinkedFolder();
    if (activeFolder && !active) {
      workspaceLinkStatus.hide();
      return;
    }

    const linked = active ?? (linkedFolders.length === 1 ? linkedFolders[0] : undefined);
    if (!linked) {
      workspaceLinkStatus.text = `$(link) ${linkedFolders.length} linked projects`;
      workspaceLinkStatus.tooltip = "Click to choose a linked CircuitPython project";
      workspaceLinkStatus.show();
      return;
    }

    workspaceLinkStatus.text = `$(link) ${linked.folder.name} → ${linked.device.name}`;
    workspaceLinkStatus.tooltip = [
      `Local project: ${linked.folder.uri.fsPath}`,
      `Linked device: ${linked.device.name}`,
      `Address: ${linked.device.ip}:${linked.device.port}`,
      `Hostname: ${linked.device.hostname}`,
      "",
      "Binding does not guarantee that the device is currently reachable.",
    ].join("\n");
    workspaceLinkStatus.show();
  };

  const saveWorkspaceBinding = async (
    folderUri: vscode.Uri,
    device: CircuitPythonDevice,
  ): Promise<void> => {
    await context.globalState.update(workspaceBindingsKey, {
      ...workspaceBindings(),
      [folderUri.toString()]: device,
    });
    updateWorkspaceLinkStatus();
  };

  const boundDevice = (folderUri: vscode.Uri): CircuitPythonDevice | undefined => {
    const saved = workspaceBindings()[folderUri.toString()];
    if (!saved) return undefined;
    const discovered = discovery.getDevice(saved.key);
    const device = discovered ? { ...saved, ...discovered } : saved;
    discovery.addManualDevice(device);
    return device;
  };

  const promptForAddress = async (): Promise<CircuitPythonDevice | undefined> => {
    const address = await vscode.window.showInputBox({
      title: "Connect to CircuitPython by IP Address",
      prompt: "Enter the board's IPv4 address and optional Web Workflow port",
      placeHolder: "192.168.1.100 or 192.168.1.100:8080",
      ignoreFocusOut: true,
      validateInput: (value) => parseIpv4Address(value.trim())
        ? undefined
        : "Enter a valid IPv4 address with an optional port.",
    });
    if (!address) return undefined;

    const target = parseIpv4Address(address.trim());
    if (!target) return undefined;
    const device = await client.identifyDevice(target.ip, target.port);
    discovery.addManualDevice(device);
    return device;
  };

  const connectByAddress = async (): Promise<void> => {
    try {
      const device = await promptForAddress();
      if (!device) return;
      await useDevice(device);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: ${message}`);
    }
  };

  const linkWorkspaceToDevice = async (
    requestedFolder?: vscode.WorkspaceFolder,
  ): Promise<void> => {
    const folder = requestedFolder
      ?? await localWorkspaceFolder("Select the local project to link");
    if (!folder) return;

    const selection = await discovery.pickDevice();
    if (!selection) return;
    let device: CircuitPythonDevice | undefined;
    try {
      device = selection === "manual" ? await promptForAddress() : selection;
      if (!device) return;
      if (!(await client.ensurePassword(device))) return;
      await client.readDirectory(device, "/");
      await saveWorkspaceBinding(folder.uri, device);
      discovery.addManualDevice(device);
      output.appendLine(
        `Linked local workspace ${folder.uri.fsPath} to ${device.name} at ${device.ip}:${device.port}`,
      );
      void vscode.window.showInformationMessage(
        `Linked ${folder.name} to ${device.name} at ${device.ip}:${device.port}.`,
      );
    } catch (error) {
      if (device && error instanceof WebWorkflowError && error.status === 401) {
        await client.forgetPassword(device);
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: Unable to link workspace. ${message}`);
    }
  };

  const selectDevice = async (): Promise<void> => {
    const selection = await discovery.pickDevice();
    if (selection === "manual") {
      await connectByAddress();
    } else if (selection) {
      await useDevice(selection);
    }
  };

  const showOutput = async (): Promise<void> => {
    const device = tree.device;
    if (!device) {
      void vscode.window.showInformationMessage("Select a CircuitPython device first.");
      return;
    }

    client.showOutput();
    try {
      await client.connectOutput(device);
    } catch (error) {
      if (error instanceof WebWorkflowError && error.status === 401) {
        await client.forgetPassword(device);
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: ${message}`);
    }
  };

  const reloadAndRun = async (): Promise<void> => {
    const device = tree.device;
    if (!device) {
      void vscode.window.showInformationMessage("Select a CircuitPython device first.");
      return;
    }

    client.showOutput();
    try {
      await client.reloadAndRun(device);
      void vscode.window.showInformationMessage(`Reload requested for ${device.name}.`);
    } catch (error) {
      if (error instanceof WebWorkflowError && error.status === 401) {
        await client.forgetPassword(device);
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: ${message}`);
    }
  };

  const createLocalProject = async (): Promise<void> => {
    const device = tree.device;
    if (!device) {
      void vscode.window.showInformationMessage("Select a CircuitPython device first.");
      return;
    }

    const selected = await vscode.window.showOpenDialog({
      title: `Create a local project from ${device.name}`,
      openLabel: "Select Empty Folder",
      defaultUri: vscode.Uri.file(homedir()),
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
    });
    const destination = selected?.[0];
    if (!destination) return;
    if (destination.scheme !== "file") {
      void vscode.window.showErrorMessage("Select a folder on the local filesystem.");
      return;
    }

    try {
      const localEntries = await vscode.workspace.fs.readDirectory(destination);
      const existing = localEntries.filter(([name]) => !isSystemMetadataName(name));
      if (existing.length > 0) {
        void vscode.window.showErrorMessage(
          "The selected folder is not empty. Choose an empty folder to avoid overwriting local files.",
        );
        return;
      }

      const summary: ProjectDownloadSummary = {
        files: 0,
        directories: 0,
        skipped: 0,
        includesSettings: false,
      };
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Downloading project from ${device.name}`,
        cancellable: true,
      }, async (progress, token) => {
        const downloadDirectory = async (remotePath: string, localDirectory: vscode.Uri): Promise<void> => {
          const entries = await client.readDirectory(device, remotePath);
          for (const entry of entries) {
            if (token.isCancellationRequested) throw new vscode.CancellationError();
            if (!isSafeRemoteName(entry.name)) {
              throw new WebWorkflowError(`The device returned an unsafe file name in ${remotePath}.`);
            }
            if (isSystemMetadataName(entry.name)) {
              summary.skipped += 1;
              output.appendLine(`Skipped system metadata: ${remotePath}${entry.name}`);
              continue;
            }

            const remoteEntryPath = `${remotePath}${entry.name}${entry.directory ? "/" : ""}`;
            const localEntry = vscode.Uri.joinPath(localDirectory, entry.name);
            progress.report({ message: remoteEntryPath });
            if (entry.directory) {
              await vscode.workspace.fs.createDirectory(localEntry);
              summary.directories += 1;
              await downloadDirectory(remoteEntryPath, localEntry);
            } else {
              const content = await client.readFile(device, remoteEntryPath);
              await vscode.workspace.fs.writeFile(localEntry, content);
              summary.files += 1;
              if (remoteEntryPath === "/settings.toml") summary.includesSettings = true;
            }
          }
        };

        await downloadDirectory("/", destination);
      });
      await saveWorkspaceBinding(destination, device);

      if (summary.includesSettings) {
        await vscode.window.showWarningMessage(
          "The local project contains settings.toml, which may include Wi-Fi and Web Workflow passwords. Keep it private and do not commit it to a public repository.",
        );
      }
      const openFolder = await vscode.window.showInformationMessage(
        `Downloaded ${summary.files} files and ${summary.directories} folders from ${device.name}. Skipped ${summary.skipped} system metadata items.`,
        "Open Folder",
      );
      if (openFolder === "Open Folder") {
        await vscode.commands.executeCommand("vscode.openFolder", destination, true);
      }
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        void vscode.window.showWarningMessage(
          `Project download cancelled. Partially downloaded files remain in ${destination.fsPath}.`,
        );
        return;
      }
      if (error instanceof WebWorkflowError && error.status === 401) {
        await client.forgetPassword(device);
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `CircuitPython Remote: Project download stopped. Partial files may remain in ${destination.fsPath}. ${message}`,
      );
    }
  };

  const syncLocalProject = async (
    requestedFolder?: vscode.WorkspaceFolder,
  ): Promise<void> => {
    const localFolder = requestedFolder
      ?? await localWorkspaceFolder("Select the local project to sync");
    if (!localFolder) return;
    const device = boundDevice(localFolder.uri) ?? tree.device;
    if (!device) {
      const link = await vscode.window.showInformationMessage(
        "This workspace is not linked to a CircuitPython device.",
        "Link Workspace",
      );
      if (link === "Link Workspace") {
        await vscode.commands.executeCommand("circuitpythonRemote.linkWorkspaceToDevice");
      }
      return;
    }

    try {
      const remoteFiles = new Map<string, DirectoryEntry>();
      const remoteDirectories = new Set<string>(["/"]);
      const localFiles = new Set<string>();
      const candidates: ProjectSyncCandidate[] = [];
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Comparing ${localFolder.name} with ${device.name}`,
        cancellable: true,
      }, async (progress, token) => {
        const scanRemote = async (remotePath: string): Promise<void> => {
          const entries = await client.readDirectory(device, remotePath);
          for (const entry of entries) {
            if (token.isCancellationRequested) throw new vscode.CancellationError();
            if (!isSafeRemoteName(entry.name)) {
              throw new WebWorkflowError(`The device returned an unsafe file name in ${remotePath}.`);
            }
            if (isSystemMetadataName(entry.name)) continue;
            const path = `${remotePath}${entry.name}${entry.directory ? "/" : ""}`;
            if (isLocalProjectMetadata(path, entry.name, entry.directory)) {
              output.appendLine(`Skipped remote project metadata: ${path}`);
              continue;
            }
            progress.report({ message: path });
            if (entry.directory) {
              remoteDirectories.add(path);
              await scanRemote(path);
            } else {
              remoteFiles.set(path, entry);
            }
          }
        };

        const scanLocal = async (localDirectory: vscode.Uri, remotePath: string): Promise<void> => {
          const entries = await vscode.workspace.fs.readDirectory(localDirectory);
          for (const [name, type] of entries) {
            if (token.isCancellationRequested) throw new vscode.CancellationError();
            if (!isSafeRemoteName(name)) {
              throw new WebWorkflowError(`The local project contains an unsafe file name in ${remotePath}.`);
            }
            if ((type & vscode.FileType.SymbolicLink) !== 0) {
              throw new WebWorkflowError(`Symbolic links are not supported: ${remotePath}${name}`);
            }
            const directory = (type & vscode.FileType.Directory) !== 0;
            const path = `${remotePath}${name}${directory ? "/" : ""}`;
            if (isLocalProjectMetadata(path, name, directory)) {
              output.appendLine(`Skipped local project metadata: ${path}`);
              continue;
            }
            progress.report({ message: path });
            const localEntry = vscode.Uri.joinPath(localDirectory, name);
            if (directory) {
              if (remoteFiles.has(path.slice(0, -1))) {
                throw new WebWorkflowError(`A remote file blocks the local directory ${path}.`);
              }
              await scanLocal(localEntry, path);
              continue;
            }
            localFiles.add(path);
            if (remoteDirectories.has(`${path}/`)) {
              throw new WebWorkflowError(`A remote directory blocks the local file ${path}.`);
            }

            const content = await vscode.workspace.fs.readFile(localEntry);
            const remote = remoteFiles.get(path);
            let status: ProjectSyncUploadCandidate["status"] | undefined;
            if (!remote) {
              status = "new";
            } else if (remote.file_size !== content.byteLength) {
              status = "modified";
            } else {
              const remoteContent = await client.readFile(device, path);
              if (!Buffer.from(content).equals(Buffer.from(remoteContent))) status = "modified";
            }
            if (status) {
              candidates.push({
                path,
                localUri: localEntry,
                content,
                status,
                binary: isKnownBinaryPath(path),
                remoteSize: remote?.file_size,
              });
            }
          }
        };

        await scanRemote("/");
        await scanLocal(localFolder.uri, "/");

        for (const [path, entry] of remoteFiles) {
          if (localFiles.has(path)) continue;
          candidates.push({
            path,
            status: "deleted",
            binary: isKnownBinaryPath(path),
            remoteSize: entry.file_size,
          });
        }
      });

      if (candidates.length === 0) {
        void vscode.window.showInformationMessage("The local project is already in sync with the device.");
        return;
      }

      candidates.sort((left, right) => {
        const deletionOrder = Number(right.status === "deleted") - Number(left.status === "deleted");
        return deletionOrder || left.path.localeCompare(right.path);
      });
      const detectedDeletionCount = candidates.filter(
        (candidate) => candidate.status === "deleted",
      ).length;
      const selectedItems = await vscode.window.showQuickPick<ProjectSyncQuickPickItem>(
        candidates.map((candidate) => ({
          label: `${candidate.status === "new"
            ? "$(diff-added)"
            : candidate.status === "modified"
              ? "$(diff-modified)"
              : "$(diff-removed)"} ${candidate.path}`,
          description: candidate.status === "new"
            ? "New"
            : candidate.status === "modified"
              ? "Modified"
              : "Delete file",
          detail: candidate.status === "deleted"
            ? `${candidate.binary ? "Binary" : "Text"} · Remote only${candidate.remoteSize === undefined ? "" : ` · ${formatByteCount(candidate.remoteSize)}`} · Not selected by default`
            : candidate.binary
              ? `Binary · Local ${formatByteCount(candidate.content.byteLength)}${candidate.remoteSize === undefined ? "" : ` · Remote ${formatByteCount(candidate.remoteSize)}`}`
              : candidate.path === "/settings.toml"
                ? "Sensitive file · Not selected by default"
                : `Text · Local ${formatByteCount(candidate.content.byteLength)}${candidate.remoteSize === undefined ? "" : ` · Remote ${formatByteCount(candidate.remoteSize)}`}`,
          picked: candidate.status !== "deleted" && candidate.path !== "/settings.toml",
          candidate,
        })),
        {
          canPickMany: true,
          ignoreFocusOut: true,
          placeHolder: "Select files to create, update, or delete on the device",
          title: `Sync ${localFolder.name} to ${device.name} · ${detectedDeletionCount} deletion${detectedDeletionCount === 1 ? "" : "s"} found`,
        },
      );
      if (!selectedItems || selectedItems.length === 0) return;
      const selectedCandidates = selectedItems.map((item) => item.candidate);

      const previewChoice = await vscode.window.showInformationMessage(
        `${selectedCandidates.length} changes selected for sync.`,
        "Review Changes",
        "Continue",
        "Cancel",
      );
      if (!previewChoice || previewChoice === "Cancel") return;
      if (previewChoice === "Review Changes") {
        for (let index = 0; index < selectedCandidates.length; index += 1) {
          const candidate = selectedCandidates[index];
          if (candidate.status === "deleted" && !candidate.binary) {
            const document = await vscode.workspace.openTextDocument(remoteUri(device, candidate.path));
            await vscode.window.showTextDocument(document, { preview: true });
          } else if (candidate.status !== "deleted" && !candidate.binary) {
            if (candidate.status === "modified") {
              await vscode.commands.executeCommand(
                "vscode.diff",
                remoteUri(device, candidate.path),
                candidate.localUri,
                `${candidate.path} (Remote ↔ Local)`,
              );
            } else {
              const document = await vscode.workspace.openTextDocument(candidate.localUri);
              await vscode.window.showTextDocument(document, { preview: true });
            }
          }

          const last = index === selectedCandidates.length - 1;
          const reviewAction = await vscode.window.showInformationMessage(
            candidate.status === "deleted"
              ? `Reviewing remote file deletion ${candidate.path}${candidate.remoteSize === undefined ? "" : ` (${formatByteCount(candidate.remoteSize)})`}.`
              : candidate.binary
              ? `${candidate.path} is binary; Local ${formatByteCount(candidate.content.byteLength)}${candidate.remoteSize === undefined ? "" : `, Remote ${formatByteCount(candidate.remoteSize)}`}.`
              : `Reviewing ${candidate.status} file ${candidate.path}.`,
            last ? "Finish Review" : "Next",
            last ? "Cancel" : "Finish Review",
            ...(last ? [] : ["Cancel"]),
          );
          if (!reviewAction || reviewAction === "Cancel") return;
          if (reviewAction === "Finish Review") break;
        }
      }

      const uploadCandidates = selectedCandidates.filter(
        (candidate): candidate is ProjectSyncUploadCandidate => candidate.status !== "deleted",
      );
      const deleteCandidates = selectedCandidates.filter(
        (candidate): candidate is ProjectSyncDeleteCandidate => candidate.status === "deleted",
      );
      const newCount = uploadCandidates.filter((candidate) => candidate.status === "new").length;
      const modifiedCount = uploadCandidates.length - newCount;
      const selectedForDeletion = (uri: vscode.Uri): boolean =>
        uri.scheme === "circuitpython-remote"
        && uri.query === remoteUri(device, "/").query
        && deleteCandidates.some((candidate) => uri.path === candidate.path);
      const dirtyDeletedDocument = vscode.workspace.textDocuments.find(
        (document) => document.isDirty && selectedForDeletion(document.uri),
      );
      if (dirtyDeletedDocument) {
        void vscode.window.showWarningMessage(
          `Save or discard the unsaved changes in ${dirtyDeletedDocument.uri.path} before syncing its deletion.`,
        );
        return;
      }
      const includesSettings = selectedCandidates.some((candidate) => candidate.path === "/settings.toml");
      const confirmation = await vscode.window.showWarningMessage(
        `Sync ${newCount} new, ${modifiedCount} modified, and ${deleteCandidates.length} deleted items to ${device.name}?`,
        {
          modal: true,
          detail: includesSettings
            ? "Selected remote content will be overwritten or permanently deleted. settings.toml may change Wi-Fi credentials and Web Workflow access."
            : "Selected remote files will be overwritten or permanently deleted. Remote directories will not be deleted.",
        },
        "Sync Selected Changes",
      );
      if (confirmation !== "Sync Selected Changes") return;

      const neededDirectories = new Set<string>();
      for (const candidate of uploadCandidates) {
        const parts = candidate.path.split("/").filter(Boolean);
        parts.pop();
        let directory = "/";
        for (const part of parts) {
          directory += `${part}/`;
          neededDirectories.add(directory);
        }
      }
      const orderedDirectories = [...neededDirectories].sort(
        (left, right) => left.split("/").length - right.split("/").length,
      );
      const orderedCandidates = [...uploadCandidates].sort((left, right) => {
        const priority = (candidate: ProjectSyncUploadCandidate): number => {
          if (candidate.path === "/settings.toml") return 2;
          if (candidate.path === "/code.py" || candidate.path === "/main.py") return 1;
          return 0;
        };
        const priorityDifference = priority(left) - priority(right);
        if (priorityDifference !== 0) return priorityDifference;
        return left.path.localeCompare(right.path);
      });
      const orderedDeleteCandidates = [...deleteCandidates].sort((left, right) => {
        const priority = (candidate: ProjectSyncDeleteCandidate): number => {
          if (candidate.path === "/settings.toml") return 2;
          if (candidate.path === "/code.py" || candidate.path === "/main.py") return 1;
          return 0;
        };
        const priorityDifference = priority(left) - priority(right);
        if (priorityDifference !== 0) return priorityDifference;
        return left.path.localeCompare(right.path);
      });

      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Syncing ${localFolder.name} to ${device.name}`,
        cancellable: false,
      }, async (progress) => {
        for (const directory of orderedDirectories) {
          if (remoteFiles.has(directory.slice(0, -1))) {
            throw new WebWorkflowError(`A remote file blocks the directory ${directory}.`);
          }
          if (!remoteDirectories.has(directory)) {
            progress.report({ message: directory });
            await client.createDirectory(device, directory);
            remoteDirectories.add(directory);
          }
        }
        for (const candidate of orderedCandidates) {
          progress.report({ message: candidate.path });
          await client.writeFile(device, candidate.path, candidate.content);
          output.appendLine(`${candidate.status === "new" ? "Created" : "Updated"}: ${candidate.path}`);
        }
        for (const candidate of orderedDeleteCandidates) {
          progress.report({ message: candidate.path });
          await client.deleteFile(device, candidate.path);
          output.appendLine(`Deleted: ${candidate.path}`);
        }
      });
      const deletedTabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(
        (tab) => tab.input instanceof vscode.TabInputText
          && selectedForDeletion(tab.input.uri),
      );
      if (deletedTabs.length > 0) {
        await vscode.window.tabGroups.close(deletedTabs, true);
      }
      tree.refresh();

      const reload = await vscode.window.showInformationMessage(
        `Synced ${newCount} new and ${modifiedCount} modified files; deleted ${deleteCandidates.length} files from ${device.name}.`,
        "Reload and Run",
      );
      if (reload === "Reload and Run") {
        await vscode.commands.executeCommand("circuitpythonRemote.reloadAndRun");
      }
    } catch (error) {
      if (error instanceof vscode.CancellationError) {
        void vscode.window.showInformationMessage("Project comparison cancelled. No files were uploaded.");
        return;
      }
      if (error instanceof WebWorkflowError && error.status === 401) {
        await client.forgetPassword(device);
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: Project sync stopped. ${message}`);
    }
  };

  const showWorkspaceLinkActions = async (): Promise<void> => {
    const linkedFolders = openLinkedFolders();
    if (linkedFolders.length === 0) return;

    let linked = activeLinkedFolder()
      ?? (linkedFolders.length === 1 ? linkedFolders[0] : undefined);
    if (!linked) {
      const selected = await vscode.window.showQuickPick(
        linkedFolders.map((candidate) => ({
          label: candidate.folder.name,
          description: candidate.device.name,
          detail: `${candidate.folder.uri.fsPath} → ${candidate.device.ip}:${candidate.device.port}`,
          linked: candidate,
        })),
        { placeHolder: "Select a linked CircuitPython project" },
      );
      if (!selected) return;
      linked = selected.linked;
    }

    const action = await vscode.window.showQuickPick([
      {
        label: "$(arrow-circle-up) Sync Local Project to Device",
        description: linked.device.name,
        action: "sync" as const,
      },
      {
        label: "$(link) Link Workspace to Another Device",
        description: linked.folder.name,
        action: "link" as const,
      },
    ], {
      placeHolder: `${linked.folder.name} is linked to ${linked.device.name}`,
    });
    if (action?.action === "sync") {
      await syncLocalProject(linked.folder);
    } else if (action?.action === "link") {
      await linkWorkspaceToDevice(linked.folder);
    }
  };

  const newFile = async (entry?: RemoteEntry): Promise<void> => {
    const device = entry?.device ?? tree.device;
    if (!device) {
      void vscode.window.showInformationMessage("Select a CircuitPython device first.");
      return;
    }
    const directory = entry?.isDirectory ? entry.remotePath : "/";
    const name = await vscode.window.showInputBox({
      title: `New file in ${directory}`,
      prompt: "Enter a file name",
      placeHolder: "example.py",
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value !== value.trim()) return "Enter a file name without leading or trailing spaces.";
        if (value === "." || value === "..") return "This file name is not allowed.";
        if (/[\\/\0]/.test(value)) return "Enter a name only, without a path or slash.";
        return undefined;
      },
    });
    if (!name) return;

    try {
      const entries = await client.readDirectory(device, directory);
      if (entries.some((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        void vscode.window.showErrorMessage(`A remote file or directory named "${name}" already exists.`);
        return;
      }

      const uri = remoteUri(device, `${directory}${name}`);
      await remoteFiles.writeFile(uri, new Uint8Array());
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: ${message}`);
    }
  };

  const newFolder = async (entry?: RemoteEntry): Promise<void> => {
    const device = entry?.device ?? tree.device;
    if (!device) {
      void vscode.window.showInformationMessage("Select a CircuitPython device first.");
      return;
    }
    const directory = entry?.isDirectory ? entry.remotePath : "/";
    const name = await vscode.window.showInputBox({
      title: `New folder in ${directory}`,
      prompt: "Enter a folder name",
      placeHolder: "folder",
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value !== value.trim()) return "Enter a folder name without leading or trailing spaces.";
        if (value === "." || value === "..") return "This folder name is not allowed.";
        if (/[\\/\0]/.test(value)) return "Enter a name only, without a path or slash.";
        return undefined;
      },
    });
    if (!name) return;

    try {
      const entries = await client.readDirectory(device, directory);
      if (entries.some((candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        void vscode.window.showErrorMessage(`A remote file or directory named "${name}" already exists.`);
        return;
      }

      await remoteFiles.createDirectory(remoteUri(device, `${directory}${name}/`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: ${message}`);
    }
  };

  const deleteFile = async (entry?: RemoteEntry): Promise<void> => {
    if (!entry || entry.isDirectory) return;
    const uri = remoteUri(entry.device, entry.remotePath);
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === uri.toString(),
    );
    if (openDocument?.isDirty) {
      void vscode.window.showWarningMessage(
        `Save or discard the unsaved changes in ${entry.remotePath} before deleting it.`,
      );
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Delete remote file "${entry.remotePath}"?`,
      {
        modal: true,
        detail: "This action cannot be undone.",
      },
      "Delete",
    );
    if (confirmation !== "Delete") return;

    try {
      await remoteFiles.delete(uri);
      const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(
        (tab) => tab.input instanceof vscode.TabInputText
          && tab.input.uri.toString() === uri.toString(),
      );
      if (tabs.length > 0) {
        await vscode.window.tabGroups.close(tabs, true);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: ${message}`);
    }
  };

  const downloadFile = async (entry?: RemoteEntry): Promise<void> => {
    if (!entry || entry.isDirectory) return;
    const name = entry.remotePath.slice(entry.remotePath.lastIndexOf("/") + 1);
    const workspaceFolder = vscode.workspace.workspaceFolders?.find(
      (folder) => folder.uri.scheme === "file",
    );
    const defaultDirectory = workspaceFolder?.uri ?? vscode.Uri.file(homedir());
    const destination = await vscode.window.showSaveDialog({
      title: `Download ${entry.remotePath}`,
      saveLabel: "Download",
      defaultUri: vscode.Uri.joinPath(defaultDirectory, name),
    });
    if (!destination) return;

    try {
      const content = await client.readFile(entry.device, entry.remotePath);
      await vscode.workspace.fs.writeFile(destination, content);
      void vscode.window.showInformationMessage(
        `Downloaded ${entry.remotePath} to ${destination.fsPath}.`,
      );
    } catch (error) {
      if (error instanceof WebWorkflowError && error.status === 401) {
        await client.forgetPassword(entry.device);
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: ${message}`);
    }
  };

  const uploadFile = async (entry?: RemoteEntry): Promise<void> => {
    const device = entry?.device ?? tree.device;
    if (!device) {
      void vscode.window.showInformationMessage("Select a CircuitPython device first.");
      return;
    }
    const directory = entry?.isDirectory ? entry.remotePath : "/";
    const selected = await vscode.window.showOpenDialog({
      title: `Upload a file to ${directory}`,
      openLabel: "Upload",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
    });
    const source = selected?.[0];
    if (!source) return;

    const name = basename(source.fsPath);
    try {
      const entries = await client.readDirectory(device, directory);
      const existing = entries.find(
        (candidate) => candidate.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
      );
      if (existing?.directory) {
        void vscode.window.showErrorMessage(`A remote directory named "${existing.name}" already exists.`);
        return;
      }

      const remoteName = existing?.name ?? name;
      const uri = remoteUri(device, `${directory}${remoteName}`);
      if (existing) {
        const openDocument = vscode.workspace.textDocuments.find(
          (document) => document.uri.toString() === uri.toString(),
        );
        if (openDocument?.isDirty) {
          void vscode.window.showWarningMessage(
            `Save or discard the unsaved changes in ${uri.path} before overwriting it.`,
          );
          return;
        }

        const confirmation = await vscode.window.showWarningMessage(
          `Overwrite remote file "${uri.path}"?`,
          {
            modal: true,
            detail: "The existing remote file will be replaced with the selected local file.",
          },
          "Overwrite",
        );
        if (confirmation !== "Overwrite") return;
      }

      const content = await vscode.workspace.fs.readFile(source);
      await remoteFiles.uploadFile(uri, content, existing !== undefined);
      void vscode.window.showInformationMessage(`Uploaded ${name} to ${uri.path}.`);
    } catch (error) {
      if (error instanceof WebWorkflowError && error.status === 401) {
        await client.forgetPassword(device);
      }
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: ${message}`);
    }
  };

  const deleteFolder = async (entry?: RemoteEntry): Promise<void> => {
    if (!entry?.isDirectory) return;
    const confirmation = await vscode.window.showWarningMessage(
      `Delete empty remote folder "${entry.remotePath}"?`,
      {
        modal: true,
        detail: "Non-empty folders will not be deleted. This action cannot be undone.",
      },
      "Delete",
    );
    if (confirmation !== "Delete") return;

    try {
      await remoteFiles.delete(remoteUri(entry.device, entry.remotePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: ${message}`);
    }
  };

  const renameFile = async (entry?: RemoteEntry): Promise<void> => {
    if (!entry || entry.isDirectory) return;
    const oldUri = remoteUri(entry.device, entry.remotePath);
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.toString() === oldUri.toString(),
    );
    if (openDocument?.isDirty) {
      void vscode.window.showWarningMessage(
        `Save or discard the unsaved changes in ${entry.remotePath} before renaming it.`,
      );
      return;
    }

    const slash = entry.remotePath.lastIndexOf("/");
    const directory = entry.remotePath.slice(0, slash + 1);
    const oldName = entry.remotePath.slice(slash + 1);
    const extension = oldName.lastIndexOf(".");
    const newName = await vscode.window.showInputBox({
      title: `Rename ${entry.remotePath}`,
      prompt: "Enter a new file name",
      value: oldName,
      valueSelection: [0, extension > 0 ? extension : oldName.length],
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value !== value.trim()) return "Enter a file name without leading or trailing spaces.";
        if (value === "." || value === "..") return "This file name is not allowed.";
        if (/[\\/\0]/.test(value)) return "Enter a name only, without a path or slash.";
        if (value === oldName) return "Enter a different file name.";
        if (isKnownBinaryPath(value) !== isKnownBinaryPath(oldName)) {
          return "Renaming between text and binary file types is not allowed.";
        }
        return undefined;
      },
    });
    if (!newName) return;

    try {
      const entries = await client.readDirectory(entry.device, directory);
      if (entries.some((candidate) => candidate.name !== oldName
        && candidate.name.toLocaleLowerCase() === newName.toLocaleLowerCase())) {
        void vscode.window.showErrorMessage(`A remote file or directory named "${newName}" already exists.`);
        return;
      }

      const newUri = remoteUri(entry.device, `${directory}${newName}`);
      const tabs = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter(
        (tab) => tab.input instanceof vscode.TabInputText
          && tab.input.uri.toString() === oldUri.toString(),
      );
      await remoteFiles.rename(oldUri, newUri);
      if (tabs.length > 0) {
        await vscode.window.tabGroups.close(tabs, true);
        const document = await vscode.workspace.openTextDocument(newUri);
        await vscode.window.showTextDocument(document, { preview: false });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: ${message}`);
    }
  };

  const renameFolder = async (entry?: RemoteEntry): Promise<void> => {
    if (!entry?.isDirectory) return;
    const openTab = vscode.window.tabGroups.all.flatMap((group) => group.tabs).find(
      (tab) => tab.input instanceof vscode.TabInputText
        && tab.input.uri.scheme === "circuitpython-remote"
        && tab.input.uri.query === remoteUri(entry.device, "/").query
        && tab.input.uri.path.startsWith(entry.remotePath),
    );
    if (openTab) {
      void vscode.window.showWarningMessage(
        `Close files opened from ${entry.remotePath} before renaming the folder.`,
      );
      return;
    }

    const oldPath = entry.remotePath.slice(0, -1);
    const slash = oldPath.lastIndexOf("/");
    const directory = oldPath.slice(0, slash + 1);
    const oldName = oldPath.slice(slash + 1);
    const newName = await vscode.window.showInputBox({
      title: `Rename ${entry.remotePath}`,
      prompt: "Enter a new folder name",
      value: oldName,
      valueSelection: [0, oldName.length],
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value !== value.trim()) return "Enter a folder name without leading or trailing spaces.";
        if (value === "." || value === "..") return "This folder name is not allowed.";
        if (/[\\/\0]/.test(value)) return "Enter a name only, without a path or slash.";
        if (value === oldName) return "Enter a different folder name.";
        return undefined;
      },
    });
    if (!newName) return;

    try {
      const entries = await client.readDirectory(entry.device, directory);
      if (entries.some((candidate) => candidate.name !== oldName
        && candidate.name.toLocaleLowerCase() === newName.toLocaleLowerCase())) {
        void vscode.window.showErrorMessage(`A remote file or directory named "${newName}" already exists.`);
        return;
      }

      await remoteFiles.rename(
        remoteUri(entry.device, entry.remotePath),
        remoteUri(entry.device, `${directory}${newName}/`),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`CircuitPython Remote: ${message}`);
    }
  };

  context.subscriptions.push(
    output, discovery, client, treeView, workspaceLinkStatus,
    vscode.window.onDidChangeActiveTextEditor(updateWorkspaceLinkStatus),
    vscode.workspace.onDidChangeWorkspaceFolders(updateWorkspaceLinkStatus),
    vscode.workspace.registerFileSystemProvider("circuitpython-remote", remoteFiles, {
      isCaseSensitive: true,
    }),
    vscode.commands.registerCommand(
      "circuitpythonRemote.discover",
      () => discovery.showDevices(),
    ),
    vscode.commands.registerCommand("circuitpythonRemote.selectDevice", selectDevice),
    vscode.commands.registerCommand("circuitpythonRemote.connectByAddress", connectByAddress),
    vscode.commands.registerCommand("circuitpythonRemote.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("circuitpythonRemote.showOutput", showOutput),
    vscode.commands.registerCommand("circuitpythonRemote.reloadAndRun", reloadAndRun),
    vscode.commands.registerCommand("circuitpythonRemote.createLocalProject", createLocalProject),
    vscode.commands.registerCommand("circuitpythonRemote.syncLocalProject", syncLocalProject),
    vscode.commands.registerCommand("circuitpythonRemote.linkWorkspaceToDevice", linkWorkspaceToDevice),
    vscode.commands.registerCommand("circuitpythonRemote.showWorkspaceLinkActions", showWorkspaceLinkActions),
    vscode.commands.registerCommand("circuitpythonRemote.newFile", newFile),
    vscode.commands.registerCommand("circuitpythonRemote.newFolder", newFolder),
    vscode.commands.registerCommand("circuitpythonRemote.deleteFile", deleteFile),
    vscode.commands.registerCommand("circuitpythonRemote.downloadFile", downloadFile),
    vscode.commands.registerCommand("circuitpythonRemote.uploadFile", uploadFile),
    vscode.commands.registerCommand("circuitpythonRemote.deleteFolder", deleteFolder),
    vscode.commands.registerCommand("circuitpythonRemote.renameFile", renameFile),
    vscode.commands.registerCommand("circuitpythonRemote.renameFolder", renameFolder),
    vscode.commands.registerCommand("circuitpythonRemote.openFile", async (entry: RemoteEntry) => {
      if (isKnownBinaryPath(entry.remotePath)) {
        void vscode.window.showWarningMessage(
          `${entry.remotePath} is a binary file and cannot be opened as text.`,
        );
        return;
      }
      const uri = remoteUri(entry.device, entry.remotePath);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    }),
  );
  updateWorkspaceLinkStatus();
  discovery.start();
}

export function deactivate(): void {}
