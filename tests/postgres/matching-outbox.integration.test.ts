import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import type { Pool } from "pg";
import {
  createUser, updateUser, archiveUser, createOffer, updateOffer, archiveOffer,
  publishOffer, pauseOffer, createDemand, updateDemand, archiveDemand,
  activateDemand, satisfyDemand, getOfferById, getDemandById, getUserById,
} from "../../lib/server/catalog";
import { createCatalogExtractionProposal, applyCatalogExtractionProposal } from "../../lib/server/catalog-extraction";
import { recordOutboxEvent, listOutboxEventsForAggregate, OutboxValidationError } from "../../lib/server/matching/outbox";
import { evaluateOfflineMatching, computeMatchingScore, persistEvaluatedMatch,
  normalizeScoringConfig, computeScoringConfigHash } from "../../lib/server/matching";
import { withPostgresTransaction } from "../../lib/server/postgres/client";
import { runMigrations } from "../../lib/server/postgres/migrations";
import { openVerifiedTestDatabase, openVerifiedIsolatedPool, createTemporarySchemaName, quoteTemporarySchema } from "./test-database";

let admin: Pool, pool: Pool, second: Pool;
const schema = createTemporarySchemaName();
const quoted = quoteTemporarySchema(schema);
before(async () => {
  const opened = await openVerifiedTestDatabase(process.env.TEST_DATABASE_URL);
  admin = opened.pool;
  await admin.query(`CREATE SCHEMA ${quoted}`);
  pool = await openVerifiedIsolatedPool(opened.target, schema);
  second = await openVerifiedIsolatedPool(opened.target, schema);
  const first = await runMigrations(pool);
  assert.equal(first.applied.length, 27);
  const rerun = await runMigrations(pool);
  assert.deepEqual(rerun.applied, []);
  assert.equal(rerun.skipped.length, 27);
  await pool.query(`CREATE FUNCTION reject_audit_outbox() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'audit outbox failure'; END $$`);
});
after(async () => {
  if (second) await second.end();
  if (pool) await pool.end();
  if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quoted} CASCADE`); await admin.end(); }
});
const events = (kind: "offer" | "demand" | "user", id: string) => listOutboxEventsForAggregate(pool, kind, id);
async function failOutbox(operation: () => Promise<unknown>) {
  await pool.query(`CREATE TRIGGER reject_audit_outbox BEFORE INSERT ON matching_outbox_events
    FOR EACH ROW EXECUTE FUNCTION reject_audit_outbox()`);
  try { await assert.rejects(operation(), /audit outbox failure/); }
  finally { await pool.query("DROP TRIGGER reject_audit_outbox ON matching_outbox_events"); }
}

test("schémas : contraintes outbox, identité jobs obligatoire et unicité après complétion", async () => {
  for (const [sql, args] of [
    ["INSERT INTO matching_outbox_events(event_type,aggregate_type,aggregate_id) VALUES('offer.created','offer',$1)", [randomUUID()]],
    ["INSERT INTO matching_outbox_events(event_type,aggregate_type,aggregate_id,payload) VALUES('user.suspended','user',$1,'[]'::jsonb)", [randomUUID()]],
    ["INSERT INTO matching_jobs(job_type,resource_id,resource_version) VALUES('evaluate_offer_candidates',$1,1)", [randomUUID()]],
  ] as [string, unknown[]][]) await assert.rejects(pool.query(sql, args));
  const identity = createHash("sha256").update("audit-identity").digest("hex"), id = randomUUID();
  await pool.query("INSERT INTO matching_jobs(job_identity,job_type,resource_id,resource_version,status,completed_at) VALUES($1,'user_reactivation_sweep',$2,1,'completed',clock_timestamp())", [identity,id]);
  await assert.rejects(pool.query("INSERT INTO matching_jobs(job_identity,job_type,resource_id,resource_version) VALUES($1,'user_reactivation_sweep',$2,1)", [identity,id]), /unique/);
});

test("créations éligibles : versions et configuration complète scellées ; brouillons sans événement", async () => {
  const user = await createUser({}, pool);
  const offer = await createOffer({ownerId:user.id,rawText:"iPhone 12",status:"published"},pool);
  const demand = await createDemand({ownerId:user.id,rawText:"iPhone 12",status:"active"},pool);
  for (const [kind,record] of [["offer",offer],["demand",demand]] as const) {
    const rows = await events(kind,record.id);
    assert.equal(rows.length,1); assert.equal(rows[0].eventType,`${kind}.created`);
    assert.equal(rows[0].aggregateVersion,record.contentVersion);
    assert.equal(rows[0].payload.generation,record.contentVersion);
    assert.deepEqual(rows[0].payload.scoring_config,normalizeScoringConfig());
    assert.equal(rows[0].payload.scoring_config_hash,computeScoringConfigHash(normalizeScoringConfig()));
    assert.equal(rows[0].payload.engine_offline_version,"matching-offline/v1");
    assert.equal(rows[0].dispatchStatus,"pending");
    assert.equal(Object.hasOwn(rows[0].payload,"rawText"),false);
  }
  const draft = await createOffer({ownerId:user.id,rawText:"draft"},pool);
  const unavailable = await createOffer({ownerId:user.id,rawText:"sold",status:"published",availabilityStatus:"unavailable"},pool);
  const draftDemand = await createDemand({ownerId:user.id,rawText:"draft"},pool);
  assert.equal((await events("offer",draft.id)).length,0);
  assert.equal((await events("offer",unavailable.id)).length,0);
  assert.equal((await events("demand",draftDemand.id)).length,0);
});

test("offre : publication, pause, disponibilité, édition, archivage et no-op", async () => {
  const user=await createUser({},pool);
  let offer=await createOffer({ownerId:user.id,rawText:"iPhone 12"},pool);
  offer=await publishOffer(user.id,offer.id,offer.contentVersion,pool);
  await publishOffer(user.id,offer.id,offer.contentVersion,pool);
  const unchanged=await updateOffer({id:offer.id,ownerId:user.id,expectedContentVersion:offer.contentVersion,changes:{rawText:offer.rawText}},pool);
  assert.equal(unchanged.contentVersion,offer.contentVersion);
  offer=await pauseOffer(user.id,offer.id,offer.contentVersion,pool);
  offer=await publishOffer(user.id,offer.id,offer.contentVersion,pool);
  for(const availabilityStatus of ["unavailable","reserved","unavailable",null] as const) {
    offer=await updateOffer({id:offer.id,ownerId:user.id,expectedContentVersion:offer.contentVersion,changes:{availabilityStatus}},pool);
  }
  offer=await updateOffer({id:offer.id,ownerId:user.id,expectedContentVersion:offer.contentVersion,changes:{category:"phones",attributes:{a:1,b:2}}},pool);
  const same=await updateOffer({id:offer.id,ownerId:user.id,expectedContentVersion:offer.contentVersion,changes:{attributes:{b:2,a:1}}},pool);
  assert.equal(same.contentVersion,offer.contentVersion);
  await assert.rejects(updateOffer({id:offer.id,ownerId:user.id,expectedContentVersion:1,changes:{model:"x"}},pool));
  await archiveOffer(user.id,offer.id,offer.contentVersion,pool);
  assert.deepEqual((await events("offer",offer.id)).map(e=>e.eventType),[
    "offer.published","offer.paused","offer.published","offer.unavailable","offer.available",
    "offer.unavailable","offer.available","offer.updated","offer.archived",
  ]);
});

test("demande : activation, satisfaction, édition et archivage ; no-op et refus sans événement", async () => {
  const user=await createUser({},pool), stranger=await createUser({},pool);
  let demand=await createDemand({ownerId:user.id,rawText:"iPhone 12"},pool);
  demand=await activateDemand(user.id,demand.id,demand.contentVersion,pool);
  await activateDemand(user.id,demand.id,demand.contentVersion,pool);
  const same=await updateDemand({id:demand.id,ownerId:user.id,expectedContentVersion:demand.contentVersion,changes:{rawText:demand.rawText}},pool);
  assert.equal(same.contentVersion,demand.contentVersion);
  await assert.rejects(updateDemand({id:demand.id,ownerId:stranger.id,expectedContentVersion:demand.contentVersion,changes:{model:"x"}},pool));
  demand=await satisfyDemand(user.id,demand.id,demand.contentVersion,pool);
  demand=await activateDemand(user.id,demand.id,demand.contentVersion,pool);
  demand=await updateDemand({id:demand.id,ownerId:user.id,expectedContentVersion:demand.contentVersion,changes:{quantity:2}},pool);
  await archiveDemand(user.id,demand.id,demand.contentVersion,pool);
  assert.deepEqual((await events("demand",demand.id)).map(e=>e.eventType),[
    "demand.activated","demand.satisfied","demand.activated","demand.updated","demand.archived",
  ]);
});

test("comptes : générations durables, suspension, réactivation et archivage", async () => {
  let user=await createUser({},pool);
  const same=await updateUser({id:user.id,expectedVersion:user.version,status:"active"},pool);
  assert.equal(same.version,user.version);
  for(const status of ["suspended","active","suspended","active"] as const) user=await updateUser({id:user.id,expectedVersion:user.version,status},pool);
  user=await archiveUser(user.id,user.version,pool);
  await archiveUser(user.id,user.version,pool);
  await assert.rejects(updateUser({id:user.id,expectedVersion:user.version,status:"active"},pool));
  const rows=await events("user",user.id);
  assert.deepEqual(rows.map(e=>e.eventType),["user.suspended","user.reactivated","user.suspended","user.reactivated","user.archived"]);
  assert.deepEqual(rows.map(e=>e.payload.generation),[2,3,4,5,6]);
});

test("échec outbox annule les créations offre et demande", async () => {
  const user=await createUser({},pool), offerId=randomUUID(), demandId=randomUUID();
  await failOutbox(()=>createOffer({id:offerId,ownerId:user.id,rawText:"x",status:"published"},pool));
  await failOutbox(()=>createDemand({id:demandId,ownerId:user.id,rawText:"x",status:"active"},pool));
  assert.equal(await getOfferById(user.id,offerId,pool),null);
  assert.equal(await getDemandById(user.id,demandId,pool),null);
  assert.equal((await events("offer",offerId)).length,0);
  assert.equal((await events("demand",demandId)).length,0);
});

test("rollback commun : mutation, invalidation 2D et événement pour offre, demande et compte", async () => {
  const seller=await createUser({},pool), buyer=await createUser({},pool);
  const offer=await createOffer({ownerId:seller.id,rawText:"iPhone 12",status:"published",model:"iphone 12"},pool);
  const demand=await createDemand({ownerId:buyer.id,rawText:"iPhone 12",status:"active",model:"iphone 12"},pool);
  const evaluation=evaluateOfflineMatching(offer,demand);
  const scoring=computeMatchingScore(evaluation);
  const saved=await persistEvaluatedMatch({offer,demand,evaluation,scoring,idempotencyKey:randomUUID(),pool});
  for(const operation of [
    ()=>updateOffer({id:offer.id,ownerId:seller.id,expectedContentVersion:1,changes:{quantity:2}},pool),
    ()=>updateDemand({id:demand.id,ownerId:buyer.id,expectedContentVersion:1,changes:{quantity:2}},pool),
    ()=>updateUser({id:seller.id,expectedVersion:1,status:"suspended"},pool),
    ()=>archiveOffer(seller.id,offer.id,1,pool),
    ()=>archiveDemand(buyer.id,demand.id,1,pool),
    ()=>archiveUser(seller.id,1,pool),
    ()=>pauseOffer(seller.id,offer.id,1,pool),
    ()=>satisfyDemand(buyer.id,demand.id,1,pool),
  ]) {
    await failOutbox(operation);
    const result=await pool.query("SELECT is_stale FROM matching_evaluations WHERE id=$1",[saved.id]);
    assert.equal(result.rows[0].is_stale,false);
  }
  assert.equal((await getOfferById(seller.id,offer.id,pool))?.contentVersion,1);
  assert.equal((await getDemandById(buyer.id,demand.id,pool))?.contentVersion,1);
  assert.equal((await getUserById(seller.id,pool))?.version,1);
  assert.equal((await events("offer",offer.id)).length,1);
  assert.equal((await events("demand",demand.id)).length,1);
  assert.equal((await events("user",seller.id)).length,0);
});

test("transaction appelante : aucune validation prématurée, événements invisibles puis annulés", async () => {
  const userId=randomUUID(), offerId=randomUUID(), demandId=randomUUID();
  await assert.rejects(withPostgresTransaction(async client=>{
    await createUser({id:userId},client);
    await createOffer({id:offerId,ownerId:userId,rawText:"x",status:"published"},client);
    await createDemand({id:demandId,ownerId:userId,rawText:"x",status:"active"},client);
    assert.equal((await client.query("SELECT id FROM matching_outbox_events WHERE aggregate_id=ANY($1::uuid[])",[[offerId,demandId]])).rowCount,2);
    assert.equal((await second.query("SELECT id FROM matching_outbox_events WHERE aggregate_id=ANY($1::uuid[])",[[offerId,demandId]])).rowCount,0);
    throw new Error("caller rollback");
  },pool),/caller rollback/);
  assert.equal(await getUserById(userId,pool),null);
  assert.equal((await events("offer",offerId)).length,0);
  // Also test an ordinary pg client with BEGIN, without Noma's flag.
  const user=await createUser({},pool), client=await pool.connect();
  try {
    await client.query("BEGIN");
    await updateUser({id:user.id,expectedVersion:1,status:"suspended"},client);
    await client.query("ROLLBACK");
  } finally {client.release();}
  assert.equal((await getUserById(user.id,pool))?.status,"active");
  assert.equal((await events("user",user.id)).length,0);
});

test("écriture outbox refuse pool, exécuteur brut et client hors transaction", async () => {
  const input={eventType:"offer.created" as const,aggregateType:"offer" as const,aggregateId:randomUUID(),aggregateVersion:1};
  await assert.rejects(recordOutboxEvent(pool,input),OutboxValidationError);
  let queries=0;
  await assert.rejects(recordOutboxEvent({query:async()=>{queries++;throw new Error("unexpected");}},input),OutboxValidationError);
  assert.equal(queries,0);
  const client=await pool.connect();
  try {await assert.rejects(recordOutboxEvent(client,input),OutboxValidationError);}
  finally {client.release();}
  await withPostgresTransaction(async tx=>{
    await assert.rejects(recordOutboxEvent(tx,{...input,aggregateType:"demand"}),OutboxValidationError);
    await assert.rejects(recordOutboxEvent(tx,{...input,aggregateVersion:2147483648}),OutboxValidationError);
    await assert.rejects(recordOutboxEvent(tx,{...input,targetAggregateId:""}));
    for (const payload of [{ value: NaN }, { toJSON: () => ({}) }, { scoring_config_hash: "spoofed" }]) {
      await assert.rejects(recordOutboxEvent(tx,{...input,payload}),OutboxValidationError);
    }
  },pool);
});

test("statuts modifiés via CRUD : événement de transition et retrait vers brouillon", async () => {
  const user=await createUser({},pool);
  let offer=await createOffer({ownerId:user.id,rawText:"x"},pool);
  let demand=await createDemand({ownerId:user.id,rawText:"x"},pool);
  for(const status of ["published","paused","published","draft"] as const) {
    offer=await updateOffer({id:offer.id,ownerId:user.id,expectedContentVersion:offer.contentVersion,changes:{status}},pool);
  }
  for(const status of ["active","satisfied","active","draft"] as const) {
    demand=await updateDemand({id:demand.id,ownerId:user.id,expectedContentVersion:demand.contentVersion,changes:{status}},pool);
  }
  const offers=await events("offer",offer.id), demands=await events("demand",demand.id);
  assert.deepEqual(offers.map(e=>e.eventType),["offer.published","offer.paused","offer.published","offer.updated"]);
  assert.deepEqual(demands.map(e=>e.eventType),["demand.activated","demand.satisfied","demand.activated","demand.updated"]);
  assert.equal(offers.at(-1)?.payload.eligible,false);
  assert.equal(demands.at(-1)?.payload.eligible,false);
});

test("concurrence : deux mutations sur la même version, un seul événement", async () => {
  const user=await createUser({},pool);
  const offer=await createOffer({ownerId:user.id,rawText:"x",status:"published"},pool);
  const results=await Promise.allSettled([pool,second].map((db,i)=>updateOffer({id:offer.id,ownerId:user.id,expectedContentVersion:1,changes:{quantity:i+2}},db)));
  assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
  const rows=await events("offer",offer.id);
  assert.deepEqual(rows.map(e=>e.aggregateVersion),[1,2]);
});

for(const kind of ["offer","demand"] as const) test(`extraction ${kind} : événement atomique, rejeu et absence de changement`,async()=>{
  const user=await createUser({},pool);
  const resource=kind==="offer"
    ? await createOffer({ownerId:user.id,rawText:"iPhone 12 128 Go",status:"published"},pool)
    : await createDemand({ownerId:user.id,rawText:"iPhone 12 128 Go",status:"active"},pool);
  const proposal=await createCatalogExtractionProposal({ownerId:user.id,resourceType:kind,resourceId:resource.id},{pool});
  const input={ownerId:user.id,resourceType:kind,resourceId:resource.id,proposalId:proposal.id,
    expectedContentVersion:1,selection:{fields:["model"],attributeKeys:[]},idempotencyKey:randomUUID()};
  await failOutbox(()=>applyCatalogExtractionProposal(input,{pool}));
  assert.equal((await pool.query(`SELECT content_version FROM ${kind==="offer"?"offers":"demands"} WHERE id=$1`,[resource.id])).rows[0].content_version,1);
  assert.equal((await pool.query("SELECT id FROM catalog_extraction_applications WHERE idempotency_key=$1",[input.idempotencyKey])).rowCount,0);
  await applyCatalogExtractionProposal(input,{pool});
  await applyCatalogExtractionProposal(input,{pool});
  const next=await createCatalogExtractionProposal({ownerId:user.id,resourceType:kind,resourceId:resource.id},{pool});
  await applyCatalogExtractionProposal({...input,proposalId:next.id,expectedContentVersion:2,idempotencyKey:randomUUID()},{pool});
  const rows=await events(kind,resource.id);
  assert.deepEqual(rows.map(e=>e.eventType),[`${kind}.created`,`${kind}.updated`]);
  assert.deepEqual(rows.map(e=>e.aggregateVersion),[1,2]);
});
