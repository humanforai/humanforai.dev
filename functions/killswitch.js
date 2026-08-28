/**
 * Human For AI — billing kill switch.
 *
 * Google's documented "cap costs by disabling billing" pattern:
 * a Cloud Billing budget publishes spend notifications to the Pub/Sub
 * topic `billing-cap`; when actual spend exceeds the budget amount,
 * this function DETACHES BILLING from the project. Every paid service
 * stops (site goes down) and no further charges can accrue.
 *
 * This is intentionally destructive — it is the hard stop the free
 * pilot wants. Restore by re-linking the billing account in the
 * console: https://console.cloud.google.com/billing/linkedaccount
 *
 * Enabled only when ENABLE_BILLING_KILLSWITCH=true in functions/.env
 * (the Pub/Sub topic must exist first — it is created in the console
 * when the budget is set up).
 *
 * Required one-time console setup:
 *   1. Billing → Budgets & alerts → Create budget
 *      scope: project human-api-988d4, amount: e.g. $5,
 *      "Connect a Pub/Sub topic": create/select topic `billing-cap`
 *      in project human-api-988d4.
 *   2. Grant the functions runtime service account
 *      (human-api-988d4@appspot.gserviceaccount.com or
 *       <project-number>-compute@developer.gserviceaccount.com)
 *      the "Billing Account Administrator" role ON THE BILLING ACCOUNT
 *      (console → Billing → Account management → permissions).
 */

'use strict';

const { onMessagePublished } = require('firebase-functions/v2/pubsub');
const { GoogleAuth } = require('google-auth-library');

const PROJECT = 'human-api-988d4';

exports.billingKillSwitch = onMessagePublished(
  { topic: 'billing-cap', region: 'us-central1', retry: false, maxInstances: 1 },
  async (event) => {
    let data;
    try {
      data = event.data.message.json;
    } catch {
      console.error('kill switch: unparseable budget message');
      return;
    }
    const cost = Number(data.costAmount);
    const budget = Number(data.budgetAmount);
    console.log(`billing check: spend=$${cost} budget=$${budget}`);

    // Budgets notify at every threshold; only act when real spend
    // exceeds the full budget amount.
    if (!(cost > budget)) return;

    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-billing'] });
    const client = await auth.getClient();
    const url = `https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`;

    const info = await client.request({ url });
    if (!info.data.billingEnabled) {
      console.log('kill switch: billing already disabled — nothing to do');
      return;
    }

    await client.request({ url, method: 'PUT', data: { billingAccountName: '' } });
    console.error(
      `KILL SWITCH FIRED: spend ($${cost}) exceeded budget ($${budget}). ` +
      `Billing detached from ${PROJECT}; services will stop until billing is re-linked in the console.`
    );
  }
);
