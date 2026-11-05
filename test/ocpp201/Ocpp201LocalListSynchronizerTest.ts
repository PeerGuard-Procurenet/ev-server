import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import Ocpp201LocalListStorage from '../../src/server/ocpp201/storage/Ocpp201LocalListStorage';
import Ocpp201LocalListSynchronizer from '../../src/server/ocpp201/services/Ocpp201LocalListSynchronizer';
import { Ocpp201Payload } from '../../src/server/ocpp201/types/Ocpp201Types';
import { Ocpp201RequestChannel } from '../../src/server/ocpp201/Ocpp201Connection';
import TagStorage from '../../src/storage/mongodb/TagStorage';
import Tenant from '../../src/types/Tenant';

jest.mock('../../src/utils/Logging', () => ({
  __esModule: true,
  default: {
    logDebug: jest.fn(async () => Promise.resolve('')),
    logInfo: jest.fn(async () => Promise.resolve('')),
    logWarning: jest.fn(async () => Promise.resolve('')),
    logError: jest.fn(async () => Promise.resolve('')),
    logConsoleDebug: jest.fn(),
    logConsoleError: jest.fn(),
  },
}));
let chargingStationConfig: Record<string, unknown> = {};
jest.mock('../../src/utils/Configuration', () => ({
  __esModule: true,
  default: { getChargingStationConfig: () => chargingStationConfig },
}));
jest.mock('../../src/storage/mongodb/TagStorage', () => ({ __esModule: true, default: { getTags: jest.fn() } }));
// Version increased when the content changes (as in MongoDB)
jest.mock('../../src/server/ocpp201/storage/Ocpp201LocalListStorage', () => {
  const state = { version: 0, hash: null as string };
  return {
    __esModule: true,
    default: {
      state,
      getVersion: jest.fn(async (tenant: unknown, hash: string) => {
        if (state.hash !== hash) {
          state.version++;
          state.hash = hash;
        }
        return Promise.resolve(state.version);
      }),
    },
  };
});

const tenant = { id: '5be7fb271014d90008992f06', subdomain: 'test' } as unknown as Tenant;
const identity = { tenantID: tenant.id, tokenID: 'token', chargingStationID: 'CS-LIST', clientIP: '127.0.0.1' };
const storageState = (Ocpp201LocalListStorage as unknown as { state: { version: number; hash: string } }).state;
const activeTag = (id: string, userStatus = 'A') => ({ id, active: true, issuer: true, userID: 'U1', user: { id: 'U1', status: userStatus } });

// Charging Station with a device model and a Local Authorization List
class FakeChargingStation {
  public deviceModel = new Map<string, string>([
    ['LocalAuthListCtrlr.Enabled', 'false'], ['AuthCtrlr.LocalAuthorizeOffline', 'false'], ['AuthCtrlr.OfflineTxForUnknownIdEnabled', 'false'],
    ['LocalAuthListCtrlr.ItemsPerMessage', '50'], ['LocalAuthListCtrlr.Entries', '1000'],
  ]);

  public listVersion = 0;
  public list: string[] = [];
  public sendLocalListStatus = 'Accepted';
  public requests: { action: string; payload: Ocpp201Payload }[] = [];

  public handle(action: string, payload: Ocpp201Payload): Ocpp201Payload {
    this.requests.push({ action, payload });
    const key = (data: Ocpp201Payload) => `${data.component.name as string}.${data.variable.name as string}`;
    switch (action) {
      case 'GetVariables':
        return { getVariableResult: (payload.getVariableData as Ocpp201Payload[]).map((data) => (this.deviceModel.has(key(data)) ?
          { ...data, attributeStatus: 'Accepted', attributeValue: this.deviceModel.get(key(data)) } : { ...data, attributeStatus: 'UnknownVariable' })) };
      case 'SetVariables':
        return { setVariableResult: (payload.setVariableData as Ocpp201Payload[]).map((data) => {
          this.deviceModel.set(key(data), data.attributeValue as string);
          return { component: data.component, variable: data.variable, attributeStatus: 'Accepted' };
        }) };
      case 'GetLocalListVersion':
        return { versionNumber: this.listVersion };
      case 'SendLocalList':
        if (this.sendLocalListStatus === 'Accepted') {
          const tagIDs = ((payload.localAuthorizationList ?? []) as Ocpp201Payload[]).map((data) => data.idToken.idToken as string);
          this.list = payload.updateType === 'Full' ? tagIDs : [...this.list, ...tagIDs];
          this.listVersion = payload.versionNumber as number;
        }
        return { status: this.sendLocalListStatus };
      default:
        throw new Error(`Unexpected '${action}'`);
    }
  }

  public actions(): string[] {
    return this.requests.map((request) => request.action);
  }
}

