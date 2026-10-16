const WebSocket = require('ws');

const url = process.argv[2];
if (!url?.startsWith('wss://') && !url?.startsWith('ws://')) {
  console.error('Usage: node src/scripts/TestOCPP201BootNotification.js <ws(s) OCPP 2.0.1 URL>');
  console.error('Example: node src/scripts/TestOCPP201BootNotification.js wss://<host>/OCPP201/<TENANT_ID>/<TOKEN_ID>/<CHARGING_STATION_ID>');
  process.exit(1);
}

const stationID = url.replace(/\/$/, '').split('/').pop();
const bootMessageID = `boot-${Date.now()}`;
const heartbeatMessageID = `heartbeat-${Date.now()}`;
const websocket = new WebSocket(url, 'ocpp2.0.1', { handshakeTimeout: 30000 });
const timeout = setTimeout(() => {
  console.error('Timed out waiting for the OCPP 2.0.1 responses');
  websocket.terminate();
  process.exitCode = 1;
}, 45000);

const send = (frame) => {
  console.log(`Sending: ${JSON.stringify(frame)}`);
  websocket.send(JSON.stringify(frame));
};

websocket.on('open', () => {
  console.log(`Connected using WebSocket protocol '${websocket.protocol}'`);
  if (websocket.protocol !== 'ocpp2.0.1') {
    console.error('The server did not select the OCPP 2.0.1 subprotocol');
    process.exitCode = 1;
  }
  send([2, bootMessageID, 'BootNotification', {
    chargingStation: {
      vendorName: 'Smoke Test',
      model: 'OCPP 2.0.1 Test',
      serialNumber: stationID.substring(0, 25),
      firmwareVersion: 'test-1.0'
    },
    reason: 'PowerUp'
  }]);
});

websocket.on('message', (data) => {
  const response = data.toString();
  console.log(`Received: ${response}`);
  try {
    const [messageType, messageID, payload, errorDescription] = JSON.parse(response);
    if (messageType === 4) {
      console.error(`OCPP error: ${payload} - ${errorDescription}`);
      clearTimeout(timeout);
      websocket.close();
      process.exitCode = 1;
    } else if (messageType === 3 && messageID === bootMessageID) {
      console.log(`BootNotification status: ${payload.status} (heartbeat interval ${payload.interval} secs)`);
      if (payload.status !== 'Accepted') {
        clearTimeout(timeout);
        websocket.close();
        process.exitCode = 1;
        return;
      }
      send([2, heartbeatMessageID, 'Heartbeat', {}]);
    } else if (messageType === 3 && messageID === heartbeatMessageID) {
      console.log(`Heartbeat answered, CSMS time: ${payload.currentTime}`);
      clearTimeout(timeout);
      websocket.close();
    }
  } catch (error) {
    console.error(`Invalid JSON response: ${error.message}`);
  }
});

websocket.on('unexpected-response', (_request, response) => {
  console.error(`WebSocket handshake rejected with HTTP ${response.statusCode}`);
  clearTimeout(timeout);
  process.exitCode = 1;
});

websocket.on('error', (error) => {
  console.error(`WebSocket error: ${error.message}`);
  clearTimeout(timeout);
  process.exitCode = 1;
});

websocket.on('close', (code, reason) => {
  console.log(`WebSocket closed with code ${code}${reason.length ? `: ${reason.toString()}` : ''}`);
  clearTimeout(timeout);
});
