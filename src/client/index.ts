import { DEFAULT_API_BASE, loadAuth } from "./auth.js";
import { Transport, type TransportOptions } from "./transport.js";
import { getFlowNodes, saveFlow } from "./flows.js";
import {
  listAgentsDropdown,
  listActionsDropdown,
  listIntegrations,
  listPhoneNumberPool,
  listWidgetsDropdown,
  type DropdownOption,
  type IntegrationsList,
  type PhoneNumberPoolEntry,
  type PhoneNumberPoolType,
} from "./discovery.js";
import type { FlowNode } from "../schema/index.js";
import type { SaveFlowRequest } from "../schema/flow.js";

export type { DropdownOption, IntegrationsList, PhoneNumberPoolEntry, PhoneNumberPoolType };

export interface ClientOptions extends Partial<TransportOptions> {}

/**
 * Thin façade over the `/v1/*` API. Construct via `Client.fromAuthFile()`
 * for normal use, or `new Client({ token, apiBase })` in tests.
 */
export class Client {
  readonly transport: Transport;

  constructor(opts: TransportOptions) {
    this.transport = new Transport(opts);
  }

  static async fromAuthFile(overrides: ClientOptions = {}): Promise<Client> {
    const auth = await loadAuth();
    return new Client({
      token: overrides.token ?? auth.token,
      apiBase: overrides.apiBase ?? auth.apiBase ?? DEFAULT_API_BASE,
      ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      ...(overrides.onRequest ? { onRequest: overrides.onRequest } : {}),
    });
  }

  // --- Flows ---
  getFlowNodes(uuid: string): Promise<FlowNode[]> {
    return getFlowNodes(this.transport, uuid);
  }

  saveFlow(req: SaveFlowRequest): Promise<void> {
    return saveFlow(this.transport, req);
  }

  // --- Discovery / reference data ---
  listPhoneNumberPool(type: PhoneNumberPoolType): Promise<PhoneNumberPoolEntry[]> {
    return listPhoneNumberPool(this.transport, type);
  }

  listAgents(): Promise<DropdownOption[]> {
    return listAgentsDropdown(this.transport);
  }

  listWidgets(): Promise<DropdownOption[]> {
    return listWidgetsDropdown(this.transport);
  }

  listActions(): Promise<DropdownOption[]> {
    return listActionsDropdown(this.transport);
  }

  listIntegrations(): Promise<IntegrationsList> {
    return listIntegrations(this.transport);
  }
}
