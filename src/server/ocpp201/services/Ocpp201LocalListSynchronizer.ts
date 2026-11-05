import { Ocpp201AuthorizationData, Ocpp201AuthorizationStatus, Ocpp201ComponentVariable, Ocpp201GetLocalListVersionResponse, Ocpp201IdTokenType, Ocpp201OutgoingAction, Ocpp201Payload, Ocpp201SendLocalListStatus } from '../types/Ocpp201Types';
import { Ocpp201ConnectionIdentity, Ocpp201RequestChannel } from '../Ocpp201Connection';

import Configuration from '../../../utils/Configuration';
import Constants from '../../../utils/Constants';
import Ocpp201DeviceModel from './Ocpp201DeviceModel';
import Ocpp201LocalListStorage from '../storage/Ocpp201LocalListStorage';
import Ocpp201Logger from '../Ocpp201Logger';
import Ocpp201Mapper from '../mapping/Ocpp201Mapper';
import { ServerAction } from '../../../types/Server';
import TagStorage from '../../../storage/mongodb/TagStorage';
import Tenant from '../../../types/Tenant';
import { UserStatus } from '../../../types/User';
import { createHash } from 'crypto';

const MODULE_NAME = 'Ocpp201LocalListSynchronizer';

// The list of a tenant is shared by all its Charging Stations: built at most once per period
const LOCAL_LIST_CACHE_MILLIS = 60 * 1000;
// Number of ID Tokens per SendLocalList when the Charging Station does not report its limit
const DEFAULT_ITEMS_PER_MESSAGE = 50;
// Maximum length of an ID Token in OCPP 2.0.1
const ID_TOKEN_MAX_LENGTH = 36;

const LOCAL_AUTH_LIST_ENABLED: Ocpp201ComponentVariable = { component: { name: 'LocalAuthListCtrlr' }, variable: { name: 'Enabled' } };
const LOCAL_AUTH_LIST_ENTRIES: Ocpp201ComponentVariable = { component: { name: 'LocalAuthListCtrlr' }, variable: { name: 'Entries' } };
const LOCAL_AUTH_LIST_ITEMS_PER_MESSAGE: Ocpp201ComponentVariable = { component: { name: 'LocalAuthListCtrlr' }, variable: { name: 'ItemsPerMessage' } };
const LOCAL_AUTHORIZE_OFFLINE: Ocpp201ComponentVariable = { component: { name: 'AuthCtrlr' }, variable: { name: 'LocalAuthorizeOffline' } };
const OFFLINE_TX_FOR_UNKNOWN_ID_ENABLED: Ocpp201ComponentVariable = { component: { name: 'AuthCtrlr' }, variable: { name: 'OfflineTxForUnknownIdEnabled' } };

export interface Ocpp201LocalList {
  version: number;
  tagIDs: string[];
}

// Keeps the Local Authorization List of an OCPP 2.0.1 Charging Station in line with the active tags of the platform,
// so that their users can charge while the Charging Station is offline
export default class Ocpp201LocalListSynchronizer {
  private static readonly localLists = new Map<string, { localList: Ocpp201LocalList; builtOn: number }>();
  private readonly identity: Ocpp201ConnectionIdentity;
  private readonly channel: Ocpp201RequestChannel | null;
  // Set after the boot when the Charging Station supports the list
  private supported = false;
  private itemsPerMessage = DEFAULT_ITEMS_PER_MESSAGE;
  private maxEntries: number = null;
  private sentVersion: number = null;
  private synchronization: Promise<void> = null;

  public constructor(identity: Ocpp201ConnectionIdentity, channel: Ocpp201RequestChannel | null) {
    this.identity = identity;
    this.channel = channel;
  }

  // Active tags of active users (the platform authorizes only them)
  public static async getLocalList(tenant: Tenant): Promise<Ocpp201LocalList> {
    const cached = Ocpp201LocalListSynchronizer.localLists.get(tenant.id);
    if (cached && (Date.now() - cached.builtOn) < LOCAL_LIST_CACHE_MILLIS) {
      return cached.localList;
    }
    const tags = await TagStorage.getTags(tenant, { issuer: true, active: true, withUsersOnly: true, withUser: true }, Constants.DB_PARAMS_MAX_LIMIT);
    const tagIDs = Array.from(new Set(tags.result
      .filter((tag) => tag.user?.status === UserStatus.ACTIVE && tag.id && tag.id.length <= ID_TOKEN_MAX_LENGTH)
      .map((tag) => tag.id))).sort();
    const hash = createHash('sha256').update(tagIDs.join('\n')).digest('hex');
    const localList = { version: await Ocpp201LocalListStorage.getVersion(tenant, hash), tagIDs };
    Ocpp201LocalListSynchronizer.localLists.set(tenant.id, { localList, builtOn: Date.now() });
    return localList;
  }

  public static clearCache(): void {
    Ocpp201LocalListSynchronizer.localLists.clear();
  }

  // Tags are read from a card (RFID) by the Charging Station
  public static buildAuthorizationData(tagID: string): Ocpp201AuthorizationData {
    return {
      idToken: { idToken: tagID, type: Ocpp201IdTokenType.ISO14443 },
      idTokenInfo: { status: Ocpp201AuthorizationStatus.ACCEPTED },
    };
  }

