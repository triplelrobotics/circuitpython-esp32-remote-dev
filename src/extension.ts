import * as vscode from "vscode";
import { Bonjour, Browser, Service } from "bonjour-service";

interface CircuitPythonDevice {
  key: string;
  name: string;
  hostname: string;
  ip: string;
  port: number;
}

class CircuitPythonDiscovery implements vscode.Disposable {
  private readonly bonjour = new Bonjour();
  private readonly devices = new Map<string, CircuitPythonDevice>();
  private browser: Browser | undefined;
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
    if (this.browser) {
      return;
    }

    this.status.text = "$(loading~spin) CircuitPython: searching…";
    this.output.appendLine(
      "Searching for _circuitpython._tcp.local devices…",
    );

    this.browser = this.bonjour.find({
      type: "circuitpython",
      protocol: "tcp",
    });

    this.browser.on("up", (service: Service) => this.onDeviceUp(service));
    this.browser.on("down", (service: Service) => this.onDeviceDown(service));
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

  private onDeviceUp(service: Service): void {
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

    this.devices.set(key, device);
    this.output.appendLine(
      `Found ${device.name} at ${device.ip}:${device.port} (${device.hostname})`,
    );
    this.updateStatus();
  }

  private onDeviceDown(service: Service): void {
    const hostname = service.host || service.fqdn || service.name;
    this.devices.delete(`${hostname}:${service.port}`);
    this.output.appendLine(`Device went offline: ${service.name || hostname}`);
    this.updateStatus();
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
    this.browser?.stop();
    this.bonjour.destroy();
    this.status.dispose();
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("CircuitPython Remote");
  const discovery = new CircuitPythonDiscovery(output);

  context.subscriptions.push(
    output,
    discovery,
    vscode.commands.registerCommand(
      "circuitpythonRemote.discover",
      () => discovery.showDevices(),
    ),
  );

  discovery.start();
}

export function deactivate(): void {}