describe('OCPP 2.0.1 Local Authorization List', () => {
  let chargingStation: FakeChargingStation;
  let channel: Ocpp201RequestChannel;
  let synchronizer: Ocpp201LocalListSynchronizer;
  const setTags = (tags: Record<string, unknown>[]) => (TagStorage.getTags as jest.Mock<any>).mockResolvedValue({ count: tags.length, result: tags });

  beforeEach(() => {
    jest.clearAllMocks();
    Ocpp201LocalListSynchronizer.clearCache();
    chargingStationConfig = {};
    storageState.version = 0;
    storageState.hash = null;
    chargingStation = new FakeChargingStation();
    channel = {
      isClosed: () => false,
      sendRequest: async (action: string, payload: Ocpp201Payload) => Promise.resolve(chargingStation.handle(action, payload)),
      runAfterReceivedRequests: async <T>(task: () => Promise<T>) => task(),
    } as Ocpp201RequestChannel;
    synchronizer = new Ocpp201LocalListSynchronizer(identity, channel);
    setTags([activeTag('BB632985'), activeTag('3F3F3F7E')]);
  });

  it('should list the active tags of the active users', async () => {
    setTags([activeTag('BB632985'), activeTag('3F3F3F7E'), activeTag('3F3F3F7E'), activeTag('INACTIVEUSER', 'I'), activeTag('X'.repeat(37))]);
    await expect(Ocpp201LocalListSynchronizer.getLocalList(tenant)).resolves.toEqual({ version: 1, tagIDs: ['3F3F3F7E', 'BB632985'] });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(TagStorage.getTags).toHaveBeenCalledWith(tenant, { issuer: true, active: true, withUsersOnly: true, withUser: true }, expect.anything());
  });

  it('should enable the offline authorization and send the list after the boot', async () => {
    await synchronizer.configureAfterBoot(tenant);
    expect(chargingStation.deviceModel.get('LocalAuthListCtrlr.Enabled')).toBe('true');
    expect(chargingStation.deviceModel.get('AuthCtrlr.LocalAuthorizeOffline')).toBe('true');
    // Unknown cards stay refused while offline
    expect(chargingStation.deviceModel.get('AuthCtrlr.OfflineTxForUnknownIdEnabled')).toBe('false');
    expect(chargingStation.list).toEqual(['3F3F3F7E', 'BB632985']);
    expect(chargingStation.listVersion).toBe(1);
    expect(chargingStation.requests.find((request) => request.action === 'SendLocalList').payload).toEqual({
      versionNumber: 1, updateType: 'Full', localAuthorizationList: [
        { idToken: { idToken: '3F3F3F7E', type: 'ISO14443' }, idTokenInfo: { status: 'Accepted' } },
        { idToken: { idToken: 'BB632985', type: 'ISO14443' }, idTokenInfo: { status: 'Accepted' } },
      ] });
  });

  it('should not send the list the Charging Station already has', async () => {
    await synchronizer.configureAfterBoot(tenant);
    chargingStation.requests = [];
    // Reboot
    await new Ocpp201LocalListSynchronizer(identity, channel).configureAfterBoot(tenant);
    expect(chargingStation.actions()).toEqual(['GetVariables', 'GetVariables', 'GetLocalListVersion']);
  });

  it('should send the list again only when the tags have changed', async () => {
    await synchronizer.configureAfterBoot(tenant);
    chargingStation.requests = [];
    await synchronizer.synchronize(tenant);
    expect(chargingStation.requests).toHaveLength(0);
    setTags([activeTag('BB632985')]);
    Ocpp201LocalListSynchronizer.clearCache();
    await synchronizer.synchronize(tenant);
    expect(chargingStation.actions()).toEqual(['SendLocalList']);
    expect(chargingStation.list).toEqual(['BB632985']);
    expect(chargingStation.listVersion).toBe(2);
  });

  it('should split a long list in a full update followed by differential updates', async () => {
    chargingStation.deviceModel.set('LocalAuthListCtrlr.ItemsPerMessage', '2');
    setTags([activeTag('A1'), activeTag('A2'), activeTag('A3')]);
    await synchronizer.configureAfterBoot(tenant);
    expect(chargingStation.requests.filter((request) => request.action === 'SendLocalList').map((request) =>
      [request.payload.updateType, request.payload.localAuthorizationList.length])).toEqual([['Full', 2], ['Differential', 1]]);
    expect(chargingStation.list).toEqual(['A1', 'A2', 'A3']);
  });

  it('should clear the list of the Charging Station when there is no active tag', async () => {
    setTags([]);
    await synchronizer.configureAfterBoot(tenant);
    expect(chargingStation.requests.find((request) => request.action === 'SendLocalList').payload).toEqual({ versionNumber: 1, updateType: 'Full' });
  });

  it('should send the list again at the next synchronization when it has been refused', async () => {
    chargingStation.sendLocalListStatus = 'Failed';
    await synchronizer.configureAfterBoot(tenant);
    expect(chargingStation.listVersion).toBe(0);
    chargingStation.sendLocalListStatus = 'Accepted';
    await synchronizer.synchronize(tenant);
    expect(chargingStation.listVersion).toBe(1);
  });

  it('should not send a list larger than the Charging Station can store', async () => {
    chargingStation.deviceModel.set('LocalAuthListCtrlr.Entries', '1');
    await synchronizer.configureAfterBoot(tenant);
    expect(chargingStation.actions()).not.toContain('SendLocalList');
  });

  it('should do nothing when the Charging Station does not support the list', async () => {
    chargingStation.deviceModel.delete('LocalAuthListCtrlr.Enabled');
    await synchronizer.configureAfterBoot(tenant);
    expect(synchronizer.isSupported()).toBe(false);
    await synchronizer.synchronize(tenant);
    expect(chargingStation.actions()).toEqual(['GetVariables', 'SetVariables']);
  });

  it('should do nothing when the offline authorization is disabled', async () => {
    chargingStationConfig = { offlineAuthorizationEnabled: false };
    await synchronizer.configureAfterBoot(tenant);
    expect(chargingStation.requests).toHaveLength(0);
  });
});