  // Enable the offline authorization with the list (unknown ID Tokens stay refused while offline), then send the list
  public async configureAfterBoot(tenant: Tenant): Promise<void> {
    this.supported = false;
    this.sentVersion = null;
    if (!this.channel || Configuration.getChargingStationConfig()?.offlineAuthorizationEnabled === false) {
      return;
    }
    const updates = await Ocpp201DeviceModel.setVariables(this.channel, [
      { ...LOCAL_AUTH_LIST_ENABLED, attributeValue: 'true' },
      { ...LOCAL_AUTHORIZE_OFFLINE, attributeValue: 'true' },
      { ...OFFLINE_TX_FOR_UNKNOWN_ID_ENABLED, attributeValue: 'false' },
    ]);
    for (const update of updates.filter((variableUpdate) => variableUpdate.status !== 'Unchanged')) {
      this.log(Ocpp201DeviceModel.isUpdateApplied(update) ? 'info' : 'warning', update.status === 'NotSupported' ?
        `Offline authorization variable '${update.key}' is not supported` :
        `Offline authorization variable '${update.key}' set to '${update.value}' (was '${update.previousValue}'): '${update.status}'`);
    }
    const listEnabled = updates.find((update) => update.key === Ocpp201Mapper.buildConfigurationKey(LOCAL_AUTH_LIST_ENABLED));
    if (!Ocpp201DeviceModel.isUpdateApplied(listEnabled)) {
      this.log('warning', 'Local Authorization List cannot be enabled: the Charging Station only authorizes the ID Tokens online');
      return;
    }
    const limits = await Ocpp201DeviceModel.getVariables(this.channel, [LOCAL_AUTH_LIST_ITEMS_PER_MESSAGE, LOCAL_AUTH_LIST_ENTRIES]);
    const itemsPerMessage = Number(limits.get(Ocpp201Mapper.buildConfigurationKey(LOCAL_AUTH_LIST_ITEMS_PER_MESSAGE)));
    const maxEntries = Number(limits.get(Ocpp201Mapper.buildConfigurationKey(LOCAL_AUTH_LIST_ENTRIES)));
    this.itemsPerMessage = Number.isInteger(itemsPerMessage) && itemsPerMessage > 0 ? itemsPerMessage : DEFAULT_ITEMS_PER_MESSAGE;
    this.maxEntries = Number.isInteger(maxEntries) && maxEntries > 0 ? maxEntries : null;
    this.supported = true;
    await this.synchronize(tenant, true);
  }

  public isSupported(): boolean {
    return this.supported;
  }

  // Send the list when it has changed (one synchronization at a time)
  public async synchronize(tenant: Tenant, checkChargingStationVersion = false): Promise<void> {
    if (!this.supported || !this.channel || this.channel.isClosed()) {
      return;
    }
    if (this.synchronization === null) {
      this.synchronization = this.doSynchronize(tenant, checkChargingStationVersion).finally(() => {
        this.synchronization = null;
      });
    }
    return this.synchronization;
  }

  private async doSynchronize(tenant: Tenant, checkChargingStationVersion: boolean): Promise<void> {
    const localList = await Ocpp201LocalListSynchronizer.getLocalList(tenant);
    if (localList.version === this.sentVersion) {
      return;
    }
    if (checkChargingStationVersion) {
      const response = await this.channel.sendRequest(Ocpp201OutgoingAction.GET_LOCAL_LIST_VERSION, {}) as Ocpp201GetLocalListVersionResponse;
      if (response.versionNumber === localList.version) {
        this.sentVersion = localList.version;
        return;
      }
    }
    if (this.maxEntries && localList.tagIDs.length > this.maxEntries) {
      this.log('error', `Local Authorization List version '${localList.version}' cannot be sent: ` +
        `${localList.tagIDs.length} ID Tokens for ${this.maxEntries} entries supported by the Charging Station`);
      return;
    }
    // A list too long for one message is sent in a full update followed by differential updates (same version)
    const requests: Ocpp201Payload[] = [];
    for (let i = 0; i === 0 || i < localList.tagIDs.length; i += this.itemsPerMessage) {
      const request: Ocpp201Payload = { versionNumber: localList.version, updateType: i === 0 ? 'Full' : 'Differential' };
      const tagIDs = localList.tagIDs.slice(i, i + this.itemsPerMessage);
      // An empty full update clears the list
      if (tagIDs.length > 0) {
        request.localAuthorizationList = tagIDs.map((tagID) => Ocpp201LocalListSynchronizer.buildAuthorizationData(tagID));
      }
      requests.push(request);
    }
    for (const request of requests) {
      const response = await this.channel.sendRequest(Ocpp201OutgoingAction.SEND_LOCAL_LIST, request);
      if (response.status !== Ocpp201SendLocalListStatus.ACCEPTED) {
        // Sent again at the next synchronization
        this.log('warning', `Local Authorization List version '${localList.version}' has been answered with status '${response.status as string}'`, { response });
        return;
      }
    }
    this.sentVersion = localList.version;
    this.log('info', `Local Authorization List version '${localList.version}' with ${localList.tagIDs.length} ID Token(s) has been sent`);
  }

  private log(level: 'info' | 'warning' | 'error', message: string, detailedMessages?: Record<string, unknown>): void {
    Ocpp201Logger[level]({
      tenantID: this.identity.tenantID,
      chargingStationID: this.identity.chargingStationID,
      action: ServerAction.WS_SERVER_MESSAGE, module: MODULE_NAME, method: 'synchronize',
      message, detailedMessages
    });
  }
}
