require('dotenv').config();

const { MongoClient, ObjectId } = require('mongodb');

const TENANT_NAME = process.env.SEED_TENANT_NAME || 'Charging Station Test Tenant';
const TENANT_SUBDOMAIN = process.env.SEED_TENANT_SUBDOMAIN || 'charging-station-test';
const TENANT_EMAIL = process.env.SEED_TENANT_EMAIL || 'admin@charging-station-test.local';
const TOKEN_DESCRIPTION = process.env.SEED_TOKEN_DESCRIPTION || 'Initial charging station test token';
const TOKEN_VALIDITY_DAYS = Number(process.env.SEED_TOKEN_VALIDITY_DAYS || 365);
const TEST_STATION_ID = process.env.SEED_STATION_ID || 'TEST-CHARGER-001';
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://ev-server-moeo.onrender.com').replace(/\/$/, '');

async function seed() {
  const mongoDBURI = process.env.MONGODB_URI?.trim();
  if (!mongoDBURI) {
    throw new Error('MONGODB_URI environment variable is required');
  }
  if (!Number.isFinite(TOKEN_VALIDITY_DAYS) || TOKEN_VALIDITY_DAYS < 1) {
    throw new Error('SEED_TOKEN_VALIDITY_DAYS must be a positive number');
  }

  const client = new MongoClient(mongoDBURI);
  try {
    await client.connect();
    const database = client.db();
    const tenants = database.collection('default.tenants');
    const now = new Date();

    let tenant = await tenants.findOne({ subdomain: TENANT_SUBDOMAIN });
    if (!tenant) {
      tenant = {
        _id: new ObjectId(),
        name: TENANT_NAME,
        email: TENANT_EMAIL,
        subdomain: TENANT_SUBDOMAIN,
        components: {},
        createdOn: now,
        lastChangedOn: now
      };
      await tenants.insertOne(tenant);
    }

    const registrationTokens = database.collection(`${tenant._id.toString()}.registrationtokens`);
    let token = await registrationTokens.findOne({
      description: TOKEN_DESCRIPTION,
      expirationDate: { $gt: now },
      $or: [{ revocationDate: null }, { revocationDate: { $exists: false } }]
    });
    if (!token) {
      const expirationDate = new Date(now);
      expirationDate.setUTCDate(expirationDate.getUTCDate() + TOKEN_VALIDITY_DAYS);
      token = {
        _id: new ObjectId(),
        description: TOKEN_DESCRIPTION,
        siteAreaID: null,
        expirationDate,
        revocationDate: null,
        createdOn: now,
        lastChangedOn: now
      };
      await registrationTokens.insertOne(token);
    }

    const tenantID = tenant._id.toString();
    const tokenID = token._id.toString();
    const websocketBaseURL = PUBLIC_BASE_URL.replace(/^http/i, 'ws');
    console.log('Charging-station test data is ready:');
    console.log(`Tenant name: ${tenant.name}`);
    console.log(`Tenant ID: ${tenantID}`);
    console.log(`Registration token: ${tokenID}`);
    console.log(`Token expires: ${token.expirationDate.toISOString()}`);
    console.log(`Test station ID: ${TEST_STATION_ID}`);
    console.log(`OCPP 1.6 JSON URL: ${websocketBaseURL}/OCPP16/${tenantID}/${tokenID}/${TEST_STATION_ID}`);
    console.log(`Base URL for chargers that append their ID: ${websocketBaseURL}/OCPP16/${tenantID}/${tokenID}`);
  } finally {
    await client.close();
  }
}

seed().catch((error) => {
  console.error(`Unable to seed charging-station data: ${error.message}`);
  process.exitCode = 1;
});
