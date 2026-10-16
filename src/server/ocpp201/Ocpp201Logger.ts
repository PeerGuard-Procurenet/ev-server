import { Log } from '../../types/Log';
import Logging from '../../utils/Logging';

// Logging must never break the OCPP message processing
export default class Ocpp201Logger {
  public static debug(log: Log): void {
    Logging.logDebug(log).catch(() => { /* Intentional */ });
  }

  public static info(log: Log): void {
    Logging.logInfo(log).catch(() => { /* Intentional */ });
  }

  public static warning(log: Log): void {
    Logging.logWarning(log).catch(() => { /* Intentional */ });
  }

  public static error(log: Log): void {
    Logging.logError(log).catch(() => { /* Intentional */ });
  }
}
