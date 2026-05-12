import { DEFAULT_API_BASE, DEFAULT_YII_HOST, loadAuth } from "./auth.js";
import { Transport, type TransportOptions } from "./transport.js";
import { YiiTransport, type YiiTransportOptions } from "./yii.js";
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
import { getAgent, updateAgent, type AgentDetails, type AgentUpdate } from "./agents.js";
import {
  listCustomFields,
  upsertCustomField,
  deleteCustomField,
  type CustomFieldDTO,
} from "./custom_fields.js";
import type { FlowNode } from "../schema/index.js";
import type { SaveFlowRequest } from "../schema/flow.js";

export type { DropdownOption, IntegrationsList, PhoneNumberPoolEntry, PhoneNumberPoolType };
export type { AgentDetails, AgentUpdate };
export type { CustomFieldDTO };

export interface ClientOptions extends Partial<TransportOptions> {
  /** Yii host override (default: from auth file or DEFAULT_YII_HOST). */
  yiiHost?: string;
  /** Yii cookies override (default: from auth file). */
  yiiCookies?: YiiTransportOptions["cookies"];
  /** fetchImpl for YiiTransport (tests). */
  yiiFetchImpl?: typeof fetch;
}

/**
 * Thin façade over the `/v1/*` API. Construct via `Client.fromAuthFile()`
 * for normal use, or `new Client({ token, apiBase })` in tests.
 */
export class Client {
  readonly transport: Transport;

  /** Yii transport options — present only when auth file included cookies. */
  private readonly _yiiOpts: YiiTransportOptions | null;

  /** Lazy-constructed YiiTransport instance. */
  private _yiiTransport: YiiTransport | null = null;

  constructor(opts: TransportOptions, yiiOpts?: YiiTransportOptions) {
    this.transport = new Transport(opts);
    this._yiiOpts = yiiOpts ?? null;
  }

  static async fromAuthFile(overrides: ClientOptions = {}): Promise<Client> {
    const auth = await loadAuth();
    const transportOpts: TransportOptions = {
      token: overrides.token ?? auth.token,
      apiBase: overrides.apiBase ?? auth.apiBase ?? DEFAULT_API_BASE,
      ...(overrides.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
      ...(overrides.onRequest ? { onRequest: overrides.onRequest } : {}),
    };

    // Build YiiTransportOptions when cookies are available
    const cookies = overrides.yiiCookies ?? auth.cookies;
    const yiiHost = overrides.yiiHost ?? auth.yiiHost ?? DEFAULT_YII_HOST;
    const yiiOpts: YiiTransportOptions | undefined = cookies
      ? {
          yiiHost,
          cookies,
          ...(overrides.yiiFetchImpl
            ? { fetchImpl: overrides.yiiFetchImpl }
            : {}),
        }
      : undefined;

    return new Client(transportOpts, yiiOpts);
  }

  /**
   * Lazily-constructed YiiTransport. Throws if Yii cookies were not loaded
   * (auth file is missing the `cookies` field).
   */
  get yiiTransport(): YiiTransport {
    if (this._yiiTransport) return this._yiiTransport;
    if (!this._yiiOpts) {
      throw new Error(
        "auth incomplete — Yii cookies not configured; run `aiployee-bridge auth` with --cookie flags",
      );
    }
    this._yiiTransport = new YiiTransport(this._yiiOpts);
    return this._yiiTransport;
  }

  // --- Agents (Yii form) ---
  getAgent(uuid: string): Promise<AgentDetails> {
    return getAgent(this, uuid);
  }

  updateAgent(update: AgentUpdate): Promise<void> {
    return updateAgent(this, update);
  }

  // --- Custom Fields (Yii bulk form) ---
  listCustomFields(): Promise<CustomFieldDTO[]> {
    return listCustomFields(this);
  }

  upsertCustomField(dto: CustomFieldDTO): Promise<CustomFieldDTO> {
    return upsertCustomField(this, dto);
  }

  deleteCustomField(key: { slug?: string; uuid?: string }): Promise<void> {
    return deleteCustomField(this, key);
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
