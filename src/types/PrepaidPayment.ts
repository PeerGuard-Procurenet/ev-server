import CreatedUpdatedProps from './CreatedUpdatedProps';

export enum PrepaidPaymentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  CHARGING = 'charging',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  FAILED = 'failed',
}

export enum PrepaidPaymentProvider {
  PAYSTACK = 'paystack',
}

export default interface PrepaidPayment extends CreatedUpdatedProps {
  id?: string;
  reference: string;
  status: PrepaidPaymentStatus;
  provider: PrepaidPaymentProvider;
  email: string;
  chargingStationID: string;
  connectorID: number;
  siteID?: string;
  siteAreaID?: string;
  siteName?: string;
  connectorType?: string;
  connectorPowerWatts?: number;
  energyKWh: number;
  ratePerKWh: number;
  currency: string;
  amount: number;
  amountKobo: number;
  callbackURL?: string;
  authorizationURL?: string;
  accessCode?: string;
  paystackReference?: string;
  paystackAccessCode?: string;
  paidAt?: Date;
  userID?: string;
  tagID?: string;
  transactionID?: number;
  startedAt?: Date;
  stoppedAt?: Date;
  energyDeliveredWh?: number;
  stopReason?: string;
  metadata?: Record<string, unknown>;
}

export interface PrepaidChargerGun {
  connectorID: number;
  label: string;
  type: string;
  powerWatts: number;
  status: string;
  available: boolean;
}

export interface PrepaidChargerDetails {
  chargingStationID: string;
  siteID?: string;
  siteAreaID?: string;
  siteName?: string;
  online: boolean;
  maximumPowerWatts?: number;
  ratePerKWh: number;
  currency: string;
  guns: PrepaidChargerGun[];
}

export interface PrepaidPaymentStatusResponse {
  id: string;
  reference: string;
  status: PrepaidPaymentStatus;
  email: string;
  chargingStationID: string;
  connectorID: number;
  siteName?: string;
  connectorType?: string;
  connectorPowerWatts?: number;
  energyKWh: number;
  ratePerKWh: number;
  currency: string;
  amount: number;
  paidAt?: Date;
  startedAt?: Date;
  stoppedAt?: Date;
  transactionID?: number;
  energyDeliveredKWh: number;
  energyPurchasedKWh: number;
  percentDelivered: number;
  currentPowerKW: number;
  elapsedSeconds: number;
  estimatedRemainingSeconds: number | null;
  stopReason?: string;
}
