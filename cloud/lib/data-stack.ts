/**
 * DataStack: the stateful resources of the cloud (R11, R17.16, R19.7, R19.8).
 *
 * - Data bucket: private, TLS only, SSE-S3, lifecycle expiry per prefix (R11.1 to R11.3).
 * - DynamoDB table `warashi`: on-demand, TTL attribute `ttl`, GSI1 (R11.4).
 * - Rekognition collections with fixed ids, never derived from a token (R17.16, design C21).
 *
 * All resources use `RemovalPolicy.DESTROY` so that `cdk destroy --all` leaves nothing behind
 * (R19.7, R19.8); the bucket is emptied by `autoDeleteObjects`.
 */
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as rekognition from "aws-cdk-lib/aws-rekognition";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { Construct } from "constructs";

/** Fixed collection ids (R17.16). A changed id would replace the collection and drop its faces. */
export const HOUSEHOLD_COLLECTION_ID = "warashi-household";
export const DEMO_COLLECTION_ID = "warashi-demo";

/** Table name, TTL attribute and index name shared with the Lambda adapters. */
export const TABLE_NAME = "warashi";
export const TTL_ATTRIBUTE = "ttl";
export const GSI1_NAME = "GSI1";

/** Default and upper bound of the snapshot lifetime in days (R11.1). */
export const DEFAULT_SNAPSHOT_EXPIRY_DAYS = 3;
export const MAX_SNAPSHOT_EXPIRY_DAYS = 7;

export interface DataStackProps extends StackProps {
  /** Days after which objects under `snapshots/` expire. Integer 1..7, default 3. */
  snapshotExpiryDays?: number;
}

export class DataStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly table: dynamodb.Table;
  readonly householdCollectionId: string;
  readonly demoCollectionId: string;

  constructor(scope: Construct, id: string, props: DataStackProps = {}) {
    super(scope, id, props);

    const { snapshotExpiryDays = DEFAULT_SNAPSHOT_EXPIRY_DAYS } = props;
    if (
      !Number.isInteger(snapshotExpiryDays) ||
      snapshotExpiryDays < 1 ||
      snapshotExpiryDays > MAX_SNAPSHOT_EXPIRY_DAYS
    ) {
      throw new RangeError(
        `snapshotExpiryDays: must be an integer from 1 to ${MAX_SNAPSHOT_EXPIRY_DAYS}, got ${String(snapshotExpiryDays)}`,
      );
    }

    this.bucket = new s3.Bucket(this, "DataBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        { id: "expire-snapshots", prefix: "snapshots/", expiration: Duration.days(snapshotExpiryDays) },
        { id: "expire-audio", prefix: "audio/", expiration: Duration.days(1) },
        { id: "expire-faces-staging", prefix: "faces-staging/", expiration: Duration.days(1) },
      ],
      // No CORS rule here on purpose: the CloudFront origin is unknown in this stack and a
      // reference to WebStack would create a cycle. WebStack sets it (see "Web and API stack cycle").
    });

    this.table = new dynamodb.Table(this, "Table", {
      tableName: TABLE_NAME,
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: TTL_ATTRIBUTE,
      removalPolicy: RemovalPolicy.DESTROY,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: GSI1_NAME,
      partitionKey: { name: "gsi1pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "gsi1sk", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    this.householdCollectionId = HOUSEHOLD_COLLECTION_ID;
    this.demoCollectionId = DEMO_COLLECTION_ID;
    for (const [logicalId, collectionId] of [
      ["HouseholdCollection", HOUSEHOLD_COLLECTION_ID],
      ["DemoCollection", DEMO_COLLECTION_ID],
    ] as const) {
      const collection = new rekognition.CfnCollection(this, logicalId, { collectionId });
      collection.applyRemovalPolicy(RemovalPolicy.DESTROY);
    }
    new CfnOutput(this, "DataBucketName", { value: this.bucket.bucketName, description: "Private data bucket" });
    new CfnOutput(this, "HouseholdCollectionId", { value: this.householdCollectionId, description: "Rekognition household collection" });
    new CfnOutput(this, "DemoCollectionId", { value: this.demoCollectionId, description: "Rekognition demo collection" });
  }
}
