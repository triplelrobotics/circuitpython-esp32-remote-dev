import * as vscode from "vscode";
import { networkInterfaces } from "os";
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

interface DirectoryEntry {
  name: string;
  directory: boolean;
  modified_ns?: number;
  file_size?: number;
}

interface DirectoryResponse {
  files: DirectoryEntry[];
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

  async pickDevice(): Promise<CircuitPythonDevice | undefined> {
    const devices = [...this.devices.values()];
    if (devices.length === 0) {
      void vscode.window.showInformationMessage(
        "No CircuitPython Web Workflow device found yet. Still searching…",
      );
      return undefined;
    }

    const selected = await vscode.window.showQuickPick(
      devices.map((device) => ({
        label: device.name,
        description: `${device.ip}:${device.port}`,
        detail: device.hostname,
        device,
      })),
      { placeHolder: "Select a CircuitPython device" },
    );

    return selected?.device;
  }

  getDevice(key: string): CircuitPythonDevice | undefined {
    return this.devices.get(key);
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

class WebWorkflowClient {
  constructor(private readonly secrets: vscode.SecretStorage, private readonly output: vscode.OutputChannel) {}

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

  async forgetPassword(device: CircuitPythonDevice): Promise<void> {
    await this.secrets.delete(this.secretKey(device));
  }

  private async request(device: CircuitPythonDevice, path: string, init: RequestInit): Promise<Response> {
    const password = await this.secrets.get(this.secretKey(device));
    if (!password) throw new WebWorkflowError("No Web Workflow password is available.", 401);
    const url = `http://${device.ip}:${device.port}${this.apiPath(path)}`;
    const method = init.method ?? "GET";
    this.output.appendLine(`${method} ${url}`);
    let response: Response;
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
      const detail = error instanceof Error ? error.message : String(error);
      throw new WebWorkflowError(`Unable to reach ${device.ip}:${device.port}: ${detail}`);
    }
    if (!response.ok) {
      if (response.status === 401) throw new WebWorkflowError("Incorrect Web Workflow password.", 401);
      if (response.status === 403) throw new WebWorkflowError("Web Workflow is disabled because CIRCUITPY_WEB_API_PASSWORD is not configured on the device.", 403);
      if (response.status === 404) throw new WebWorkflowError(`Remote path not found: ${path}`, 404);
      if (response.status === 409) throw new WebWorkflowError("The CircuitPython filesystem is not writable, usually because USB currently owns it.", 409);
      if (response.status === 413 || response.status === 417) throw new WebWorkflowError("The file is too large for the device to accept.", response.status);
      throw new WebWorkflowError(`The device returned HTTP ${response.status} ${response.statusText}.`, response.status);
    }
    return response;
  }

  private apiPath(path: string): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `/fs${encoded.startsWith("/") ? encoded : `/${encoded}`}`;
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
    const slash = uri.path.lastIndexOf("/");
    const parentPath = uri.path.slice(0, slash + 1);
    const name = uri.path.slice(slash + 1);
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

  createDirectory(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(`Creating directories is not implemented yet: ${uri.path}`);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(`Deleting files is not implemented yet: ${uri.path}`);
  }

  rename(oldUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(`Renaming files is not implemented yet: ${oldUri.path}`);
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

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CircuitPython Remote");
  const discovery = new CircuitPythonDiscovery(output);
  const client = new WebWorkflowClient(context.secrets, output);
  const tree = new RemoteFileTree(client, output);
  const treeView = vscode.window.createTreeView("circuitpythonRemote.files", { treeDataProvider: tree, showCollapseAll: true });
  const remoteFiles = new RemoteFileSystem(discovery, client, () => tree.refresh());

  const selectDevice = async (): Promise<void> => {
    const device = await discovery.pickDevice();
    if (!device || !(await client.ensurePassword(device))) return;
    tree.selectDevice(device);
    treeView.title = `CircuitPython: ${device.name}`;
    void vscode.commands.executeCommand("setContext", "circuitpythonRemote.deviceSelected", true);
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

  context.subscriptions.push(
    output, discovery, treeView,
    vscode.workspace.registerFileSystemProvider("circuitpython-remote", remoteFiles, {
      isCaseSensitive: true,
    }),
    vscode.commands.registerCommand(
      "circuitpythonRemote.discover",
      () => discovery.showDevices(),
    ),
    vscode.commands.registerCommand("circuitpythonRemote.selectDevice", selectDevice),
    vscode.commands.registerCommand("circuitpythonRemote.refresh", () => tree.refresh()),
    vscode.commands.registerCommand("circuitpythonRemote.newFile", newFile),
    vscode.commands.registerCommand("circuitpythonRemote.openFile", async (entry: RemoteEntry) => {
      const uri = remoteUri(entry.device, entry.remotePath);
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: true });
    }),
  );
  discovery.start();
}

export function deactivate(): void {}
