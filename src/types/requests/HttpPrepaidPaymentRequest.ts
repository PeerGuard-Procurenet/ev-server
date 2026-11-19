export interface HttpPrepaidChargerGetRequest {
  ID: string;
}

export interface HttpPrepaidPaymentInitializeRequest {
  chargingStationID: string;
  connectorID: number;
  energyKWh: number;
  email: string;
  callbackURL?: string;
}

export interface HttpPrepaidPaymentGetRequest {
  Reference: string;
}

export interface HttpPrepaidPaymentActionRequest {
  Reference: string;
}
