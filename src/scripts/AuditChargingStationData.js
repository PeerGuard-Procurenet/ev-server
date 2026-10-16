require('dotenv').config();

const { MongoClient, ObjectId } = require('mongodb');

const STATION_ID = process.env.AUDIT_STATION_ID || '20241012000005';
const TENANT_ID = process.env.AUDIT_TENANT_ID || '6a97123c5ddfdce571887e9e';
const TOKEN_ID = process.env.AUDIT_TOKEN_ID || '6a97123c5ddfdce571887e9f';

const redactDocument = (document) => {
  if (!document) {
    return null;
  }
  const allowedFields = [
    '_id', 'id', 'chargeBoxID', 'chargingStationID', 'chargingStationId',
    'chargePointVendor', 'chargePointModel', 'chargePointSerialNumber',
    'chargeBoxSerialNumber', 'firmwareVersion', 'ocppProtocol', 'ocppVersion',
    'tokenID', 'createdOn', 'lastChangedOn', 'timestamp', 'lastSeen', 'lastReboot',
    'status', 'connectorId', 'transactionId', 'deleted', 'action', 'module',
    'method', 'message', 'severity'
  ];
  return Object.fromEntries(allowedFields
    .filter((field) => Object.prototype.hasOwnProperty.call(document, field))
    .map((field) => [field, document[field]]));
};

async function audit() {
  const mongoDBURI = process.env.MONGODB_URI?.trim();
  if (!mongoDBURI) {
    throw new Error('MONGODB_URI environment variable is required');
  }

  const client = new MongoClient(mongoDBURI);
  try {
    await client.connect();
    const database = client.db();
    const tenantObjectID = new ObjectId(TENANT_ID);
    const tokenObjectID = new ObjectId(TOKEN_ID);
    const tenant = await database.collection('default.tenants').findOne({ _id: tenantObjectID });
    const token = await database.collection(`${TENANT_ID}.registrationtokens`).findOne({ _id: tokenObjectID });

    console.log(JSON.stringify({
      stationID: STATION_ID,
      tenant: tenant ? { id: tenant._id, name: tenant.name, subdomain: tenant.subdomain } : null,
      registrationToken: token ? {
        id: token._id,
        description: token.description,
        expirationDate: token.expirationDate,
        revocationDate: token.revocationDate,
        siteAreaID: token.siteAreaID
      } : null
    }, null, 2));

    const collectionPrefix = `${TENANT_ID}.`;
    const collections = (await database.listCollections({}, { nameOnly: true }).toArray())
      .map(({ name }) => name)
      .filter((name) => name.startsWith(collectionPrefix));
    const identityQuery = {
      $or: [
        { _id: STATION_ID },
        { id: STATION_ID },
        { chargeBoxID: STATION_ID },
        { chargingStationID: STATION_ID },
        { chargingStationId: STATION_ID }
      ]
    };

    for (const collectionName of collections.sort()) {
      const collection = database.collection(collectionName);
      const count = await collection.countDocuments(identityQuery);
      if (count > 0) {
        const samples = await collection.find(identityQuery).sort({ timestamp: -1 }).limit(5).toArray();
        console.log(JSON.stringify({
          collection: collectionName.slice(collectionPrefix.length),
          matchingRecords: count,
          samples: samples.map(redactDocument)
        }, null, 2));
      }
    }
  } finally {
    await client.close();
  }
}

audit().catch((error) => {
  console.error(`Unable to audit charging-station data: ${error.message}`);
  process.exitCode = 1;
});
