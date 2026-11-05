import { Ocpp201ComponentVariable, Ocpp201GetVariableStatus, Ocpp201GetVariablesResponse, Ocpp201OutgoingAction, Ocpp201SetVariableStatus, Ocpp201SetVariablesResponse } from '../types/Ocpp201Types';

import Ocpp201Mapper from '../mapping/Ocpp201Mapper';
import { Ocpp201RequestChannel } from '../Ocpp201Connection';

export interface Ocpp201ExpectedVariable extends Ocpp201ComponentVariable {
  attributeValue: string;
}

export interface Ocpp201VariableUpdate {
  // 'Component.Variable' (see Ocpp201Mapper.buildConfigurationKey)
  key: string;
  value: string;
  previousValue?: string;
  // 'Unchanged': already set to the expected value, 'NotSupported': unknown or not readable by the Charging Station
  status: 'Unchanged' | 'NotSupported' | Ocpp201SetVariableStatus;
}

// Reads and sets the device model variables of an OCPP 2.0.1 Charging Station
export default class Ocpp201DeviceModel {
  public static isUpdateApplied(update: Ocpp201VariableUpdate): boolean {
    return update?.status === 'Unchanged' || update?.status === Ocpp201SetVariableStatus.ACCEPTED || update?.status === Ocpp201SetVariableStatus.REBOOT_REQUIRED;
  }

  // Value of each variable (by key), null when not supported by the Charging Station
  public static async getVariables(channel: Ocpp201RequestChannel, variables: Ocpp201ComponentVariable[]): Promise<Map<string, string | null>> {
    const values = new Map<string, string | null>(variables.map((variable) => [Ocpp201Mapper.buildConfigurationKey(variable), null]));
    const response = await channel.sendRequest(Ocpp201OutgoingAction.GET_VARIABLES, {
      getVariableData: variables.map((variable) => ({ component: variable.component, variable: variable.variable })),
    }) as Ocpp201GetVariablesResponse;
    for (const result of response.getVariableResult ?? []) {
      if (result.attributeStatus === Ocpp201GetVariableStatus.ACCEPTED) {
        values.set(Ocpp201Mapper.buildConfigurationKey(result), result.attributeValue ?? '');
      }
    }
    return values;
  }

  // Set the variables supported by the Charging Station that do not have the expected value
  public static async setVariables(channel: Ocpp201RequestChannel, expectedVariables: Ocpp201ExpectedVariable[]): Promise<Ocpp201VariableUpdate[]> {
    const currentValues = await Ocpp201DeviceModel.getVariables(channel, expectedVariables);
    const updates: Ocpp201VariableUpdate[] = [];
    const setVariableData: Ocpp201ExpectedVariable[] = [];
    for (const expectedVariable of expectedVariables) {
      const key = Ocpp201Mapper.buildConfigurationKey(expectedVariable);
      const currentValue = currentValues.get(key);
      const update: Ocpp201VariableUpdate = { key, value: expectedVariable.attributeValue, status: 'NotSupported' };
      if (currentValue !== null) {
        update.previousValue = currentValue;
        // Boolean values are case insensitive
        if (currentValue.toLowerCase() === expectedVariable.attributeValue.toLowerCase()) {
          update.status = 'Unchanged';
        } else {
          // Until answered
          update.status = Ocpp201SetVariableStatus.REJECTED;
          setVariableData.push({ component: expectedVariable.component, variable: expectedVariable.variable, attributeValue: expectedVariable.attributeValue });
        }
      }
      updates.push(update);
    }
    if (setVariableData.length > 0) {
      const response = await channel.sendRequest(Ocpp201OutgoingAction.SET_VARIABLES, { setVariableData }) as Ocpp201SetVariablesResponse;
      for (const result of response.setVariableResult ?? []) {
        const update = updates.find((variableUpdate) => variableUpdate.key === Ocpp201Mapper.buildConfigurationKey(result));
        if (update) {
          update.status = result.attributeStatus;
        }
      }
    }
    return updates;
  }
}
