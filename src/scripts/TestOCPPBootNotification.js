const WebSocket = require('ws');

const url = process.argv[2];
if (!url?.startsWith('wss://') && !url?.startsWith('ws://')) {
  console.error('Usage: node src/scripts/TestOCPPBootNotification.js <ws(s) OCPP URL>');
  process.exit(1);
}

const stationID = url.replace(/\/$/, '').split('/').pop();
const messageID = `boot-${Date.now()}`;
const websocket = new WebSocket(url, 'ocpp1.6', { handshakeTimeout: 30000 });
const timeout = setTimeout(() => {
  console.error('Timed out waiting for the OCPP BootNotification response');
  websocket.terminate();
  process.exitCode = 1;
}, 45000);

websocket.on('open', () => {
  console.log(`Connected using WebSocket protocol '${websocket.protocol}'`);
  const request = [
    2,
    messageID,
    'BootNotification',
    {
      chargePointVendor: 'Codex Test',
      chargePointModel: 'OCPP 1.6 Smoke Test',
      chargePointSerialNumber: stationID,
      firmwareVersion: 'test-1.0'
    }
  ];
  console.log(`Sending BootNotification for station '${stationID}'`);
  websocket.send(JSON.stringify(request));
});

websocket.on('message', (data) => {
  const response = data.toString();
  console.log(`Received: ${response}`);
  try {
    const parsedResponse = JSON.parse(response);
    if (parsedResponse[0] === 3 && parsedResponse[1] === messageID) {
      console.log(`BootNotification status: ${parsedResponse[2].status}`);
      clearTimeout(timeout);
      websocket.close();
    } else if (parsedResponse[0] === 4 && parsedResponse[1] === messageID) {
      console.error(`OCPP error: ${parsedResponse[2]} - ${parsedResponse[3]}`);
      clearTimeout(timeout);
      websocket.close();
      process.exitCode = 1;
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
