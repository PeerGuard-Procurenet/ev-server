import { Ocpp201ComponentVariable, Ocpp201OutgoingAction } from '../types/Ocpp201Types';
import { Ocpp201ConnectionIdentity, Ocpp201RequestChannel } from '../Ocpp201Connection';

import Configuration from '../../../utils/Configuration';
import Ocpp201DeviceModel from './Ocpp201DeviceModel';
import Ocpp201Logger from '../Ocpp201Logger';
import { ServerAction } from '../../../types/Server';
import moment from 'moment-timezone';

const MODULE_NAME = 'Ocpp201ClockSynchronizer';

// A message cannot be sent before it is created: beyond this, the clock of the Charging Station is ahead
const CLOCK_AHEAD_THRESHOLD_SECS = 5 * 60;
// A message can be delivered late (sent again after a failure): beyond this, the clock of the Charging Station is behind
const CLOCK_BEHIND_THRESHOLD_SECS = 24 * 3600;
const RESYNCHRONIZATION_MIN_INTERVAL_MILLIS = 10 * 60 * 1000;

// Local time displayed by the Charging Station (its clock and the OCPP messages stay in UTC)
const TIME_OFFSET: Ocpp201ComponentVariable = { component: { name: 'ClockCtrlr' }, variable: { name: 'TimeOffset' } };
const TIME_ZONE: Ocpp201ComponentVariable = { component: { name: 'ClockCtrlr' }, variable: { name: 'TimeZone' } };

// Keeps the clock of an OCPP 2.0.1 Charging Station in line with the CSMS: the CSMS is the time source of the Charging Station
// (current time in the Boot Notification and Heartbeat responses) and sets the local time it displays
export default class Ocpp201ClockSynchronizer {
  private readonly identity: Ocpp201ConnectionIdentity;
  private readonly channel: Ocpp201RequestChannel | null;
  private lastResynchronizationOn: number = null;

  public constructor(identity: Ocpp201ConnectionIdentity, channel: Ocpp201RequestChannel | null) {
    this.identity = identity;
    this.channel = channel;
  }

  // Note: the time offset of a timezone with daylight saving time changes, this would require 'NextTimeOffsetTransitionDateTime'
  public static getLocalTimeSettings(timezone: string, date = new Date()): { TimeOffset: string; TimeZone: string } {
    return {
      TimeOffset: moment(date).tz(timezone).format('Z'),
      TimeZone: timezone,
    };
  }

  // Set the local time displayed by the Charging Station (only the variables it supports)
  public async configureLocalTime(timezone: string): Promise<void> {
    if (!this.channel || !timezone || Configuration.getChargingStationConfig()?.setLocalTimeOnChargingStations === false) {
      return;
    }
    const expectedSettings = Ocpp201ClockSynchronizer.getLocalTimeSettings(timezone);
    const updates = await Ocpp201DeviceModel.setVariables(this.channel, [
      { ...TIME_OFFSET, attributeValue: expectedSettings.TimeOffset },
      { ...TIME_ZONE, attributeValue: expectedSettings.TimeZone },
    ]);
    for (const update of updates) {
      if (update.status === 'NotSupported') {
        this.log('info', `Local time variable '${update.key}' is not supported`);
      } else if (update.status !== 'Unchanged') {
        this.log(Ocpp201DeviceModel.isUpdateApplied(update) ? 'info' : 'warning',
          `Local time variable '${update.key}' set to '${update.value}' (was '${update.previousValue}'): '${update.status}'`);
      }
    }
  }

  // Check the time of a message created right before being sent: resynchronize the clock of the Charging Station when it is wrong
  public checkMessageTimestamp(action: string, timestamp: string): void {
    const messageTime = new Date(timestamp).getTime();
    if (!this.channel || Number.isNaN(messageTime)) {
      return;
    }
    const now = Date.now();
    const skewSecs = Math.round((messageTime - now) / 1000);
    if (skewSecs <= CLOCK_AHEAD_THRESHOLD_SECS && skewSecs >= -CLOCK_BEHIND_THRESHOLD_SECS) {
      return;
    }
    if (this.lastResynchronizationOn && (now - this.lastResynchronizationOn) < RESYNCHRONIZATION_MIN_INTERVAL_MILLIS) {
      return;
    }
    this.lastResynchronizationOn = now;
    this.log('warning', `Clock of the Charging Station is ${skewSecs > 0 ? 'ahead' : 'behind'} by ${Math.abs(skewSecs)} secs ` +
      `('${action}' timestamp '${timestamp}', CSMS time '${new Date(now).toISOString()}'): a Heartbeat is requested to synchronize it`);
    // The Heartbeat response provides the current time of the CSMS
    this.channel.sendRequest(Ocpp201OutgoingAction.TRIGGER_MESSAGE, { requestedMessage: 'Heartbeat' }).then((response) => {
      if (response.status !== 'Accepted') {
        this.log('warning', `Heartbeat request to synchronize the clock has been answered with status '${response.status as string}'`);
      }
    }).catch((error) => {
      this.log('warning', `Heartbeat request to synchronize the clock has failed: ${(error as Error)?.message}`);
    });
  }

  private log(level: 'info' | 'warning', message: string, detailedMessages?: Record<string, unknown>): void {
    Ocpp201Logger[level]({
      tenantID: this.identity.tenantID,
      chargingStationID: this.identity.chargingStationID,
      action: ServerAction.WS_SERVER_MESSAGE, module: MODULE_NAME, method: 'synchronizeClock',
      message, detailedMessages
    });
  }
}
