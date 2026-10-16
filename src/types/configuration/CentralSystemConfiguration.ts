import CentralSystemServerConfiguration from './CentralSystemServerConfiguration';

export enum CentralSystemImplementation {
  SOAP = 'soap',
  JSON = 'json',
  OCPP201 = 'ocpp201'
}

export default interface CentralSystemConfiguration extends CentralSystemServerConfiguration {
  implementation: CentralSystemImplementation;
  debug: boolean;
}
